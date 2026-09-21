import { describe, it, expect } from 'vitest';
import {
  SHELF_ID_RE,
  assertShelfId,
  capUnshelveConflict,
  countLines,
  isShelfId,
  newShelfId,
  parseManifest,
} from '../../src/lib/shelf.js';
import type { ShelfManifest, UnshelveConflictFile } from '../../src/lib/shelf.js';

/** A well-formed manifest, so each rejection test can change exactly one thing. */
function goodManifest(): ShelfManifest {
  return {
    version: 1,
    id: 'sh-1a2b3c4d',
    label: 'mid-sentence intro',
    createdAt: '2026-09-18T10:00:00.000Z',
    sessionId: 'sess-a',
    headSha: 'a'.repeat(40),
    files: [{ path: 'sections/intro.tex', status: 'modified', added: 3, removed: 1 }],
  };
}

/** A manifest with one file record field overridden. */
function withFile(file: Record<string, unknown>): Record<string, unknown> {
  return { ...goodManifest(), files: [{ ...goodManifest().files[0], ...file }] };
}

describe('shelf id', () => {
  it('accepts sh- plus 8 lowercase hex', () => {
    expect(isShelfId('sh-1a2b3c4d')).toBe(true);
    expect(assertShelfId('sh-1a2b3c4d')).toBe('sh-1a2b3c4d');
    expect(SHELF_ID_RE.test('sh-00000000')).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['uppercase hex', 'sh-1A2B3C4D'],
    ['too short', 'sh-123'],
    ['too long', 'sh-123456789'],
    ['a traversal', '../../etc'],
    ['a traversal appended to a valid id', 'sh-1a2b3c4d/../x'],
    ['a NUL', 'sh-1a2b3c\u00004d'],
    ['a NUL after a valid id', 'sh-1a2b3c4d\u0000'],
    ['a trailing newline after a valid id', 'sh-1a2b3c4d\n'],
    ['no prefix', '1a2b3c4d'],
    ['non-hex', 'sh-1a2b3c4g'],
  ])('refuses %s', (_label, value) => {
    expect(isShelfId(value)).toBe(false);
    expect(() => assertShelfId(value)).toThrow(/list_shelves/);
  });

  it('newShelfId is pinned by its injected random source and always valid', () => {
    expect(newShelfId(() => 'deadbeefcafebabe')).toBe('sh-deadbeef');
    // Non-hex characters are dropped, and the result is lowercased.
    expect(newShelfId(() => '1A2B-3C4D-9999')).toBe('sh-1a2b3c4d');
    for (let i = 0; i < 50; i += 1) {
      expect(isShelfId(newShelfId())).toBe(true);
    }
  });

  it('newShelfId throws rather than minting a short (invalid) id', () => {
    expect(() => newShelfId(() => 'abc')).toThrow(/hex digits/);
  });
});

describe('parseManifest', () => {
  it('returns the manifest for a well-formed one', () => {
    expect(parseManifest(JSON.parse(JSON.stringify(goodManifest())))).toEqual(goodManifest());
  });

  it('accepts a null label', () => {
    expect(parseManifest({ ...goodManifest(), label: null })?.label).toBeNull();
  });

  it.each([
    ['a non-object (string)', 'nope'],
    ['a non-object (null)', null],
    ['a non-object (number)', 7],
    ['an array', [goodManifest()]],
  ])('returns null for %s', (_label, raw) => {
    expect(parseManifest(raw)).toBeNull();
  });

  it('returns null for a missing version', () => {
    const m: Record<string, unknown> = { ...goodManifest() };
    delete m.version;
    expect(parseManifest(m)).toBeNull();
  });

  it('returns null for a wrong version', () => {
    expect(parseManifest({ ...goodManifest(), version: 2 })).toBeNull();
    expect(parseManifest({ ...goodManifest(), version: '1' })).toBeNull();
  });

  it('returns null for a missing id', () => {
    const m: Record<string, unknown> = { ...goodManifest() };
    delete m.id;
    expect(parseManifest(m)).toBeNull();
  });

  it('returns null for an id that is not a shelf id', () => {
    expect(parseManifest({ ...goodManifest(), id: '../../etc' })).toBeNull();
    expect(parseManifest({ ...goodManifest(), id: 'sh-1A2B3C4D' })).toBeNull();
  });

  it('returns null for a non-array files', () => {
    expect(parseManifest({ ...goodManifest(), files: {} })).toBeNull();
    expect(parseManifest({ ...goodManifest(), files: 'sections/intro.tex' })).toBeNull();
  });

  it('returns null for a file record whose path is missing or not a string', () => {
    expect(parseManifest(withFile({ path: undefined }))).toBeNull();
    expect(parseManifest(withFile({ path: 42 }))).toBeNull();
  });

  it('returns null for a file record whose path is empty', () => {
    expect(parseManifest(withFile({ path: '' }))).toBeNull();
  });

  it('returns null for a file record whose path escapes with ..', () => {
    expect(parseManifest(withFile({ path: '../outside.tex' }))).toBeNull();
    expect(parseManifest(withFile({ path: 'sections/../../outside.tex' }))).toBeNull();
  });

  it('returns null for a file record whose path is absolute', () => {
    expect(parseManifest(withFile({ path: '/abs.tex' }))).toBeNull();
    expect(parseManifest(withFile({ path: 'C:/abs.tex' }))).toBeNull();
  });

  it('returns null for a file record whose path contains a backslash', () => {
    expect(parseManifest(withFile({ path: 'sections\\intro.tex' }))).toBeNull();
    expect(parseManifest(withFile({ path: '..\\outside.tex' }))).toBeNull();
  });

  it('returns null for a file record whose path contains a NUL', () => {
    expect(parseManifest(withFile({ path: 'intro.tex\u0000.png' }))).toBeNull();
  });

  it('returns null for a non-finite added or removed', () => {
    expect(parseManifest(withFile({ added: Number.NaN }))).toBeNull();
    expect(parseManifest(withFile({ removed: Number.POSITIVE_INFINITY }))).toBeNull();
    expect(parseManifest(withFile({ added: '3' }))).toBeNull();
  });

  it('returns null for an unknown status', () => {
    expect(parseManifest(withFile({ status: 'renamed' }))).toBeNull();
    expect(parseManifest(withFile({ status: undefined }))).toBeNull();
  });

  it('never throws, whatever it is handed', () => {
    for (const raw of [undefined, null, 0, '', [], { files: [null] }, { version: 1, files: [1] }]) {
      expect(() => parseManifest(raw)).not.toThrow();
    }
  });
});

describe('countLines', () => {
  it.each([
    ['', 0],
    ['a', 1],
    ['a\n', 1],
    ['a\nb', 2],
    ['a\nb\n', 2],
    ['\n', 1],
    ['\n\n', 2],
  ])('counts %j as %i lines', (text, expected) => {
    expect(countLines(Buffer.from(text as string, 'utf8'))).toBe(expected);
  });

  it('counts bytes, not decoded text', () => {
    expect(countLines(Buffer.from([0x61, 0x00, 0x0a, 0xff]))).toBe(2);
  });
});

describe('capUnshelveConflict', () => {
  const file = (over: Partial<UnshelveConflictFile> = {}): UnshelveConflictFile => ({
    path: 'a.tex',
    reason: 'dirty',
    base: 'base',
    ours: 'ours',
    theirs: 'theirs',
    ...over,
  });

  it('cuts nothing when everything fits', () => {
    const plan = capUnshelveConflict([file(), file({ path: 'b.tex' })], {
      maxFiles: 20,
      sideCap: 100,
    });
    expect(plan.truncated).toBe(false);
    expect(plan.note).toBe('');
    expect(plan.paths).toEqual(['a.tex', 'b.tex']);
    expect(plan.files).toHaveLength(2);
    for (const f of plan.files) {
      expect(f.base).toBe('base');
      expect(f.ours).toBe('ours');
      expect(f.theirs).toBe('theirs');
      expect(f.elided).toBeUndefined();
    }
  });

  it('elides a side over the cap and reports its TRUE length', () => {
    const long = 'x'.repeat(50);
    const plan = capUnshelveConflict([file({ ours: long })], { maxFiles: 20, sideCap: 10 });
    expect(plan.files[0]?.ours).toBeNull();
    expect(plan.files[0]?.elided).toEqual({ ours: 50 });
    expect(plan.files[0]?.base).toBe('base');
    expect(plan.truncated).toBe(true);
    expect(plan.note).toContain('10 characters');
    // Only the per-side cap fired, so the note must not blame the file-count cap.
    expect(plan.note).not.toContain('detailed');
  });

  it('keeps a side exactly at the cap', () => {
    const exact = 'x'.repeat(10);
    const plan = capUnshelveConflict([file({ ours: exact })], { maxFiles: 20, sideCap: 10 });
    expect(plan.files[0]?.ours).toBe(exact);
    expect(plan.files[0]?.elided).toBeUndefined();
    expect(plan.truncated).toBe(false);
  });

  it('leaves a genuinely absent side null with NO elided entry, even when another side was cut', () => {
    const long = 'x'.repeat(50);
    const plan = capUnshelveConflict([file({ base: null, ours: long, theirs: null })], {
      maxFiles: 20,
      sideCap: 10,
    });
    const only = plan.files[0];
    expect(only?.base).toBeNull();
    expect(only?.theirs).toBeNull();
    expect(only?.ours).toBeNull();
    // The distinction that must never blur: `ours` was cut (and says how much), `base`/`theirs`
    // were never there at all.
    expect(only?.elided).toEqual({ ours: 50 });
    expect(only?.elided && 'base' in only.elided).toBe(false);
    expect(only?.elided && 'theirs' in only.elided).toBe(false);
  });

  it('drops files past maxFiles from files but never from paths', () => {
    const files = ['a', 'b', 'c', 'd'].map((n) => file({ path: `${n}.tex` }));
    const plan = capUnshelveConflict(files, { maxFiles: 2, sideCap: 1000 });
    expect(plan.files.map((f) => f.path)).toEqual(['a.tex', 'b.tex']);
    expect(plan.paths).toEqual(['a.tex', 'b.tex', 'c.tex', 'd.tex']);
    expect(plan.truncated).toBe(true);
    expect(plan.note).toContain('first 2 of 4');
    expect(plan.note).toContain('detailed');
    // Only the file-count cap fired, so the note must not blame the per-side cap.
    expect(plan.note).not.toContain('characters');
  });

  it('names both caps when both fire', () => {
    const files = ['a', 'b', 'c'].map((n) => file({ path: `${n}.tex`, ours: 'x'.repeat(50) }));
    const plan = capUnshelveConflict(files, { maxFiles: 2, sideCap: 10 });
    expect(plan.note).toContain('detailed');
    expect(plan.note).toContain('characters');
    expect(plan.truncated).toBe(true);
  });

  it('is empty-safe', () => {
    expect(capUnshelveConflict([], { maxFiles: 20, sideCap: 10 })).toEqual({
      files: [],
      paths: [],
      truncated: false,
      note: '',
    });
  });
});
