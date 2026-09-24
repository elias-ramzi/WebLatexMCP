import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { ShadowStore } from '../../src/services/shadowStore.js';
import { sessionDir } from '../../src/lib/sessionPaths.js';

/**
 * The shadow index keys its entries by project-relative path, and a path is whatever the project's
 * author named a file. A plain object map inherits `Object.prototype`, so a file literally named
 * `constructor`/`toString`/`hasOwnProperty` read back an inherited FUNCTION as its "existing
 * entry" (and `JSON.stringify` then dropped it), and a file named `__proto__` hit the prototype
 * setter on assignment — either way the session's edit was owned by nobody. Every such name must
 * behave exactly like `main.tex`.
 */
const PROTO_NAMES = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'];

describe('ShadowStore: files named like Object.prototype members', () => {
  const PROJECT = 'demo';
  const DIR = '/clone';
  let workspace: string;
  let head: Map<string, Buffer>;

  const makeStore = (sessionId: string, caseInsensitive = false): ShadowStore =>
    new ShadowStore(
      workspace,
      sessionId,
      (_dir, rel) => Promise.resolve(head.get(rel) ?? null),
      undefined,
      undefined,
      undefined,
      () => Promise.resolve(caseInsensitive),
    );

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-shadow-proto-'));
    head = new Map();
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  for (const name of PROTO_NAMES) {
    describe(`a file named ${name}`, () => {
      it('is recorded, accumulates edits, and is reported by changes()', async () => {
        const store = makeStore('a');
        await store.record(PROJECT, DIR, name, null, 'one\n');
        await store.record(PROJECT, DIR, name, 'one\n', 'one\ntwo\n');

        const changes = await store.changes(PROJECT);
        expect(changes.map((c) => c.path)).toEqual([name]);
        expect(changes[0]?.content).toBe('one\ntwo\n');
        expect(changes[0]?.base).toBeNull();
        expect(changes[0]?.conflicted).toBe(false);
        expect(await store.hasChanges(PROJECT)).toBe(true);
      });

      it('merges against HEAD like any tracked file', async () => {
        head.set(name, Buffer.from('a\nb\nc\n'));
        const store = makeStore('a');
        await store.record(PROJECT, DIR, name, 'a\nb\nc\n', 'a\nB\nc\n');
        const [change] = await store.changes(PROJECT);
        expect(change?.path).toBe(name);
        expect(change?.base).toBe('a\nb\nc\n');
        expect(change?.content).toBe('a\nB\nc\n');
      });

      it('sits beside an ordinary file without disturbing it', async () => {
        const store = makeStore('a');
        await store.record(PROJECT, DIR, name, null, 'x\n');
        await store.record(PROJECT, DIR, 'main.tex', null, 'm\n');
        expect((await store.changes(PROJECT)).map((c) => c.path).sort()).toEqual(
          [name, 'main.tex'].sort(),
        );
      });

      it('is visible to a peer through peerEntries', async () => {
        await makeStore('a').record(PROJECT, DIR, name, null, 'x\n');
        const peer = await makeStore('b').peerEntries(PROJECT, 'a');
        expect(peer?.map((e) => e.path)).toEqual([name]);
      });

      it('is marked unrecorded as its own entry', async () => {
        const store = makeStore('a');
        await store.markUnrecorded(PROJECT, name);
        const [change] = await store.changes(PROJECT);
        expect(change?.path).toBe(name);
        expect(change?.unrecorded).toBe(true);
        expect(change?.conflicted).toBe(true);
      });

      it('is dropped by settle and settleAll, and nothing else is', async () => {
        const a = makeStore('a');
        await a.record(PROJECT, DIR, name, null, 'x\n');
        await a.record(PROJECT, DIR, 'keep.tex', null, 'k\n');
        expect(await a.settle(PROJECT, [name])).toEqual([name]);
        expect((await a.changes(PROJECT)).map((c) => c.path)).toEqual(['keep.tex']);

        await a.record(PROJECT, DIR, name, null, 'y\n');
        expect(await makeStore('b').settleAll(PROJECT, [name])).toEqual([name]);
        expect((await a.changes(PROJECT)).map((c) => c.path)).toEqual(['keep.tex']);
      });

      it('settles on refresh once HEAD carries it, like any other file', async () => {
        const store = makeStore('a');
        await store.record(PROJECT, DIR, name, null, 'landed\n');
        head.set(name, Buffer.from('landed\n'));
        const result = await store.refresh(PROJECT, DIR);
        expect(result.settled).toEqual([name]);
        expect(await store.changes(PROJECT)).toEqual([]);
      });

      it('folds a second spelling onto it on a case-insensitive clone', async () => {
        const store = makeStore('a', true);
        await store.record(PROJECT, DIR, name, null, 'one\n');
        await store.record(PROJECT, DIR, name.toUpperCase(), 'one\n', 'one\ntwo\n');
        const changes = await store.changes(PROJECT);
        expect(changes.map((c) => c.path)).toEqual([name]);
        expect(changes[0]?.content).toBe('one\ntwo\n');
      });
    });
  }

  it('recording a file named __proto__ or constructor never writes onto a shared prototype', async () => {
    // Pre-fix, `index.entries['__proto__']` on a fresh index returned Object.prototype itself,
    // and `record` then stamped `touchedAt`/`binary`/... onto it: every object in the server
    // process inherited them. `constructor` did the same to the global `Object` function.
    const store = makeStore('a');
    try {
      await store.record(PROJECT, DIR, '__proto__', null, 'x\n');
      await store.record(PROJECT, DIR, 'constructor', null, 'y\n');
      expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'touchedAt')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(Object, 'touchedAt')).toBe(false);
      expect(({} as { binary?: unknown }).binary).toBeUndefined();
    } finally {
      // Never leak pollution into the rest of the worker if the fix regresses.
      for (const k of [
        'touchedAt',
        'binary',
        'deleted',
        'baseExists',
        'conflicted',
        'incomplete',
      ]) {
        delete (Object.prototype as Record<string, unknown>)[k];
        delete (Object as unknown as Record<string, unknown>)[k];
      }
    }
  });

  it('a new file is not mistaken for an inherited member on a case-insensitive clone', async () => {
    // `entryKey` short-circuits on `index.entries[rel]` being truthy; an inherited `constructor`
    // made a brand-new `constructor` look already-tracked and skipped the HEAD anchor.
    head.set('constructor', Buffer.from('from head\n'));
    const store = makeStore('a', true);
    await store.record(PROJECT, DIR, 'constructor', 'from head\n', 'edited\n');
    const [change] = await store.changes(PROJECT);
    expect(change?.base).toBe('from head\n');
    expect(change?.content).toBe('edited\n');
  });

  it('keeps the on-disk index format: a plain JSON object keyed by path, readable back', async () => {
    const store = makeStore('a');
    await store.record(PROJECT, DIR, '__proto__', null, 'x\n');
    const file = path.join(sessionDir(workspace, PROJECT, 'a'), 'shadow.json');
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { entries: object };
    expect(Object.keys(parsed.entries)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(parsed.entries)).toBe(Object.prototype);
  });

  it('reads a hand-written index holding such keys (older format) as ordinary entries', async () => {
    const dir = sessionDir(workspace, PROJECT, 'a');
    await mkdir(dir, { recursive: true });
    const entry = { deleted: false, baseExists: false, touchedAt: '2026-01-01T00:00:00.000Z' };
    await writeFile(
      path.join(dir, 'shadow.json'),
      `{"entries":{"__proto__":${JSON.stringify(entry)},"constructor":${JSON.stringify(entry)}}}`,
    );
    await mkdir(path.join(dir, 'shadow'), { recursive: true });
    await writeFile(path.join(dir, 'shadow', '__proto__'), 'p\n');
    await writeFile(path.join(dir, 'shadow', 'constructor'), 'c\n');

    const store = makeStore('a');
    // A further record must merge into the loaded entry, not replace or lose it — and a NEW
    // prototype-named file recorded into the loaded index must land beside them.
    await store.record(PROJECT, DIR, '__proto__', 'p\n', 'p\nq\n');
    await store.record(PROJECT, DIR, 'toString', null, 't\n');
    const changes = await store.changes(PROJECT);
    expect(changes.map((c) => [c.path, c.content])).toEqual([
      ['__proto__', 'p\nq\n'],
      ['constructor', 'c\n'],
      ['toString', 't\n'],
    ]);
  });
});
