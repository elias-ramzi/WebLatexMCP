import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { resolveWorkspace, quoteEnvValue } from '../config.js';
import { openBrowser } from '../lib/openBrowser.js';
import { ChatManager, packageRoot } from './chatEngine.js';
import { ChatStore } from './chatStore.js';
import { DaemonClient } from './daemonClient.js';
import { PaperMetaStore } from './paperMeta.js';
import { readUiInfo, removeUiInfo, writeUiInfo } from './uiFiles.js';
import { UiServer } from './uiServer.js';

/**
 * `web-latex-mcp ui [--port <n>] [--no-open] [--to <workspace>]`: the web UI — papers in a
 * sidebar, a Claude chat and the live viewer side by side (docs/ui.md). Runs in the foreground
 * until Ctrl+C. A second launch on the same workspace opens the running one's page instead.
 */

export const UI_USAGE =
  '  npx web-latex-mcp ui [--port <n>] [--no-open] [--to <workspace>]\n' +
  '      the web UI: your papers, a Claude chat beside the live PDF (needs\n' +
  '      @anthropic-ai/claude-agent-sdk for the chat); Ctrl+C stops it\n';

export interface UiIo {
  env: NodeJS.ProcessEnv;
  cwd: string;
  out: (text: string) => void;
  err: (text: string) => void;
}

interface UiArgs {
  port: number;
  open: boolean;
  to?: string;
}

export function parseUiArgs(args: string[]): UiArgs | string {
  const out: UiArgs = { port: 0, open: true };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--no-open') out.open = false;
    else if (arg === '--open') out.open = true;
    else if (arg === '--port' || arg === '--to') {
      const v = args[++i];
      if (v === undefined) return `${arg} needs a value.`;
      if (arg === '--to') out.to = v;
      else {
        const n = /^\d{1,5}$/.test(v) ? Number(v) : NaN;
        if (!Number.isInteger(n) || n < 1 || n > 65535) {
          return `--port ${quoteEnvValue(v)} is not a port (1-65535).`;
        }
        out.port = n;
      }
    } else return `Unknown argument to ui: ${quoteEnvValue(arg ?? '')}.`;
  }
  return out;
}

export function pageUrl(port: number, token: string): string {
  return `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;
}

/**
 * The Agent SDK warns, on every start, that `allowedTools` lets the web-latex-mcp tools through
 * without `canUseTool`: that is the intent (they keep to the server's sandbox). Every other warning
 * is printed as before.
 */
function quietSdkWarning(): void {
  const emit = process.emitWarning.bind(process) as (...args: unknown[]) => void;
  process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
    const opts = rest[0];
    const code =
      typeof opts === 'object' && opts !== null
        ? (opts as { code?: unknown }).code
        : typeof rest[1] === 'string'
          ? rest[1]
          : (warning as { code?: unknown } | undefined)?.code;
    if (code === 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED') return;
    emit(warning, ...rest);
  }) as typeof process.emitWarning;
}

export async function runUi(args: string[], io: UiIo): Promise<number> {
  const parsed = parseUiArgs(args);
  if (typeof parsed === 'string') {
    io.err(`web-latex-mcp ui: ${parsed}\n`);
    return 2;
  }
  let workspaceRoot: string;
  try {
    workspaceRoot = parsed.to
      ? path.resolve(io.cwd, parsed.to)
      : resolveWorkspace(io.env.WEB_LATEX_MCP_WORKSPACE, io.cwd);
  } catch (err) {
    io.err(`web-latex-mcp ui: ${(err as Error).message}\n`);
    return 1;
  }

  const running = await readUiInfo(workspaceRoot);
  if (running) {
    const url = pageUrl(running.port, running.token);
    io.out(`The UI already runs (pid ${running.pid}): ${url}\n`);
    if (parsed.open) await openBrowser(url);
    return 0;
  }

  quietSdkWarning();
  const daemon = new DaemonClient({ workspaceRoot, env: io.env, cwd: io.cwd });
  try {
    await daemon.daemon();
  } catch (err) {
    io.err(`web-latex-mcp ui: the shared server could not be reached: ${(err as Error).message}\n`);
    return 1;
  }
  const token = randomBytes(24).toString('base64url');
  const holder: { server?: UiServer } = {};
  const chats = new ChatManager({
    workspaceRoot,
    store: new ChatStore(workspaceRoot),
    endpoint: () => daemon.endpoint(),
    paperDir: (paper) => holder.server?.paperDir(paper) ?? Promise.resolve(undefined),
  });
  const server = new UiServer({
    token,
    staticDir: path.join(packageRoot(), 'ui'),
    backend: daemon,
    papers: new PaperMetaStore(workspaceRoot),
    chats,
    workspaceRoot,
  });
  holder.server = server;
  let port: number;
  try {
    port = await server.start(parsed.port);
  } catch (err) {
    io.err(`web-latex-mcp ui: could not listen: ${(err as Error).message}\n`);
    await daemon.close();
    return 1;
  }
  await writeUiInfo(workspaceRoot, {
    pid: process.pid,
    port,
    token,
    startedAt: new Date().toISOString(),
  });
  const url = pageUrl(port, token);
  io.out(`WebLatexMCP UI: ${url}\n(Ctrl+C stops it)\n`);
  const sdkProblem = await chats.unavailable();
  if (sdkProblem) io.err(`web-latex-mcp ui: the chat is off: ${sdkProblem}\n`);
  if (parsed.open) await openBrowser(url);

  await new Promise<void>((resolve) => {
    const stop = (): void => resolve();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    process.once('SIGHUP', stop);
  });
  chats.stopAll();
  await server.close();
  await daemon.close();
  await removeUiInfo(workspaceRoot);
  return 0;
}
