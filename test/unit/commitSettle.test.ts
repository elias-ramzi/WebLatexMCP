import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { ShadowStore } from '../../src/services/shadowStore.js';
import { settleTakenPaths, settleNothingToCommit } from '../../src/lib/commitSettle.js';
import type { SettleStore, SettleRequest } from '../../src/lib/commitSettle.js';
import { foldCase } from '../../src/lib/caseFold.js';

/**
 * The settle policy `commit` applies after a deliberate `scope: "all"`/`"paths"` take, exercised
 * against a REAL `ShadowStore` over a temp dir (no git, no MCP round trip) — the whole reason
 * `src/lib/commitSettle.ts` was extracted out of the tool handler (issue #70).
 *
 * Nothing here mocks the store: an in-memory `Map` stands in for HEAD through the store's own
 * injected `HeadReader`, exactly as `test/unit/shadowStore.test.ts` does, and the store object
 * itself is passed to `settleTakenPaths` unchanged. That is deliberate — it is what proves the
 * structural `SettleStore` port actually accepts `ShadowStore` rather than only a hand-written
 * stub that happens to match the interface.
 *
 * `settlePaths`' own normalisation is covered in isolation by `test/unit/settlePaths.test.ts`;
 * this file is about what a take DOES to a session's records.
 */

/** How many times each `SettleStore` method was called — see `counting` below. */
interface CallCounts {
  hasChanges: number;
  changes: number;
  clear: number;
  settle: number;
}

/**
 * A counting delegate over a real store: it forwards every call unchanged and only tallies them.
 *
 * Used exclusively where a test has to observe that a method was NOT called (the `hasChanges`
 * guard). It is a delegate rather than a stub on purpose — replacing the store would stop the
 * assertion saying anything about the real one's behaviour, and this repo's unit tests mock
 * nothing external.
 */
function counting(inner: SettleStore): { store: SettleStore; counts: CallCounts } {
  const counts: CallCounts = { hasChanges: 0, changes: 0, clear: 0, settle: 0 };
  const store: SettleStore = {
    hasChanges: (projectId) => {
      counts.hasChanges += 1;
      return inner.hasChanges(projectId);
    },
    changes: (projectId) => {
      counts.changes += 1;
      return inner.changes(projectId);
    },
    clear: (projectId) => {
      counts.clear += 1;
      return inner.clear(projectId);
    },
    settle: (projectId, paths, fold) => {
      counts.settle += 1;
      return inner.settle(projectId, paths, fold);
    },
  };
  return { store, counts };
}

/**
 * `settleTakenPaths`' guard selector, named after the call site each value belongs to rather than
 * passed as a bare boolean.
 *
 * `commit` calls it twice: once in the `NothingToCommitError` rescue, which has always guarded on
 * `hasChanges`, and once after a commit has landed, which never has. They differ in exactly one
 * case — an `"all"` take of the whole tree by a session that tracks nothing — and the extraction
 * preserves both rather than unifying them, because `clear` unlinks `shadow.json` and "absent"
 * versus "readable and empty" is a distinction `ShadowStore.peerEntries` is being taught to keep
 * (issue #78, finding 3).
 */
const RESCUE = { requireTracked: true } as const;
const POST_COMMIT = { requireTracked: false } as const;

describe('commitSettle — what a deliberate "all"/"paths" take settles', () => {
  const PROJECT = 'demo';
  /** Never touched on disk: the store reaches HEAD only through the injected reader below. */
  const DIR = '/clone';

  let workspace: string;
  /** Fake HEAD, keyed by relative path, holding raw bytes (as the real GitService reader does). */
  let head: Map<string, Buffer>;

  const setHead = (rel: string, content: string): void => {
    head.set(rel, Buffer.from(content, 'utf8'));
  };

  /**
   * A real `ShadowStore` for one session id. `insensitive` models the clone's `core.ignorecase`
   * (the store's 7th constructor parameter): on such a clone `record` folds a new key onto an
   * existing entry differing only in ASCII case, so two case-differing keys never coexist.
   */
  const makeStore = (sessionId: string, insensitive = false): ShadowStore =>
    new ShadowStore(
      workspace,
      sessionId,
      (_dir, rel) => Promise.resolve(head.get(rel) ?? null),
      Date.now,
      undefined,
      undefined,
      () => Promise.resolve(insensitive),
    );

  /**
   * A fresh session (its own directory under the workspace) holding one recorded edit per entry,
   * so each test starts from independent records without a second temp dir.
   */
  const seeded = async (
    sessionId: string,
    files: Array<[rel: string, content: string]>,
    insensitive = false,
  ): Promise<ShadowStore> => {
    const store = makeStore(sessionId, insensitive);
    for (const [rel, content] of files) {
      setHead(rel, 'original\n');
      await store.record(PROJECT, DIR, rel, 'original\n', content);
    }
    return store;
  };

  const trackedPaths = async (store: ShadowStore): Promise<string[]> =>
    (await store.changes(PROJECT)).map((c) => c.path);

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-settle-'));
    head = new Map();
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  /**
   * Issue #66 item 2. Both entries here are ones git stages NOTHING for: `main.tex`'s content is
   * already at HEAD (a `push` with `message`, or a hand revert, got there first) and `stuck.tex`
   * is `unrecorded`, which `refresh` deliberately never advances or settles. Left alone, both keep
   * the default scope refusing forever — the wedge whose only remaining exit is this take.
   */
  describe('an entry git would never stage is still settled by the take', () => {
    /** Seeds the two wedged entries described above. */
    const seedWedged = async (sessionId: string): Promise<ShadowStore> => {
      const store = await seeded(sessionId, [['main.tex', 'edited\n']]);
      // The content this session edited is now exactly what HEAD holds, so `git add` finds
      // nothing to stage for it. Nothing in `settleTakenPaths` reads HEAD — that is precisely the
      // point being pinned: the take settles by requested-path coverage, not by git's verdict.
      setHead('main.tex', 'edited\n');
      // A permanently wedged entry: `markUnrecorded` flags it conflicted + unrecorded, and
      // `refresh` skips it forever. Only a deliberate take or a discard ends that state.
      await store.markUnrecorded(PROJECT, 'stuck.tex');
      return store;
    };

    it('scope "all" with no paths clears every tracked entry, wedged ones included', async () => {
      const store = await seedWedged('a');
      expect(await trackedPaths(store)).toEqual(['main.tex', 'stuck.tex']);

      const settled = await settleTakenPaths(
        store,
        PROJECT,
        { scope: 'all', paths: undefined },
        RESCUE,
      );

      // The `clear` route: everything the session tracked comes back, and the session is left
      // holding nothing — not "nothing that git staged", which would be neither entry.
      expect(settled.sort()).toEqual(['main.tex', 'stuck.tex']);
      expect(await store.changes(PROJECT)).toEqual([]);
      expect(await store.hasChanges(PROJECT)).toBe(false);
    });

    it('scope "all" naming the path settles that entry through the coverage route', async () => {
      const store = await seedWedged('b');

      const settled = await settleTakenPaths(
        store,
        PROJECT,
        {
          scope: 'all',
          paths: ['main.tex'],
        },
        RESCUE,
      );

      // The `settle` route, not `clear`: only the named entry goes, the other is untouched.
      expect(settled).toEqual(['main.tex']);
      expect(await trackedPaths(store)).toEqual(['stuck.tex']);
    });

    it('settleNothingToCommit reports the settled paths rather than refusing', async () => {
      const store = await seedWedged('c');

      // git reported nothing to stage, so `commit` is holding a `NothingToCommitError`. Because
      // the take settled something, the caller reports `committed: false` with these under
      // `settled` instead of rethrowing — the only way out that is neither an empty commit nor a
      // discard.
      const settled = await settleNothingToCommit(store, PROJECT, {
        scope: 'all',
        paths: undefined,
      });
      expect(settled).not.toBeNull();
      expect(settled?.sort()).toEqual(['main.tex', 'stuck.tex']);
    });
  });

  /**
   * Issue #66 finding 5, pinned explicitly because it reads like a bug until you know why:
   *
   *   SETTLING IS BY REQUESTED-PATH COVERAGE, NEVER BY WHAT GIT STAGED.
   *
   * `notes/ig.md` here models a file git ignores. Nothing at this layer knows or cares about
   * `.gitignore` — that is the point: the take is given the paths the caller REQUESTED, so the
   * entry is dropped even though the commit that just landed does not contain it. A version that
   * settled on the committed file list instead would leave this entry wedged forever, with the
   * session's default scope refusing on a file it can never commit.
   */
  describe('coverage decides, not the committed file list', () => {
    const seedIgnored = (sessionId: string): Promise<ShadowStore> =>
      seeded(sessionId, [
        ['notes/ig.md', 'a local note\n'],
        ['notesx/a.tex', 'a sibling directory that merely shares a prefix\n'],
        ['other/x.tex', 'unrelated work this session still owns\n'],
      ]);

    it('a "paths" request naming a directory settles an entry git would never stage', async () => {
      const store = await seedIgnored('a');

      const settled = await settleTakenPaths(
        store,
        PROJECT,
        {
          scope: 'paths',
          paths: ['notes'],
        },
        RESCUE,
      );

      expect(settled).toEqual(['notes/ig.md']);
    });

    it('leaves a sibling entry outside the named directory alone', async () => {
      const store = await seedIgnored('b');

      await settleTakenPaths(store, PROJECT, { scope: 'paths', paths: ['notes'] }, RESCUE);

      // A take settles what it named and nothing else — dropping `other/x.tex` would throw away
      // this session's proof of ownership over lines it has not committed.
      expect(await trackedPaths(store)).toContain('other/x.tex');
    });

    it('matches whole path segments — "notes" never swallows "notesx"', async () => {
      const store = await seedIgnored('c');

      const settled = await settleTakenPaths(
        store,
        PROJECT,
        {
          scope: 'paths',
          paths: ['notes'],
        },
        RESCUE,
      );

      // Segment matching, not prefix matching (`coversPath`). A naive `startsWith` would settle a
      // neighbouring directory the commit never touched.
      expect(settled).not.toContain('notesx/a.tex');
      expect(await trackedPaths(store)).toContain('notesx/a.tex');
    });
  });

  /**
   * The other half of the rescue: a request that covers nothing this session tracks is a genuine
   * "nothing to commit", not a wedge. `settleNothingToCommit` must say so with `null` — never
   * `[]` — so the caller rethrows the original `NothingToCommitError` instead of claiming a
   * settlement it did not make. `settleTakenPaths` returns `[]` for the identical input, which is
   * the ONLY difference between the two functions; each case below pins both.
   */
  describe('a request covering nothing this session tracks still refuses', () => {
    it('returns null for a named path this session does not track', async () => {
      // A non-empty store, so `null` cannot be an artefact of there being no records at all.
      const store = await seeded('a', [['main.tex', 'edited\n']]);

      const req: SettleRequest = { scope: 'paths', paths: ['sections/intro.tex'] };
      expect(await settleNothingToCommit(store, PROJECT, req)).toBeNull();
      expect(await settleTakenPaths(store, PROJECT, req, RESCUE)).toEqual([]);
      expect(await trackedPaths(store)).toEqual(['main.tex']);
    });

    it('returns null for scope "all" on a store with no entries, and never calls clear', async () => {
      const real = makeStore('b');
      const { store, counts } = counting(real);

      expect(
        await settleNothingToCommit(store, PROJECT, { scope: 'all', paths: undefined }),
      ).toBeNull();
      expect(
        await settleTakenPaths(store, PROJECT, { scope: 'all', paths: undefined }, RESCUE),
      ).toEqual([]);

      // The `hasChanges` guard. An empty-tree "all" with no shadow entries at all is a plain
      // "nothing to commit", not a wedge to clear — so `clear` must not even be reached. Calling
      // it on an untracked store is exactly the shape of change this refactor must not have made:
      // `clear` wipes `shadow/`, `base/` and `shadow.json` for the session.
      expect(counts.clear).toBe(0);
      expect(counts.hasChanges).toBeGreaterThan(0);
    });
  });

  /**
   * The other side of that guard, and the reason it is a parameter at all.
   *
   * The post-commit take has never consulted `hasChanges`: the commit has already landed and the
   * whole tree was taken deliberately, so it clears unconditionally. Pinned here because the
   * difference is invisible in the return value — both flags yield `[]` for an untracked session —
   * and shows up only as a `clear` call, i.e. only on disk. A refactor that "simplified" the two
   * call sites into one guarded helper would pass every other test in this file.
   */
  describe('the post-commit take clears unconditionally, as it always has', () => {
    it('calls clear for scope "all" on a session that tracks nothing', async () => {
      const { store, counts } = counting(makeStore('a'));

      const settled = await settleTakenPaths(
        store,
        PROJECT,
        { scope: 'all', paths: undefined },
        POST_COMMIT,
      );

      // Nothing to report either way — the observable difference is the `clear` call itself.
      expect(settled).toEqual([]);
      // `clear` unlinks `shadow.json`. Whether a peer's index is absent or readable-and-empty is a
      // distinction `peerEntries` is being taught to keep (issue #78, finding 3), so skipping this
      // unlink would quietly change what a peer reports the moment it does.
      expect(counts.clear).toBe(1);
      // ...and the guard is not merely satisfied but never consulted under this flag.
      expect(counts.hasChanges).toBe(0);
    });

    it('settles a tracked session exactly as the rescue does', async () => {
      const store = await seeded('b', [['main.tex', 'edited\n']]);

      const settled = await settleTakenPaths(
        store,
        PROJECT,
        { scope: 'all', paths: undefined },
        POST_COMMIT,
      );

      // The flag changes nothing once the session actually tracks something: same paths back,
      // same empty store afterwards. It is the untracked case alone that the two callers split on.
      expect(settled).toEqual(['main.tex']);
      expect(await store.hasChanges(PROJECT)).toBe(false);
    });
  });

  /**
   * The folded twin of the coverage decision. `fold` is a PARAMETER the caller supplies — `commit`
   * passes `foldCase` exactly when `GitService.isCaseInsensitive` says the clone has
   * `core.ignorecase` — and this module never infers it. Each folded case below is paired with its
   * byte-exact twin: the same store, the same request, `fold` omitted, settling nothing. Without
   * the fold a `Notes.txt` entry survives a commit that staged it as `notes.txt` and stays wedged
   * forever; with the fold applied unconditionally, a case-sensitive repository would settle
   * records for a file the commit never touched.
   */
  describe('the fold is the caller’s decision, never inferred', () => {
    it('settles a "Notes.txt" entry for a request naming "notes.txt" when folded', async () => {
      const store = await seeded('a', [['Notes.txt', 'edited\n']], true);

      const settled = await settleTakenPaths(
        store,
        PROJECT,
        {
          scope: 'paths',
          paths: ['notes.txt'],
          fold: foldCase,
        },
        RESCUE,
      );

      // The dropped path is the session's OWN spelling, not the request's.
      expect(settled).toEqual(['Notes.txt']);
      expect(await trackedPaths(store)).toEqual([]);
    });

    it('byte-exact twin: the same "notes.txt" request without fold settles nothing', async () => {
      const store = await seeded('b', [['Notes.txt', 'edited\n']], true);

      const req: SettleRequest = { scope: 'paths', paths: ['notes.txt'] };
      expect(await settleTakenPaths(store, PROJECT, req, RESCUE)).toEqual([]);
      expect(await settleNothingToCommit(store, PROJECT, req)).toBeNull();
      expect(await trackedPaths(store)).toEqual(['Notes.txt']);
    });

    it('settles a "Sub/new.tex" entry for a request naming the directory "sub" when folded', async () => {
      const store = await seeded('c', [['Sub/new.tex', 'edited\n']], true);

      const settled = await settleTakenPaths(
        store,
        PROJECT,
        {
          scope: 'paths',
          paths: ['sub'],
          fold: foldCase,
        },
        RESCUE,
      );

      expect(settled).toEqual(['Sub/new.tex']);
      expect(await trackedPaths(store)).toEqual([]);
    });

    it('byte-exact twin: the same "sub" directory request without fold settles nothing', async () => {
      const store = await seeded('d', [['Sub/new.tex', 'edited\n']], true);

      const req: SettleRequest = { scope: 'paths', paths: ['sub'] };
      expect(await settleTakenPaths(store, PROJECT, req, RESCUE)).toEqual([]);
      expect(await settleNothingToCommit(store, PROJECT, req)).toBeNull();
      expect(await trackedPaths(store)).toEqual(['Sub/new.tex']);
    });
  });

  /**
   * `settlePaths` maps `"."`/`""`/`"./"` to `'everything'`, because `git add "."` means the whole
   * tree and `coversPath` covers nothing for those spellings. That widening is licensed for scope
   * "all" ONLY. A "paths" take must never settle what it did not name.
   *
   * The "paths" half is unreachable through the tool today — `commitPaths` refuses an empty or
   * `"."`-shaped list before anything is committed — so it is pinned here purely as a fail-safe:
   * if that upstream refusal is ever relaxed, this guard is what stops a narrow request from
   * silently clearing every record the session holds.
   */
  describe('a "."-shaped paths list never widens a "paths" take', () => {
    const seedTwo = (sessionId: string): Promise<ShadowStore> =>
      seeded(sessionId, [
        ['main.tex', 'edited\n'],
        ['other/x.tex', 'also edited\n'],
      ]);

    it('scope "paths" with ["."] settles nothing and leaves every entry intact', async () => {
      const store = await seedTwo('a');

      const req: SettleRequest = { scope: 'paths', paths: ['.'] };
      expect(await settleTakenPaths(store, PROJECT, req, RESCUE)).toEqual([]);
      expect(await settleNothingToCommit(store, PROJECT, req)).toBeNull();
      expect((await trackedPaths(store)).sort()).toEqual(['main.tex', 'other/x.tex']);
    });

    it('scope "all" with ["."] clears everything on the same store', async () => {
      const store = await seedTwo('b');

      const settled = await settleTakenPaths(
        store,
        PROJECT,
        { scope: 'all', paths: ['.'] },
        RESCUE,
      );

      expect(settled.sort()).toEqual(['main.tex', 'other/x.tex']);
      expect(await store.hasChanges(PROJECT)).toBe(false);
    });
  });
});
