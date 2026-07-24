import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { ShadowStore, type ShadowChange } from '../../src/services/shadowStore.js';

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

  let workspace: string;
  let head: Map<string, string>;

  const makeStore = (sessionId: string): ShadowStore =>
    new ShadowStore(workspace, sessionId, (_dir, rel) => Promise.resolve(head.get(rel) ?? null));

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-shadow-'));
    head = new Map([[REL, BASE]]);
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
    head.set(REL, afterA);

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

    head.set(REL, BASE.replace('Alpha line.', 'Alpha per A.'));

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
    head.set(REL, landed);
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
});
