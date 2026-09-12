import { describe, it, expect, afterEach, vi } from 'vitest';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveInside, samePath, toFileUrl, toPosix } from '../../src/lib/paths.js';

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

describe('samePath', () => {
  it('says two identical paths are the same on every platform', () => {
    expect(samePath('/tmp/project/figures/x.png', '/tmp/project/figures/x.png')).toBe(true);
  });

  it('resolves relative segments before comparing', () => {
    expect(samePath('/tmp/project/figures/../figures/x.png', '/tmp/project/figures/x.png')).toBe(
      true,
    );
  });

  it('treats a case mismatch as the same path only on win32/darwin', () => {
    // NTFS and (default-configured) APFS/HFS+ are case-insensitive, so a caller spelling
    // "Figures/x.png" for an on-disk "figures/x.png" names the same file there; Linux's typical
    // filesystems are case-sensitive, so the same two spellings name different (non-existent vs.
    // existent) paths. Branch on process.platform rather than skipping — the point is the
    // per-platform answer, not just "it doesn't crash" on whichever CI runner happens to run it.
    const insensitive = process.platform === 'win32' || process.platform === 'darwin';
    expect(samePath('/tmp/project/Figures/x.png', '/tmp/project/figures/x.png')).toBe(insensitive);
  });

  it('says two different paths are different regardless of platform', () => {
    expect(samePath('/tmp/project/figures/x.png', '/tmp/project/figures/y.png')).toBe(false);
  });

  describe('with the platform stubbed', () => {
    // The test above only ever asserts against the *real* process.platform, so on Linux CI it
    // only exercises the exact-comparison branch — a samePath that always used `===` would still
    // pass it there. Stub process.platform so each of the three branches actually runs, whatever
    // platform the test happens to execute on.
    afterEach(() => {
      vi.restoreAllMocks();
    });

    // Built from one common absolute base with path.join/path.resolve so this is correct whether
    // the file runs on POSIX or Windows separators.
    const base = path.resolve(path.join('tmp', 'project'));
    const upper = path.join(base, 'Figures', 'x.png');
    const lower = path.join(base, 'figures', 'x.png');

    it('treats a case mismatch as the same path on darwin', () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
      expect(samePath(upper, lower)).toBe(true);
    });

    it('treats a case mismatch as the same path on win32', () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      expect(samePath(upper, lower)).toBe(true);
    });

    it('treats a case mismatch as a different path on linux', () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
      expect(samePath(upper, lower)).toBe(false);
    });
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
