import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { resolveInside, toPosix } from '../../src/lib/paths.js';

describe('resolveInside', () => {
  const root = '/tmp/project';

  it('resolves a normal relative path inside the root', () => {
    expect(resolveInside(root, 'chapters/intro.tex')).toBe(path.join(root, 'chapters/intro.tex'));
  });

  it('allows the root itself', () => {
    expect(resolveInside(root, '.')).toBe(path.resolve(root));
  });

  it('rejects parent-directory escapes', () => {
    expect(() => resolveInside(root, '../secrets')).toThrow(/escapes/);
    expect(() => resolveInside(root, 'a/../../b')).toThrow(/escapes/);
  });

  it('rejects absolute paths', () => {
    expect(() => resolveInside(root, '/etc/passwd')).toThrow(/absolute/);
  });
});

describe('toPosix', () => {
  it('converts native separators to forward slashes', () => {
    expect(toPosix(['chapters', 'intro.tex'].join(path.sep))).toBe('chapters/intro.tex');
  });

  it('leaves already-POSIX paths unchanged', () => {
    expect(toPosix('a/b/c.tex')).toBe('a/b/c.tex');
  });
});
