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

  it('assigns stable per-project numbers that are never reused', () => {
    const s = new CommentStore();
    expect(s.add('p', base).number).toBe(1);
    const b = s.add('p', base);
    expect(b.number).toBe(2);
    expect(s.add('q', base).number).toBe(1); // per-project
    s.remove('p', b.id);
    expect(s.add('p', base).number).toBe(3); // not reused after delete
    // Undo restores the original number.
    expect(s.undo('p')?.number).toBe(2);
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
});
