/**
 * Running `search_files`' regex scans on a worker thread, so a deadline can actually stop them.
 *
 * `RegExp.prototype.exec` cannot be interrupted from the thread that runs it. `searchPattern.ts`
 * refuses the pattern shapes that backtrack without bound, but it is a static analysis, and a
 * shape it misjudges runs one `exec` for minutes — on the one event loop a stdio server has, so
 * every other tool call and every peer session's heartbeat stalls behind it. A worker thread CAN
 * be stopped mid-`exec` (`Worker.terminate()` interrupts V8, backtracking included), so the regex
 * work runs there and the search terminates it at its deadline. The analyzer stays the first line
 * — it is what makes the ordinary case fast — and this is the backstop for when it is wrong.
 *
 * Literal searches do not come here: an escaped literal has no quantifiers, its scan is linear,
 * and the between-lines deadline on the main thread bounds it (`firstHits`).
 *
 * **The worker's code is an inline string run with `eval: true`, not a module file**, and that is
 * the whole of the packaging story. A file entry point has to resolve in three worlds — `dist/`
 * after `npm run build` (and inside the `.mcpb` bundle, which ships `dist/`), `src/*.ts` under
 * tsx, and `src/*.ts` under vitest, whose transform does not reach a worker's own loader — and
 * each one has a different answer. A string needs none of them. The price is that the code below
 * is not type-checked or linted, so it does one thing only: compile the pattern once, and for
 * each line report the index of the first match or -1. Splitting, the scan cap, comment handling
 * and the reported window all stay in `searchMatch.ts` on the main thread, where they are
 * tested — the worker is handed exactly the `scans` the inline path would `exec`.
 *
 * **stdout is the JSON-RPC channel**, and a worker's `process.stdout` is piped into the parent's
 * by default. The worker writes nothing, but it is created with `stdout: true` / `stderr: true`
 * and both streams are forwarded to the parent's stderr, so no future edit to it (or a Node
 * warning printed inside it) can corrupt the protocol.
 */

import { Worker } from 'node:worker_threads';

/**
 * How often, at most, the worker reports progress on a file, in milliseconds. Progress is what
 * lets a scan cut off by the deadline still report the lines it DID scan; batching it keeps a
 * 50000-line file from costing 50000 messages. The cost is that the lines finished in the last
 * window before a cut-off are never reported, and so are counted as not scanned: the result
 * under-claims what was searched, never over-claims it.
 */
export const WORKER_PROGRESS_MS = 25;

/**
 * The worker, as plain CommonJS. Protocol: the pattern arrives once in `workerData`; each message
 * `{id, scans}` is answered by one or more `{id, hits, done}` messages whose `hits` concatenate,
 * in order, to one entry per scanned line.
 */
const WORKER_SOURCE = `
'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const re = new RegExp(workerData.source, workerData.flags);
parentPort.on('message', (msg) => {
  const scans = msg.scans;
  let hits = [];
  let last = Date.now();
  for (let i = 0; i < scans.length; i++) {
    re.lastIndex = 0;
    const m = re.exec(scans[i]);
    hits.push(m === null ? -1 : m.index);
    const t = Date.now();
    if (t - last >= ${WORKER_PROGRESS_MS}) {
      parentPort.postMessage({ id: msg.id, hits, done: false });
      hits = [];
      last = t;
    }
  }
  parentPort.postMessage({ id: msg.id, hits, done: true });
});
`;

interface WorkerReply {
  id: number;
  hits: number[];
  done: boolean;
}

export interface ScanResult {
  /** First-match index per scanned line, or -1; a prefix of the lines when `complete` is false. */
  hits: number[];
  /** Every line was scanned before the deadline. */
  complete: boolean;
}

/**
 * One worker for one search call: created on the first file, reused for every file after it (a
 * worker per line, or per file, would spend the budget on thread start-up), and gone when the
 * call ends — call {@link RegexScanWorker.close} in a `finally`. Once a scan has been cut off the
 * worker is dead, and so is the scanner: the search has timed out, and there is nothing left to
 * scan.
 */
export class RegexScanWorker {
  private worker: Worker | undefined;
  private seq = 0;
  private dead = false;

  constructor(private readonly matcher: RegExp) {}

  /**
   * Scan `scans` with the pattern, giving up after `timeoutMs`. Resolves with whatever prefix of
   * lines was confirmed scanned by then; rejects only when the worker itself fails (it threw, or
   * exited on its own), which is an error to report, never a partial answer to present as one.
   */
  scan(scans: readonly string[], timeoutMs: number): Promise<ScanResult> {
    if (this.dead) return Promise.resolve({ hits: [], complete: false });
    const worker = this.start();
    const id = ++this.seq;
    const hits: number[] = [];

    return new Promise<ScanResult>((resolve, reject) => {
      const settle = (): void => {
        clearTimeout(timer);
        worker.off('message', onMessage);
        worker.off('error', onError);
        worker.off('exit', onExit);
      };
      const onMessage = (reply: WorkerReply): void => {
        if (reply.id !== id) return;
        for (const h of reply.hits) hits.push(h);
        if (reply.done) {
          settle();
          resolve({ hits, complete: true });
        }
      };
      const onError = (err: Error): void => {
        settle();
        this.dead = true;
        reject(err);
      };
      const onExit = (code: number): void => {
        settle();
        this.dead = true;
        reject(new Error(`the regex search worker exited unexpectedly (code ${code})`));
      };
      const timer = setTimeout(
        () => {
          settle();
          this.kill();
          resolve({ hits, complete: false });
        },
        Math.max(0, timeoutMs),
      );
      worker.on('message', onMessage);
      worker.on('error', onError);
      worker.on('exit', onExit);
      worker.postMessage({ id, scans });
    });
  }

  /** Stop the worker, if one was started. Safe to call more than once. */
  close(): void {
    this.kill();
  }

  private start(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { source: this.matcher.source, flags: this.matcher.flags },
      stdout: true,
      stderr: true,
    });
    const toStderr = (chunk: Buffer | string): void => {
      process.stderr.write(chunk);
    };
    worker.stdout.on('data', toStderr);
    worker.stderr.on('data', toStderr);
    // A standing listener, so an 'error' between scans (or while the thread is being torn down
    // after a cut-off) is never an unhandled 'error' event that takes the server down with it. A
    // scan in flight gets its own listener and rejects.
    worker.on('error', () => {});
    // And a standing 'exit' listener, so a thread that dies BETWEEN scans is forgotten rather
    // than reused: posting to it is answered by nothing, and the next scan would sit out its
    // whole budget and be reported as the search deadline running out, which is not what
    // happened. The next scan starts a fresh thread instead; a thread that dies DURING a scan
    // still rejects that scan through its own listener. `kill()` has already let go of the
    // thread it terminates, so this never revives a scanner that was cut off.
    worker.once('exit', () => {
      if (this.worker === worker) this.worker = undefined;
    });
    this.worker = worker;
    return worker;
  }

  private kill(): void {
    this.dead = true;
    const worker = this.worker;
    this.worker = undefined;
    if (!worker) return;
    // Not awaited: `terminate()` interrupts the running `exec` promptly, and the search's answer
    // does not depend on when the thread has finished unwinding.
    worker.terminate().catch(() => {});
  }
}
