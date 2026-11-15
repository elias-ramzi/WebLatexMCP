import path from 'node:path';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolveWorkspace, quoteEnvValue } from '../config.js';
import { openBrowser } from '../lib/openBrowser.js';
import { ChatManager, packageRoot } from './chatEngine.js';
import { ChatStore } from './chatStore.js';
import { DaemonClient } from './daemonClient.js';
import { PaperMetaStore } from './paperMeta.js';
import { readUiInfo, removeUiInfo, writeUiInfo } from './uiFiles.js';
import { UiServer, type UiDevState } from './uiServer.js';
import {
  CHILD_ENV,
  DevReloader,
  devSystemPrompt,
  ERROR_ENV,
  findDevRepo,
  liveStep,
  RELOAD_EXIT,
  sourceRev,
  superviseUi,
  SUPERVISOR_ENV,
  TOKEN_ENV,
  WATCH_ENV,
} from './devMode.js';
import {
  buildEntry,
  defaultLiveDir,
  goodDir,
  keepBuild,
  LIVE_BRANCH,
  liveStatus,
  liveSystemPrompt,
  prepareLive,
  type LiveStatus,
} from './liveMode.js';

/**
 * `web-latex-mcp ui [--port <n>] [--no-open] [--to <workspace>] [--dev [--repo <dir>] [--live
 * [<dir>]]]`: the web
 * UI — papers in a sidebar, a Claude chat and the live viewer side by side (docs/ui.md). Runs in
 * the foreground until Ctrl+C. A second launch on the same workspace opens the running one's page
 * instead. `--dev` runs it under a supervisor that restarts it on each new build, with a chat
 * that changes WebLatexMCP itself (`devMode.ts`); with `--live`, the UI runs from a worktree that chat
 * edits in place, shipped as one pull request when the user says so (`liveMode.ts`).
 */

export const UI_USAGE =
  '  npx web-latex-mcp ui [--port <n>] [--no-open] [--to <workspace>]\n' +
  '                     [--dev [--repo <dir>] [--live [<dir>]]]\n' +
  '      the web UI: your papers, a Claude chat beside the live PDF (needs\n' +
  '      @anthropic-ai/claude-agent-sdk for the chat); Ctrl+C stops it. --dev: it\n' +
  '      restarts on each new build, and "Improve WebLatexMCP" changes it.\n' +
  '      --live: it runs from a worktree that chat edits in place, shipped on demand\n';

export interface UiIo {
  env: NodeJS.ProcessEnv;
  cwd: string;
  out: (text: string) => void;
  err: (text: string) => void;
  /** The CLI's path as started (default `process.argv[1]`): what `--dev` starts again. */
  entry?: string;
}

interface UiArgs {
  port: number;
  open: boolean;
  to?: string;
  dev: boolean;
  repo?: string;
  /** `--live [<dir>]`: `''` when no folder is named (the default one). */
  live?: string;
}

export function parseUiArgs(args: string[]): UiArgs | string {
  const out: UiArgs = { port: 0, open: true, dev: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--no-open') out.open = false;
    else if (arg === '--open') out.open = true;
    else if (arg === '--dev') out.dev = true;
    else if (arg === '--live') {
      const v = args[i + 1];
      out.live = v !== undefined && !v.startsWith('-') ? (i++, v) : '';
    }
    else if (arg === '--port' || arg === '--to' || arg === '--repo') {
      const v = args[++i];
      if (v === undefined) return `${arg} needs a value.`;
      if (arg === '--to') out.to = v;
      else if (arg === '--repo') out.repo = v;
      else {
        const n = /^\d{1,5}$/.test(v) ? Number(v) : NaN;
        if (!Number.isInteger(n) || n < 1 || n > 65535) {
          return `--port ${quoteEnvValue(v)} is not a port (1-65535).`;
        }
        out.port = n;
      }
    } else return `Unknown argument to ui: ${quoteEnvValue(arg ?? '')}.`;
  }
  if (out.repo !== undefined && !out.dev) return '--repo goes with --dev.';
  if (out.live !== undefined && !out.dev) return '--live goes with --dev.';
  return out;
}

/** The arguments a live-mode child gets: the checkout and the worktree, as found by its supervisor. */
export function liveChildArgs(args: string[], repo: string, dir: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '--repo') i++;
    else if (arg === '--live') {
      const v = args[i + 1];
      if (v !== undefined && !v.startsWith('-')) i++;
    } else if (arg !== '--open' && arg !== '--no-open') out.push(arg);
  }
  return [...out, '--repo', repo, '--live', dir];
}

/** `liveStatus` at most every few seconds: the page asks for the state often. */
function cachedLiveStatus(dir: string, everyMs = 3000): () => Promise<LiveStatus> {
  let last: { at: number; status: Promise<LiveStatus> } | undefined;
  return () => {
    if (!last || Date.now() - last.at > everyMs) {
      last = {
        at: Date.now(),
        status: liveStatus(dir).catch((err: unknown) => ({
          dir,
          branch: '',
          ahead: 0,
          changed: 0,
          problem: (err as Error).message,
        })),
      };
    }
    return last.status;
  };
}

/**
 * `ui --dev --live`: make the live worktree ready, then supervise the UI run from it, keeping a
 * copy of each build that starts for a broken one to fall back to.
 */
async function superviseLive(
  parsed: UiArgs,
  workspaceRoot: string,
  args: string[],
  io: UiIo,
): Promise<number> {
  const found = findDevRepo({ given: parsed.repo, env: io.env, cwd: io.cwd, root: packageRoot() });
  if (!found.repo) {
    io.err(`web-latex-mcp ui: --live needs the WebLatexMCP checkout: ${found.problem ?? ''}\n`);
    return 1;
  }
  const repo = found.repo;
  const dir = parsed.live ? path.resolve(io.cwd, parsed.live) : defaultLiveDir(repo);
  let entry: string;
  try {
    entry = await prepareLive({ repo, dir, log: io.err });
  } catch (err) {
    io.err(`web-latex-mcp ui: the live worktree is not ready: ${(err as Error).message}\n`);
    return 1;
  }
  const good = goodDir(workspaceRoot);
  const kept = buildEntry(good);
  io.out(`Live mode: the UI runs from ${dir} (branch ${LIVE_BRANCH}).\n`);
  return superviseUi(
    {
      entry,
      args: liveChildArgs(args, repo, dir),
      open: parsed.open,
      keep: () => keepBuild(dir, good),
      ...(existsSync(kept) ? { lastGood: kept } : {}),
    },
    io,
  );
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

  // `--dev`: this process supervises; the UI itself runs in a child it restarts on each build.
  const child = io.env[CHILD_ENV] === '1';
  if (parsed.dev && !child) {
    const running = await readUiInfo(workspaceRoot);
    if (running) {
      io.err(
        `web-latex-mcp ui: a UI already runs on this workspace (pid ${running.pid}): stop it ` +
          'first, then start it again with --dev.\n',
      );
      return 1;
    }
    if (parsed.live !== undefined) return superviseLive(parsed, workspaceRoot, args, io);
    const entry = io.entry ?? process.argv[1];
    if (!entry) {
      io.err('web-latex-mcp ui: --dev cannot tell which file started it.\n');
      return 1;
    }
    return superviseUi(
      {
        entry,
        // the child keeps --dev (and --repo): it knows it is the child from CHILD_ENV
        args: args.filter((a) => a !== '--open' && a !== '--no-open'),
        open: parsed.open,
      },
      io,
    );
  }

  const running = child ? undefined : await readUiInfo(workspaceRoot);
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
  // A dev child keeps its supervisor's token across restarts; no Claude it starts inherits it.
  const given = child ? io.env[TOKEN_ENV] : undefined;
  delete process.env[TOKEN_ENV];
  const token = given || randomBytes(24).toString('base64url');
  const watch = child ? io.env[WATCH_ENV] : undefined;
  const found = child
    ? findDevRepo({ given: parsed.repo, env: io.env, cwd: io.cwd, root: packageRoot() })
    : {};
  // live mode: the dev chat works in the worktree the UI runs from
  const liveDir =
    found.repo && parsed.live !== undefined && parsed.live !== ''
      ? path.resolve(io.cwd, parsed.live)
      : undefined;
  const holder: { server?: UiServer; reloader?: DevReloader } = {};
  const chats = new ChatManager({
    workspaceRoot,
    store: new ChatStore(workspaceRoot),
    endpoint: () => daemon.endpoint(),
    paperDir: (paper) => holder.server?.paperDir(paper) ?? Promise.resolve(undefined),
    ...(found.repo
      ? {
          dev: liveDir
            ? { repo: liveDir, prompt: liveSystemPrompt(found.repo, liveDir) }
            : {
                repo: found.repo,
                prompt: devSystemPrompt(found.repo, liveStep(found.repo, packageRoot(), io.env)),
              },
        }
      : {}),
  });
  const dev: UiDevState | undefined = child
    ? {
        ...(found.repo ? { repo: found.repo } : {}),
        ...(found.problem ? { problem: found.problem } : {}),
        ...(io.env[ERROR_ENV] ? { error: io.env[ERROR_ENV] } : {}),
        pending: () => holder.reloader?.pending ?? false,
        ...(liveDir ? { live: cachedLiveStatus(liveDir) } : {}),
      }
    : undefined;
  const server = new UiServer({
    token,
    staticDir: path.join(packageRoot(), 'ui'),
    backend: daemon,
    papers: new PaperMetaStore(workspaceRoot),
    chats,
    workspaceRoot,
    rev: sourceRev(watch ?? fileURLToPath(new URL('../index.js', import.meta.url))),
    ...(dev ? { dev } : {}),
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
  const supervisor = Number(io.env[SUPERVISOR_ENV]);
  // a dev child names its supervisor: stopping that one stops the UI for good
  const infoPid = child && Number.isInteger(supervisor) && supervisor > 0 ? supervisor : process.pid;
  await writeUiInfo(workspaceRoot, {
    pid: infoPid,
    port,
    token,
    startedAt: new Date().toISOString(),
  });
  const url = pageUrl(port, token);
  io.out(`WebLatexMCP UI: ${url}\n(Ctrl+C stops it)\n`);
  if (child) {
    io.out(
      found.repo
        ? `Dev mode: it restarts on each new build; "Improve WebLatexMCP" works in ${found.repo}.\n`
        : `Dev mode: it restarts on each new build. The dev chat is off: ${found.problem}\n`,
    );
    process.send?.({ ready: port });
  }
  const sdkProblem = await chats.unavailable();
  if (sdkProblem) io.err(`web-latex-mcp ui: the chat is off: ${sdkProblem}\n`);
  if (parsed.open) await openBrowser(url);

  const reason = await new Promise<'stop' | 'reload'>((resolve) => {
    const stop = (): void => resolve('stop');
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    process.once('SIGHUP', stop);
    if (child && watch) {
      holder.reloader = new DevReloader(
        watch,
        () => chats.active(),
        () => resolve('reload'),
      );
      holder.reloader.start();
    }
  });
  holder.reloader?.stop();
  chats.stopAll();
  await server.close();
  await daemon.close();
  // On a reload the next child takes the same port and token: ui.json stays as it is.
  if (reason === 'stop') await removeUiInfo(workspaceRoot, infoPid);
  if (child) {
    // The Claude processes may take a while to go: the supervisor waits for this one to end.
    setTimeout(() => process.exit(reason === 'reload' ? RELOAD_EXIT : 0), 1500).unref();
  }
  return reason === 'reload' ? RELOAD_EXIT : 0;
}
