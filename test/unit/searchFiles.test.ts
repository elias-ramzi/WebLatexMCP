import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { FileService, MAX_READ_BYTES } from '../../src/services/fileService.js';
import { searchProject, type SearchReader } from '../../src/lib/searchFiles.js';
import { UnsafePatternError } from '../../src/lib/searchPattern.js';
import { SEARCH_MAX_MATCHES } from '../../src/lib/searchBudget.js';

/**
 * The search over a real project directory, with a real `FileService` and no mocks — temp dirs
 * and canned content, as this repo's unit tests do.
 */
describe('searchProject', () => {
  const files = new FileService();
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-search-'));
    await mkdir(path.join(dir, 'sections'), { recursive: true });
    await mkdir(path.join(dir, '.git'), { recursive: true });
    await writeFile(
      path.join(dir, 'main.tex'),
      [
        '\\input{sections/intro}',
        'see \\Cref{tab:sota}',
        '% see \\Cref{tab:sota} (retired)',
        '',
      ].join('\n'),
    );
    await writeFile(
      path.join(dir, 'sections', 'intro.tex'),
      ['intro text', '\\Cref{tab:sota} again', ''].join('\n'),
    );
    await writeFile(path.join(dir, 'refs.bib'), '@book{x, title={Cref tab:sota}}\n');
    await writeFile(path.join(dir, 'notes.md'), '100% of \\Cref{tab:sota} mentions\n');
    await writeFile(path.join(dir, 'figure.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/master\n');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('finds a literal pattern across the project, in path then line order', async () => {
    const out = await searchProject(files, dir, { pattern: '\\Cref{tab:sota}' });

    expect(out.matches.map((m) => `${m.path}:${m.line}`)).toEqual([
      'main.tex:2',
      'main.tex:3',
      'notes.md:1',
      'sections/intro.tex:2',
    ]);
    expect(out.totalMatches).toBe(4);
    expect(out.matchedFiles).toBe(3);
  });

  it('excludes comment-only hits on request, in .tex only, and counts them either way', async () => {
    const withComments = await searchProject(files, dir, { pattern: '\\Cref{tab:sota}' });
    expect(withComments.commentMatches).toBe(1);

    const live = await searchProject(files, dir, {
      pattern: '\\Cref{tab:sota}',
      excludeComments: true,
    });
    // main.tex:3 goes; notes.md:1 stays, because `%` is not a comment character in markdown —
    // and its `100%` would have swallowed the rest of the line if it were.
    expect(live.matches.map((m) => `${m.path}:${m.line}`)).toEqual([
      'main.tex:2',
      'notes.md:1',
      'sections/intro.tex:2',
    ]);
    expect(live.commentMatches).toBe(1);
  });

  it('narrows by filter and by subdir, as list_files does', async () => {
    const tex = await searchProject(files, dir, { pattern: 'Cref', filter: 'tex' });
    expect(tex.matches.every((m) => m.path.endsWith('.tex'))).toBe(true);

    const sub = await searchProject(files, dir, { pattern: 'Cref', subdir: 'sections' });
    expect(sub.matches.map((m) => m.path)).toEqual(['sections/intro.tex']);
  });

  it('refuses a subdir outside the project rather than searching it', async () => {
    await expect(searchProject(files, dir, { pattern: 'x', subdir: '../..' })).rejects.toThrow();
  });

  it('searches as a regex only when asked', async () => {
    const literal = await searchProject(files, dir, { pattern: '\\Cref{tab:.*}' });
    expect(literal.totalMatches).toBe(0);

    const regex = await searchProject(files, dir, {
      pattern: '\\\\Cref\\{tab:[a-z]*\\}',
      regex: true,
    });
    expect(regex.totalMatches).toBe(4);
  });

  it('matches case-insensitively on request', async () => {
    expect((await searchProject(files, dir, { pattern: 'INTRO TEXT' })).totalMatches).toBe(0);
    expect(
      (await searchProject(files, dir, { pattern: 'INTRO TEXT', caseInsensitive: true }))
        .totalMatches,
    ).toBe(1);
  });
});

describe('searchProject: files it does not search', () => {
  const files = new FileService();
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-searchskip-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reports an image as skipped rather than as containing no match', async () => {
    await writeFile(path.join(dir, 'figure.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(path.join(dir, 'main.tex'), 'PNG\n');

    const out = await searchProject(files, dir, { pattern: 'PNG' });

    expect(out.filesSearched).toBe(1);
    expect(out.skipped).toEqual([{ path: 'figure.png', reason: 'asset' }]);
    expect(out.skippedByReason.asset).toBe(1);
  });

  it('reports a file with a NUL byte as skipped: "binary", not "no match"', async () => {
    // The whole point: a NUL makes naive tooling report nothing, which reads as "searched and
    // clean". An extension rule alone would miss this — the file is a .tex.
    await writeFile(path.join(dir, 'blob.tex'), Buffer.from('needle\u0000needle', 'utf8'));

    const out = await searchProject(files, dir, { pattern: 'needle' });

    expect(out.matches).toEqual([]);
    expect(out.totalMatches).toBe(0);
    expect(out.filesSearched).toBe(0);
    expect(out.skipped).toEqual([{ path: 'blob.tex', reason: 'binary' }]);
    expect(out.skippedByReason.binary).toBe(1);
  });

  it('reports a file over the text read cap as skipped: "too-large"', async () => {
    await writeFile(path.join(dir, 'huge.tex'), 'x'.repeat(MAX_READ_BYTES + 1));

    const out = await searchProject(files, dir, { pattern: 'x' });

    expect(out.skipped).toEqual([{ path: 'huge.tex', reason: 'too-large' }]);
    expect(out.filesSearched).toBe(0);
  });

  it('reports a file that vanished between the walk and the read as "unreadable"', async () => {
    // A stub reader, because the race cannot be arranged reliably against a real filesystem —
    // what is under test is that a failed read is reported, not swallowed as "no match".
    const reader: SearchReader = {
      list: async () => [{ path: 'gone.tex', type: 'tex', sizeBytes: 10 }],
      read: async () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
    };

    const out = await searchProject(reader, dir, { pattern: 'x' });

    expect(out.skipped).toEqual([{ path: 'gone.tex', reason: 'unreadable' }]);
    expect(out.skippedByReason.unreadable).toBe(1);
  });
});

describe('searchProject: the bounds', () => {
  const files = new FileService();
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-searchbound-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('refuses a catastrophic pattern in milliseconds instead of running it', async () => {
    // 60 `a`s and no `b`: `(a+)+$` against this is 2^60 steps, and `exec` cannot be interrupted
    // — with the static refusal removed, this call never returns and vitest kills the file.
    await writeFile(path.join(dir, 'evil.tex'), `${'a'.repeat(60)}!\n`);

    const started = Date.now();
    await expect(
      searchProject(files, dir, { pattern: '(a+)+$', regex: true }),
    ).rejects.toBeInstanceOf(UnsafePatternError);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('refuses a polynomial-blowup pattern the same way', async () => {
    // Measured at 7.8 seconds for ONE 2000-character line; a project has thousands.
    await writeFile(path.join(dir, 'evil.tex'), `${'a'.repeat(2000)}\n`.repeat(20));

    const started = Date.now();
    await expect(
      searchProject(files, dir, { pattern: '.*a.*b', regex: true }),
    ).rejects.toBeInstanceOf(UnsafePatternError);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('refuses before opening a single file', async () => {
    const reader: SearchReader = {
      list: async () => {
        throw new Error('list must not be called for a refused pattern');
      },
      read: async () => {
        throw new Error('read must not be called for a refused pattern');
      },
    };

    await expect(
      searchProject(reader, dir, { pattern: '(a+)+$', regex: true }),
    ).rejects.toBeInstanceOf(UnsafePatternError);
  });

  it('stops at the time budget and says the answer is partial', async () => {
    for (let i = 0; i < 6; i++) {
      await writeFile(path.join(dir, `f${i}.tex`), 'needle\n');
    }
    // An injected clock, so the deadline is exact rather than a race: it jumps past the budget
    // after the third reading of it.
    let ticks = 0;
    const now = (): number => {
      ticks++;
      return ticks > 3 ? 10_000 : 0;
    };

    const out = await searchProject(files, dir, { pattern: 'needle', budgetMs: 1000, now });

    expect(out.timedOut).toBe(true);
    expect(out.filesNotReached).toBeGreaterThan(0);
    expect(out.filesSearched).toBeLessThan(6);
    expect(out.note).toContain('budget ran out');
  });

  it('does not report a timeout when the budget was never reached', async () => {
    await writeFile(path.join(dir, 'a.tex'), 'needle\n');
    const out = await searchProject(files, dir, { pattern: 'needle' });
    expect(out.timedOut).toBe(false);
    expect(out.filesNotReached).toBe(0);
    expect(out.note).toBeUndefined();
  });

  it('bounds the payload and reports the true total alongside it', async () => {
    const lines = Array.from({ length: 400 }, (_unused, i) => `needle ${i}`).join('\n');
    await writeFile(path.join(dir, 'many.tex'), `${lines}\n`);

    const out = await searchProject(files, dir, { pattern: 'needle' });

    expect(out.totalMatches).toBe(400);
    expect(out.matches).toHaveLength(SEARCH_MAX_MATCHES);
    expect(out.omittedByCap).toBe(200);
    expect(JSON.stringify(out.matches).length).toBeLessThanOrEqual(20000);
    expect(out.note).toContain('omitted');
  });

  it('counts a long line as partially scanned rather than reporting a clean miss', async () => {
    await writeFile(path.join(dir, 'gen.tex'), `${'x'.repeat(50)}needle\n`);

    const out = await searchProject(files, dir, { pattern: 'needle', maxLineScanChars: 20 });

    expect(out.totalMatches).toBe(0);
    expect(out.linesTruncatedForScan).toBe(1);
    expect(out.note).toContain('per-line scan cap');
  });
});

describe('searchProject: runtime bounds inside one file', () => {
  const files = new FileService();
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-searchpartial-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('checks the deadline between LINES, and reports a file cut off part-way', async () => {
    // One file, so the old between-files check had nothing to interrupt: it read the clock
    // before the file and after it, and — the file being the last — never reported a timeout.
    const body = Array.from({ length: 50 }, (_unused, i) => `needle ${i}`).join('\n');
    await writeFile(path.join(dir, 'big.tex'), `${body}\n`);
    let ticks = 0;
    // Advances one step per reading: past the 10-unit budget after a dozen readings.
    const now = (): number => ticks++;

    const out = await searchProject(files, dir, { pattern: 'needle', budgetMs: 10, now });

    expect(out.timedOut).toBe(true);
    expect(out.filesPartiallySearched).toBe(1);
    expect(out.totalMatches).toBeGreaterThan(0);
    expect(out.totalMatches).toBeLessThan(50);
    expect(out.note).toContain('big.tex');
  });

  it('says when excludeComments met files that have no % comment syntax', async () => {
    await writeFile(path.join(dir, 'a.tex'), '% needle\nneedle\n');
    await writeFile(path.join(dir, 'notes.md'), '% needle\n');
    await writeFile(path.join(dir, 'todo.txt'), 'needle\n');

    const out = await searchProject(files, dir, { pattern: 'needle', excludeComments: true });

    // The .md line starting with `%` is reported: `%` is not a comment there.
    expect(out.matches.map((m) => m.path)).toEqual(['a.tex', 'notes.md', 'todo.txt']);
    expect(out.note).toMatch(/excludeComments/);
    expect(out.note).toMatch(/2 searched file\(s\)/);
  });

  it('adds no excludeComments note when every searched file has % comments', async () => {
    await writeFile(path.join(dir, 'a.tex'), 'needle\n');
    const out = await searchProject(files, dir, { pattern: 'needle', excludeComments: true });
    expect(out.note).toBeUndefined();
  });
});
