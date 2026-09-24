import { describe, it, expect } from 'vitest';
import {
  capUnshelveConflict,
  resolveUnshelveFile,
  planUnshelveFile,
  UNSHELVE_FILE_JSON_OVERHEAD,
  UNSHELVE_ELIDED_WRAPPER_OVERHEAD,
  type UnshelveConflictFile,
  type UnshelveFileState,
  type UnshelveMerge,
} from '../../src/lib/shelf.js';
import { merge3 } from '../../src/lib/merge3.js';
import { CONFLICT_CONTENT_BUDGET, CONFLICT_SIDE_CAP } from '../../src/lib/conflictBudget.js';

/**
 * `unshelve`'s conflict payload budget (SH2b/SH2c) and its merge-on-head-moved resolution (SH2a).
 *
 * The budget is judged on what actually ships: the sides reach the caller only in
 * `structuredContent`, as JSON, so every assertion here measures `JSON.stringify(plan.files)` —
 * never the held string lengths the first version charged.
 */

const file = (over: Partial<UnshelveConflictFile> = {}): UnshelveConflictFile => ({
  path: 'sections/b.tex',
  reason: 'head-moved',
  base: 'base',
  ours: 'ours',
  theirs: 'theirs',
  ...over,
});

const HOUSE = {
  maxFiles: 20,
  sideCap: CONFLICT_SIDE_CAP,
  totalBudget: CONFLICT_CONTENT_BUDGET,
};

describe('capUnshelveConflict — which side survives', () => {
  it('keeps theirs when three 9000-character sides cannot all fit', () => {
    // theirs is the shelved content: the shelf lives outside every sandbox, so no tool can read
    // it and this payload is the only copy a caller can reach. Charged base, ours, theirs (the
    // declaration order), base and ours filled 18000 of 20000 and theirs was the one cut.
    const side = (c: string): string => c.repeat(9000);
    const plan = capUnshelveConflict(
      [file({ base: side('b'), ours: side('o'), theirs: side('t') })],
      HOUSE,
    );
    const only = plan.files[0]!;
    expect(only.theirs).toBe(side('t'));
    expect(only.ours).toBe(side('o'));
    // base is the recoverable-by-ref side, so it is the one the budget cuts — with its size.
    expect(only.base).toBeNull();
    expect(only.elided).toEqual({ base: 9000 });
    expect(plan.truncated).toBe(true);
  });

  it('charges theirs ACROSS files before any ours or base', () => {
    // Priority lanes, not file order: file 2's theirs outranks file 1's ours.
    const side = (c: string): string => c.repeat(6000);
    const plan = capUnshelveConflict(
      [
        file({ path: 'a.tex', base: side('b'), ours: side('o'), theirs: side('t') }),
        file({ path: 'b.tex', base: side('B'), ours: side('O'), theirs: side('T') }),
      ],
      HOUSE,
    );
    expect(plan.files[0]!.theirs).toBe(side('t'));
    expect(plan.files[1]!.theirs).toBe(side('T'));
    expect(plan.files[1]!.elided?.theirs).toBeUndefined();
  });

  it('does not apply the per-side cap to theirs — only the aggregate bounds it', () => {
    // 15000 characters is past CONFLICT_SIDE_CAP but inside the 20000 budget. The per-side cap
    // exists to cut sides another tool can fetch; theirs has no such route.
    const theirs = 't'.repeat(15000);
    const plan = capUnshelveConflict([file({ base: null, ours: 'o', theirs })], HOUSE);
    expect(plan.files[0]!.theirs).toBe(theirs);
    expect(plan.files[0]!.elided).toBeUndefined();
  });
});

describe('capUnshelveConflict — charged on the RENDERED size', () => {
  it('cuts 9000 control characters that render as 54002 JSON characters', () => {
    // JSON escapes each control character as \u00XX: six characters for one. Charged on held
    // length this cleared the 20000 budget with truncated: false.
    const control = '\u0001'.repeat(9000);
    expect(JSON.stringify(control).length).toBe(54002);
    const plan = capUnshelveConflict([file({ base: null, ours: 'o', theirs: control })], HOUSE);
    expect(plan.files[0]!.theirs).toBeNull();
    expect(plan.files[0]!.elided).toEqual({ theirs: 9000 });
    expect(plan.truncated).toBe(true);
    expect(JSON.stringify(plan.files).length).toBeLessThanOrEqual(CONFLICT_CONTENT_BUDGET);
  });

  it('applies the per-side cap to the rendered size too', () => {
    // 3000 control characters: 3000 held, 18002 rendered — over a 12000 side cap.
    const control = '\u0002'.repeat(3000);
    const plan = capUnshelveConflict([file({ ours: control })], HOUSE);
    expect(plan.files[0]!.ours).toBeNull();
    expect(plan.files[0]!.elided).toEqual({ ours: 3000 });
  });

  it('keeps the whole rendered payload within the budget, whatever the mix', () => {
    const kinds = ['x', '\u0003', '"', '\\', 'é', '\n'];
    for (const budget of [2000, 5000, CONFLICT_CONTENT_BUDGET]) {
      for (let n = 1; n <= 8; n += 1) {
        const files = Array.from({ length: n }, (_, i) =>
          file({
            path: `sections/${i}.tex`,
            base: kinds[i % kinds.length]!.repeat(300 * (i + 1)),
            ours: i % 3 === 0 ? null : kinds[(i + 1) % kinds.length]!.repeat(700),
            theirs: kinds[(i + 2) % kinds.length]!.repeat(900 + 100 * i),
          }),
        );
        const plan = capUnshelveConflict(files, {
          maxFiles: 20,
          sideCap: 12000,
          totalBudget: budget,
        });
        expect(JSON.stringify(plan.files).length).toBeLessThanOrEqual(budget);
      }
    }
  });

  it('never cuts a payload that fits exactly, and cuts one that is one character over', () => {
    // Sides big enough that cutting one is a saving (a side smaller than its own elision
    // report is always shown, being cheaper than the report), with an escape in each.
    const side = (c: string): string => `${c.repeat(200)}\u0004"`;
    const files = [
      file({ path: 'a.tex', base: side('b'), ours: side('o'), theirs: side('t') }),
      file({ path: 'b.tex', base: null, ours: side('O'), theirs: side('T') }),
    ];
    const exact = JSON.stringify(files).length;
    const fits = capUnshelveConflict(files, { maxFiles: 20, sideCap: 12000, totalBudget: exact });
    expect(fits.truncated).toBe(false);
    expect(fits.files).toEqual(files);
    const over = capUnshelveConflict(files, {
      maxFiles: 20,
      sideCap: 12000,
      totalBudget: exact - 1,
    });
    expect(over.truncated).toBe(true);
    expect(JSON.stringify(over.files).length).toBeLessThanOrEqual(exact - 1);
  });

  it('pins the scaffold constants against a real rendered entry', () => {
    const bare = { path: '', reason: '', base: null, ours: null, theirs: null };
    // Two empty strings (2 chars each) and three nulls (4 each), plus the array comma.
    expect(UNSHELVE_FILE_JSON_OVERHEAD).toBe(JSON.stringify(bare).length - 2 * 2 - 3 * 4 + 1);
    const withElided = { ...bare, elided: { base: 1 } };
    // `"base":1` plus its own comma is charged per part; the wrapper is the rest, less one.
    expect(UNSHELVE_ELIDED_WRAPPER_OVERHEAD).toBe(
      JSON.stringify(withElided).length - JSON.stringify(bare).length - '"base":1,'.length,
    );
  });
});

describe('capUnshelveConflict — the note', () => {
  it('points a cut base at read_file with the shelf headSha', () => {
    const side = 'b'.repeat(13000);
    const plan = capUnshelveConflict([file({ base: side })], { ...HOUSE, baseRef: 'abc123' });
    expect(plan.files[0]!.elided).toEqual({ base: 13000 });
    expect(plan.note).toContain('read_file with ref "abc123"');
    // Only the per-side cap fired.
    expect(plan.note).not.toContain('total budget');
  });

  it('says a cut theirs is held only by the shelf, and only when theirs was cut', () => {
    const cut = capUnshelveConflict([file({ theirs: 't'.repeat(30000) })], HOUSE);
    expect(cut.files[0]!.elided?.theirs).toBe(30000);
    expect(cut.note).toContain('no other tool can read');
    const kept = capUnshelveConflict([file({ base: 'b'.repeat(19000) })], {
      ...HOUSE,
      sideCap: 50000,
    });
    expect(kept.files[0]!.theirs).toBe('theirs');
    expect(kept.note).not.toContain('no other tool can read');
  });
});

describe('planUnshelveFile / resolveUnshelveFile — HEAD moved under the file', () => {
  const B = (s: string): Buffer => Buffer.from(s, 'utf8');
  const BASE = 'one\ntwo\nthree\nfour\nfive\nsix\n';
  const moved = (over: Partial<UnshelveFileState> = {}): UnshelveFileState => ({
    base: B(BASE),
    shelved: B(BASE.replace('one', 'ONE (shelved)')),
    current: B(BASE.replace('six', 'SIX (upstream)')),
    headNow: B(BASE.replace('six', 'SIX (upstream)')),
    dirty: false,
    ...over,
  });

  it('asks for a merge for a clean text file, with the TREE as ours', () => {
    expect(planUnshelveFile(moved())).toEqual({
      kind: 'merge',
      ours: BASE.replace('six', 'SIX (upstream)'),
      base: BASE,
      theirs: BASE.replace('one', 'ONE (shelved)'),
    });
  });

  it('merges a non-overlapping change and records against the pre-write tree', async () => {
    const state = moved();
    const res = await resolveUnshelveFile(state, merge3);
    expect(res).toEqual({
      kind: 'restore',
      bytes: B(BASE.replace('one', 'ONE (shelved)').replace('six', 'SIX (upstream)')),
      // HEAD's bytes (the tree, proved clean), not the stale base: the settled shadow starts at
      // the new HEAD and must be handed the shelved lines alone.
      recordBefore: state.current,
      merged: true,
    });
  });

  it('refuses an overlapping change as head-moved, writing nothing', async () => {
    const res = await resolveUnshelveFile(
      moved({
        current: B(BASE.replace('one', 'ONE (upstream)')),
        headNow: B(BASE.replace('one', 'ONE (upstream)')),
      }),
      merge3,
    );
    expect(res).toEqual({ kind: 'conflict', reason: 'head-moved' });
  });

  it('never merges bytes that are not text', async () => {
    let calls = 0;
    const spy: UnshelveMerge = async (o, b, t) => {
      calls += 1;
      return merge3(o, b, t);
    };
    const binary = moved({ shelved: Buffer.from([0x89, 0x50, 0x00, 0x01]) });
    expect(planUnshelveFile(binary)).toEqual({ kind: 'conflict', reason: 'head-moved' });
    // Lossy UTF-8 (a latin-1 é) is not text either: decoding it would corrupt the bytes.
    const latin1 = moved({ base: Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]) });
    expect(await resolveUnshelveFile(latin1, spy)).toEqual({
      kind: 'conflict',
      reason: 'head-moved',
    });
    expect(calls).toBe(0);
  });

  it('reports a mergeable file over a DIRTY tree as dirty, and does not merge it', async () => {
    let calls = 0;
    const spy: UnshelveMerge = async (o, b, t) => {
      calls += 1;
      return merge3(o, b, t);
    };
    const res = await resolveUnshelveFile(moved({ current: B('live edit\n'), dirty: true }), spy);
    expect(res).toEqual({ kind: 'conflict', reason: 'dirty' });
    expect(calls).toBe(0);
  });

  it('keeps an ordinary restore recorded against the shelf base', async () => {
    const state = moved({ current: B(BASE), headNow: B(BASE) });
    expect(await resolveUnshelveFile(state, merge3)).toEqual({
      kind: 'restore',
      bytes: state.shelved,
      recordBefore: state.base,
      merged: false,
    });
  });
});
