import { describe, it, expect } from 'vitest';
import { CommentStore } from '../../src/services/commentStore.js';

const base = { page: 1, x: 10, y: 20, note: 'n' };

describe('CommentStore', () => {
  it('assigns ids and keeps comments per project', () => {
    const s = new CommentStore();
    const a = s.add('p1', { ...base, note: 'a' });
    const b = s.add('p2', { ...base, note: 'b' });
    expect(a.id).not.toBe(b.id);
    expect(s.list('p1').map((c) => c.note)).toEqual(['a']);
    expect(s.list('p2').map((c) => c.note)).toEqual(['b']);
    expect(a.resolved).toBe(false);
  });

  it('lists open comments by default and includes resolved on request', () => {
    const s = new CommentStore();
    const a = s.add('p', { ...base, note: 'a' });
    s.add('p', { ...base, note: 'b' });
    expect(s.resolve('p', [a.id])).toBe(1);
    expect(s.list('p').map((c) => c.note)).toEqual(['b']);
    expect(s.list('p', { includeResolved: true }).map((c) => c.note)).toEqual(['a', 'b']);
  });

  it('resolves every open comment when no ids are given', () => {
    const s = new CommentStore();
    s.add('p', base);
    s.add('p', base);
    expect(s.resolve('p')).toBe(2);
    expect(s.resolve('p')).toBe(0); // already resolved
    expect(s.list('p')).toHaveLength(0);
  });

  it('clears a project and reports the count', () => {
    const s = new CommentStore();
    s.add('p', base);
    s.add('p', base);
    expect(s.clear('p')).toBe(2);
    expect(s.list('p', { includeResolved: true })).toHaveLength(0);
  });

  it('preserves quote and resolved source location', () => {
    const s = new CommentStore();
    const c = s.add('p', { ...base, quote: 'hello', file: 'main.tex', line: 12 });
    expect(c).toMatchObject({ quote: 'hello', file: 'main.tex', line: 12 });
  });

  it('numbers open comments #1..#N, renumbering as they resolve/delete/undo', () => {
    const s = new CommentStore();
    const a = s.add('p', { ...base, note: 'a' });
    const b = s.add('p', { ...base, note: 'b' });
    s.add('p', { ...base, note: 'c' });
    expect(s.list('p').map((x) => [x.note, x.number])).toEqual([
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ]);
    expect(s.add('q', base).number).toBe(1); // numbering is per project

    // Resolving the first closes the gap.
    s.resolve('p', [a.id]);
    expect(s.list('p').map((x) => [x.note, x.number])).toEqual([
      ['b', 1],
      ['c', 2],
    ]);

    // Deleting also renumbers.
    s.remove('p', b.id);
    expect(s.list('p').map((x) => [x.note, x.number])).toEqual([['c', 1]]);

    // Undo restores it in order and renumbers again.
    s.undo('p');
    expect(s.list('p').map((x) => [x.note, x.number])).toEqual([
      ['b', 1],
      ['c', 2],
    ]);
  });

  it('updates a note in place', () => {
    const s = new CommentStore();
    const c = s.add('p', { ...base, note: 'old' });
    expect(s.update('p', c.id, { note: 'new' })?.note).toBe('new');
    expect(s.list('p')[0]?.note).toBe('new');
    expect(s.update('p', 'missing', { note: 'x' })).toBeNull();
  });

  it('removes a single comment', () => {
    const s = new CommentStore();
    const a = s.add('p', { ...base, note: 'a' });
    s.add('p', { ...base, note: 'b' });
    expect(s.remove('p', a.id)).toBe(true);
    expect(s.list('p').map((c) => c.note)).toEqual(['b']);
    expect(s.remove('p', a.id)).toBe(false); // already gone
  });

  it('undoes deletes most-recent-first, restoring original order', () => {
    const s = new CommentStore();
    const a = s.add('p', { ...base, note: 'a' });
    const b = s.add('p', { ...base, note: 'b' });
    s.add('p', { ...base, note: 'c' });
    s.remove('p', a.id);
    s.remove('p', b.id);
    expect(s.list('p').map((c) => c.note)).toEqual(['c']);

    expect(s.undo('p')?.note).toBe('b'); // last deleted comes back first
    expect(s.list('p').map((c) => c.note)).toEqual(['b', 'c']); // back in original position
    expect(s.undo('p')?.note).toBe('a');
    expect(s.list('p').map((c) => c.note)).toEqual(['a', 'b', 'c']);
    expect(s.undo('p')).toBeNull(); // nothing left to undo
  });

  describe('surfaces (the PDF and each markdown document)', () => {
    const doc = (document: string, note: string) => ({ document, note, file: document, line: 3 });
    const nums = (cs: { note: string; number: number }[]) => cs.map((c) => [c.note, c.number]);

    it('accepts a document comment with no page/x/y', () => {
      const s = new CommentStore();
      const c = s.add('p', { document: 'run/a.md', note: 'd', file: 'run/a.md', line: 7 });
      expect(c).toMatchObject({ document: 'run/a.md', file: 'run/a.md', line: 7, number: 1 });
      expect(c.page).toBeUndefined();
    });

    it('numbers open comments per surface, renumbering only the surface that changed', () => {
      const s = new CommentStore();
      const p1 = s.add('p', { ...base, note: 'p1' });
      s.add('p', doc('a.md', 'a1'));
      s.add('p', { ...base, note: 'p2' });
      s.add('p', doc('b.md', 'b1'));
      s.add('p', doc('a.md', 'a2'));
      expect(nums(s.list('p'))).toEqual([
        ['p1', 1],
        ['a1', 1],
        ['p2', 2],
        ['b1', 1],
        ['a2', 2],
      ]);
      s.resolve('p', [p1.id]);
      expect(nums(s.list('p'))).toEqual([
        ['a1', 1],
        ['p2', 1],
        ['b1', 1],
        ['a2', 2],
      ]);
    });

    it('filters list by surface: undefined = all, null = PDF only, string = that document', () => {
      const s = new CommentStore();
      s.add('p', { ...base, note: 'pdf' });
      s.add('p', doc('a.md', 'a'));
      s.add('p', doc('b.md', 'b'));
      expect(s.list('p').map((c) => c.note)).toEqual(['pdf', 'a', 'b']);
      expect(s.list('p', { document: undefined }).map((c) => c.note)).toEqual(['pdf', 'a', 'b']);
      expect(s.list('p', { document: null }).map((c) => c.note)).toEqual(['pdf']);
      expect(s.list('p', { document: 'a.md' }).map((c) => c.note)).toEqual(['a']);
      const a = s.list('p', { document: 'a.md' })[0]!;
      s.resolve('p', [a.id]);
      expect(s.list('p', { document: 'a.md' })).toHaveLength(0);
      expect(s.list('p', { document: 'a.md', includeResolved: true })).toHaveLength(1);
    });

    it('resolves without ids scoped by surface', () => {
      const mk = () => {
        const s = new CommentStore();
        s.add('p', { ...base, note: 'pdf' });
        s.add('p', doc('a.md', 'a'));
        s.add('p', doc('b.md', 'b'));
        return s;
      };
      let s = mk();
      expect(s.resolve('p', undefined, null)).toBe(1);
      expect(s.list('p').map((c) => c.note)).toEqual(['a', 'b']);
      s = mk();
      expect(s.resolve('p', undefined, 'a.md')).toBe(1);
      expect(s.list('p').map((c) => c.note)).toEqual(['pdf', 'b']);
      s = mk();
      expect(s.resolve('p', undefined, undefined)).toBe(3);
      expect(s.list('p')).toHaveLength(0);
    });

    it('undoes per surface, searching the one stack from the top', () => {
      const mk = () => {
        const s = new CommentStore();
        const c1 = s.add('p', { ...base, note: 'pdf' });
        const c2 = s.add('p', doc('a.md', 'a'));
        s.remove('p', c1.id);
        s.remove('p', c2.id);
        return s;
      };
      let s = mk();
      expect(s.undo('p', null)?.note).toBe('pdf');
      expect(s.undo('p', null)).toBeNull();
      expect(s.undo('p', 'a.md')?.note).toBe('a');
      s = mk();
      expect(s.undo('p', 'b.md')).toBeNull();
      expect(s.undo('p', 'a.md')?.note).toBe('a');
      expect(s.list('p', { document: 'a.md' })[0]?.number).toBe(1);
      s = mk();
      expect(s.undo('p')?.note).toBe('a'); // most recent of any surface
      expect(s.undo('p')?.note).toBe('pdf');
    });
  });
});
