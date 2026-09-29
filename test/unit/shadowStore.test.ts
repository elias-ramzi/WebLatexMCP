import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import {
  ShadowStore,
  latestTouch,
  type ShadowChange,
  type PeerShadowEntry,
  type CleanHasher,
  type HeadShaReader,
} from '../../src/services/shadowStore.js';
import { sessionDir } from '../../src/lib/sessionPaths.js';
import { foldCase } from '../../src/lib/caseFold.js';

/** Assert the store tracks exactly one change, and return it. */
function only(changes: ShadowChange[]): ShadowChange {
  expect(changes).toHaveLength(1);
  return changes[0] as ShadowChange;
}

/**
 * Drives the store with an in-memory stand-in for HEAD, so the merge bookkeeping is tested on its
 * own — the git-backed behaviour is covered by test/integration/sessionCommit.test.ts.
 */
describe('ShadowStore', () => {
  const PROJECT = 'demo';
  const DIR = '/clone';
  const REL = 'sections/method.tex';

  const BASE = ['\\section{Method}', 'Alpha line.', '', 'Beta line.', ''].join('\n');

  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0xfd]);

  let workspace: string;
  /** Fake HEAD, keyed by relative path, holding raw bytes (as the real GitService reader does). */
  let head: Map<string, Buffer>;

  const setHead = (rel: string, content: string | Buffer): void => {
    head.set(rel, Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'));
  };

  const makeStore = (sessionId: string): ShadowStore =>
    new ShadowStore(workspace, sessionId, (_dir, rel) => Promise.resolve(head.get(rel) ?? null));

  /** Same as `makeStore`, but with an injectable clock for `touchedAt` assertions. */
  const makeClockedStore = (sessionId: string, now: () => number): ShadowStore =>
    new ShadowStore(
      workspace,
      sessionId,
      (_dir, rel) => Promise.resolve(head.get(rel) ?? null),
      now,
    );

  /**
   * A fake `CleanHasher` standing in for `GitService.cleanBlobId`: it normalises CRLF to LF
   * (decoding as UTF-8, which is fine for the ASCII fixtures these tests use) so two byte strings
   * that only differ in line endings hash equal — exactly what a `* text=auto` clean filter does
   * for git's real `hash-object`, without spawning git.
   */
  const crlfNormalizingHasher: CleanHasher = (_dir, _rel, bytes) =>
    Promise.resolve(bytes.toString('utf8').replace(/\r\n/g, '\n'));

  /** Same as `makeStore`, but with the fake clean hasher wired in. */
  const makeHashingStore = (sessionId: string): ShadowStore =>
    new ShadowStore(
      workspace,
      sessionId,
      (_dir, rel) => Promise.resolve(head.get(rel) ?? null),
      undefined,
      crlfNormalizingHasher,
    );

  /**
   * Fake HEAD *commit sha*, kept separate from the fake HEAD *content* map (`head`) above: real
   * git only moves the sha when a commit lands, so a test can change `head`'s bytes (simulating a
   * peer landing new content) independently of whether it also "commits" (bumps this). The
   * conflictHead memo (issue #66 item 6) keys off exactly this sha, not off the content.
   */
  let headCommit: string;

  /** Wraps a `CleanHasher` to count how many times it is actually invoked (i.e. spawned). */
  const countingHasher = (base: CleanHasher): { hasher: CleanHasher; count: () => number } => {
    let calls = 0;
    const hasher: CleanHasher = async (dir, rel, bytes) => {
      calls += 1;
      return base(dir, rel, bytes);
    };
    return { hasher, count: () => calls };
  };

  const identityHasher: CleanHasher = (_dir, _rel, bytes) =>
    Promise.resolve(bytes.toString('utf8'));

  /** Same as `makeStore`, but with a `CleanHasher` and a `HeadShaReader` wired in, for exercising
   * the conflictHead memo. */
  const makeMemoStore = (sessionId: string, hasher: CleanHasher): ShadowStore =>
    new ShadowStore(
      workspace,
      sessionId,
      (_dir, rel) => Promise.resolve(head.get(rel) ?? null),
      undefined,
      hasher,
      ((_dir: string) => Promise.resolve(headCommit)) as HeadShaReader,
    );

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-shadow-'));
    head = new Map();
    setHead(REL, BASE);
    headCommit = 'c0';
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('records an edit as the file at HEAD plus only that edit', async () => {
    const store = makeStore('a');
    const after = BASE.replace('Alpha line.', 'Alpha line, edited by A.');
    await store.record(PROJECT, DIR, REL, BASE, after);

    const change = only(await store.changes(PROJECT));
    expect(change.path).toBe(REL);
    expect(change.content).toBe(after);
    expect(change.base).toBe(BASE);
    expect(change.conflicted).toBe(false);
  });

  it("keeps a peer's edit out of this session's shadow", async () => {
    const a = makeStore('a');
    const b = makeStore('b');

    // A edits the working tree first.
    const afterA = BASE.replace('Alpha line.', 'Alpha line, by A.');
    await a.record(PROJECT, DIR, REL, BASE, afterA);

    // B then edits a different paragraph — its "before" already contains A's line, because that
    // is what is on disk. B's shadow must still hold only B's change.
    const afterB = afterA.replace('Beta line.', 'Beta line, by B.');
    await b.record(PROJECT, DIR, REL, afterA, afterB);

    const changeB = only(await b.changes(PROJECT));
    expect(changeB.content).toContain('Beta line, by B.');
    expect(changeB.content).not.toContain('by A.');
    expect(changeB.content).toBe(BASE.replace('Beta line.', 'Beta line, by B.'));

    // ...and A's is untouched by B.
    const changeA = only(await a.changes(PROJECT));
    expect(changeA.content).toBe(afterA);
  });

  it('accumulates several edits by the same session', async () => {
    const store = makeStore('a');
    const first = BASE.replace('Alpha line.', 'Alpha one.');
    const second = first.replace('Beta line.', 'Beta two.');
    await store.record(PROJECT, DIR, REL, BASE, first);
    await store.record(PROJECT, DIR, REL, first, second);

    const change = only(await store.changes(PROJECT));
    expect(change.content).toBe(second);
  });

  it('drops a change once HEAD contains it, and re-anchors one that it does not', async () => {
    const a = makeStore('a');
    const b = makeStore('b');
    const afterA = BASE.replace('Alpha line.', 'Alpha line, by A.');
    const afterB = afterA.replace('Beta line.', 'Beta line, by B.');
    await a.record(PROJECT, DIR, REL, BASE, afterA);
    await b.record(PROJECT, DIR, REL, afterA, afterB);

    // A commits: HEAD now holds A's line and not B's.
    setHead(REL, afterA);

    const refreshedA = await a.refresh(PROJECT, DIR);
    expect(refreshedA.settled).toEqual([REL]);
    expect(await a.changes(PROJECT)).toEqual([]);
    expect(await a.hasChanges(PROJECT)).toBe(false);

    // B's change is still outstanding, now expressed against the new HEAD.
    const refreshedB = await b.refresh(PROJECT, DIR);
    expect(refreshedB.advanced).toEqual([REL]);
    expect(refreshedB.conflicted).toEqual([]);
    const changeB = only(await b.changes(PROJECT));
    expect(changeB.base).toBe(afterA);
    expect(changeB.content).toBe(afterB); // A's line + B's line
  });

  it('marks a change conflicted when HEAD moved on the same lines', async () => {
    const a = makeStore('a');
    const b = makeStore('b');
    await a.record(PROJECT, DIR, REL, BASE, BASE.replace('Alpha line.', 'Alpha per A.'));
    await b.record(PROJECT, DIR, REL, BASE, BASE.replace('Alpha line.', 'Alpha per B.'));

    setHead(REL, BASE.replace('Alpha line.', 'Alpha per A.'));

    const refreshed = await b.refresh(PROJECT, DIR);
    expect(refreshed.conflicted).toEqual([REL]);
    const change = only(await b.changes(PROJECT));
    expect(change.conflicted).toBe(true);
    // The shadow is left exactly as it was — nothing is resolved on the session's behalf.
    expect(change.content).toBe(BASE.replace('Alpha line.', 'Alpha per B.'));
  });

  it('keeps a conflicted file flagged through later edits, rather than reviving a stale shadow', async () => {
    const b = makeStore('b');
    const mine = BASE.replace('Alpha line.', 'Alpha per B.');
    await b.record(PROJECT, DIR, REL, BASE, mine);
    const landed = BASE.replace('Alpha line.', 'Alpha per A.');
    setHead(REL, landed);
    await b.refresh(PROJECT, DIR);
    expect(only(await b.changes(PROJECT)).conflicted).toBe(true);

    // Editing an untouched part of the same file must not clear the flag: the shadow is still
    // anchored to the pre-A base, so committing it would quietly revert A's line.
    const elsewhere = landed.replace('Beta line.', 'Beta line, by B.');
    await b.record(PROJECT, DIR, REL, landed, elsewhere);

    const change = only(await b.changes(PROJECT));
    expect(change.conflicted).toBe(true);
    expect(change.content).toBe(mine); // untouched — never silently advanced
  });

  it('tracks a new file with no base', async () => {
    const store = makeStore('a');
    await store.record(PROJECT, DIR, 'sections/new.tex', null, 'fresh\n');
    const change = only(await store.changes(PROJECT));
    expect(change.path).toBe('sections/new.tex');
    expect(change.base).toBeNull();
    expect(change.content).toBe('fresh\n');
  });

  it('tracks a deletion as a null content', async () => {
    const store = makeStore('a');
    await store.record(PROJECT, DIR, REL, BASE, null);
    const change = only(await store.changes(PROJECT));
    expect(change.content).toBeNull();
    expect(change.base).toBe(BASE);
  });

  it('settles a deletion once HEAD no longer has the file', async () => {
    const store = makeStore('a');
    await store.record(PROJECT, DIR, REL, BASE, null);
    head.delete(REL);
    const refreshed = await store.refresh(PROJECT, DIR);
    expect(refreshed.settled).toEqual([REL]);
    expect(await store.changes(PROJECT)).toEqual([]);
  });

  it('keys nested paths POSIX-style, matching what git and the tools report', async () => {
    const store = makeStore('a');
    await store.record(PROJECT, DIR, path.join('sections', 'new.tex'), null, 'x\n');
    expect(only(await store.changes(PROJECT)).path).toBe('sections/new.tex');
  });

  describe('clear', () => {
    it('drops the shadow state but leaves the session record (heartbeat) in place', async () => {
      // `commit scope: "all"` calls this after every commit; wiping the whole session directory
      // would delete `session.json` and make the session look dead to peers until the next
      // throttled heartbeat.
      const store = makeStore('a');
      await store.record(PROJECT, DIR, REL, BASE, `${BASE}edited\n`);
      const dir = sessionDir(workspace, PROJECT, 'a');
      await writeFile(path.join(dir, 'session.json'), '{"heartbeatAt":"now"}');

      await store.clear(PROJECT);

      expect(await store.hasChanges(PROJECT)).toBe(false);
      expect(await readFile(path.join(dir, 'session.json'), 'utf8')).toBe('{"heartbeatAt":"now"}');
      await expect(readFile(path.join(dir, 'shadow.json'))).rejects.toThrow();
    });
  });

  describe('settle', () => {
    it('drops an entry named exactly, leaving others untouched', async () => {
      const store = makeStore('a');
      await store.record(PROJECT, DIR, REL, BASE, `${BASE}edited\n`);
      await store.record(PROJECT, DIR, 'notes.tex', null, 'fresh\n');

      const dropped = await store.settle(PROJECT, [REL]);
      expect(dropped).toEqual([REL]);

      const remaining = await store.changes(PROJECT);
      expect(remaining.map((c) => c.path)).toEqual(['notes.tex']);
    });

    it('strips a leading "./" the way the tool layer does, so "./a.tex" settles "a.tex"', async () => {
      const store = makeStore('a');
      await store.record(PROJECT, DIR, 'a.tex', null, 'a\n');
      const dropped = await store.settle(PROJECT, ['./a.tex']);
      expect(dropped).toEqual(['a.tex']);
      expect(await store.changes(PROJECT)).toEqual([]);
    });

    it('drops every entry under a covering directory', async () => {
      const store = makeStore('a');
      await store.record(PROJECT, DIR, 'figures/a.tex', null, 'a\n');
      await store.record(PROJECT, DIR, 'figures/sub/b.tex', null, 'b\n');
      await store.record(PROJECT, DIR, 'notes.tex', null, 'fresh\n');

      const dropped = await store.settle(PROJECT, ['figures']);
      expect(dropped.sort()).toEqual(['figures/a.tex', 'figures/sub/b.tex']);

      const remaining = await store.changes(PROJECT);
      expect(remaining.map((c) => c.path)).toEqual(['notes.tex']);
    });

    it('drops a conflicted/unrecorded entry too — settling does not check the flag', async () => {
      const store = makeStore('a');
      await store.markUnrecorded(PROJECT, REL);
      expect(only(await store.changes(PROJECT)).conflicted).toBe(true);

      const dropped = await store.settle(PROJECT, [REL]);
      expect(dropped).toEqual([REL]);
      expect(await store.changes(PROJECT)).toEqual([]);
      expect(await store.hasChanges(PROJECT)).toBe(false);
    });

    it('returns [] and touches nothing when no path covers any entry', async () => {
      const store = makeStore('a');
      await store.record(PROJECT, DIR, REL, BASE, `${BASE}edited\n`);

      const dropped = await store.settle(PROJECT, ['figures']);
      expect(dropped).toEqual([]);
      expect(only(await store.changes(PROJECT)).path).toBe(REL);
    });

    it('removes the shadow/base files on disk, not just the index entry', async () => {
      const store = makeStore('a');
      await store.record(PROJECT, DIR, REL, BASE, `${BASE}edited\n`);

      const shadowPath = path.join(sessionDir(workspace, PROJECT, 'a'), 'shadow', REL);
      const basePath = path.join(sessionDir(workspace, PROJECT, 'a'), 'base', REL);
      await expect(readFile(shadowPath)).resolves.toBeDefined();
      await expect(readFile(basePath)).resolves.toBeDefined();

      await store.settle(PROJECT, [REL]);

      await expect(readFile(shadowPath)).rejects.toThrow();
      await expect(readFile(basePath)).rejects.toThrow();
    });

    describe('case fold (issue #66)', () => {
      it('drops a differently-cased entry when a fold is passed, and returns its own spelling', async () => {
        const store = makeStore('a');
        await store.record(PROJECT, DIR, 'Notes.txt', null, 'fresh\n');

        const dropped = await store.settle(PROJECT, ['notes.txt'], foldCase);
        expect(dropped).toEqual(['Notes.txt']);
        expect(await store.changes(PROJECT)).toEqual([]);
      });

      it('just outside: without a fold, a differently-cased request drops nothing', async () => {
        const store = makeStore('a');
        await store.record(PROJECT, DIR, 'Notes.txt', null, 'fresh\n');

        const dropped = await store.settle(PROJECT, ['notes.txt']);
        expect(dropped).toEqual([]);
        expect(only(await store.changes(PROJECT)).path).toBe('Notes.txt');
      });

      it('a directory request drops a differently-cased entry underneath it, with a fold', async () => {
        const store = makeStore('a');
        await store.record(PROJECT, DIR, 'Sub/x.tex', null, 'x\n');

        const dropped = await store.settle(PROJECT, ['sub'], foldCase);
        expect(dropped).toEqual(['Sub/x.tex']);
        expect(await store.changes(PROJECT)).toEqual([]);
      });
    });
  });

  it('clearAll drops every session, not just this one', async () => {
    const a = makeStore('a');
    const b = makeStore('b');
    await a.record(PROJECT, DIR, REL, BASE, `${BASE}A\n`);
    await b.record(PROJECT, DIR, REL, BASE, `${BASE}B\n`);

    await a.clearAll(PROJECT);
    expect(await a.hasChanges(PROJECT)).toBe(false);
    expect(await b.hasChanges(PROJECT)).toBe(false);
  });

  describe('settleAll (issue #66)', () => {
    it('settles only the named path, in every session, leaving unrelated entries in every session intact', async () => {
      const one = makeStore('one');
      const two = makeStore('two');
      await one.record(PROJECT, DIR, 'a.tex', null, 'a\n');
      await two.record(PROJECT, DIR, 'b.tex', null, 'b\n');
      await two.record(PROJECT, DIR, 'sub/c.tex', null, 'c\n');

      // Callable from either store — settleAll does not depend on the calling store's own
      // sessionId, only on the workspace/project it was constructed with.
      const dropped = await one.settleAll(PROJECT, ['b.tex']);
      expect(dropped).toEqual(['b.tex']);

      expect((await one.peerEntries(PROJECT, 'one'))?.map((e) => e.path)).toEqual(['a.tex']);
      expect((await one.peerEntries(PROJECT, 'two'))?.map((e) => e.path).sort()).toEqual([
        'sub/c.tex',
      ]);
    });

    it('drops a differently-cased entry only when a fold is passed', async () => {
      const one = makeStore('one');
      const two = makeStore('two');
      await one.record(PROJECT, DIR, 'a.tex', null, 'a\n');
      await two.record(PROJECT, DIR, 'b.tex', null, 'b\n');

      const droppedNoFold = await one.settleAll(PROJECT, ['B.TEX']);
      expect(droppedNoFold).toEqual([]);
      expect((await one.peerEntries(PROJECT, 'two'))?.map((e) => e.path)).toEqual(['b.tex']);

      const droppedFolded = await one.settleAll(PROJECT, ['B.TEX'], foldCase);
      expect(droppedFolded).toEqual(['b.tex']);
      expect(await one.peerEntries(PROJECT, 'two')).toEqual([]);
      // Untouched throughout.
      expect((await one.peerEntries(PROJECT, 'one'))?.map((e) => e.path)).toEqual(['a.tex']);
    });

    it('returns [] and touches nothing when there is no session state at all yet', async () => {
      const store = makeStore('a');
      await expect(store.settleAll(PROJECT, ['anything'])).resolves.toEqual([]);
    });
  });

  it('stamps touchedAt from the injected clock on every record, updating on later edits', async () => {
    let clock = 1_700_000_000_000;
    const store = makeClockedStore('a', () => clock);
    const v1 = BASE.replace('Alpha line.', 'Alpha, v1.');
    await store.record(PROJECT, DIR, REL, BASE, v1);

    const firstEntries = await store.peerEntries(PROJECT, 'a');
    expect(firstEntries).toEqual([
      { path: REL, deleted: false, conflicted: false, touchedAt: new Date(clock).toISOString() },
    ]);

    clock = 1_700_000_100_000; // advance the clock before the second edit
    const v2 = v1.replace('Beta line.', 'Beta, v2.');
    await store.record(PROJECT, DIR, REL, v1, v2);

    const secondEntries = await store.peerEntries(PROJECT, 'a');
    expect(secondEntries).toEqual([
      { path: REL, deleted: false, conflicted: false, touchedAt: new Date(clock).toISOString() },
    ]);
  });

  it('stamps touchedAt even on the conflicted early-return branch of record', async () => {
    let clock = 1_700_000_000_000;
    const a = makeStore('a');
    const b = makeClockedStore('b', () => clock);

    await a.record(PROJECT, DIR, REL, BASE, BASE.replace('Alpha line.', 'Alpha per A.'));
    await b.record(PROJECT, DIR, REL, BASE, BASE.replace('Alpha line.', 'Alpha per B.'));
    setHead(REL, BASE.replace('Alpha line.', 'Alpha per A.'));
    await b.refresh(PROJECT, DIR); // b's entry is now conflicted

    clock = 1_700_000_200_000;
    // b edits again while conflicted: the shadow cannot fold the edit in, but the session did
    // write the file, so touchedAt must still advance.
    const landed = BASE.replace('Alpha line.', 'Alpha per A.');
    await b.record(PROJECT, DIR, REL, landed, landed.replace('Beta line.', 'Beta, by B.'));

    const entries = await b.peerEntries(PROJECT, 'b');
    expect(entries).toEqual([
      { path: REL, deleted: false, conflicted: true, touchedAt: new Date(clock).toISOString() },
    ]);
  });

  it('leaves touchedAt unchanged when refresh carries the shadow onto a moved HEAD', async () => {
    let clock = 1_700_000_000_000;
    const a = makeStore('a');
    const b = makeClockedStore('b', () => clock);

    const afterA = BASE.replace('Alpha line.', 'Alpha line, by A.');
    const afterB = afterA.replace('Beta line.', 'Beta line, by B.');
    await a.record(PROJECT, DIR, REL, BASE, afterA);
    await b.record(PROJECT, DIR, REL, afterA, afterB);

    const beforeRefresh = await b.peerEntries(PROJECT, 'b');
    const stampedAt = beforeRefresh?.[0]?.touchedAt;
    expect(stampedAt).toBe(new Date(clock).toISOString());

    // A commits, moving HEAD out from under B; the clock advances in between, but refresh must
    // not touch touchedAt — file mtimes/refresh timing are not a write signal.
    setHead(REL, afterA);
    clock = 1_700_000_999_000;
    const refreshed = await b.refresh(PROJECT, DIR);
    expect(refreshed.advanced).toEqual([REL]);

    const afterRefresh = await b.peerEntries(PROJECT, 'b');
    expect(afterRefresh?.[0]?.touchedAt).toBe(stampedAt);
  });

  it('peerEntries returns [] for a session directory that does not exist', async () => {
    const store = makeStore('a');
    await expect(store.peerEntries(PROJECT, 'nobody')).resolves.toEqual([]);
  });

  it('peerEntries reads another session’s index, filled with path/deleted/conflicted/touchedAt', async () => {
    const clock = 1_700_000_000_000;
    const a = makeStore('a');
    const b = makeClockedStore('b', () => clock);

    await b.record(PROJECT, DIR, REL, BASE, BASE.replace('Alpha line.', 'Alpha per B.'));
    await b.record(PROJECT, DIR, 'sections/new.tex', null, 'fresh\n');
    await b.record(PROJECT, DIR, 'sections/gone.tex', 'old\n', null); // a deletion

    const entries = await a.peerEntries(PROJECT, 'b');
    expect(entries).toEqual([
      {
        path: 'sections/gone.tex',
        deleted: true,
        conflicted: false,
        touchedAt: new Date(clock).toISOString(),
      },
      { path: REL, deleted: false, conflicted: false, touchedAt: new Date(clock).toISOString() },
      {
        path: 'sections/new.tex',
        deleted: false,
        conflicted: false,
        touchedAt: new Date(clock).toISOString(),
      },
    ]);
  });

  describe('markUnrecorded', () => {
    it('flags a fresh path conflicted + unrecorded, with no shadow content', async () => {
      const store = makeStore('a');
      await store.markUnrecorded(PROJECT, REL);

      const change = only(await store.changes(PROJECT));
      expect(change.conflicted).toBe(true);
      expect(change.unrecorded).toBe(true);
      expect(change.content).toBeNull();
    });

    it("peerEntries lists it conflicted, with a touchedAt, for the session's own id", async () => {
      const clock = 1_700_000_000_000;
      const store = makeClockedStore('a', () => clock);
      await store.markUnrecorded(PROJECT, REL);

      const entries = await store.peerEntries(PROJECT, 'a');
      expect(entries).toEqual([
        { path: REL, deleted: false, conflicted: true, touchedAt: new Date(clock).toISOString() },
      ]);
    });

    it('a later record() leaves it conflicted (sticky)', async () => {
      const store = makeStore('a');
      await store.markUnrecorded(PROJECT, REL);

      await store.record(PROJECT, DIR, REL, BASE, BASE.replace('Alpha line.', 'Alpha, later.'));

      const change = only(await store.changes(PROJECT));
      expect(change.conflicted).toBe(true);
      expect(change.unrecorded).toBe(true);
      expect(change.content).toBeNull(); // never folded in — record's conflicted early return
    });

    it('refresh reports it conflicted and does not throw when HEAD has no file for it', async () => {
      const store = makeStore('a');
      await store.markUnrecorded(PROJECT, 'sections/never-existed.tex');

      const refreshed = await store.refresh(PROJECT, DIR);
      // An unrecorded entry is reported conflicted on every refresh, unconditionally — refresh
      // never even reaches the "has HEAD moved" check for it (see the #64 fix): that check says
      // nothing about a shadow that is known to be missing this session's latest write.
      expect(refreshed.conflicted).toEqual(['sections/never-existed.tex']);
      expect(refreshed.settled).toEqual([]);
      expect(refreshed.advanced).toEqual([]);

      const change = only(await store.changes(PROJECT));
      expect(change.conflicted).toBe(true);
      expect(change.unrecorded).toBe(true);
    });

    it('refresh leaves it conflicted and does not throw when HEAD does have the file', async () => {
      const store = makeStore('a');
      await store.markUnrecorded(PROJECT, REL); // HEAD already holds REL (set in beforeEach)

      const refreshed = await store.refresh(PROJECT, DIR);
      expect(refreshed.conflicted).toEqual([REL]);
      expect(refreshed.settled).toEqual([]);

      const change = only(await store.changes(PROJECT));
      expect(change.conflicted).toBe(true);
      expect(change.unrecorded).toBe(true);
    });

    it('refresh does not advance an unrecorded entry even when a non-overlapping HEAD change merges cleanly (#64 regression)', async () => {
      // Reproduces the probe: a write reached the working tree and was folded into the
      // shadow, but a LATER write on the same path failed to record (`markUnrecorded`) — so the
      // shadow is missing that latest edit. A peer's unrelated commit then lands, and a bare
      // three-way merge of the (stale) shadow onto the new HEAD succeeds cleanly, which must NOT
      // be allowed to clear `conflicted`/`unrecorded`: the shadow still lacks the write that failed
      // to record, so staging it would silently drop that edit (and, via `commitContents`, revert
      // it if it happened to already be in the working tree).
      const store = makeStore('a');
      const mine = BASE.replace('Beta line.', 'Beta, MINE.');
      await store.record(PROJECT, DIR, REL, BASE, mine); // shadow now holds "Beta, MINE."
      await store.markUnrecorded(PROJECT, REL); // a later write failed to fold in

      // A peer's commit changes a different line — a change that would merge cleanly onto the
      // stale shadow if `refresh` didn't special-case `unrecorded`.
      const peerLanded = BASE.replace('Alpha line.', 'Alpha, PEER.');
      setHead(REL, peerLanded);

      const refreshed = await store.refresh(PROJECT, DIR);
      expect(refreshed.advanced).toEqual([]);
      expect(refreshed.settled).toEqual([]);
      expect(refreshed.conflicted).toEqual([REL]);

      const change = only(await store.changes(PROJECT));
      expect(change.conflicted).toBe(true);
      expect(change.unrecorded).toBe(true);
      // The shadow is untouched — not merged with the peer's line.
      expect(change.content).toBe(mine);
    });

    it('refresh does not settle/forget an unrecorded entry even when HEAD lands on bytes equal to the shadow (#64 regression)', async () => {
      const store = makeStore('a');
      const mine = BASE.replace('Beta line.', 'Beta, MINE.');
      await store.record(PROJECT, DIR, REL, BASE, mine);
      await store.markUnrecorded(PROJECT, REL);

      // HEAD happens to land on exactly the shadow's bytes (e.g. a peer independently made the
      // same edit) — this must not be read as "our change is what landed", because the shadow is
      // known to be missing this session's latest write.
      setHead(REL, mine);

      const refreshed = await store.refresh(PROJECT, DIR);
      expect(refreshed.settled).toEqual([]);
      expect(refreshed.advanced).toEqual([]);
      expect(refreshed.conflicted).toEqual([REL]);

      const change = only(await store.changes(PROJECT));
      expect(change.conflicted).toBe(true);
      expect(change.unrecorded).toBe(true);
      expect(change.content).toBe(mine);
    });

    it('peerEntries reports conflicted:true for an unrecorded entry even when the raw index has no conflicted field', async () => {
      // Belt-and-braces derivation: write an index by hand with `unrecorded: true` and no
      // `conflicted` field at all, proving peerEntries does not rely solely on the raw flag.
      const dir = sessionDir(workspace, PROJECT, 'raw');
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, 'shadow.json'),
        JSON.stringify({
          entries: {
            [REL]: { deleted: false, baseExists: true, unrecorded: true },
          },
        }),
        'utf8',
      );

      const store = makeStore('a');
      const entries = await store.peerEntries(PROJECT, 'raw');
      expect(entries).toEqual([{ path: REL, deleted: false, conflicted: true, touchedAt: null }]);
    });

    it('on an existing entry, keeps its binary/deleted fields and just flags it', async () => {
      const store = makeStore('a');
      const rel = 'figs/photo.png';
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]);
      await store.record(PROJECT, DIR, rel, null, png);
      const before = only(await store.changes(PROJECT));
      expect(before.binary).toBe(true);
      expect(before.conflicted).toBe(false);

      await store.markUnrecorded(PROJECT, rel);

      const after = only(await store.changes(PROJECT));
      expect(after.binary).toBe(true); // preserved
      expect(after.conflicted).toBe(true);
      expect(after.unrecorded).toBe(true);
      // The shadow bytes this session already recorded are untouched — only the flag changed.
      expect(Buffer.isBuffer(after.content) && Buffer.compare(after.content, png) === 0).toBe(true);
    });
  });

  it('parses a hand-written index missing touchedAt as touchedAt: null', async () => {
    const legacyDir = sessionDir(workspace, PROJECT, 'legacy');
    await mkdir(legacyDir, { recursive: true });
    await writeFile(
      path.join(legacyDir, 'shadow.json'),
      JSON.stringify({
        entries: {
          [REL]: { deleted: false, baseExists: true },
        },
      }),
      'utf8',
    );

    const store = makeStore('a');
    const entries = await store.peerEntries(PROJECT, 'legacy');
    expect(entries).toEqual([{ path: REL, deleted: false, conflicted: false, touchedAt: null }]);
  });

  it('peerEntries returns null for unparsable or malformed shadow.json', async () => {
    const store = makeStore('a');

    const badDir = sessionDir(workspace, PROJECT, 'bad-json');
    await mkdir(badDir, { recursive: true });
    await writeFile(path.join(badDir, 'shadow.json'), 'not json', 'utf8');
    await expect(store.peerEntries(PROJECT, 'bad-json')).resolves.toBeNull();

    const noEntriesDir = sessionDir(workspace, PROJECT, 'no-entries');
    await mkdir(noEntriesDir, { recursive: true });
    await writeFile(path.join(noEntriesDir, 'shadow.json'), JSON.stringify({ foo: 1 }), 'utf8');
    await expect(store.peerEntries(PROJECT, 'no-entries')).resolves.toBeNull();
  });
  describe('binary shadows', () => {
    const PNG_REL = 'figs/photo.png';

    it('survives byte-identically, unlike the text path', async () => {
      const store = makeStore('a');
      await store.record(PROJECT, DIR, PNG_REL, null, PNG);

      const change = only(await store.changes(PROJECT));
      expect(change.binary).toBe(true);
      expect(Buffer.isBuffer(change.content)).toBe(true);
      expect(Buffer.compare(change.content as Buffer, PNG)).toBe(0);
    });

    it('the corruption a binary shadow prevents: the text path mangles the same bytes', async () => {
      const store = makeStore('a');
      // Route the exact same bytes through the *text* path (a plain string write) to show why the
      // binary branch exists: a UTF-8 round trip does not preserve arbitrary bytes.
      await store.record(PROJECT, DIR, PNG_REL, null, PNG.toString('utf8'));

      const change = only(await store.changes(PROJECT));
      expect(change.binary).toBe(false);
      const roundTripped = Buffer.from(change.content as string, 'utf8');
      expect(Buffer.compare(roundTripped, PNG)).not.toBe(0);
    });

    it("a peer's concurrent byte change conflicts rather than merging", async () => {
      const store = makeStore('a');
      await store.record(PROJECT, DIR, PNG_REL, null, PNG);

      // Simulate a peer having changed the working-tree bytes under us: our "before" no longer
      // matches what we last wrote into the shadow.
      const peerBytes = Buffer.from([0x01, 0x02, 0x03]);
      const ourNewBytes = Buffer.from([0x04, 0x05, 0x06]);
      await store.record(PROJECT, DIR, PNG_REL, peerBytes, ourNewBytes);

      const change = only(await store.changes(PROJECT));
      expect(change.conflicted).toBe(true);
      // Nothing was merged and nothing was silently adopted — the shadow is exactly as before.
      expect(Buffer.compare(change.content as Buffer, PNG)).toBe(0);
    });

    it('stays conflicted through a later ordinary write (conflicted stays flagged)', async () => {
      const store = makeStore('a');
      await store.record(PROJECT, DIR, PNG_REL, null, PNG);
      const peerBytes = Buffer.from([0x01, 0x02, 0x03]);
      await store.record(PROJECT, DIR, PNG_REL, peerBytes, Buffer.from([0x04, 0x05, 0x06]));
      expect(only(await store.changes(PROJECT)).conflicted).toBe(true);

      // A further, otherwise-unremarkable binary write must not clear the flag.
      await store.record(PROJECT, DIR, PNG_REL, PNG, Buffer.from([0x07, 0x08, 0x09]));

      const change = only(await store.changes(PROJECT));
      expect(change.conflicted).toBe(true);
      expect(Buffer.compare(change.content as Buffer, PNG)).toBe(0);
    });

    it('refresh conflicts a binary whose HEAD moved, never merging it', async () => {
      const store = makeStore('a');
      await store.record(PROJECT, DIR, PNG_REL, null, PNG);

      setHead(PNG_REL, Buffer.from([0xaa, 0xbb, 0xcc]));
      const refreshed = await store.refresh(PROJECT, DIR);

      expect(refreshed.conflicted).toEqual([PNG_REL]);
      expect(refreshed.advanced).toEqual([]);
      const change = only(await store.changes(PROJECT));
      expect(change.conflicted).toBe(true);
      expect(Buffer.compare(change.content as Buffer, PNG)).toBe(0);
    });

    it('refresh settles a binary whose bytes are what landed', async () => {
      const store = makeStore('a');
      await store.record(PROJECT, DIR, PNG_REL, null, PNG);

      setHead(PNG_REL, PNG);
      const refreshed = await store.refresh(PROJECT, DIR);

      expect(refreshed.settled).toEqual([PNG_REL]);
      expect(await store.changes(PROJECT)).toEqual([]);
    });

    it('a path recorded binary once stays binary even after a later text-shaped write', async () => {
      const store = makeStore('a');
      await store.record(PROJECT, DIR, PNG_REL, null, PNG);
      // A later write with string before/after on the same path — the entry must stay binary.
      await store.record(PROJECT, DIR, PNG_REL, PNG, PNG.toString('utf8'));

      const change = only(await store.changes(PROJECT));
      expect(change.binary).toBe(true);
    });

    it('a pre-existing index with no binary field parses as text', async () => {
      const store = makeStore('a');
      // Write a shadow.json by hand, as an index from before `binary` existed would look.
      const dir = path.join(workspace, '.sessions', PROJECT, 'a');
      await mkdir(path.join(dir, 'shadow', 'sections'), { recursive: true });
      await writeFile(path.join(dir, 'shadow', REL), 'legacy shadow\n', 'utf8');
      await writeFile(
        path.join(dir, 'shadow.json'),
        JSON.stringify({ entries: { [REL]: { deleted: false, baseExists: true } } }, null, 2),
        'utf8',
      );

      const change = only(await store.changes(PROJECT));
      expect(change.binary).toBe(false);
      expect(change.content).toBe('legacy shadow\n');

      // And the text path still works for it: an edit whose "before" matches the shadow applies
      // directly, exactly as it did before `binary` existed.
      await store.record(PROJECT, DIR, REL, 'legacy shadow\n', 'legacy shadow, edited\n');
      const updated = only(await store.changes(PROJECT));
      expect(updated.binary).toBe(false);
      expect(updated.content).toBe('legacy shadow, edited\n');
    });

    it('a later text-shaped write to a path already carrying binary shadow bytes is not a false conflict (the sticky-binary regression)', async () => {
      const store = makeStore('a');
      const svgRel = 'figures/diagram.svg';
      // Bytes that are NOT valid UTF-8 (0xff/0xfe have no valid continuation here) — the case that
      // actually exposes the bug. A text-valid payload would round-trip through toBuffer(before)
      // unchanged and never reproduce the mismatch.
      const svgBytes = Buffer.from([0x3c, 0x73, 0x76, 0x67, 0xff, 0xfe, 0x3e]);
      await store.record(PROJECT, DIR, svgRel, null, svgBytes);

      // FileService.write/applyEdits read the current working-tree content as a *string*
      // (`readFile(abs, 'utf8')`) even for a path whose shadow is sticky-binary. That read is
      // lossy for non-UTF-8 bytes (every invalid byte becomes U+FFFD), so `before` here is exactly
      // what a real text-tool write would supply: the lossily-decoded string, not the true bytes.
      const beforeStr = svgBytes.toString('utf8');
      const afterStr = '<svg>edited</svg>';
      await store.record(PROJECT, DIR, svgRel, beforeStr, afterStr);

      const change = only(await store.changes(PROJECT));
      expect(change.conflicted).toBe(false);
      expect(change.binary).toBe(true);
      expect(Buffer.compare(change.content as Buffer, Buffer.from(afterStr, 'utf8'))).toBe(0);
    });

    it('a genuine Buffer-vs-Buffer collision still conflicts (the string relaxation never applies to a Buffer before)', async () => {
      const store = makeStore('a');
      const svgRel = 'figures/diagram.svg';
      const svgBytes = Buffer.from([0x3c, 0x73, 0x76, 0x67, 0xff, 0xfe, 0x3e]);
      await store.record(PROJECT, DIR, svgRel, null, svgBytes);

      // A genuine binary collision: another binary writer supplies Buffer `before` bytes that do
      // not match the shadow. The relaxed comparison only ever fires when `before` is a string, so
      // this must still conflict.
      const peerBytes = Buffer.from([0x01, 0x02, 0x03]);
      await store.record(PROJECT, DIR, svgRel, peerBytes, Buffer.from([0x04, 0x05, 0x06]));
      expect(only(await store.changes(PROJECT)).conflicted).toBe(true);

      // And conflicted stays flagged through a further write, exactly as elsewhere in this file.
      await store.record(PROJECT, DIR, svgRel, svgBytes, Buffer.from([0x07, 0x08, 0x09]));
      expect(only(await store.changes(PROJECT)).conflicted).toBe(true);
    });
  });

  describe('clean-filter equality (#63)', () => {
    const CRLF_REL = 'figures/diagram.svg';
    const crlf = (s: string): Buffer => Buffer.from(s.replace(/\n/g, '\r\n'), 'utf8');
    const lf = (s: string): Buffer => Buffer.from(s, 'utf8');
    const SVG = '<svg>\n<rect/>\n</svg>\n';

    it('refresh settles a binary entry whose shadow is CRLF when HEAD is the LF-normalised version', async () => {
      const store = makeHashingStore('a');
      await store.record(PROJECT, DIR, CRLF_REL, null, crlf(SVG));
      expect(only(await store.changes(PROJECT)).binary).toBe(true);

      // Simulate `commitContents` having clean-filtered the CRLF bytes to LF when writing HEAD.
      setHead(CRLF_REL, lf(SVG));
      const refreshed = await store.refresh(PROJECT, DIR);

      expect(refreshed.settled).toEqual([CRLF_REL]);
      expect(refreshed.conflicted).toEqual([]);
      expect(await store.changes(PROJECT)).toEqual([]);
    });

    it('refresh settles a text entry whose shadow is CRLF when HEAD is the LF-normalised version', async () => {
      const store = makeHashingStore('a');
      const rel = 'notes.tex';
      await store.record(PROJECT, DIR, rel, null, crlf(SVG).toString('utf8'));
      expect(only(await store.changes(PROJECT)).binary).toBe(false);

      setHead(rel, lf(SVG));
      const refreshed = await store.refresh(PROJECT, DIR);

      expect(refreshed.settled).toEqual([rel]);
      expect(refreshed.conflicted).toEqual([]);
      expect(await store.changes(PROJECT)).toEqual([]);
    });

    it('record on a binary entry accepts a before that differs raw but hashes equal to the shadow', async () => {
      const store = makeHashingStore('a');
      await store.record(PROJECT, DIR, CRLF_REL, null, crlf(SVG));

      // The working tree now (as far as this call is told) holds the LF-normalised bytes — as it
      // would if `commitContents` had just written HEAD and the caller re-read the file off disk
      // before writing again — even though the shadow still holds the original CRLF bytes.
      const after = crlf('<svg>\n<rect fill="red"/>\n</svg>\n');
      await store.record(PROJECT, DIR, CRLF_REL, lf(SVG), after);

      const change = only(await store.changes(PROJECT));
      expect(change.conflicted).toBe(false);
      expect(Buffer.compare(change.content as Buffer, after)).toBe(0);
    });

    it('a before whose normalised content differs still conflicts, even with the hasher present', async () => {
      const store = makeHashingStore('a');
      await store.record(PROJECT, DIR, CRLF_REL, null, crlf(SVG));

      // Genuinely different content (not just line endings) — normalising CRLF->LF does not make
      // this equal to the shadow, so it must still conflict.
      const peerContent = lf('<svg>\n<rect fill="blue"/>\n</svg>\n');
      await store.record(
        PROJECT,
        DIR,
        CRLF_REL,
        peerContent,
        crlf('<svg>\n<rect/>\n<x/>\n</svg>\n'),
      );

      expect(only(await store.changes(PROJECT)).conflicted).toBe(true);
    });

    it('without a hasher, refresh stays byte-exact and still conflicts on a CRLF/LF mismatch', async () => {
      const store = makeStore('a'); // no CleanHasher wired
      await store.record(PROJECT, DIR, CRLF_REL, null, crlf(SVG));

      setHead(CRLF_REL, lf(SVG));
      const refreshed = await store.refresh(PROJECT, DIR);

      expect(refreshed.conflicted).toEqual([CRLF_REL]);
      expect(refreshed.settled).toEqual([]);
    });

    it('a hasher that throws (e.g. an uninstalled filter= driver) fails safe: refresh conflicts rather than rejecting', async () => {
      const throwingHasher: CleanHasher = () =>
        Promise.reject(new Error('git hash-object failed (simulated): unknown filter driver'));
      const store = new ShadowStore(
        workspace,
        'a',
        (_dir, rel) => Promise.resolve(head.get(rel) ?? null),
        undefined,
        throwingHasher,
      );
      const rel = 'notes.tex';
      await store.record(PROJECT, DIR, rel, null, crlf(SVG).toString('utf8'));

      setHead(rel, lf(SVG));
      // Byte-exact comparison already fails (CRLF vs LF), so refresh falls back to the hasher,
      // which throws — this must not reject the call, and must not silently treat the two as
      // equal (settled) either: the honest answer when we cannot vouch for equality is the same
      // as when no hasher was wired at all.
      await expect(store.refresh(PROJECT, DIR)).resolves.toEqual({
        advanced: [],
        conflicted: [rel],
        settled: [],
      });
    });

    it('a hasher that throws makes record() on a binary entry conflict rather than reject', async () => {
      const throwingHasher: CleanHasher = () =>
        Promise.reject(new Error('git hash-object failed (simulated)'));
      const store = new ShadowStore(
        workspace,
        'a',
        (_dir, rel) => Promise.resolve(head.get(rel) ?? null),
        undefined,
        throwingHasher,
      );
      await store.record(PROJECT, DIR, CRLF_REL, null, crlf(SVG));

      // Working tree now holds bytes that differ raw from the shadow (the LF-normalised form) —
      // exactly the case that would consult the hasher. It throws, so this must resolve (not
      // reject) with the entry flagged conflicted, never silently accepted as a match.
      await expect(
        store.record(PROJECT, DIR, CRLF_REL, lf(SVG), crlf('<svg>\n<rect fill="red"/>\n</svg>\n')),
      ).resolves.toBeUndefined();

      const change = only(await store.changes(PROJECT));
      expect(change.conflicted).toBe(true);
    });
  });

  describe('conflictHead memo (issue #66 item 6)', () => {
    it('does not re-hash a conflicted entry while HEAD stays put', async () => {
      const { hasher, count } = countingHasher(identityHasher);
      const a = makeMemoStore('a', hasher);
      const b = makeMemoStore('b', hasher);

      await a.record(PROJECT, DIR, REL, BASE, BASE.replace('Alpha line.', 'Alpha per A.'));
      await b.record(PROJECT, DIR, REL, BASE, BASE.replace('Alpha line.', 'Alpha per B.'));

      // A's commit lands: HEAD moves to different bytes on the same line B touched.
      headCommit = 'c1';
      setHead(REL, BASE.replace('Alpha line.', 'Alpha per A.'));

      expect(count()).toBe(0);
      const first = await b.refresh(PROJECT, DIR);
      expect(first.conflicted).toEqual([REL]);
      // The settled check's sameAsGitSees fallback spawns the hasher twice (idA/idB) before
      // falling through to the merge3 conflict — this is the pre-fix baseline cost per call.
      expect(count()).toBe(2);
      expect(only(await b.changes(PROJECT)).conflicted).toBe(true);

      // Three more refreshes with HEAD unchanged must not grow the hasher call count at all —
      // pre-fix, each of these would add 2 more (6 total).
      for (let i = 0; i < 3; i++) {
        const refreshed = await b.refresh(PROJECT, DIR);
        expect(refreshed.conflicted).toEqual([REL]);
        expect(count()).toBe(2);
        expect(only(await b.changes(PROJECT)).conflicted).toBe(true);
      }
    });

    it('re-evaluates once HEAD moves again, and can settle', async () => {
      const { hasher, count } = countingHasher(identityHasher);
      const a = makeMemoStore('a', hasher);
      const b = makeMemoStore('b', hasher);

      await a.record(PROJECT, DIR, REL, BASE, BASE.replace('Alpha line.', 'Alpha per A.'));
      await b.record(PROJECT, DIR, REL, BASE, BASE.replace('Alpha line.', 'Alpha per B.'));

      headCommit = 'c1';
      setHead(REL, BASE.replace('Alpha line.', 'Alpha per A.'));
      await b.refresh(PROJECT, DIR);
      expect(count()).toBe(2);
      expect(only(await b.changes(PROJECT)).conflicted).toBe(true);

      // HEAD moves to exactly what B's own shadow already holds (e.g. someone applied B's fix) —
      // the memo must not freeze the stale verdict past this move: it settles.
      headCommit = 'c2';
      setHead(REL, BASE.replace('Alpha line.', 'Alpha per B.'));
      const settled = await b.refresh(PROJECT, DIR);
      expect(settled.settled).toEqual([REL]);
      expect(settled.conflicted).toEqual([]);
      expect(await b.changes(PROJECT)).toEqual([]);
      // bytesEqual(head, shadow) matched directly — no hasher spawn needed for this move.
      expect(count()).toBe(2);

      // A fresh conflict, then HEAD moves to a THIRD, still-conflicting commit: the evaluation
      // must re-run (hasher spawns again) and the new conflictHead must be the new sha, not stuck
      // on the first one. `before` matches the entry's re-anchored base (the settled HEAD content)
      // exactly, so this record() applies cleanly (no hasher spawn) and leaves a fresh shadow to
      // conflict against.
      await b.record(
        PROJECT,
        DIR,
        REL,
        BASE.replace('Alpha line.', 'Alpha per B.'),
        BASE.replace('Alpha line.', 'Alpha per B, again.'),
      );
      expect(count()).toBe(2); // unchanged — that record() applied directly
      headCommit = 'c3';
      setHead(REL, BASE.replace('Alpha line.', 'Alpha per A, again.'));
      const reconflicted = await b.refresh(PROJECT, DIR);
      expect(reconflicted.conflicted).toEqual([REL]);
      expect(count()).toBe(4); // settled-check fallback spawned again for this new HEAD

      headCommit = 'c4';
      setHead(REL, BASE.replace('Alpha line.', 'Alpha per A, yet again.'));
      const reconflictedAgain = await b.refresh(PROJECT, DIR);
      expect(reconflictedAgain.conflicted).toEqual([REL]);
      expect(count()).toBe(6); // re-evaluated again — a new HEAD sha each time, no memo hit
    });

    it('a record-time collision is skipped by refresh outright — its shadow is incomplete, so there is nothing to evaluate', async () => {
      const { hasher, count } = countingHasher(identityHasher);
      const store = makeMemoStore('a', hasher);

      // First edit lands in the shadow.
      await store.record(PROJECT, DIR, REL, BASE, BASE.replace('Alpha line.', 'Alpha per A.'));
      // A second record() call whose "before" no longer matches the shadow (a peer wrote to the
      // same line in the working tree between the two calls) and whose "after" changes it a third
      // way: shadow/before/after all differ on the same line, so record()'s own merge3 conflicts.
      // The write is left out of the shadow, which marks the entry incomplete.
      await store.record(
        PROJECT,
        DIR,
        REL,
        BASE.replace('Alpha line.', 'Alpha per B.'),
        BASE.replace('Alpha line.', 'Alpha per C.'),
      );
      expect(only(await store.changes(PROJECT)).conflicted).toBe(true);
      // record()'s own raw-comparison-failed fallback (before the merge3 that finds the conflict)
      // spawns the hasher twice.
      expect(count()).toBe(2);

      headCommit = 'c1';
      setHead(REL, BASE.replace('Alpha line.', 'Alpha per HEAD.'));

      // Skipped before the memo check, like an unrecorded entry: no HEAD read, no hasher spawn,
      // and no conflictHead stamped (nothing was judged).
      for (let i = 0; i < 2; i++) {
        const refreshed = await store.refresh(PROJECT, DIR);
        expect(refreshed.conflicted).toEqual([REL]);
        expect(count()).toBe(2);
      }
      const raw = JSON.parse(
        await readFile(path.join(sessionDir(workspace, PROJECT, 'a'), 'shadow.json'), 'utf8'),
      ) as { entries: Record<string, { conflictHead?: string; incomplete?: boolean }> };
      expect(raw.entries[REL]?.conflictHead).toBeUndefined();
      expect(raw.entries[REL]?.incomplete).toBe(true);
    });

    it('an old index entry with conflicted:true but no conflictHead is re-evaluated, not skipped', async () => {
      const { hasher, count } = countingHasher(identityHasher);
      const dir = sessionDir(workspace, PROJECT, 'legacy-conflict');
      await mkdir(path.join(dir, 'shadow', 'sections'), { recursive: true });
      await mkdir(path.join(dir, 'base', 'sections'), { recursive: true });
      await writeFile(
        path.join(dir, 'shadow', REL),
        BASE.replace('Alpha line.', 'Alpha SHADOW.'),
        'utf8',
      );
      await writeFile(path.join(dir, 'base', REL), BASE, 'utf8');
      await writeFile(
        path.join(dir, 'shadow.json'),
        JSON.stringify({
          entries: { [REL]: { deleted: false, baseExists: true, conflicted: true } },
        }),
        'utf8',
      );

      const store = makeMemoStore('legacy-conflict', hasher);
      headCommit = 'cX';
      setHead(REL, BASE.replace('Alpha line.', 'Alpha HEAD.'));

      const refreshed = await store.refresh(PROJECT, DIR);
      expect(refreshed.conflicted).toEqual([REL]);
      expect(count()).toBe(2); // the missing field forced a full evaluation

      const raw = JSON.parse(await readFile(path.join(dir, 'shadow.json'), 'utf8')) as {
        entries: Record<string, { conflictHead?: string }>;
      };
      expect(raw.entries[REL]?.conflictHead).toBe('cX');

      // Now that conflictHead is set, a further refresh with the same HEAD is memoised.
      const again = await store.refresh(PROJECT, DIR);
      expect(again.conflicted).toEqual([REL]);
      expect(count()).toBe(2);
    });

    it('leaves conflictHead unset on an unrecorded entry — it is skipped before the memo check', async () => {
      const store = makeMemoStore('a', identityHasher);
      await store.markUnrecorded(PROJECT, REL);

      const refreshed = await store.refresh(PROJECT, DIR);
      expect(refreshed.conflicted).toEqual([REL]);

      const raw = JSON.parse(
        await readFile(path.join(sessionDir(workspace, PROJECT, 'a'), 'shadow.json'), 'utf8'),
      ) as { entries: Record<string, { conflictHead?: string }> };
      expect(raw.entries[REL]?.conflictHead).toBeUndefined();
    });
  });

  /**
   * A conflicted entry whose shadow is MISSING one of this session's writes — a record-time
   * collision, or a write that reached the working tree while the entry was already conflicted —
   * is known-incomplete, exactly like an `unrecorded` one: "the stale shadow merges cleanly onto
   * the new HEAD" and "HEAD equals the shadow" are both statements about a shadow that lacks the
   * write, so neither may clear the flag. Before this, `refresh` advanced/settled such an entry,
   * the missing write was owned by nobody, and a live peer's `scope: "paths"` took it.
   */
  describe('an incomplete conflicted entry stays flagged through refresh', () => {
    const betaB = BASE.replace('Beta line.', 'Beta line, by B.');

    it('a record-time collision is not advanced when HEAD moves and the stale shadow merges cleanly', async () => {
      const store = makeStore('b');
      await store.record(PROJECT, DIR, REL, BASE, betaB);
      // A peer changed Alpha in the working tree; this session rewrites that same line.
      const peerAlpha = betaB.replace('Alpha line.', 'Alpha per A.');
      await store.record(
        PROJECT,
        DIR,
        REL,
        peerAlpha,
        peerAlpha.replace('Alpha per A.', 'Alpha per B.'),
      );
      expect(only(await store.changes(PROJECT)).conflicted).toBe(true);

      // The peer commits its Alpha line: shadow (BASE + Beta) merges cleanly onto it.
      setHead(REL, BASE.replace('Alpha line.', 'Alpha per A.'));
      const refreshed = await store.refresh(PROJECT, DIR);
      expect(refreshed).toEqual({ advanced: [], conflicted: [REL], settled: [] });
      const change = only(await store.changes(PROJECT));
      expect(change.conflicted).toBe(true);
      expect(change.content).toBe(betaB); // shadow untouched
      expect(change.base).toBe(BASE); // base untouched
    });

    it('a write made while conflicted keeps the entry from settling when HEAD lands on the shadow', async () => {
      const b = makeStore('b');
      const mine = BASE.replace('Alpha line.', 'Alpha per B.');
      await b.record(PROJECT, DIR, REL, BASE, mine);
      const landed = BASE.replace('Alpha line.', 'Alpha per A.');
      setHead(REL, landed);
      await b.refresh(PROJECT, DIR);
      expect(only(await b.changes(PROJECT)).conflicted).toBe(true);

      // A write while conflicted: never folded into the shadow.
      await b.record(PROJECT, DIR, REL, landed, landed.replace('Beta line.', 'Beta line, by B.'));

      // HEAD moves to exactly the (stale) shadow. Pre-fix this settled the entry and forgot the
      // Beta write; it must stay flagged.
      setHead(REL, mine);
      const refreshed = await b.refresh(PROJECT, DIR);
      expect(refreshed.settled).toEqual([]);
      expect(refreshed.conflicted).toEqual([REL]);
      expect(only(await b.changes(PROJECT)).conflicted).toBe(true);
    });

    it('a refresh-time conflict that received no write while conflicted can still settle (its shadow is complete)', async () => {
      const b = makeStore('b');
      const mine = BASE.replace('Alpha line.', 'Alpha per B.');
      await b.record(PROJECT, DIR, REL, BASE, mine);
      setHead(REL, BASE.replace('Alpha line.', 'Alpha per A.'));
      await b.refresh(PROJECT, DIR);
      expect(only(await b.changes(PROJECT)).conflicted).toBe(true);

      setHead(REL, mine);
      const refreshed = await b.refresh(PROJECT, DIR);
      expect(refreshed.settled).toEqual([REL]);
      expect(await b.changes(PROJECT)).toEqual([]);
    });

    it('a binary record-time collision does not settle when HEAD lands on the shadow bytes', async () => {
      const PNG_REL = 'figs/photo.png';
      const store = makeStore('a');
      await store.record(PROJECT, DIR, PNG_REL, null, PNG);
      await store.record(
        PROJECT,
        DIR,
        PNG_REL,
        Buffer.from([0x01, 0x02, 0x03]),
        Buffer.from([0x04, 0x05, 0x06]),
      );
      setHead(PNG_REL, PNG);
      const refreshed = await store.refresh(PROJECT, DIR);
      expect(refreshed.settled).toEqual([]);
      expect(refreshed.conflicted).toEqual([PNG_REL]);
    });

    it('changes() and peerEntries() report an incomplete entry conflicted even without the raw flag', async () => {
      const dir = sessionDir(workspace, PROJECT, 'hand');
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, 'shadow.json'),
        JSON.stringify({
          entries: { [REL]: { deleted: false, baseExists: true, incomplete: true } },
        }),
        'utf8',
      );
      const store = makeStore('hand');
      expect(only(await store.changes(PROJECT)).conflicted).toBe(true);
      expect((await store.peerEntries(PROJECT, 'hand'))?.[0]?.conflicted).toBe(true);
    });
  });

  describe('an edit reverted to HEAD settles without HEAD moving', () => {
    it('drops a text entry whose shadow equals HEAD (and its base)', async () => {
      const store = makeStore('a');
      const edited = BASE.replace('Alpha line.', 'Alpha per A.');
      await store.record(PROJECT, DIR, REL, BASE, edited);
      await store.record(PROJECT, DIR, REL, edited, BASE);

      const refreshed = await store.refresh(PROJECT, DIR);
      expect(refreshed.settled).toEqual([REL]);
      expect(await store.hasChanges(PROJECT)).toBe(false);
    });

    it('drops a file this session created and then deleted again (absent at HEAD)', async () => {
      const store = makeStore('a');
      await store.record(PROJECT, DIR, 'new.tex', null, 'x\n');
      await store.record(PROJECT, DIR, 'new.tex', 'x\n', null);

      const refreshed = await store.refresh(PROJECT, DIR);
      expect(refreshed.settled).toEqual(['new.tex']);
      expect(await store.hasChanges(PROJECT)).toBe(false);
    });

    it('keeps an ordinary in-flight edit while HEAD stays put', async () => {
      const store = makeStore('a');
      await store.record(PROJECT, DIR, REL, BASE, BASE.replace('Alpha line.', 'Alpha per A.'));
      const refreshed = await store.refresh(PROJECT, DIR);
      expect(refreshed).toEqual({ advanced: [], conflicted: [], settled: [] });
      expect(await store.hasChanges(PROJECT)).toBe(true);
    });

    it('never settles an unrecorded entry on HEAD == shadow == base', async () => {
      const store = makeStore('a');
      const edited = BASE.replace('Alpha line.', 'Alpha per A.');
      await store.record(PROJECT, DIR, REL, BASE, edited);
      await store.record(PROJECT, DIR, REL, edited, BASE);
      await store.markUnrecorded(PROJECT, REL);
      const refreshed = await store.refresh(PROJECT, DIR);
      expect(refreshed.settled).toEqual([]);
      expect(refreshed.conflicted).toEqual([REL]);
    });
  });

  describe('refreshedChanges (the lock-free view status uses)', () => {
    it('reports the refreshed picture but writes nothing', async () => {
      const a = makeStore('a');
      const b = makeStore('b');
      const afterA = BASE.replace('Alpha line.', 'Alpha by A.');
      const afterB = afterA.replace('Beta line.', 'Beta by B.');
      await a.record(PROJECT, DIR, REL, BASE, afterA);
      await b.record(PROJECT, DIR, REL, afterA, afterB);
      await b.record(PROJECT, DIR, 'other.tex', null, 'o\n');
      setHead(REL, afterA); // A's commit lands

      const bDir = sessionDir(workspace, PROJECT, 'b');
      const snapshot = async (): Promise<string[]> =>
        Promise.all([
          readFile(path.join(bDir, 'shadow.json'), 'utf8'),
          readFile(path.join(bDir, 'shadow', REL), 'utf8'),
          readFile(path.join(bDir, 'base', REL), 'utf8'),
        ]);
      const before = await snapshot();

      const viewB = await b.refreshedChanges(PROJECT, DIR);
      const rel = viewB.find((c) => c.path === REL);
      expect(rel?.conflicted).toBe(false);
      expect(rel?.content).toBe(afterB);
      expect(rel?.base).toBe(afterA);
      expect(viewB.map((c) => c.path)).toEqual(
        ['other.tex', REL].sort((x, y) => x.localeCompare(y)),
      );
      expect(await snapshot()).toEqual(before);

      // A settled entry is left out of the view, still without touching disk.
      const aDir = sessionDir(workspace, PROJECT, 'a');
      const aIndex = await readFile(path.join(aDir, 'shadow.json'), 'utf8');
      expect(await a.refreshedChanges(PROJECT, DIR)).toEqual([]);
      expect(await readFile(path.join(aDir, 'shadow.json'), 'utf8')).toBe(aIndex);
      expect(await a.hasChanges(PROJECT)).toBe(true);
    });

    it('agrees with refresh() + changes() on a conflict', async () => {
      const b = makeStore('b');
      await b.record(PROJECT, DIR, REL, BASE, BASE.replace('Alpha line.', 'Alpha per B.'));
      setHead(REL, BASE.replace('Alpha line.', 'Alpha per A.'));
      const view = await b.refreshedChanges(PROJECT, DIR);
      await b.refresh(PROJECT, DIR);
      expect(view).toEqual(await b.changes(PROJECT));
      expect(only(view).conflicted).toBe(true);
    });
  });

  describe('index read-modify-writes are serialised in-process', () => {
    /** A HEAD reader that stalls on one path, so a refresh holds the index across a real await. */
    const slowStore = (sessionId: string, slowRel: string): ShadowStore =>
      new ShadowStore(workspace, sessionId, async (_dir, rel) => {
        if (rel === slowRel) await new Promise((r) => setTimeout(r, 40));
        return head.get(rel) ?? null;
      });

    it("a record landing during this session's refresh is not overwritten by it", async () => {
      const store = slowStore('a', 'seed.tex');
      await store.record(PROJECT, DIR, 'seed.tex', null, 's\n');
      const refreshing = store.refresh(PROJECT, DIR);
      await new Promise((r) => setTimeout(r, 5));
      await store.record(PROJECT, DIR, 'new.tex', null, 'n\n');
      await refreshing;
      expect((await store.changes(PROJECT)).map((c) => c.path)).toEqual(['new.tex', 'seed.tex']);
    });

    it("a peer store's settleAll during this session's refresh is not undone by it", async () => {
      const a = slowStore('a', 'seed.tex');
      const b = makeStore('b');
      await a.record(PROJECT, DIR, 'seed.tex', null, 's\n');
      await a.record(PROJECT, DIR, REL, BASE, BASE.replace('Alpha line.', 'Alpha per A.'));
      const refreshing = a.refresh(PROJECT, DIR);
      await new Promise((r) => setTimeout(r, 5));
      await b.settleAll(PROJECT, [REL]);
      await refreshing;
      expect((await a.changes(PROJECT)).map((c) => c.path)).toEqual(['seed.tex']);
    });
  });
});

describe('latestTouch', () => {
  const entry = (touchedAt: string | null): PeerShadowEntry => ({
    path: 'x.tex',
    deleted: false,
    conflicted: false,
    touchedAt,
  });

  it('picks the later of two touchedAt values', () => {
    const earlier = new Date(1_700_000_000_000).toISOString();
    const later = new Date(1_700_000_100_000).toISOString();
    expect(latestTouch([entry(earlier), entry(later)])).toBe(later);
    expect(latestTouch([entry(later), entry(earlier)])).toBe(later);
  });

  it('returns null for an empty list', () => {
    expect(latestTouch([])).toBeNull();
  });

  it('returns null when every entry has no touchedAt', () => {
    expect(latestTouch([entry(null), entry(null)])).toBeNull();
  });
});

describe('entry keys fold onto an existing spelling on a case-insensitive clone', () => {
  const PROJECT = 'demo';
  const DIR = '/nonexistent';
  const HEAD = 'a\nb\nc\n';
  async function makeFoldingStore(insensitive: boolean): Promise<{
    store: ShadowStore;
    cleanup: () => Promise<void>;
  }> {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-shadow-fold-'));
    const store = new ShadowStore(
      workspace,
      'a',
      () => Promise.resolve(Buffer.from(HEAD, 'utf8')),
      Date.now,
      undefined,
      undefined,
      () => Promise.resolve(insensitive),
    );
    return { store, cleanup: () => rm(workspace, { recursive: true, force: true }) };
  }

  it('records a second spelling into the first entry (one file, one shadow)', async () => {
    const { store, cleanup } = await makeFoldingStore(true);
    try {
      await store.record(PROJECT, DIR, 'Notes.txt', HEAD, 'AAA\n');
      await store.record(PROJECT, DIR, 'notes.txt', 'AAA\n', 'BBB\n');
      const changes = await store.changes(PROJECT);
      expect(changes.map((c) => c.path)).toEqual(['Notes.txt']);
      expect(changes[0]?.content).toBe('BBB\n');
      expect(changes[0]?.conflicted).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('just outside: byte-exact keys on a case-sensitive clone', async () => {
    const { store, cleanup } = await makeFoldingStore(false);
    try {
      await store.record(PROJECT, DIR, 'Notes.txt', HEAD, 'AAA\n');
      await store.record(PROJECT, DIR, 'notes.txt', HEAD, 'BBB\n');
      const paths = (await store.changes(PROJECT)).map((c) => c.path).sort();
      expect(paths).toEqual(['Notes.txt', 'notes.txt']);
    } finally {
      await cleanup();
    }
  });

  it('markUnrecorded reuses the folded key once record has learnt the answer', async () => {
    const { store, cleanup } = await makeFoldingStore(true);
    try {
      await store.record(PROJECT, DIR, 'Notes.txt', HEAD, 'AAA\n');
      await store.markUnrecorded(PROJECT, 'notes.txt');
      const changes = await store.changes(PROJECT);
      expect(changes.map((c) => c.path)).toEqual(['Notes.txt']);
      expect(changes[0]?.unrecorded).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
