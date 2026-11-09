import { loadConfig, quoteEnvValue } from '../config.js';
import { CredentialResolver, loadIdentity } from '../services/auth.js';
import { ProjectRegistry } from '../services/projectRegistry.js';
import { startDaemon, type RunningDaemon } from './daemon.js';

/**
 * `web-latex-mcp serve [--keep-alive] [--port <n>]`: run the daemon in the foreground until it is
 * stopped (`/shutdown`, SIGINT/SIGTERM, or idleness unless `--keep-alive`). Logs go to stderr;
 * stdout stays empty. Returns the exit status.
 */

export const SERVE_USAGE =
  '  npx web-latex-mcp serve [--keep-alive] [--port <n>]\n' +
  '      run one shared server (Streamable HTTP on 127.0.0.1) for every session on the\n' +
  '      workspace; without --keep-alive it exits after 30 minutes with no open session\n';

export interface ServeArgs {
  keepAlive: boolean;
  port?: number;
}

/** Parse `serve`'s arguments; a string is the refusal. */
export function parseServeArgs(args: string[], env: NodeJS.ProcessEnv): ServeArgs | string {
  const out: ServeArgs = { keepAlive: false };
  let portText = env.WEB_LATEX_MCP_PORT?.trim() || undefined;
  let portSource = 'WEB_LATEX_MCP_PORT';
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--keep-alive') out.keepAlive = true;
    else if (arg === '--port') {
      portText = args[++i];
      portSource = '--port';
      if (portText === undefined) return '--port needs a value.';
    } else return `Unknown argument to serve: ${quoteEnvValue(arg ?? '')}.`;
  }
  if (portText !== undefined) {
    const n = /^\d{1,5}$/.test(portText) ? Number(portText) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      return `${portSource} ${quoteEnvValue(portText)} is not a port (1-65535).`;
    }
    out.port = n;
  }
  return out;
}

export async function runServe(
  args: string[],
  io: { env: NodeJS.ProcessEnv; err: (text: string) => void },
): Promise<number> {
  const parsed = parseServeArgs(args, io.env);
  if (typeof parsed === 'string') {
    io.err(`${parsed}\n\nUsage:\n${SERVE_USAGE}`);
    return 2;
  }
  process.env.GIT_TERMINAL_PROMPT ??= '0';
  process.env.GCM_INTERACTIVE ??= 'never';

  let daemon: RunningDaemon;
  try {
    const config = loadConfig(io.env);
    if (config.envProjectIds && config.envProjectIds.length > 0) {
      // A daemon serves every client; one client's env list would leak to the rest (Q2).
      io.err(
        '[web-latex-mcp] WEB_LATEX_MCP_PROJECTS is set in the daemon environment; those projects ' +
          'apply to every session. Prefer `web-latex-mcp import-env-projects` to register them.\n',
      );
    }
    daemon = await startDaemon({
      config,
      env: io.env,
      credentials: new CredentialResolver(io.env),
      identity: loadIdentity(io.env),
      registry: new ProjectRegistry(config.workspaceRoot),
      keepAlive: parsed.keepAlive,
      ...(parsed.port !== undefined ? { port: parsed.port } : {}),
    });
  } catch (err) {
    io.err(`web-latex-mcp serve: ${(err as Error).message}\n`);
    return 1;
  }
  const onSignal = (signal: string) => () => void daemon.stop(`${signal}`);
  process.once('SIGINT', onSignal('SIGINT'));
  process.once('SIGTERM', onSignal('SIGTERM'));
  await daemon.stopped;
  return 0;
}
