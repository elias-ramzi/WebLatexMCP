import { execCapture } from './exec.js';
import { isWsl } from './wsl.js';

/**
 * A URL `cmd.exe /c start` can be given safely: cmd parses its command line, so `&`, `^`, `%`, `|`
 * or a quote in the URL would run as syntax. Every URL this server opens is its own loopback page
 * (`http://127.0.0.1:<port>/<hex nonce>`), which this admits; anything else skips the cmd route.
 */
const CMD_SAFE_URL = /^https?:\/\/[A-Za-z0-9.:/_~-]+$/;

export interface OpenBrowserDeps {
  platform?: NodeJS.Platform;
  wsl?: boolean;
  exec?: typeof execCapture;
}

/** The launch commands to try, in order, until one exits 0. */
export function browserCommands(
  url: string,
  platform: NodeJS.Platform,
  wsl: boolean,
): Array<{ cmd: string; args: string[] }> {
  if (platform === 'darwin') return [{ cmd: 'open', args: [url] }];
  if (platform === 'win32') return [{ cmd: 'cmd', args: ['/c', 'start', '', url] }];
  if (!wsl) return [{ cmd: 'xdg-open', args: [url] }];
  // WSL: the user's browser is the Windows one. `wslview` (wslu) hands the URL over without a
  // shell; `cmd.exe` through interop is always there. `xdg-open` last — it is often missing, or
  // opens nothing because no Linux browser is installed. WSL2 forwards 127.0.0.1 to Windows.
  const cmds = [{ cmd: 'wslview', args: [url] }];
  if (CMD_SAFE_URL.test(url)) cmds.push({ cmd: 'cmd.exe', args: ['/c', 'start', '', url] });
  cmds.push({ cmd: 'xdg-open', args: [url] });
  return cmds;
}

/**
 * Best-effort "open this URL in the user's default browser", cross-platform (WSL included).
 * Returns whether a launch command succeeded — callers treat failure as non-fatal (the URL is
 * always also returned for the user to open manually). Never throws.
 */
export async function openBrowser(url: string, deps: OpenBrowserDeps = {}): Promise<boolean> {
  const platform = deps.platform ?? process.platform;
  const wsl = deps.wsl ?? isWsl(process.env, platform);
  const exec = deps.exec ?? execCapture;
  for (const { cmd, args } of browserCommands(url, platform, wsl)) {
    try {
      const res = await exec(cmd, args, { timeoutMs: 5000 });
      if (res.code === 0) return true;
    } catch {
      // Not installed — try the next one.
    }
  }
  return false;
}
