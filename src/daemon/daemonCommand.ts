import { resolveWorkspace } from '../config.js';
import { quoteId } from '../lib/projectId.js';
import { credentialVarNames, daemonSpawnEnv } from '../proxy/clientEnv.js';
import { autostartDaemon, findDaemon, shutdownDaemon, waitGone } from '../proxy/discovery.js';
import { HEADER_DEFAULT_PROJECT, HEADER_SESSION } from './sessionHeaders.js';

/**
 * `web-latex-mcp daemon status | stop [--force] | restart [--force]`: manage the workspace's
 * shared server from a shell (docs/design/shared-server.md §4). Prints to stdout; never prints
 * the token.
 */

export const DAEMON_USAGE =
  '  npx web-latex-mcp daemon status | stop [--force] | restart [--force] | headers\n' +
  "      show, stop or restart the workspace's shared server; --force stops it even with\n" +
  '      sessions open; headers prints the JSON headers a direct HTTP client needs\n';

export async function runDaemonCommand(
  args: string[],
  io: { env: NodeJS.ProcessEnv; cwd: string; out: (t: string) => void; err: (t: string) => void },
): Promise<number> {
  const [action, ...rest] = args;
  const force = rest.includes('--force');
  const actions = ['status', 'stop', 'restart', 'headers'];
  if (!actions.includes(action ?? '') || rest.some((a) => a !== '--force')) {
    io.err(`Usage:\n${DAEMON_USAGE}`);
    return 2;
  }
  let workspace: string;
  try {
    workspace = resolveWorkspace(io.env.WEB_LATEX_MCP_WORKSPACE, io.cwd);
  } catch (err) {
    io.err(`web-latex-mcp: ${(err as Error).message}\n`);
    return 1;
  }
  const found = await findDaemon(workspace);

  if (action === 'headers') {
    // For a client connecting over HTTP directly (Claude Code's `headersHelper`): the bearer token,
    // read from daemon.json, and this client's session settings. The token is printed on purpose,
    // to stdout only, for the user who can already read daemon.json.
    if (!found) {
      io.err(
        `No shared server answers for ${quoteId(workspace)}; start one (\`serve --keep-alive\`).\n`,
      );
      return 1;
    }
    const headers: Record<string, string> = { Authorization: `Bearer ${found.info.token}` };
    const session = io.env.WEB_LATEX_MCP_SESSION?.trim();
    if (session) headers[HEADER_SESSION] = session;
    const project = io.env.WEB_LATEX_MCP_DEFAULT_PROJECT?.trim();
    if (project) headers[HEADER_DEFAULT_PROJECT] = project;
    io.out(`${JSON.stringify(headers)}\n`);
    return 0;
  }

  if (action === 'status') {
    if (!found) {
      io.out(`No shared server answers for ${quoteId(workspace)}.\n`);
      return 1;
    }
    const h = found.health;
    io.out(
      `Shared server for ${quoteId(workspace)}: pid ${h.pid}, 127.0.0.1:${found.info.port}, ` +
        `version ${h.version}, ${h.sessions} open session${h.sessions === 1 ? '' : 's'}` +
        `${h.keepAlive ? ', keep-alive' : ''}` +
        `${h.replaceRequested ? ', to be replaced by a newer build once idle' : ''}.\n`,
    );
    return 0;
  }

  if (found) {
    const asked = await shutdownDaemon(found, { force });
    if (asked !== 'stopping') {
      io.err(
        asked === 'busy'
          ? `The shared server has ${found.health.sessions} open session(s) and was left running; ` +
              'pass --force to stop it anyway.\n'
          : `The shared server (pid ${found.health.pid}) did not accept the request to stop.\n`,
      );
      return 1;
    }
    if (!(await waitGone(workspace))) {
      io.err(`The shared server (pid ${found.health.pid}) did not stop within 30 s.\n`);
      return 1;
    }
    io.out(`Stopped the shared server for ${quoteId(workspace)}.\n`);
  } else if (action === 'stop') {
    io.out(`No shared server answers for ${quoteId(workspace)}; nothing to stop.\n`);
    return 0;
  }
  if (action === 'restart') {
    try {
      const names = credentialVarNames(io.env, workspace);
      const started = await autostartDaemon({
        workspaceRoot: workspace,
        env: daemonSpawnEnv(io.env, workspace, names, io.cwd),
      });
      io.out(`Started the shared server: pid ${started.health.pid}, port ${started.info.port}.\n`);
    } catch (err) {
      io.err(`web-latex-mcp: ${(err as Error).message}\n`);
      return 1;
    }
  }
  return 0;
}
