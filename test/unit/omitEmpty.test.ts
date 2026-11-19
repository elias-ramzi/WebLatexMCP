import { describe, it, expect } from 'vitest';
import { omitEmpty } from '../../src/lib/omitEmpty.js';

describe('omitEmpty', () => {
  it('drops only the named keys, and only when undefined, [] or 0', () => {
    const input = { a: [], b: 0, c: undefined, d: [1], e: 2, f: 0, g: '' };
    const out = omitEmpty(input, ['a', 'b', 'c', 'd', 'e', 'g']);
    expect(out).toEqual({ d: [1], e: 2, f: 0, g: '' });
    expect(Object.keys(out)).not.toContain('a');
    expect(Object.keys(out)).not.toContain('b');
    expect(Object.keys(out)).not.toContain('c');
  });

  it('returns a fresh object and leaves its input alone', () => {
    const input = { a: [] as number[], b: 1 };
    const out = omitEmpty(input, ['a']);
    expect(out).not.toBe(input);
    expect(input).toEqual({ a: [], b: 1 });
  });
});
