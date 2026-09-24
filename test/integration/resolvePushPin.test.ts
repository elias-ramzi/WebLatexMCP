import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { simpleGit } from 'simple-git';
import { createFakeRemote, pushCommit, type FakeRemote } from './helpers/bareRepo.js';
import { GitService } from '../../src/services/gitService.js';
import { FileService } from '../../src/services/fileService.js';

/**
 * `expectedRemoteHead` is the caller's pin on the `theirs` they merged against. Two holes made it
 * decorative:
 *
 * 1. Any rev was accepted and resolved in the clone, so `origin/master`, `FETCH_HEAD` or `@{u}`
 *    always "matched" the remote it names — the guard was simply off.
 * 2. After the check, `pull --rebase` fetched AGAIN, so a commit landing between the two fetches
 *    was rebased onto, and the caller's verbatim resolution overwrote it — a merge computed
 *    against X pushed over Y.
 */

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const BASE = 'alpha\nbeta\ngamma\n';

async function conflicted(): Promise<{
  remote: FakeRemote;
  git: GitService;
  dir: string;
  remoteHead: string;
}> {
  const remote = await createFakeRemote({ 'main.tex': BASE });
  cleanups.push(remote.cleanup);
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-pin-'));
  cleanups.push(() =>
    rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  );
  const dir = path.join(workspace, 'demo');
  const git = new GitService();
  await git.clone(remote.url, dir, { username: 'git' });
  await new FileService().applyEdits(dir, 'main.tex', [
    { oldString: 'beta', newString: 'beta-local' },
  ]);
  await git.commit(dir, { message: 'local edits line 2' });
  await pushCommit(remote, { 'main.tex': 'alpha\nbeta-remote\ngamma\n' }, 'remote edits line 2');
  const conflict = await git.safePush(dir, remote.url, { username: 'git' });
  expect(conflict.status).toBe('conflict');
  return { remote, git, dir, remoteHead: conflict.conflict!.remoteHead };
}

async function remoteFile(remote: FakeRemote, rel: string): Promise<string> {
  const verify = await mkdtemp(path.join(os.tmpdir(), 'ovl-pin-verify-'));
  cleanups.push(() =>
    rm(verify, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  );
  await simpleGit(verify).clone(remote.url, verify);
  return readFile(path.join(verify, rel), 'utf8');
}

describe('resolvePush expectedRemoteHead', () => {
  it.each(['origin/master', 'FETCH_HEAD', '@{u}', 'HEAD', 'xyz1234'])(
    'refuses a non-SHA pin (%s) instead of reading it as a match',
    async (pin) => {
      const { remote, git, dir } = await conflicted();

      await expect(
        git.resolvePush(
          dir,
          remote.url,
          { username: 'git' },
          {
            resolutions: [{ path: 'main.tex', content: 'alpha\nMERGED\ngamma\n' }],
            expectedRemoteHead: pin,
          },
        ),
      ).rejects.toThrow(/commit SHA/);

      expect(await remoteFile(remote, 'main.tex')).toBe('alpha\nbeta-remote\ngamma\n');
    },
  );

  // With the branch gone from the remote (deleted or renamed), the fetch must leave no
  // `origin/<branch>` to check the pin against. The check used to be skipped outright on a null
  // remote head, so a PINNED call fell through to the rebase and surfaced git's raw
  // "invalid upstream" instead of saying what the pin could not verify. And the fetch did not
  // prune: the clone's tracking ref survived the rename, still naming the pinned head, so the pin
  // "matched", the rebase landed on that stale sha, and `push origin master` RECREATED the branch
  // the collaborator had just renamed away. The clone's own tracking ref is deliberately left
  // alone here — only the remote changes, as it does in real life.
  it('refuses in server words when the pinned branch no longer exists on the remote', async () => {
    const { remote, git, dir, remoteHead } = await conflicted();
    execFileSync('git', ['branch', '-m', 'master', 'renamed'], { cwd: remote.bareDir });
    // Precondition: the clone still believes in origin/master, at the pinned head.
    expect(
      execFileSync('git', ['rev-parse', 'refs/remotes/origin/master'], {
        cwd: dir,
        encoding: 'utf8',
      }).trim(),
    ).toBe(remoteHead);

    let thrown: unknown;
    try {
      await git.resolvePush(
        dir,
        remote.url,
        { username: 'git' },
        {
          resolutions: [{ path: 'main.tex', content: 'alpha\nMERGED\ngamma\n' }],
          expectedRemoteHead: remoteHead,
        },
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain('origin/master');
    expect(message).toContain(remoteHead);
    expect(message).toMatch(/Nothing was pushed/);
    expect(message).not.toMatch(/invalid upstream/i);
    // Refused before the rebase started: the clone is not left mid-rebase.
    const status = execFileSync('git', ['status'], { cwd: dir, encoding: 'utf8' });
    expect(status).not.toMatch(/rebase in progress/i);
    // The rename stands: the remote did not gain a `master` back.
    const heads = execFileSync('git', ['for-each-ref', '--format=%(refname)', 'refs/heads'], {
      cwd: remote.bareDir,
      encoding: 'utf8',
    });
    expect(heads.split('\n').filter(Boolean)).toEqual(['refs/heads/renamed']);
  });

  it('accepts an upper-case abbreviated SHA of the current remote head', async () => {
    const { remote, git, dir, remoteHead } = await conflicted();

    const res = await git.resolvePush(
      dir,
      remote.url,
      { username: 'git' },
      {
        resolutions: [{ path: 'main.tex', content: 'alpha\nMERGED\ngamma\n' }],
        expectedRemoteHead: remoteHead.slice(0, 10).toUpperCase(),
      },
    );

    expect(res.status).toBe('pushed');
    expect(await remoteFile(remote, 'main.tex')).toBe('alpha\nMERGED\ngamma\n');
  });

  it('rebases onto the head it checked, so a commit landing after that fetch is never merged over', async () => {
    const { remote, git, dir, remoteHead } = await conflicted();

    // Prepare Y — a child of the pinned head X that edits a DIFFERENT line of the same file — on
    // a side ref of the bare remote, so it can be promoted to master without any network step.
    const side = await mkdtemp(path.join(os.tmpdir(), 'ovl-pin-side-'));
    cleanups.push(() =>
      rm(side, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
    );
    const sideGit = simpleGit(side, {
      config: ['user.email=c@example.com', 'user.name=C', 'core.autocrlf=false'],
    });
    await sideGit.clone(remote.url, side);
    await writeFile(path.join(side, 'main.tex'), 'alpha\nbeta-remote\ngamma-Y\n');
    await sideGit.add('main.tex');
    await sideGit.commit('Y: edits line 3');
    await sideGit.push('origin', 'HEAD:refs/heads/pending');
    const ySha = (await sideGit.revparse(['HEAD'])).trim();

    // Wrap the clone's upload-pack (every fetch/pull of `origin` runs it, file:// included): the
    // FIRST fetch is served X and only then does Y land on master. Before the fix, resolvePush's
    // pinned check passed on that first fetch and its `pull --rebase` fetched a SECOND time, got
    // Y, rebased onto it, and wrote the caller's X-based resolution verbatim over Y's line.
    const marker = path.join(side, 'landed');
    const wrapper = path.join(side, 'upload-pack.mjs');
    await writeFile(
      wrapper,
      [
        "import { spawnSync } from 'node:child_process';",
        "import { existsSync, writeFileSync } from 'node:fs';",
        "const r = spawnSync('git', ['upload-pack', ...process.argv.slice(2)], { stdio: 'inherit' });",
        `if (!existsSync(${JSON.stringify(marker)})) {`,
        `  writeFileSync(${JSON.stringify(marker)}, '');`,
        `  spawnSync('git', ['--git-dir', ${JSON.stringify(remote.bareDir)}, 'update-ref', 'refs/heads/master', ${JSON.stringify(ySha)}]);`,
        '}',
        'process.exit(r.status ?? 1);',
        '',
      ].join('\n'),
    );
    const toSh = (p: string): string => `"${p.split(path.sep).join('/')}"`;
    // Plain `git config`: simple-git refuses to write `remote.*.uploadpack` itself.
    execFileSync(
      'git',
      ['config', 'remote.origin.uploadpack', `${toSh(process.execPath)} ${toSh(wrapper)}`],
      { cwd: dir },
    );

    const res = await git.resolvePush(
      dir,
      remote.url,
      { username: 'git' },
      {
        resolutions: [{ path: 'main.tex', content: 'alpha\nbeta-merged\ngamma\n' }],
        expectedRemoteHead: remoteHead,
      },
    );

    // The move after the check surfaces on the push itself; Y's line is never overwritten.
    expect(res.status).toBe('remote-moved');
    expect(res.pushed).toBe(false);
    expect(res.remoteHead).toBe(ySha);
    expect(await remoteFile(remote, 'main.tex')).toBe('alpha\nbeta-remote\ngamma-Y\n');
  });
});
