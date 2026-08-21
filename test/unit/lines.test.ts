import { describe, it, expect } from 'vitest';
import { splitLines, sliceLineRange } from '../../src/lib/lines.js';

describe('splitLines', () => {
  it('counts the lines a file has, not the parts a split produces', () => {
    expect(splitLines('a\nb\nc\n')).toEqual(['a', 'b', 'c']);
    expect(splitLines('a\nb\nc')).toEqual(['a', 'b', 'c']);
    expect(splitLines('')).toEqual(['']);
  });

  it('handles CRLF and CR-only line endings', () => {
    expect(splitLines('a\r\nb\r\n')).toEqual(['a', 'b']);
    expect(splitLines('a\rb\rc')).toEqual(['a', 'b', 'c']);
  });
});

describe('sliceLineRange', () => {
  it('returns a byte-exact substring, so a ranged read round-trips into an edit', () => {
    const crlf = 'line one\r\nline two\r\nline three\r\n';
    const slice = sliceLineRange(crlf, 1, 2);
    expect(crlf).toContain(slice); // the whole point: it still occurs in the file
    expect(slice).toBe('line one\r\nline two');
  });

  it('keeps the file untouched when the range covers all of it', () => {
    const full = 'alpha\nbeta\ngamma\n';
    expect(sliceLineRange(full, 1)).toBe(full);
    expect(sliceLineRange(full, 1, 3)).toBe(full);
    expect(sliceLineRange(full, 1, 99)).toBe(full);
    // …including a CRLF blob written back to the repository verbatim.
    const crlf = 'alpha\r\nbeta\r\n';
    expect(sliceLineRange(crlf, 1)).toBe(crlf);
  });

  it('slices inner and trailing ranges without inventing or dropping terminators', () => {
    const text = 'a\nb\nc\nd\n';
    expect(sliceLineRange(text, 2, 3)).toBe('b\nc');
    expect(sliceLineRange(text, 4, 4)).toBe('d');
    expect(sliceLineRange(text, 3)).toBe('c\nd');
    expect(sliceLineRange('a\rb\rc', 2, 3)).toBe('b\rc');
  });
});
