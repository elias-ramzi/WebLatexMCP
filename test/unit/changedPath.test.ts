import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { changedPath } from '../../src/lib/changeDiff.js';

/** One rule for "which path did a write through `relPath` actually change", shared by the tools. */
describe('changedPath', () => {
  it('is the given path when no link is involved', () => {
    expect(changedPath(null, 'notes.tex')).toBe('notes.tex');
  });

  it('is the in-project link target when there is one', () => {
    expect(changedPath('sub/main.tex', 'notes.tex')).toBe('sub/main.tex');
  });

  it('is the given path when the target lies outside the project (absolute)', () => {
    expect(changedPath(path.resolve('/outside/real.tex'), 'notes.tex')).toBe('notes.tex');
  });

  // The real caller passes `toPosix(target)`: on Windows that is a forward-slashed drive path
  // (`C:/outside/real.tex`), never the native backslash form `path.resolve` above produces there.
  it.skipIf(process.platform !== 'win32')(
    'is the given path when the target lies outside the project (absolute, win32 toPosix shape)',
    () => {
      expect(changedPath('C:/outside/real.tex', 'notes.tex')).toBe('notes.tex');
    },
  );

  it('POSIX-ifies the given path', () => {
    expect(changedPath(null, path.join('sub', 'notes.tex'))).toBe('sub/notes.tex');
  });
});
