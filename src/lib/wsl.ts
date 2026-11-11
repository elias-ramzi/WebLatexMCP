import { readFileSync } from 'node:fs';

/**
 * Whether this Linux process runs under WSL. Opening a browser and storing a credential both differ
 * there: `xdg-open` is usually missing or has no browser behind it, while Windows' own browser and
 * Credential Manager are reachable through interop. Never throws.
 */
export function isWsl(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  readOsRelease: () => string = () => readFileSync('/proc/sys/kernel/osrelease', 'utf8'),
): boolean {
  if (platform !== 'linux') return false;
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  try {
    return /microsoft|wsl/i.test(readOsRelease());
  } catch {
    return false;
  }
}
