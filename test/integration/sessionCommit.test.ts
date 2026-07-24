import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { simpleGit } from 'simple-git';
import { createFakeRemote, type FakeRemote } from './helpers/bareRepo.js';
import { GitService } from '../../src/services/gitService.js';
import { ProjectManager } from '../../src/services/projectManager.js';
import type { ServerConfig } from '../../src/types.js';
import { execCapture } from '../../src/lib/exec.js';

/**
 * The git plumbing behind per-session commits (several agent sessions sharing one clone).
 *
 * The model under test: each session keeps a *shadow* copy of every file it touched,
 * holding `HEAD + only that session's edits`, while the working tree holds
 * `HEAD + everyone's edits`. Committing a session's work then means staging its shadow
 * content directly — never `git add` — so the commit captures that session's lines and
 * leaves its peers' in-flight edits untouched in the working tree.
 *
 * These tests exercise the two plumbing primitives that make it possible:
 *  - `hash-object -w --stdin` + `update-index --cacheinfo` to stage content the working
 *    tree does not contain, and
 *  - `merge-file` to rebase a peer's shadow onto the new HEAD afterwards.
 *
 * They deliberately drive raw git rather than the services built on these primitives
 * (`GitService.commitContents`, `ShadowStore`), which multiSession.test.ts exercises end to
 * end through the tools. When that breaks, these say whether git moved or we did.
 */

const REL = 'sections/method.tex';

const BASE = [
  '\\section{Method}',
  'The first paragraph opens the method.',
  'It then states the assumption.',
  '',
  'The second paragraph defines the loss.',
  'It closes with the optimisation detail.',
  '',
].join('\n');

/** `BASE` with one line replaced — how a session edits a single sentence. */
function withLine(source: string, find: string, replacement: string): string {
  if (!source.includes(find)) throw new Error(`line not found: ${find}`);
  return source.replace(find, replacement);
}

const A_LINE = 'It then states the assumption, as revised by session A.';
const B_LINE = 'The second paragraph defines the loss, as revised by session B.';

/** Session A's shadow: HEAD + only A's edit. */
const SHADOW_A = withLine(BASE, 'It then states the assumption.', A_LINE);
/** Session B's shadow: HEAD + only B's edit. */
const SHADOW_B = withLine(BASE, 'The second paragraph defines the loss.', B_LINE);
/** The real document both sessions see on disk. */
const WORKING = withLine(SHADOW_A, 'The second paragraph defines the loss.', B_LINE);

describe('per-session commits from a shadow tree', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  async function setup(): Promise<{ remote: FakeRemote; dir: string }> {
    const remote = await createFakeRemote({ [REL]: BASE });
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-ws-'));
    cleanups.push(remote.cleanup, () => rm(workspace, { recursive: true, force: true }));
    const config: ServerConfig = {
      workspaceRoot: workspace,
      sessionId: 'test',
      projects: [{ id: 'demo', gitUrl: remote.url }],
      defaultProject: 'demo',
    };
    const pm = new ProjectManager(config);
    const dir = pm.projectPath('demo');
    await new GitService().clone(remote.url, dir, { username: 'git' });
    return { remote, dir };
  }

  /** Read a path's mode from the index, so staging preserves it (e.g. an executable script). */
  async function indexMode(dir: string, rel: string): Promise<string> {
    const out = await simpleGit(dir).raw(['ls-files', '-s', '--', rel]);
    const mode = out.trim().split(/\s+/)[0];
    if (!mode) throw new Error(`${rel} is not tracked`);
    return mode;
  }

  /**
   * Stage `content` for `rel` without writing it to the working tree — the core primitive.
   * Returns the blob sha so the caller can assert on it.
   */
  async function stageContent(dir: string, rel: string, content: string): Promise<string> {
    const mode = await indexMode(dir, rel);
    const hashed = await execCapture('git', ['hash-object', '-w', '--stdin', '--path', rel], {
      cwd: dir,
      input: content,
    });
    expect(hashed.code, hashed.stderr).toBe(0);
    const sha = hashed.stdout.trim();
    await simpleGit(dir).raw(['update-index', '--add', '--cacheinfo', `${mode},${sha},${rel}`]);
    return sha;
  }

  /** Commit whatever is in the index. Never stages, so the working tree is irrelevant. */
  async function commitIndex(dir: string, message: string): Promise<string> {
    const git = simpleGit(dir);
    await git.raw([
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-m',
      message,
    ]);
    return (await git.revparse(['HEAD'])).trim();
  }

  /**
   * Three-way merge `ours` and `theirs` over `base`, as `git merge-file` would.
   * Returns the merged text plus whether it conflicted, without touching the repo.
   */
  async function mergeFile(
    ours: string,
    base: string,
    theirs: string,
  ): Promise<{ merged: string; conflicted: boolean }> {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'ovl-merge-'));
    cleanups.push(() => rm(tmp, { recursive: true, force: true }));
    const files = { ours: 'ours', base: 'base', theirs: 'theirs' };
    await Promise.all(
      Object.entries({ [files.ours]: ours, [files.base]: base, [files.theirs]: theirs }).map(
        ([name, content]) => writeFile(path.join(tmp, name), content),
      ),
    );
    const res = await execCapture(
      'git',
      ['merge-file', '-p', files.ours, files.base, files.theirs],
      {
        cwd: tmp,
      },
    );
    // merge-file exits 0 when clean, >0 with the number of conflicts, <0 on error.
    expect(res.code, res.stderr).not.toBeNull();
    expect(res.code).toBeGreaterThanOrEqual(0);
    return { merged: res.stdout, conflicted: (res.code ?? 0) > 0 };
  }

  it("commits one session's lines and leaves the peer's edits in the working tree", async () => {
    const { dir } = await setup();
    const git = simpleGit(dir);
    const baseHead = (await git.revparse(['HEAD'])).trim();

    // Both sessions have edited the shared working tree; neither has committed.
    await writeFile(path.join(dir, REL), WORKING);

    // Session A commits — staging its shadow, not the working tree.
    await stageContent(dir, REL, SHADOW_A);
    const shaA = await commitIndex(dir, 'session A: revise the assumption');

    // The commit holds A's edit and *not* B's.
    const committed = await git.show([`${shaA}:${REL}`]);
    expect(committed).toBe(SHADOW_A);
    expect(committed).toContain(A_LINE);
    expect(committed).not.toContain(B_LINE);

    // The working tree is untouched: B's in-flight edit survives, and so does A's.
    expect(await readFile(path.join(dir, REL), 'utf8')).toBe(WORKING);

    // What is now uncommitted is exactly B's change: it is the only *changed* line.
    // (A's line is present too, but as unchanged context — it is already committed.)
    const pending = await git.diff(['HEAD', '--', REL]);
    const changed = pending.split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l));
    expect(changed).toEqual(['-The second paragraph defines the loss.', `+${B_LINE}`]);
    expect(await git.raw(['diff', 'HEAD', '--name-only'])).toBe(`${REL}\n`);

    // Exactly one commit landed, on top of the clone's original head.
    expect((await git.revparse(['HEAD^'])).trim()).toBe(baseHead);
  });

  it("rebases the peer's shadow onto the new HEAD after a disjoint commit", async () => {
    const { dir } = await setup();
    const git = simpleGit(dir);
    const oldHead = await git.show([`HEAD:${REL}`]);

    await writeFile(path.join(dir, REL), WORKING);
    await stageContent(dir, REL, SHADOW_A);
    await commitIndex(dir, 'session A: revise the assumption');
    const newHead = await git.show([`HEAD:${REL}`]);

    // B's shadow still says "HEAD + B", but HEAD has moved. Restore the invariant by
    // merging it forward: base = the old HEAD, ours = the new HEAD, theirs = B's shadow.
    const { merged, conflicted } = await mergeFile(newHead, oldHead, SHADOW_B);
    expect(conflicted).toBe(false);
    expect(merged).toBe(WORKING);

    // The rebased shadow now matches the working tree, so committing B lands only B's line.
    await stageContent(dir, REL, merged);
    const shaB = await commitIndex(dir, 'session B: revise the loss');
    const diffB = await git.raw(['show', '--format=', '--numstat', shaB]);
    expect(diffB.trim()).toBe(`1\t1\t${REL}`);

    // Both sessions' work is now committed, and the tree is clean.
    expect(await git.show([`HEAD:${REL}`])).toBe(WORKING);
    expect((await git.status()).isClean()).toBe(true);
  });

  it('reports a conflict when two sessions edit the same line', async () => {
    const { dir } = await setup();
    const git = simpleGit(dir);
    const oldHead = await git.show([`HEAD:${REL}`]);

    const target = 'It then states the assumption.';
    const shadowA = withLine(BASE, target, 'It then states the assumption, per A.');
    const shadowB = withLine(BASE, target, 'It then states the assumption, per B.');

    await writeFile(path.join(dir, REL), shadowB);
    await stageContent(dir, REL, shadowA);
    await commitIndex(dir, 'session A: revise the assumption');

    const { merged, conflicted } = await mergeFile(
      await git.show([`HEAD:${REL}`]),
      oldHead,
      shadowB,
    );
    expect(conflicted).toBe(true);
    expect(merged).toContain('<<<<<<<');
    expect(merged).toContain('per A.');
    expect(merged).toContain('per B.');
  });
});
