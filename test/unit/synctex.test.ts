import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { normalizeInput, parseSyncTexEdit, SyncTexService } from '../../src/services/synctex.js';
import type { Runner } from '../../src/services/synctex.js';

const OK = (stdout: string) => ({ code: 0, stdout, stderr: '', timedOut: false });

// A real `synctex edit -o` block (absolute Input with a ./ segment, as synctex prints it).
const SAMPLE = [
  'This is SyncTeX command line utility, version 1.5',
  'SyncTeX result begin',
  'Output:main.pdf',
  'Input:/home/u/proj/./sections/intro.tex',
  'Line:42',
  'Column:-1',
  'Offset:0',
  'Context:',
  'SyncTeX result end',
].join('\n');

describe('parseSyncTexEdit', () => {
  it('extracts the file and line, made project-relative', () => {
    expect(parseSyncTexEdit(SAMPLE, '/home/u/proj')).toEqual({
      file: 'sections/intro.tex',
      line: 42,
    });
  });

  it('normalizes a ./main.tex input against the project dir', () => {
    const out = 'Input:./main.tex\nLine:5\n';
    expect(parseSyncTexEdit(out, '/home/u/proj')).toEqual({ file: 'main.tex', line: 5 });
  });

  it('returns null when there is no Input or Line', () => {
    expect(parseSyncTexEdit('SyncTeX result begin\nSyncTeX result end', '/p')).toBeNull();
    expect(parseSyncTexEdit('Input:/p/main.tex', '/p')).toBeNull();
  });

  it('returns null for a non-positive line', () => {
    expect(parseSyncTexEdit('Input:/p/main.tex\nLine:0', '/p')).toBeNull();
  });

  it('falls back to the basename when the input is outside the project', () => {
    expect(parseSyncTexEdit('Input:/other/shared.tex\nLine:3', '/home/u/proj')).toEqual({
      file: 'shared.tex',
      line: 3,
    });
  });
});

// Windows rules applied on any host: a SyncTeX `Input:` on another drive is not in the project,
// but `path.win32.relative` answers it with an absolute `D:\\…` rather than a `..` climb.
describe('normalizeInput under win32 path rules', () => {
  const proj = 'C:\\Users\\u\\proj';

  it('falls back to the basename for an input on another drive', () => {
    expect(normalizeInput('D:\\shared\\refs\\shared.tex', proj, path.win32)).toBe('shared.tex');
  });

  it('falls back to the basename for an input above the project on the same drive', () => {
    expect(normalizeInput('C:\\Users\\u\\other\\x.tex', proj, path.win32)).toBe('x.tex');
  });

  it('keeps an in-project input project-relative and POSIX', () => {
    expect(normalizeInput('C:\\Users\\u\\proj\\.\\sections\\intro.tex', proj, path.win32)).toBe(
      'sections/intro.tex',
    );
    expect(normalizeInput('.\\main.tex', proj, path.win32)).toBe('main.tex');
  });
});

describe('SyncTexService', () => {
  it('builds a rounded page:x:y:pdf query and parses the result', async () => {
    let seen: string[] = [];
    const run: Runner = async (_cmd, args) => {
      seen = args;
      return OK('Input:/p/main.tex\nLine:7\n');
    };
    const loc = await new SyncTexService(run).resolve('/p/main.pdf', '/p', 2, 100.6, 200.4);
    expect(loc).toEqual({ file: 'main.tex', line: 7 });
    expect(seen).toEqual(['edit', '-o', '2:101:200:/p/main.pdf']);
  });

  it('returns null when synctex is unavailable (spawn throws)', async () => {
    const run: Runner = async () => {
      throw new Error('not found');
    };
    expect(await new SyncTexService(run).resolve('/p/main.pdf', '/p', 1, 0, 0)).toBeNull();
  });

  it('reports availability from the probe', async () => {
    expect(await new SyncTexService(async () => OK('')).isAvailable()).toBe(true);
    expect(
      await new SyncTexService(async () => {
        throw new Error('nope');
      }).isAvailable(),
    ).toBe(false);
  });
});
