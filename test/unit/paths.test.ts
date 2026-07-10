import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveInside, toFileUrl, toPosix } from '../../src/lib/paths.js';

describe('resolveInside', () => {
  const root = '/tmp/project';

  it('resolves a normal relative path inside the root', () => {
    expect(resolveInside(root, 'chapters/intro.tex')).toBe(
      path.resolve(root, 'chapters/intro.tex'),
    );
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

describe('toFileUrl', () => {
  it('produces a clickable file:// URL for an absolute path', () => {
    const abs = path.resolve('/tmp/web-latex-mcp-build/proj/main.pdf');
    expect(toFileUrl(abs)).toBe(pathToFileURL(abs).href);
    expect(toFileUrl(abs).startsWith('file://')).toBe(true);
  });

  it('percent-encodes spaces so the URL stays valid', () => {
    const abs = path.resolve('/tmp/my project/main.pdf');
    expect(toFileUrl(abs)).toContain('my%20project');
  });
});
