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
 */
export function execCapture(
  cmd: string,
  args: string[],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, opts.timeoutMs)
      : undefined;

    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });

    if (opts.input !== undefined) {
      // Swallow EPIPE if the child never reads (e.g. failed to spawn).
      child.stdin.on('error', () => {});
      child.stdin.write(opts.input);
      child.stdin.end();
    }
  });
}

/**
 * Like `execCapture`, except stdout is captured as raw bytes (`Buffer.concat` over the
 * chunks) rather than decoded with `.toString()`. `execCapture` accumulates stdout via
 * `stdout += d.toString()`, which replaces every invalid UTF-8 byte sequence with U+FFFD —
 * fine for text (git plumbing output, log lines) but silently corrupts binary content such
 * as a PNG read out of `git show`/`git cat-file`. Use this whenever the output may not be
 * valid UTF-8. stderr is still a string, and the spawn/timeout/reject-only-on-spawn-failure
 * behaviour is identical to `execCapture`.
 */
export function execCaptureBytes(
  cmd: string,
  args: string[],
  opts: ExecOptions = {},
): Promise<ExecBytesResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, windowsHide: true });
    const stdoutChunks: Buffer[] = [];
    let stderr = '';
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
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(stdoutChunks), stderr, timedOut });
    });

    if (opts.input !== undefined) {
      // Swallow EPIPE if the child never reads (e.g. failed to spawn).
      child.stdin.on('error', () => {});
      child.stdin.write(opts.input);
      child.stdin.end();
    }
  });
}
