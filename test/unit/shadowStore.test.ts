import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import {
  ShadowStore,
  latestTouch,
  type ShadowChange,
  type PeerShadowEntry,
} from '../../src/services/shadowStore.js';
import { sessionDir } from '../../src/lib/sessionPaths.js';

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

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-shadow-'));
    head = new Map();
    setHead(REL, BASE);
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

  it('clearAll drops every session, not just this one', async () => {
    const a = makeStore('a');
    const b = makeStore('b');
    await a.record(PROJECT, DIR, REL, BASE, `${BASE}A\n`);
    await b.record(PROJECT, DIR, REL, BASE, `${BASE}B\n`);

    await a.clearAll(PROJECT);
    expect(await a.hasChanges(PROJECT)).toBe(false);
    expect(await b.hasChanges(PROJECT)).toBe(false);
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
