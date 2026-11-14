import type { Readable, Writable } from 'node:stream';
import { resolveWorkspace } from '../config.js';
import { currentBuildId } from '../lib/buildId.js';
import { credentialVarNames, daemonSpawnEnv, sessionRequestHeaders } from './clientEnv.js';
import {
  autostartDaemon,
  decideBuild,
  findDaemon,
  shutdownDaemon,
  waitGone,
  type FoundDaemon,
} from './discovery.js';
import { runRelay, type Endpoint } from './relay.js';

/**
 * `web-latex-mcp` with no command: the stdio proxy (docs/design/shared-server.md §9). Finds the
 * workspace's daemon, applies the build rule, starts one when none answers, and relays.
 */

/** `--standalone`, or `WEB_LATEX_MCP_STANDALONE` set to a true value: serve in-process. */
export function standaloneRequested(argv: readonly string[], env: NodeJS.ProcessEnv): boolean {
  if (argv.includes('--standalone')) return true;
  return /^(1|true|yes|on)$/i.test(env.WEB_LATEX_MCP_STANDALONE?.trim() ?? '');
}

export interface ProxyIo {
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdin: Readable;
  stdout: Writable;
  log: (line: string) => void;
  /** Called with the function that ends the session (DELETE): wire SIGINT/SIGTERM/SIGHUP to it. */
  onStop?: (stop: () => void) => void;
  /** Test seams. */
  buildId?: string;
  autostart?: (workspaceRoot: string, env: NodeJS.ProcessEnv) => Promise<FoundDaemon>;
}

export type ProxyOutcome =
  /** The client closed stdin; the session ended on the daemon. */
  | { kind: 'relayed' }
  /** No daemon could be reached or started: nothing was read from stdin yet. */
  | { kind: 'unavailable'; reason: string }
  /** The daemon was lost mid-session and could not be restarted. */
  | { kind: 'failed'; reason: string };

const endpointOf = (found: FoundDaemon): Endpoint => ({
  url: `http://127.0.0.1:${found.info.port}/mcp`,
  token: found.info.token,
});

export async function runProxy(io: ProxyIo): Promise<ProxyOutcome> {
  // A config listing its projects in the environment keeps working exactly as before: the shared
  // server serves the central registry and ignores that list (Q2), so this client is served
  // in-process until its projects are imported.
  if (io.env.WEB_LATEX_MCP_PROJECTS?.trim()) {
    return {
      kind: 'unavailable',
      reason:
        'WEB_LATEX_MCP_PROJECTS is set, and the shared server does not read it; run ' +
        '`web-latex-mcp import-env-projects` once and remove it from this config to use the ' +
        'shared server',
    };
  }
  let workspaceRoot: string;
  try {
    workspaceRoot = resolveWorkspace(io.env.WEB_LATEX_MCP_WORKSPACE, io.cwd);
  } catch (err) {
    return { kind: 'unavailable', reason: (err as Error).message };
  }
  const credentialNames = credentialVarNames(io.env, workspaceRoot);
  const spawnEnv = daemonSpawnEnv(io.env, workspaceRoot, credentialNames, io.cwd);
  const start =
    io.autostart ??
    ((ws: string, env: NodeJS.ProcessEnv) => autostartDaemon({ workspaceRoot: ws, env }));
  const mine = io.buildId ?? currentBuildId();

  let found: FoundDaemon | undefined;
  let replaceWhenIdle = false;
  try {
    found = await findDaemon(workspaceRoot);
    if (found) {
      const decision = decideBuild(mine, found);
      if (decision === 'replace-now') {
        io.log(`replacing the shared server (build ${found.health.buildId}) with this build`);
        // Refused (409) if a session opened meanwhile: then connect, and ask it to make way.
        if (
          (await shutdownDaemon(found)) === 'stopping' &&
          (await waitGone(workspaceRoot, 5_000))
        ) {
          found = undefined;
        } else {
          replaceWhenIdle = true;
          found = await findDaemon(workspaceRoot);
        }
      } else if (decision === 'connect-and-replace') {
        replaceWhenIdle = true;
        io.log('the shared server runs another build; it is replaced once its sessions end');
      }
    }
    found ??= await start(workspaceRoot, spawnEnv);
  } catch (err) {
    return { kind: 'unavailable', reason: (err as Error).message };
  }

  try {
    await runRelay({
      stdin: io.stdin,
      stdout: io.stdout,
      headers: sessionRequestHeaders(io.env, credentialNames, { replaceWhenIdle }),
      endpoint: endpointOf(found),
      // After a loss: whatever answers now (another proxy may have restarted it), else start one.
      reconnect: async () => {
        found = (await findDaemon(workspaceRoot)) ?? (await start(workspaceRoot, spawnEnv));
        return endpointOf(found);
      },
      // The daemon relayed to now, by nonce: a different one answering means this one is gone.
      isAlive: async () => {
        const now = await findDaemon(workspaceRoot);
        return now !== undefined && now.info.processNonce === found?.info.processNonce;
      },
      log: io.log,
      ...(io.onStop ? { onStop: io.onStop } : {}),
    });
    return { kind: 'relayed' };
  } catch (err) {
    return { kind: 'failed', reason: (err as Error).message };
  }
}
