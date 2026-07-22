import { execCapture } from './exec.js';

/**
 * Best-effort "open this URL in the user's default browser", cross-platform. Returns whether the
 * launch command was spawned successfully — callers treat failure as non-fatal (the URL is always
 * also returned for the user to open manually). Never throws.
 */
export async function openBrowser(url: string): Promise<boolean> {
  const { cmd, args } =
    process.platform === 'darwin'
      ? { cmd: 'open', args: [url] }
      : process.platform === 'win32'
        ? { cmd: 'cmd', args: ['/c', 'start', '', url] }
        : { cmd: 'xdg-open', args: [url] };
  try {
    const res = await execCapture(cmd, args, { timeoutMs: 5000 });
    return res.code === 0;
  } catch {
    return false;
  }
}
