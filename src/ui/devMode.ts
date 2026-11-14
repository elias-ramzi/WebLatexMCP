import path from 'node:path';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';

/**
 * `web-latex-mcp ui --dev`, after cc-servers' dev mode (docs/ui.md): the UI restarts itself on a
 * new build, and an "Improve WebLatexMCP" chat lets Claude change WebLatexMCP from the page.
 *
 * - **A supervisor** (`superviseUi`, the process `ui --dev` starts) runs the UI as a child and
 *   starts it again whenever it exits with `RELOAD_EXIT`, on the same port with the same token,
 *   so open pages carry on (they reload themselves when `rev` changes). A new build that exits
 *   before it listens is not kept: the build that ran before is started again, with why in
 *   `ERROR_ENV` for the page.
 * - **The child** watches the build it was started from (`sourceRev` over `WATCH_ENV`, the path
 *   as given, links unresolved: the dev build's `current` link moves on each update) and exits
 *   with `RELOAD_EXIT` once it changed **and no chat is working** — a reload cuts every Claude,
 *   so it waits for the turns to end (the dev chat's own included: it is the one that updates).
 * - **The dev chat** (`DEV_CHAT`) is a chat like a paper's, run in the WebLatexMCP checkout
 *   (`findDevRepo`) with `devSystemPrompt`. Its key starts with a dot, which no project id may.
 */

/** The dev chat's key in the chat store and API (no project id starts with a dot). */
export const DEV_CHAT = '.dev';
/** The child's exit status that asks its supervisor for a restart (EX_TEMPFAIL). */
export const RELOAD_EXIT = 75;
/** Set by the supervisor in its child's environment. */
export const CHILD_ENV = 'WEB_LATEX_MCP_UI_DEV_CHILD';
export const TOKEN_ENV = 'WEB_LATEX_MCP_UI_TOKEN';
export const WATCH_ENV = 'WEB_LATEX_MCP_UI_DEV_WATCH';
export const ERROR_ENV = 'WEB_LATEX_MCP_UI_DEV_ERROR';
export const SUPERVISOR_ENV = 'WEB_LATEX_MCP_UI_SUPERVISOR';
/** The checkout the dev chat works in, when it is not found by itself. */
export const REPO_ENV = 'WEB_LATEX_MCP_DEV_REPO';

const MAX_WALK_FILES = 2000;

function newestMtime(dir: string, budget: { left: number }): number {
  let newest = 0;
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (budget.left-- <= 0) break;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) newest = Math.max(newest, newestMtime(p, budget));
    else if (e.isFile()) {
      try {
        newest = Math.max(newest, statSync(p).mtimeMs);
      } catch {
        // removed meanwhile
      }
    }
  }
  return newest;
}

/**
 * Which build `entry` (the CLI's path as started, links unresolved) runs now: the real path of the
 * entry and the newest file of the page (`ui/`) and of the UI's server (`dist/ui/`). It changes
 * when a dev update re-points `current`, and when a checkout is rebuilt in place.
 */
export function sourceRev(entry: string): string {
  let real = entry;
  try {
    real = realpathSync(entry);
  } catch {
    // gone: the path as given
  }
  const root = path.resolve(path.dirname(real), '..');
  const budget = { left: MAX_WALK_FILES };
  let newest = 0;
  try {
    newest = statSync(real).mtimeMs;
  } catch {
    // gone
  }
  newest = Math.max(newest, newestMtime(path.join(root, 'ui'), budget));
  newest = Math.max(newest, newestMtime(path.join(root, 'dist', 'ui'), budget));
  return `${real}@${Math.round(newest)}`;
}

/** Whether `dir` is a git checkout of WebLatexMCP (its package.json names web-latex-mcp). */
export function isWebLatexCheckout(dir: string): boolean {
  if (!existsSync(path.join(dir, '.git'))) return false;
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: unknown };
    return pkg.name === 'web-latex-mcp';
  } catch {
    return false;
  }
}

function checkoutAbove(start: string): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) return isWebLatexCheckout(dir) ? dir : undefined;
    const up = path.dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

/**
 * The WebLatexMCP checkout the dev chat works in: `--repo`, else `$WEB_LATEX_MCP_DEV_REPO`, else
 * the checkout the UI runs from, else the one the UI was started in. A path that was named but is
 * no checkout of WebLatexMCP is said, never replaced by a guess.
 */
export function findDevRepo(opts: {
  given?: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  root: string;
}): { repo?: string; problem?: string } {
  const named = opts.given ?? opts.env[REPO_ENV];
  if (named) {
    const dir = path.resolve(opts.cwd, named);
    return isWebLatexCheckout(dir)
      ? { repo: dir }
      : { problem: `${JSON.stringify(dir)} is not a git checkout of WebLatexMCP.` };
  }
  let realRoot = opts.root;
  try {
    realRoot = realpathSync(opts.root);
  } catch {
    // as given
  }
  const repo = checkoutAbove(realRoot) ?? checkoutAbove(opts.cwd);
  return repo
    ? { repo }
    : {
        problem:
          'No checkout of WebLatexMCP was found: start the UI inside one, or name it with ' +
          `--repo <dir> (or ${REPO_ENV}).`,
      };
}

function onPath(name: string, env: NodeJS.ProcessEnv): boolean {
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (dir && existsSync(path.join(dir, name))) return true;
  }
  return false;
}

/** How the dev chat makes a merged change live, for the build this UI runs from. */
export function liveStep(repo: string, root: string, env: NodeJS.ProcessEnv): string {
  let realRoot = root;
  try {
    realRoot = realpathSync(root);
  } catch {
    // as given
  }
  let realRepo = repo;
  try {
    realRepo = realpathSync(repo);
  } catch {
    // as given
  }
  const rel = path.relative(realRepo, realRoot);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    return (
      `The UI runs from ${repo} itself: bring it to the merged dev (\`git -C ${repo} pull ` +
      `--ff-only origin dev\`; if that checkout is on another branch or has local changes, say so ` +
      `and leave it alone), then \`npm --prefix ${repo} run build\`.`
    );
  }
  if (onPath('web-latex-mcp-dev-update', env)) {
    return 'Run `web-latex-mcp-dev-update`: it builds dev and switches the build the UI runs from.';
  }
  return (
    `The UI runs from ${realRoot}, a build this chat cannot update by itself: tell the user the ` +
    'change is merged and how to update that build.'
  );
}

/** What the dev chat's Claude is told, on top of Claude Code's own instructions. */
export function devSystemPrompt(repo: string, live: string): string {
  return `You are the developer of WebLatexMCP on this machine. The user talks to you from the small
"Improve WebLatexMCP" panel of its web UI (\`web-latex-mcp ui --dev\`), to change the UI, the viewer
or the server while they use them.

- The repository is ${repo} (GitHub: elias-ramzi/WebLatexMCP). Its CLAUDE.md holds the rules: read
  it. The UI is src/ui/* (its server) and ui/ (the page, vanilla JS, cc-servers' names and styles);
  the viewer is src/services/viewer.ts; docs/ui.md documents the UI.
- Work in your own git worktree, never in ${repo}'s own checkout: before your first edit, make one
  on a new branch off origin/dev (the EnterWorktree tool, or \`git -C ${repo} worktree add
  .claude/worktrees/<name> -b <branch> origin/dev\`).
- For each change: make it, update the tests, docs and CHANGELOG.md's [Unreleased] section, run the
  gate (\`npm run typecheck && npm run lint && npm run format:check && npm test\`), commit, push,
  open a pull request into dev, wait for its checks and merge it once they pass (\`gh pr merge
  --merge\`). A check that fails: fix it, push, wait again. Never push to main, never force-push.
- Then make it live. ${live} If the change touches the shared server (anything outside src/ui/
  and ui/), also run \`web-latex-mcp daemon restart --force\`.
- The UI starts again on the new build once no chat is working: this one included, so it happens
  when your turn ends, and the page reloads itself. A build that fails to start is not kept (the UI
  goes back to the one before and shows why), but test before you merge all the same.
- Never stop or kill the UI, its supervisor, the shared server's paper sessions or this session.
- Keep your replies short: the panel is small. Say what changed, the PR, and that it goes live
  when this turn ends.`;
}

/** Restart the UI when its build changes, once `busy()` says no chat is working. */
export class DevReloader {
  rev: string;
  pending = false;
  private timer: NodeJS.Timeout | undefined;
  private seen: string | undefined;

  constructor(
    private readonly entry: string,
    private readonly busy: () => boolean,
    private readonly reload: () => void,
    private readonly everyMs = 1000,
    private readonly revOf: (entry: string) => string = sourceRev,
  ) {
    this.rev = revOf(entry);
  }

  start(): void {
    this.timer = setInterval(() => this.check(), this.everyMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One look. A change counts once it reads the same twice (a build writes for a while). */
  check(): void {
    if (!this.pending) {
      const now = this.revOf(this.entry);
      if (now === this.rev) {
        this.seen = undefined;
        return;
      }
      if (this.seen !== now) {
        this.seen = now;
        return;
      }
      this.pending = true;
    }
    if (this.busy()) return;
    this.stop();
    this.reload();
  }
}

export interface SuperviseIo {
  env: NodeJS.ProcessEnv;
  out: (text: string) => void;
  err: (text: string) => void;
}

export interface SuperviseOptions {
  /** The CLI's path as started (links unresolved): each start runs what it points at then. */
  entry: string;
  /** The `ui` arguments, `--open` and `--no-open` taken out. */
  args: string[];
  open: boolean;
  /** Test seam: how a child is started. */
  spawnChild?: (script: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcess;
  /** Test seam: signals that stop the supervisor (and its child). */
  onStop?: (stop: () => void) => void;
}

const STDERR_TAIL = 4000;

function defaultSpawn(script: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(process.execPath, [...process.execArgv, script, ...args], {
    env,
    stdio: ['ignore', 'inherit', 'pipe', 'ipc'],
  });
}

/** What a child's stderr says went wrong: its first `…Error` line, else its last lines. */
function why(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim());
  const error = lines.find((l) => /^\s*(\w*Error|Error)\b/.test(l));
  if (error) return `: ${error.trim()}`;
  return lines.length ? `: ${lines.slice(-3).join('\n')}` : '.';
}

function realOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Run the UI as a child and start it again on each `RELOAD_EXIT`. Ends with the child's status
 * when it stops for any other reason (Ctrl+C, a crash it cannot recover from).
 */
export async function superviseUi(opts: SuperviseOptions, io: SuperviseIo): Promise<number> {
  const token = randomBytes(24).toString('base64url');
  const spawnChild = opts.spawnChild ?? defaultSpawn;
  let port: number | undefined;
  let lastGood: string | undefined;
  let fallback = false;
  let error: string | undefined;
  let first = true;
  let stopping = false;
  let child: ChildProcess | undefined;
  const crashes: number[] = [];

  const stop = (): void => {
    stopping = true;
    child?.kill('SIGTERM');
  };
  if (opts.onStop) opts.onStop(stop);
  else for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, stop);

  for (;;) {
    const script = fallback && lastGood ? lastGood : opts.entry;
    const args = ['ui', ...opts.args.filter((a, i, all) => a !== '--port' && all[i - 1] !== '--port')];
    if (port !== undefined) args.push('--port', String(port));
    else {
      const i = opts.args.indexOf('--port');
      if (i >= 0 && opts.args[i + 1]) args.push('--port', opts.args[i + 1] as string);
    }
    args.push(first && opts.open ? '--open' : '--no-open');
    const env: NodeJS.ProcessEnv = {
      ...io.env,
      [CHILD_ENV]: '1',
      [TOKEN_ENV]: token,
      [WATCH_ENV]: opts.entry,
      [SUPERVISOR_ENV]: String(process.pid),
    };
    // only the build that runs instead of a failed one says why: a newer one may well start
    if (fallback && error) env[ERROR_ENV] = error;
    else delete env[ERROR_ENV];
    const started = realOr(script);
    let ready = false;
    let tail = '';
    const c = spawnChild(script, args, env);
    child = c;
    c.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      io.err(text);
      tail = (tail + text).slice(-STDERR_TAIL);
    });
    c.on('message', (msg: unknown) => {
      const m = msg as { ready?: unknown };
      if (typeof m?.ready === 'number') {
        ready = true;
        port = m.ready;
        first = false;
        if (!fallback) {
          lastGood = started;
          error = undefined;
        }
      }
    });
    const code = await new Promise<number>((resolve) => {
      c.once('error', (err) => {
        tail += `\n${err.message}`;
        resolve(1);
      });
      c.once('exit', (status, signal) => resolve(status ?? (signal ? 1 : 0)));
    });
    child = undefined;
    if (stopping) return code === RELOAD_EXIT ? 0 : code;
    if (code === RELOAD_EXIT) {
      fallback = false;
      io.out('web-latex-mcp ui: the build changed, starting it\n');
      continue;
    }
    if (code === 0) return 0;
    if (!ready && lastGood && started !== lastGood) {
      error = `The new build (${started}) did not start, exit status ${code}${why(tail)}`;
      fallback = true;
      io.err(`web-latex-mcp ui: ${error}\nweb-latex-mcp ui: going back to ${lastGood}\n`);
      continue;
    }
    if (!ready) return code;
    const now = Date.now();
    crashes.push(now);
    while (crashes.length && now - (crashes[0] as number) > 60_000) crashes.shift();
    if (crashes.length > 3) {
      io.err('web-latex-mcp ui: the UI stopped 4 times within a minute; giving up\n');
      return code;
    }
    io.err(`web-latex-mcp ui: the UI stopped (status ${code}); starting it again\n`);
  }
}
