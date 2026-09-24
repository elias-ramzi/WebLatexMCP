import { spawn } from 'node:child_process';

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
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
}

export interface ExecBytesResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
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
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, windowsHide: true });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, opts.timeoutMs)
      : undefined;

    child.stdout.on('data', (d: Buffer) => {
      stdoutChunks.push(d);
    });
    // Accumulated as bytes and decoded once at the end, like stdout: decoding each chunk on its
    // own turns a multi-byte character split across two `data` events into two U+FFFD — and
    // `PathBeyondSymlinkError` rebuilds a path out of git's stderr.
    child.stderr.on('data', (d: Buffer) => {
      stderrChunks.push(d);
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        timedOut,
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
