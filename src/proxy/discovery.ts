import { spawn } from 'node:child_process';
import { openSync, closeSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { compareVersions } from '../lib/buildId.js';
import {
  daemonDir,
  ensureDaemonDir,
  readDaemonInfo,
  type DaemonInfo,
} from '../daemon/daemonFiles.js';

/**
 * Finding, judging and starting the daemon a proxy relays to (docs/design/shared-server.md §9).
 */

/** What `/health` answers. */
export interface DaemonHealth {
  version: string;
  buildId: string;
  processNonce: string;
  pid: number;
  sessions: number;
  keepAlive: boolean;
  replaceRequested: boolean;
}

export interface FoundDaemon {
  info: DaemonInfo;
  health: DaemonHealth;
}

/** Log rotated past this size before each auto-start. */
export const DAEMON_LOG_MAX_BYTES = 10 * 1024 * 1024;
/** How long an auto-start waits for the daemon to answer. */
export const AUTOSTART_WAIT_MS = 10_000;
/** After the spawned daemon exited, how long to keep waiting for another one (the race winner). */
const EXITED_GRACE_MS = 3000;

export function daemonLogPath(workspaceRoot: string): string {
  return path.join(daemonDir(workspaceRoot), 'daemon.log');
}

/**
 * The daemon `daemon.json` names, when its pid runs and it answers `/health` with that file's
 * token and nonce. `undefined` for anything else: no file, a dead pid, no answer, another process
 * on the port.
 */
export async function findDaemon(
  workspaceRoot: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FoundDaemon | undefined> {
  const info = await readDaemonInfo(workspaceRoot);
  if (!info) return undefined;
  try {
    process.kill(info.pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') return undefined;
  }
  try {
    const res = await fetchImpl(`http://127.0.0.1:${info.port}/health`, {
      headers: { authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return undefined;
    const health = (await res.json()) as DaemonHealth;
    if (health.processNonce !== info.processNonce) return undefined;
    return { info, health };
  } catch {
    return undefined;
  }
}

/**
 * What a proxy of build `mine` does with a running daemon (§9.2, build ids from `currentBuildId`):
 * - `connect`: the same build; the same version from another install (Claude Desktop's bundle and
 *   an npx install must share one daemon, not evict each other); or a newer daemon, which stays
 *   compatible with older clients;
 * - `replace-now`: a newer version, or this very entry rebuilt in place (same path, other mtime —
 *   a launcher building `main` into one directory), and nobody uses the daemon — stop it and start
 *   this build;
 * - `connect-and-replace`: the same, but sessions are open — connect, and ask the daemon to stop
 *   once its last session closes, so the next proxy starts this build.
 * A keep-alive daemon belongs to a service manager, which would only restart its own build:
 * always `connect`.
 */
export type BuildDecision = 'connect' | 'replace-now' | 'connect-and-replace';

export function decideBuild(mine: string, daemon: FoundDaemon): BuildDecision {
  const theirs = daemon.health.buildId || daemon.info.buildId;
  if (theirs === mine || daemon.health.keepAlive) return 'connect';
  const [myVersion = '', myEntry = ''] = mine.split('|');
  const [theirVersion = '', theirEntry = ''] = theirs.split('|');
  const order = compareVersions(myVersion, theirVersion || daemon.health.version);
  const newer = order > 0 || (order === 0 && myVersion === theirVersion && myEntry === theirEntry);
  if (!newer) return 'connect';
  return daemon.health.sessions === 0 ? 'replace-now' : 'connect-and-replace';
}

/**
 * Ask a daemon to stop; `force` stops it even with sessions open (the shell's `daemon stop`).
 * `stopping`, `busy` (sessions are open: 409), or `failed` (no answer, or another refusal).
 */
export async function shutdownDaemon(
  found: FoundDaemon,
  opts: { force?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<'stopping' | 'busy' | 'failed'> {
  try {
    const res = await (opts.fetchImpl ?? fetch)(
      `http://127.0.0.1:${found.info.port}/shutdown${opts.force ? '?force=1' : ''}`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${found.info.token}` },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (res.ok) return 'stopping';
    return res.status === 409 ? 'busy' : 'failed';
  } catch {
    return 'failed';
  }
}

/** Wait until no daemon answers for `workspaceRoot`, up to `timeoutMs`. */
export async function waitGone(workspaceRoot: string, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await findDaemon(workspaceRoot))) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/** Rename `daemon.log` to `daemon.log.1` once it passes `DAEMON_LOG_MAX_BYTES`. */
export function rotateDaemonLog(workspaceRoot: string, maxBytes = DAEMON_LOG_MAX_BYTES): void {
  const log = daemonLogPath(workspaceRoot);
  try {
    if (statSync(log).size > maxBytes) renameSync(log, `${log}.1`);
  } catch {
    // No log yet, or it cannot be rotated: appending to it is still fine.
  }
}

export interface AutostartOptions {
  workspaceRoot: string;
  env: NodeJS.ProcessEnv;
  /** The node binary and the arguments that run this build's entry (`[...execArgv, entry]`). */
  command?: { file: string; args: string[] };
  waitMs?: number;
}

/**
 * Start a daemon of this build in the background and wait until one answers (§9.1). Two proxies
 * starting at once both spawn; the daemon lock lets one win, the other exits, and both proxies find
 * the winner. Resolves to the daemon that answers, whichever process that is; throws with the
 * log's location when none does in time.
 */
export async function autostartDaemon(opts: AutostartOptions): Promise<FoundDaemon> {
  await ensureDaemonDir(opts.workspaceRoot);
  rotateDaemonLog(opts.workspaceRoot);
  const log = daemonLogPath(opts.workspaceRoot);
  const command = opts.command ?? {
    file: process.execPath,
    args: [...absoluteExecArgv(process.execArgv), process.argv[1] ?? ''],
  };
  const fd = openSync(log, 'a', 0o600);
  let exited: string | undefined;
  let exitedAt: number | undefined;
  try {
    const child = spawn(command.file, [...command.args, 'serve'], {
      detached: true,
      stdio: ['ignore', fd, fd],
      env: opts.env,
      // Not the client's directory: it would be held (undeletable on Windows) for the daemon's life.
      cwd: opts.workspaceRoot,
      windowsHide: true,
    });
    child.once('exit', (code, signal) => {
      exited = `exited (${signal ?? `code ${code}`})`;
      exitedAt = Date.now();
    });
    child.once('error', (err) => {
      exited = `could not start: ${err.message}`;
      exitedAt = Date.now();
    });
    child.unref();
  } finally {
    closeSync(fd);
  }
  const deadline = Date.now() + (opts.waitMs ?? AUTOSTART_WAIT_MS);
  while (Date.now() < deadline) {
    const found = await findDaemon(opts.workspaceRoot);
    if (found) return found;
    // A child that lost the lock race exits at once while the winner starts: wait a little for
    // the winner, but not the whole budget when nothing else is starting either.
    if (exitedAt !== undefined && Date.now() - exitedAt > EXITED_GRACE_MS) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    exited
      ? `the shared server did not start (it ${exited}); see ${log}`
      : `the shared server did not answer within ${Math.round((opts.waitMs ?? AUTOSTART_WAIT_MS) / 1000)} s; see ${log}`,
  );
}

/** Node options whose value names a module to load before the entry. */
const MODULE_FLAGS = new Set(['--import', '--loader', '--experimental-loader', '--require', '-r']);

/**
 * `execArgv` with each preloaded module (`--import tsx`, in development) made absolute. The daemon
 * runs in the workspace, not the client's directory, and node resolves a bare specifier there:
 * left as is, the daemon of a development build could not load its loader and would exit. A value
 * that cannot be resolved from this package is kept as given.
 */
export function absoluteExecArgv(execArgv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < execArgv.length; i++) {
    const arg = execArgv[i] as string;
    const eq = arg.indexOf('=');
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    if (!MODULE_FLAGS.has(flag)) {
      out.push(arg);
      continue;
    }
    const value = eq > 0 ? arg.slice(eq + 1) : execArgv[++i];
    if (value === undefined) {
      out.push(arg);
      continue;
    }
    out.push(flag, resolveModule(value));
  }
  return out;
}

function resolveModule(specifier: string): string {
  // Already a path or a URL: absolute paths and URLs stand; a relative one is the client's.
  if (/^[a-z][a-z0-9+.-]*:/i.test(specifier) && !/^[a-z]:[\\/]/i.test(specifier)) return specifier;
  if (path.isAbsolute(specifier)) return specifier;
  if (specifier.startsWith('.')) return path.resolve(specifier);
  try {
    return import.meta.resolve(specifier);
  } catch {
    return specifier;
  }
}
