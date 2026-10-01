import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import {
  assertRegistrableRootFile,
  rootFileSpellingProblem,
} from '../../src/lib/rootFileSpelling.js';
import { quoteId } from '../../src/lib/projectId.js';

/**
 * The pure spelling judgement shared by an overlay compile's root check (`refuseLinkedRootDir`)
 * and `register_project`: an absolute, drive-qualified or `..`-segmented root is refused on every
 * platform, whatever the disk holds.
 */
describe('rootFileSpellingProblem', () => {
  const platforms = ['linux', 'darwin', 'win32'] as const;

  it('reads an absolute spelling as absolute on every platform', () => {
    for (const platform of platforms) {
      for (const spelling of [
        '/abs/main.tex',
        'C:\\p\\main.tex',
        'C:/p/main.tex',
        '\\\\server\\share\\main.tex',
        '\\main.tex',
      ]) {
        expect(rootFileSpellingProblem(spelling, { platform }), `${platform}: ${spelling}`).toEqual(
          expect.objectContaining({ kind: 'absolute' }),
        );
      }
    }
  });

  it('reads a drive-relative spelling as drive-qualified on every platform', () => {
    for (const platform of platforms) {
      for (const spelling of ['C:main.tex', 'c:sub\\main.tex', 'z:sub/main.tex']) {
        expect(rootFileSpellingProblem(spelling, { platform }), `${platform}: ${spelling}`).toEqual(
          {
            kind: 'drive',
          },
        );
      }
    }
  });

  it('reads any ".." segment as one, with either separator', () => {
    for (const spelling of [
      '../main.tex',
      'a/../b.tex',
      '..\\x.tex',
      'sub\\..\\main.tex',
      'a/b/..',
      '..',
    ]) {
      expect(rootFileSpellingProblem(spelling), spelling).toEqual({ kind: 'dotdot' });
    }
  });

  it('accepts a relative spelling, including a "..foo" directory and an extensionless name', () => {
    for (const platform of platforms) {
      for (const spelling of [
        'main.tex',
        'sub/main.tex',
        'sub\\main.tex',
        './main.tex',
        'paper',
        '..foo/main.tex',
        'a/...tex',
      ]) {
        expect(rootFileSpellingProblem(spelling, { platform }), `${platform}: ${spelling}`).toBe(
          undefined,
        );
      }
    }
  });

  it('suggests the project-relative spelling of an absolute root inside the project', () => {
    const projectDir = path.join(os.tmpdir(), 'rfs-project');
    expect(
      rootFileSpellingProblem(path.join(projectDir, 'sub', 'main.tex'), { projectDir }),
    ).toEqual({ kind: 'absolute', relSpelling: 'sub/main.tex' });
    expect(
      rootFileSpellingProblem(path.join(projectDir, '..foo', 'main.tex'), { projectDir }),
    ).toEqual({ kind: 'absolute', relSpelling: '..foo/main.tex' });
    // Outside the project, the project itself, or no project to compare with: no suggestion.
    expect(
      rootFileSpellingProblem(path.join(os.tmpdir(), 'elsewhere', 'main.tex'), { projectDir }),
    ).toEqual({ kind: 'absolute' });
    expect(rootFileSpellingProblem(projectDir, { projectDir })).toEqual({ kind: 'absolute' });
    expect(rootFileSpellingProblem(path.join(projectDir, 'main.tex'))).toEqual({
      kind: 'absolute',
    });
  });

  it('never suggests a spelling for a path absolute only on another platform', () => {
    const other = process.platform === 'win32' ? 'linux' : 'win32';
    const projectDir = path.join(os.tmpdir(), 'rfs-project');
    expect(
      rootFileSpellingProblem(path.join(projectDir, 'main.tex'), { projectDir, platform: other }),
    ).toEqual({ kind: 'absolute' });
  });
});

describe('assertRegistrableRootFile', () => {
  it('refuses an absolute rootFile, quoting it and naming the relative spelling when inside', () => {
    const projectDir = path.join(os.tmpdir(), 'rfs-project');
    const abs = path.join(projectDir, 'sub', 'main.tex');
    let message = '';
    try {
      assertRegistrableRootFile(abs, { projectDir });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(`rootFile ${quoteId(abs)} is an absolute path`);
    expect(message).toContain('relative to the project root');
    expect(message).toContain('without ".."');
    expect(message).toContain('rootFile: "sub/main.tex"');
    expect(() => assertRegistrableRootFile('/abs/main.tex')).toThrow(/is an absolute path/);
    expect(() => assertRegistrableRootFile('/abs/main.tex')).not.toThrow(/rootFile: "/);
  });

  it('refuses a drive-qualified and a ".." rootFile', () => {
    expect(() => assertRegistrableRootFile('C:main.tex')).toThrow(
      /rootFile "C:main\.tex" is spelled with a drive prefix.*relative to the project root/s,
    );
    expect(() => assertRegistrableRootFile('C:\\p\\main.tex')).toThrow(/is an absolute path/);
    expect(() => assertRegistrableRootFile('../main.tex')).toThrow(
      /rootFile "\.\.\/main\.tex" has a "\.\." segment.*without "\.\."/s,
    );
  });

  it('escapes an invisible character in the quoted value', () => {
    expect(() => assertRegistrableRootFile('/abs/\u202emain.tex')).toThrow(/\\u\{202e\}/i);
  });

  it('accepts every relative spelling', () => {
    for (const spelling of ['main.tex', 'sub/main.tex', 'sub\\main.tex', './main.tex', 'paper']) {
      expect(() => assertRegistrableRootFile(spelling), spelling).not.toThrow();
    }
  });
});
