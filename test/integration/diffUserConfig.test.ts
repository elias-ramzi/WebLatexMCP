import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { simpleGit, type SimpleGit } from 'simple-git';
import { GitService } from '../../src/services/gitService.js';
import { splitPatch } from '../../src/lib/diffBudget.js';
import { execCapture } from '../../src/lib/exec.js';

/**
 * `GitService.diff`'s patch is parsed (`splitPatch` keys on line-initial `diff --git ` and
 * `@@ -`), so it has to be git's own plain unified diff whatever the user's config says.
 * `color.ui=always` wrapped those markers in ANSI escapes and `diff.external` replaced the patch
 * with a foreign tool's output, and either way the budget planner found no sections at all.
 *
 * And `ref` promises a single commit-ish or a two-dot range. A second `..` was validated
 * endpoint by endpoint (the lazy split let `HEAD..HEAD` through as one "endpoint", which
 * `rev-parse` accepts as a range) and then surfaced git's raw `fatal: bad revision`; a
 * three-dot range was accepted although nothing documents it.
 */

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function repo(): Promise<{ dir: string; git: SimpleGit }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-diff-config-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const git = simpleGit(dir);
  await git.raw(['init', '-b', 'master']);
  await git.addConfig('user.email', 'local@example.com');
  await git.addConfig('user.name', 'Local');
  await git.addConfig('core.autocrlf', 'false');
  await writeFile(path.join(dir, 'main.tex'), 'alpha\nbeta\n');
  await git.add(['-A']);
  await git.commit('one');
  await writeFile(path.join(dir, 'main.tex'), 'alpha\nbeta\ngamma\n');
  await git.add(['-A']);
  await git.commit('two');
  await writeFile(path.join(dir, 'main.tex'), 'alpha\nBETA\ngamma\n');
  return { dir, git };
}

function expectPlainPatch(patch: string): void {
  expect(patch).not.toContain('\u001b[');
  expect(patch.startsWith('diff --git a/main.tex b/main.tex\n')).toBe(true);
  const sections = splitPatch(patch);
  expect(sections).toHaveLength(1);
  expect(sections[0]?.path).toBe('main.tex');
  expect(sections[0]?.hunks.length).toBeGreaterThan(0);
}

describe('diff output is plain git patch whatever the user configured', () => {
  it('color.ui=always does not colour the parsed patch', async () => {
    const { dir, git } = await repo();
    await git.addConfig('color.ui', 'always');
    const res = await new GitService().diff(dir, {});
    expectPlainPatch(res.diff);
    expect(res.files).toEqual([{ path: 'main.tex', added: 1, removed: 1 }]);
    expectPlainPatch((await new GitService().diff(dir, { ref: 'HEAD~1' })).diff);
  });

  it('diff.external does not replace the patch', async () => {
    const { dir } = await repo();
    // Written with plain git: simple-git (rightly) refuses to set `diff.external` itself.
    const set = await execCapture('git', ['config', 'diff.external', 'echo EXTERNAL-TOOL'], {
      cwd: dir,
    });
    expect(set.code).toBe(0);
    const res = await new GitService().diff(dir, {});
    expect(res.diff).not.toContain('EXTERNAL-TOOL');
    expectPlainPatch(res.diff);
  });

  it('diff.noprefix / mnemonicPrefix do not change the a/ b/ headers splitPatch reads', async () => {
    const { dir, git } = await repo();
    await git.addConfig('diff.noprefix', 'true');
    expectPlainPatch((await new GitService().diff(dir, {})).diff);
    await git.raw(['config', '--unset', 'diff.noprefix']);
    await git.addConfig('diff.mnemonicPrefix', 'true');
    expectPlainPatch((await new GitService().diff(dir, {})).diff);
  });
});

describe('diff ref accepts one commit-ish or one two-dot range', () => {
  it('refuses a second range operator in server words', async () => {
    const { dir } = await repo();
    const err = await new GitService().diff(dir, { ref: 'HEAD~1..HEAD..HEAD' }).then(
      () => new Error('resolved'),
      (e: unknown) => e as Error,
    );
    expect(err.message).not.toMatch(/resolved|fatal:|bad revision/);
    expect(err.message).toMatch(/one `\.\.`|two-dot/);
  });

  it('refuses a three-dot range, saying what to pass instead', async () => {
    const { dir } = await repo();
    const err = await new GitService().diff(dir, { ref: 'HEAD~1...HEAD' }).then(
      () => new Error('resolved'),
      (e: unknown) => e as Error,
    );
    expect(err.message).not.toMatch(/resolved|fatal:/);
    expect(err.message).toMatch(/three-dot/i);
    expect(err.message).toMatch(/merge.base/i);
  });

  it('still accepts a single ref and a two-dot range', async () => {
    const { dir } = await repo();
    const git = new GitService();
    expect((await git.diff(dir, { ref: 'HEAD~1' })).files).toEqual([
      { path: 'main.tex', added: 2, removed: 1 },
    ]);
    expect((await git.diff(dir, { ref: 'HEAD~1..HEAD' })).files).toEqual([
      { path: 'main.tex', added: 1, removed: 0 },
    ]);
  });
});
