import path from 'node:path';
import { cpSync, existsSync, mkdirSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { execCapture } from '../lib/exec.js';
import { isWebLatexCheckout } from './devMode.js';

/**
 * `web-latex-mcp ui --dev --live [<dir>]`: the UI runs from a worktree of the checkout, and the dev
 * chat edits that worktree in place. A page change shows when Claude's turn ends and a UI server
 * change after a build, with no pull request and no dev update in between. Changes pile up as
 * commits on the worktree's branch until the user ships them: then Claude opens one pull request
 * into dev for the lot and merges it once its checks pass.
 *
 * - **The worktree** is `<repo>/.claude/worktrees/live` unless named, on branch `LIVE_BRANCH`.
 *   `prepareLive` makes it (off `origin/dev`), installs and builds it when it is missing.
 * - **A build rebuilt in place has no build before it** to go back to, as the dev build's
 *   `current` link has. So each live build that starts is copied (`keepBuild`) to
 *   `<workspace>/.ui/live-good/`, and a live build that does not start falls back to that copy.
 * - **What is not shipped** (`liveStatus`): commits on the branch not on `origin/dev`, and files
 *   changed in the worktree. The page shows it on its **Ship** button.
 */

/** The branch the live worktree is on. */
export const LIVE_BRANCH = 'ui-live';

/** Where the live worktree is when `--live` names none. */
export function defaultLiveDir(repo: string): string {
  return path.join(repo, '.claude', 'worktrees', 'live');
}

/** The CLI file of a build rooted at `dir`. */
export function buildEntry(dir: string): string {
  return path.join(dir, 'dist', 'index.js');
}

/** Where the last live build that started is kept. */
export function goodDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.ui', 'live-good');
}

/** Runs a command in `cwd`; resolves with its exit status and output. */
export type LiveRun = (
  cmd: string,
  args: string[],
  cwd: string,
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export const defaultRun: LiveRun = (cmd, args, cwd) =>
  // npm is a .cmd file on Windows, which only a shell runs
  process.platform === 'win32' && cmd === 'npm'
    ? execCapture('cmd.exe', ['/d', '/s', '/c', cmd, ...args], { cwd })
    : execCapture(cmd, args, { cwd });

async function must(run: LiveRun, cmd: string, args: string[], cwd: string): Promise<string> {
  const r = await run(cmd, args, cwd);
  if (r.code !== 0) {
    const said = (r.stderr || r.stdout).trim().split('\n').slice(-3).join('\n');
    throw new Error(`\`${cmd} ${args.join(' ')}\` failed (exit status ${r.code})${said ? `: ${said}` : '.'}`);
  }
  return r.stdout;
}

/**
 * Make the live worktree ready to run, and return its CLI file. A missing worktree is added on
 * `LIVE_BRANCH` (off `origin/dev`, or the branch as it is when it already exists, so commits not
 * shipped are kept), then installed and built; a worktree without a build is built. Never resets,
 * checks out or cleans anything that is there.
 */
export async function prepareLive(opts: {
  repo: string;
  dir: string;
  run?: LiveRun;
  log: (text: string) => void;
}): Promise<string> {
  const run = opts.run ?? defaultRun;
  const { repo, dir, log } = opts;
  if (existsSync(dir)) {
    if (!isWebLatexCheckout(dir)) {
      throw new Error(`${JSON.stringify(dir)} is there but is not a git checkout of WebLatexMCP.`);
    }
  } else {
    log(`Live mode: adding the worktree ${dir} on ${LIVE_BRANCH}…\n`);
    await must(run, 'git', ['fetch', 'origin', 'dev'], repo);
    const known = await run('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${LIVE_BRANCH}`], repo);
    await must(
      run,
      'git',
      known.code === 0
        ? ['worktree', 'add', dir, LIVE_BRANCH]
        : ['worktree', 'add', '-b', LIVE_BRANCH, dir, 'origin/dev'],
      repo,
    );
  }
  if (!existsSync(path.join(dir, 'node_modules'))) {
    log('Live mode: installing its dependencies (npm ci)…\n');
    await must(run, 'npm', ['ci', '--no-audit', '--no-fund', '--loglevel=error'], dir);
  }
  const entry = buildEntry(dir);
  if (!existsSync(entry)) {
    log('Live mode: building it…\n');
    await must(run, 'npm', ['run', 'build', '--silent'], dir);
  }
  if (!existsSync(entry)) throw new Error(`The build of ${dir} has no ${entry}.`);
  return entry;
}

/** What a build needs at its root to run the UI: its code, the page, and the plugin its chats load. */
const KEPT = ['package.json', 'dist', 'ui', 'docs', '.claude', '.claude-plugin'];

/**
 * Copy the build at `dir` to `good` (whole, or not at all: written beside it, then renamed over
 * it) and return the copy's CLI file. Its `node_modules` is a link to the live one's.
 */
export function keepBuild(dir: string, good: string): string {
  const next = `${good}.next`;
  rmSync(next, { recursive: true, force: true });
  mkdirSync(next, { recursive: true, mode: 0o700 });
  const worktrees = path.join(dir, '.claude', 'worktrees');
  for (const name of KEPT) {
    const from = path.join(dir, name);
    if (!existsSync(from)) continue;
    cpSync(from, path.join(next, name), {
      recursive: true,
      // a checkout's own worktrees are other checkouts, not part of its build
      filter: (src) => src !== worktrees && !src.startsWith(worktrees + path.sep),
    });
  }
  symlinkSync(path.join(dir, 'node_modules'), path.join(next, 'node_modules'), 'junction');
  const old = `${good}.old`;
  rmSync(old, { recursive: true, force: true });
  if (existsSync(good)) renameSync(good, old);
  renameSync(next, good);
  rmSync(old, { recursive: true, force: true });
  return buildEntry(good);
}

export interface LiveStatus {
  dir: string;
  branch: string;
  /** Commits on the branch that `origin/dev` does not have. */
  ahead: number;
  /** Files changed in the worktree, committed or not. */
  changed: number;
  /** Set when git could not tell. */
  problem?: string;
}

/** What the live worktree holds that is not shipped yet. */
export async function liveStatus(dir: string, run: LiveRun = defaultRun): Promise<LiveStatus> {
  const branch = (await run('git', ['branch', '--show-current'], dir)).stdout.trim() || '(detached)';
  const count = await run('git', ['rev-list', '--count', 'origin/dev..HEAD'], dir);
  const status = await run('git', ['status', '--porcelain', '--untracked-files=normal'], dir);
  if (count.code !== 0 || status.code !== 0) {
    return {
      dir,
      branch,
      ahead: 0,
      changed: 0,
      problem: (count.stderr || status.stderr).trim().split('\n')[0] || 'git could not tell.',
    };
  }
  return {
    dir,
    branch,
    ahead: Number(count.stdout.trim()) || 0,
    changed: status.stdout.split('\n').filter((l) => l.trim()).length,
  };
}

/** The dev chat's brief in live mode, on top of Claude Code's own instructions. */
export function liveSystemPrompt(repo: string, dir: string): string {
  return `You are the developer of WebLatexMCP on this machine. The user talks to you from the small
"Improve WebLatexMCP" panel of its web UI, in live mode (\`web-latex-mcp ui --dev --live\`): the UI
runs from the worktree ${dir}, on branch ${LIVE_BRANCH}, and you change it there while they use it.

- The repository is ${repo} (GitHub: elias-ramzi/WebLatexMCP). Its CLAUDE.md holds the rules: read
  it. The UI is src/ui/* (its server) and ui/ (the page, vanilla JS, cc-servers' names and styles);
  the viewer is src/services/viewer.ts; docs/ui.md documents the UI.
- Edit ${dir} directly: no other worktree, no pull request per change. Never touch ${repo}'s own
  checkout.
- After each change, make it live:
  - a change to the page only (ui/): nothing to do;
  - a change to src/: \`npm --prefix ${dir} run typecheck\`, fix what it says, then
    \`npm --prefix ${dir} run build\`.
  The UI starts again on it once no chat is working: this one included, so it happens when your
  turn ends, and the page reloads itself. A build that does not start falls back to the last live
  build that did, and the page says why: fix it and build again.
- Commit each change on ${LIVE_BRANCH} with a short message; do not push. Changes outside src/ui/ and
  ui/ reach the shared server only once shipped: say so when you make one.
- Shipping ("ship", or the Ship button): \`git -C ${dir} fetch origin\`, rebase ${LIVE_BRANCH} onto
  origin/dev, then add the tests, docs and CHANGELOG.md's [Unreleased] entries the changes need, run
  the gate (\`npm run typecheck && npm run lint && npm run format:check && npm test\`), push the
  branch, open one pull request into dev for the lot, wait for its checks and merge it once they
  pass (\`gh pr merge --merge --delete-branch\`). A check that fails: fix it, push, wait again. Then
  \`git -C ${dir} pull --ff-only origin dev\`, build again, run \`web-latex-mcp-dev-update\` if it is
  on the PATH (the papers' sessions run that build), and \`web-latex-mcp daemon restart --force\` if
  the changes touch the shared server (anything outside src/ui/ and ui/).
- Never push to main, never force-push.
- Never stop or kill the UI, its supervisor, the shared server's paper sessions or this session.
- Keep your replies short: the panel is small. Say what changed and that it shows when this turn
  ends; when shipping, give the PR.`;
}
