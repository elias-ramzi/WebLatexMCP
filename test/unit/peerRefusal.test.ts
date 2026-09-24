import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import {
  guardPeerWork,
  enrichPullRefusal,
  type PeerRefusalDeps,
} from '../../src/lib/peerRefusal.js';
import {
  LocalChangesOverwriteError,
  UntrackedOverwriteError,
  type StatusResult,
} from '../../src/services/gitService.js';
import { ShadowStore } from '../../src/services/shadowStore.js';
import type { PeerSession } from '../../src/services/sessionRegistry.js';
import { sessionDir } from '../../src/lib/sessionPaths.js';

/**
 * Unit coverage for `guardPeerWork`'s dirty set (Task 1: `status.staged` must join the set the
 * same way `status`'s own `otherChanges` does) and `enrichPullRefusal`'s widened `instanceof`
 * check (Task 2: it must decorate a pull-worded `UntrackedOverwriteError` but never a push-worded
 * one). No live git repo is needed — `deps.git` is stubbed directly, and `deps.shadows` is a real
 * `ShadowStore` over a scratch workspace dir (its type is not `Pick`-narrowed, since
 * `collectPeerShadows` needs the full class). A peer's own shadow (when a test needs one to be
 * "owned") is written with a second `ShadowStore` instance sharing the same workspace root —
 * `peerEntries` reads a peer's index straight off disk, so two store instances over one workspace
 * behave exactly as two sibling server processes would.
 */
describe('peerRefusal', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  async function makeDeps(peers: PeerSession[]): Promise<{
    deps: PeerRefusalDeps;
    workspace: string;
  }> {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-peerrefusal-'));
    cleanups.push(() => rm(workspace, { recursive: true, force: true }));
    const shadows = new ShadowStore(workspace, 'alpha', () => Promise.resolve(null));
    const deps: PeerRefusalDeps = {
      sessions: { livePeers: () => Promise.resolve(peers) },
      shadows,
      git: {
        status: () => {
          throw new Error('status stub not configured');
        },
        isCaseInsensitive: () => Promise.resolve(false),
      },
    };
    return { deps, workspace };
  }

  const peer = (sessionId: string): PeerSession => ({
    sessionId,
    pid: 1,
    startedAt: '2026-01-01T00:00:00.000Z',
    heartbeatAt: '2026-01-01T00:00:10.000Z',
    live: true,
    self: false,
  });

  const status = (overrides: Partial<StatusResult>): StatusResult => ({
    branch: 'main',
    ahead: 0,
    behind: 0,
    clean: false,
    staged: [],
    unstaged: [],
    untracked: [],
    aheadCommits: [],
    aheadCommitsOmitted: 0,
    behindCommits: [],
    remoteBranchMissing: false,
    ...overrides,
  });

  describe('guardPeerWork', () => {
    it('refuses over a path dirty only in the index (staged, not unstaged/untracked)', async () => {
      const { deps } = await makeDeps([peer('beta')]);
      deps.git.status = () => Promise.resolve(status({ staged: ['a.tex'] }));

      await expect(guardPeerWork(deps, 'demo', '/clone')).rejects.toThrow(/a\.tex/);
    });

    it('does not name a path dirty in both the index and the working tree twice (deduped)', async () => {
      const { deps } = await makeDeps([peer('beta')]);
      deps.git.status = () => Promise.resolve(status({ staged: ['a.tex'], unstaged: ['a.tex'] }));

      // "a.tex" must be named exactly once in the header line's disputed list, not twice.
      const header = await guardPeerWork(deps, 'demo', '/clone').then(
        () => {
          throw new Error('expected guardPeerWork to throw');
        },
        (err: unknown) => (err as Error).message.split('\n')[0] ?? '',
      );
      expect(header.match(/a\.tex/g)).toHaveLength(1);
    });

    it('does not refuse when nothing is dirty at all (staged included)', async () => {
      const { deps } = await makeDeps([peer('beta')]);
      deps.git.status = () => Promise.resolve(status({}));

      await expect(guardPeerWork(deps, 'demo', '/clone')).resolves.toBeUndefined();
    });

    it(
      'dedupes two spellings of the same file on an ignorecase clone (fold-before-dedupe, ' +
        'Fix 3) — the two-spelling input is synthetic (stubbed `git.status`); real git normally ' +
        'reports one canonical index spelling for a path across all three lists, so it is unclear ' +
        'this exact input is reachable through real git at all. It is not merely a guard, though: ' +
        'run directly against the pre-fix dedupe-then-fold ordering it fails for real (confirmed by ' +
        'temporarily reverting the fix) — `A.tex`/`a.tex` both survive the raw-string `Set` dedupe ' +
        'and the header names the path twice — and passes once dedup happens on the folded key.',
      async () => {
        const { deps } = await makeDeps([peer('beta')]);
        deps.git.isCaseInsensitive = () => Promise.resolve(true);
        // A hostile/synthetic status: the same file named under two spellings across two lists —
        // something real `git status` may never actually produce (git reports one canonical index
        // spelling everywhere), but exercises the dedupe ordering directly regardless.
        deps.git.status = () => Promise.resolve(status({ staged: ['A.tex'], unstaged: ['a.tex'] }));

        const header = await guardPeerWork(deps, 'demo', '/clone').then(
          () => {
            throw new Error('expected guardPeerWork to throw');
          },
          (err: unknown) => (err as Error).message.split('\n')[0] ?? '',
        );
        // Named once — case-insensitively — not as two separate disputed paths.
        expect(header.match(/a\.tex/gi)).toHaveLength(1);
      },
    );
    describe('a path this session ALSO owns (co-edited with a live peer)', () => {
      // `push` with a `message` commits via `git add -A`, so a file both sessions edited carries
      // the peer's lines into this session's commit. `commit scope: "paths"` refuses any path a
      // live peer lists even when the caller owns it too (`peerOwnership`); the push guard must
      // hold the same line instead of subtracting this session's own paths first.
      it("refuses when a live peer's shadow lists a path this session's shadow lists too", async () => {
        const { deps, workspace } = await makeDeps([peer('beta')]);
        deps.git.status = () => Promise.resolve(status({ unstaged: ['sections/method.tex'] }));
        await deps.shadows.record('demo', '/clone', 'sections/method.tex', 'a\n', 'a, per A\n');
        const betaShadows = new ShadowStore(workspace, 'beta', () => Promise.resolve(null));
        await betaShadows.record('demo', '/clone', 'sections/method.tex', 'a\n', 'a, per B\n');

        const message = await guardPeerWork(deps, 'demo', '/clone').then(
          () => {
            throw new Error('expected guardPeerWork to throw');
          },
          (err: unknown) => (err as Error).message,
        );
        expect(message).toContain('"beta" owns sections/method.tex');
        expect(message).toMatch(/also carries this session's own edits/);
        expect(message).not.toMatch(/or may have/);
        expect(message).toMatch(/scope "session"/);
        expect(message).toMatch(/without a `message`/);
      });

      it("refuses over this session's own path when a live peer's index is unreadable (fail closed)", async () => {
        const { deps, workspace } = await makeDeps([peer('beta')]);
        deps.git.status = () => Promise.resolve(status({ unstaged: ['sections/method.tex'] }));
        await deps.shadows.record('demo', '/clone', 'sections/method.tex', 'a\n', 'a, per A\n');
        const betaDir = sessionDir(workspace, 'demo', 'beta');
        await mkdir(betaDir, { recursive: true });
        await writeFile(path.join(betaDir, 'shadow.json'), '{ not json');

        const message = await guardPeerWork(deps, 'demo', '/clone').then(
          () => {
            throw new Error('expected guardPeerWork to throw');
          },
          (err: unknown) => (err as Error).message,
        );
        expect(message).toMatch(/unreadable/);
        // The shared-file sentence does not claim beta edited it — only that it may have.
        expect(message).toMatch(/or may have: a live session's change index cannot be read/);
      });

      it("matches the peer's spelling through the case fold on an ignorecase clone", async () => {
        const { deps, workspace } = await makeDeps([peer('beta')]);
        deps.git.isCaseInsensitive = () => Promise.resolve(true);
        deps.git.status = () => Promise.resolve(status({ unstaged: ['sections/method.tex'] }));
        await deps.shadows.record('demo', '/clone', 'sections/method.tex', 'a\n', 'a, per A\n');
        const betaShadows = new ShadowStore(workspace, 'beta', () => Promise.resolve(null));
        await betaShadows.record('demo', '/clone', 'Sections/Method.tex', 'a\n', 'a, per B\n');

        await expect(guardPeerWork(deps, 'demo', '/clone')).rejects.toThrow(
          /beta" owns sections\/method\.tex/,
        );
      });

      it("does not refuse this session's own path when no live peer lists it", async () => {
        const { deps, workspace } = await makeDeps([peer('beta')]);
        deps.git.status = () => Promise.resolve(status({ unstaged: ['sections/method.tex'] }));
        await deps.shadows.record('demo', '/clone', 'sections/method.tex', 'a\n', 'a, per A\n');
        // beta is live with a readable index that lists a different, clean file.
        const betaShadows = new ShadowStore(workspace, 'beta', () => Promise.resolve(null));
        await betaShadows.record('demo', '/clone', 'sections/intro.tex', 'i\n', 'i, per B\n');

        await expect(guardPeerWork(deps, 'demo', '/clone')).resolves.toBeUndefined();
      });
    });
  });

  describe('enrichPullRefusal', () => {
    it('decorates a pull-worded UntrackedOverwriteError, naming the live peer that owns the path', async () => {
      const { deps, workspace } = await makeDeps([peer('beta')]);
      // Simulate beta's write_file of a brand-new file: its shadow claims the path. A second
      // ShadowStore instance over the same workspace root, sessioned as "beta", is exactly what
      // peerEntries (disk-backed, instance-agnostic) reads back for alpha's deps.shadows.
      const betaShadows = new ShadowStore(workspace, 'beta', () => Promise.resolve(null));
      await betaShadows.record('demo', '/clone', 'sections/new.tex', null, 'new content');

      const err = new UntrackedOverwriteError(['sections/new.tex'], 'pull');
      const result = await enrichPullRefusal(deps, 'demo', '/clone', err);

      expect(result).not.toBe(err);
      expect(result.message).toContain('sections/new.tex');
      expect(result.message).toContain('beta" owns sections/new.tex');
      // Fix 2: the closing's retry line no longer says "sync again" — a committed collision makes
      // syncPull report `diverged`, never lands the commit via pull; push is the route forward.
      expect(result.message).toContain(
        'Then push — once the work is committed, a sync would only report the histories as ' +
          'diverged; push rebases onto the remote and surfaces any real conflict.',
      );
      expect(result.message).not.toContain('Then sync again.');
    });

    it("decorates a path this session also owns when a live peer's shadow lists it too", async () => {
      const { deps, workspace } = await makeDeps([peer('beta')]);
      await deps.shadows.record('demo', '/clone', 'sections/method.tex', 'a\n', 'a, per A\n');
      const betaShadows = new ShadowStore(workspace, 'beta', () => Promise.resolve(null));
      await betaShadows.record('demo', '/clone', 'sections/method.tex', 'a\n', 'a, per B\n');

      const err = new LocalChangesOverwriteError(['sections/method.tex']);
      const result = await enrichPullRefusal(deps, 'demo', '/clone', err);

      expect(result).not.toBe(err);
      expect(result.message.startsWith(err.message)).toBe(true);
      expect(result.message).toContain('"beta" owns sections/method.tex');
      expect(result.message).toMatch(/also carries this session's own edits/);
      expect(result.message).toMatch(/scope "session"/);
    });

    it('still passes through a path only this session owns (no live peer lists it)', async () => {
      const { deps } = await makeDeps([peer('beta')]);
      await deps.shadows.record('demo', '/clone', 'sections/method.tex', 'a\n', 'a, per A\n');

      const err = new LocalChangesOverwriteError(['sections/method.tex']);
      const result = await enrichPullRefusal(deps, 'demo', '/clone', err);

      expect(result).toBe(err);
    });

    it('leaves a pull-worded UntrackedOverwriteError with an empty paths list unchanged', async () => {
      const { deps } = await makeDeps([peer('beta')]);
      const err = new UntrackedOverwriteError([], 'pull');

      const result = await enrichPullRefusal(deps, 'demo', '/clone', err);

      expect(result).toBe(err);
    });

    it('never decorates a push-worded UntrackedOverwriteError (wrong vocabulary)', async () => {
      const { deps } = await makeDeps([peer('beta')]);
      const err = new UntrackedOverwriteError(['a.tex'], 'push');

      const result = await enrichPullRefusal(deps, 'demo', '/clone', err);

      expect(result).toBe(err);
    });

    it('still passes through LocalChangesOverwriteError unchanged when no live peer exists (regression guard)', async () => {
      const { deps } = await makeDeps([]);
      const err = new LocalChangesOverwriteError(['a.tex']);

      const result = await enrichPullRefusal(deps, 'demo', '/clone', err);

      expect(result).toBe(err);
    });

    it('falls back to the original error when decoration itself throws', async () => {
      const { deps } = await makeDeps([peer('beta')]);
      deps.sessions.livePeers = () => {
        throw new Error('boom');
      };
      const err = new UntrackedOverwriteError(['sections/new.tex'], 'pull');

      const result = await enrichPullRefusal(deps, 'demo', '/clone', err);

      expect(result).toBe(err);
      expect(result.message).not.toContain('boom');
    });

    it(
      'attributes a peer-owned path even when its spelling differs only in case, on an ' +
        'ignorecase clone (Fix 1 — the case fold guardPeerWork already applied)',
      async () => {
        const { deps, workspace } = await makeDeps([peer('beta')]);
        deps.git.isCaseInsensitive = () => Promise.resolve(true);
        // beta's shadow claims the path under the spelling it wrote it with...
        const betaShadows = new ShadowStore(workspace, 'beta', () => Promise.resolve(null));
        await betaShadows.record('demo', '/clone', 'Sections/Method.tex', null, 'new content');

        // ...but git's stderr (and so the typed error) names it in the index's own spelling.
        const err = new LocalChangesOverwriteError(['sections/method.tex']);
        const result = await enrichPullRefusal(deps, 'demo', '/clone', err);

        expect(result).not.toBe(err);
        expect(result.message).not.toContain('No live session owns');
        expect(result.message).toMatch(/beta" owns sections\/method\.tex/);
      },
    );
  });
});
