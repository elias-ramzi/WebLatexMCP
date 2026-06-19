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
  /** Written to the child's stdin, which is then closed (e.g. for `git credential fill`). */
  input?: string;
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
