import { spawn } from 'node:child_process';

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Set when `signal` aborted the run (and killed its process tree). */
  aborted?: boolean;
}

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  /** Environment for the child process. Defaults to the parent's environment. */
  env?: NodeJS.ProcessEnv;
  /**
   * Written to the child's stdin, which is then closed (e.g. for `git credential fill`).
   * A `Buffer` is written verbatim — used to pipe binary blob content into `git hash-object`.
   */
  input?: string | Buffer;
  /**
   * Aborting kills the child **and every process it started** (a compile task cancelled, #290):
   * latexmk runs the engine, biber, makeindex as children of its own, and killing latexmk alone
   * leaves them writing into the build directory after the lock is released. On POSIX the child
   * leads its own process group (spawned `detached`), which is killed whole; on Windows
   * `taskkill /T` kills the tree. The result then has `aborted: true`.
   */
  signal?: AbortSignal;
  /** Called with each piece of stdout and stderr as it arrives (decoded as UTF-8, best-effort). */
  onOutput?: (text: string) => void;
}

/** Kill a child and, when it leads a process group (POSIX) or has children (Windows), them too. */
function killTree(pid: number | undefined, group: boolean): void {
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }).on(
        'error',
        () => {},
      );
    } else {
      process.kill(group ? -pid : pid, 'SIGKILL');
    }
  } catch {
    /* already gone */
  }
}

export interface ExecBytesResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
  /** Set when `signal` aborted the run (and killed its process tree). */
  aborted?: boolean;
}

/**
 * Spawn a command and capture its output. Rejects only when the binary cannot be
 * spawned (e.g. not found); a non-zero exit code resolves normally so callers can
 * inspect `code`. Kills the process on timeout. `windowsHide` avoids console flashes.
 *
 * Defined in terms of {@link execCaptureBytes}: stdout is accumulated as raw bytes across
 * chunks and decoded as UTF-8 only once, at the end, so a multi-byte character split across
 * two `data` events (a real possibility with a pipe) decodes correctly instead of each half
 * being replaced with U+FFFD.
 */
export async function execCapture(
  cmd: string,
  args: string[],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  const res = await execCaptureBytes(cmd, args, opts);
  return { ...res, stdout: res.stdout.toString('utf8') };
}

/**
 * Like `execCapture`, except stdout is captured as raw bytes (`Buffer.concat` over the
 * chunks) rather than decoded with `.toString()`. `execCapture` decodes the fully
 * concatenated buffer as UTF-8, which is fine for text (git plumbing output, log lines);
 * this is the primitive to reach for when the output may not be valid UTF-8 at all (a PNG
 * read out of `git show`/`git cat-file`), since decoding *any* prefix of such bytes as text
 * is lossy. stderr is still a string (collected as bytes and decoded once, as stdout is in
 * `execCapture`), and the spawn/timeout/reject-only-on-spawn-failure
 * behaviour is identical to `execCapture` — `execCapture` is now defined in terms of this.
 */
export function execCaptureBytes(
  cmd: string,
  args: string[],
  opts: ExecOptions = {},
): Promise<ExecBytesResult> {
  return new Promise((resolve, reject) => {
    // Its own process group only when it may have to be killed whole: everything else keeps the
    // spawn it always had.
    const group = opts.signal !== undefined && process.platform !== 'win32';
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      windowsHide: true,
      ...(group ? { detached: true } : {}),
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let aborted = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          if (group) killTree(child.pid, true);
          else child.kill('SIGKILL');
        }, opts.timeoutMs)
      : undefined;
    const onAbort = (): void => {
      aborted = true;
      killTree(child.pid, group);
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (d: Buffer) => {
      stdoutChunks.push(d);
      opts.onOutput?.(d.toString('utf8'));
    });
    // Accumulated as bytes and decoded once at the end, like stdout: decoding each chunk on its
    // own turns a multi-byte character split across two `data` events into two U+FFFD — and
    // `PathBeyondSymlinkError` rebuilds a path out of git's stderr. (`onOutput` gets a per-chunk
    // decode, good enough for progress lines.)
    child.stderr.on('data', (d: Buffer) => {
      stderrChunks.push(d);
      opts.onOutput?.(d.toString('utf8'));
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        timedOut,
        ...(aborted ? { aborted } : {}),
      });
    });

    if (opts.input !== undefined) {
      // Swallow EPIPE if the child never reads (e.g. failed to spawn).
      child.stdin.on('error', () => {});
      child.stdin.write(opts.input);
      child.stdin.end();
    }
  });
}
