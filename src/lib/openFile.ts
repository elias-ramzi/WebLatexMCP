import path from 'node:path';
import { execCapture } from './exec.js';

/** The variable the Windows launcher reads the path from, so the path is never on a command line. */
export const OPEN_PATH_ENV = 'WEB_LATEX_MCP_OPEN_PATH';

/**
 * The fixed PowerShell command the win32 launcher runs. `Invoke-Item` opens an item with its
 * associated handler (what `start` does), and `-LiteralPath` takes the path verbatim — no wildcard
 * reading of `[1]` or `*`. (`Start-Process` has no `-LiteralPath` at all: binding fails with
 * `NamedParameterNotFound`, so every launch failed.) The path itself arrives through
 * {@link OPEN_PATH_ENV}, which PowerShell reads as a value and never parses.
 */
export const WIN32_OPEN_COMMAND = `Invoke-Item -LiteralPath $env:${OPEN_PATH_ENV} -ErrorAction Stop`;

/** A drive letter, a colon and a separator: the only system-root shape accepted. */
const DRIVE_ROOT = /^[A-Za-z]:[\\/]/;

/**
 * Windows PowerShell by absolute path under the system root, never a bare `powershell.exe`: libuv
 * on Windows searches the current directory before `PATH`, so a bare name would run a
 * `powershell.exe` planted in the server's cwd. The root is the first of `SystemRoot`, `windir`
 * that is a drive-qualified absolute path with no surrounding whitespace ({@link DRIVE_ROOT}: so
 * not `''`, `Windows`, `C:`, `C:foo`, `\Windows`, `\\srv\share`, `\\?\C:\…` or `C:\Windows `),
 * else `C:\Windows`. `path.win32.isAbsolute` alone accepts a current-drive-rooted, UNC or device
 * path, which would run PowerShell from the cwd's drive, a network share or the device namespace.
 */
export function win32PowerShellPath(env: NodeJS.ProcessEnv = process.env): string {
  const root = [env.SystemRoot, env.windir].find(
    (candidate): candidate is string =>
      !!candidate && DRIVE_ROOT.test(candidate) && candidate === candidate.trim(),
  );
  return path.win32.join(
    root ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
}

/**
 * Best-effort "open this file with the OS default handler", cross-platform. Returns whether the
 * launch command exited 0 — callers treat failure as non-fatal (the path is always also returned
 * for the user to open by hand). Never throws.
 *
 * Unlike `openBrowser`, whose callers pass server-built loopback URLs, this takes a
 * filesystem path that may hold any character, so on win32 the path never appears in a command
 * line: `cmd /c start "" <path>` lets cmd split a path at `&`, drop `^` and expand `%VAR%`
 * (libuv quotes an argument only for spaces, tabs and `"`). Instead PowerShell, spawned by
 * absolute path ({@link win32PowerShellPath}), runs the fixed {@link WIN32_OPEN_COMMAND}
 * (`Invoke-Item -LiteralPath`, no wildcard expansion) over a variable in the child's environment,
 * which neither cmd nor PowerShell parses. On darwin (`open`) and elsewhere (`xdg-open`) no shell
 * is involved. A path that is not absolute for the target platform is refused without spawning
 * anything, so nothing beginning with `-` can be read as an option.
 *
 * `platform`, `run` and `env` (where the system root is read from) are injectable only so tests
 * can check the command on every OS.
 */
export async function openFile(
  filePath: string,
  deps: { platform?: NodeJS.Platform; run?: typeof execCapture; env?: NodeJS.ProcessEnv } = {},
): Promise<boolean> {
  const platform = deps.platform ?? process.platform;
  const run = deps.run ?? execCapture;
  const env = deps.env ?? process.env;
  const absolute = platform === 'win32' ? path.win32.isAbsolute : path.posix.isAbsolute;
  if (!absolute(filePath)) return false;
  try {
    const res =
      platform === 'win32'
        ? await run(
            win32PowerShellPath(env),
            ['-NoProfile', '-NonInteractive', '-Command', WIN32_OPEN_COMMAND],
            // `execCapture` hands `env` to `spawn` as is, which replaces the environment.
            { timeoutMs: 10_000, env: { ...env, [OPEN_PATH_ENV]: filePath } },
          )
        : await run(platform === 'darwin' ? 'open' : 'xdg-open', [filePath], { timeoutMs: 5000 });
    return res.code === 0;
  } catch {
    return false;
  }
}
