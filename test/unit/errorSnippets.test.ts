import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { FileService } from '../../src/services/fileService.js';
import { parseLog } from '../../src/services/logParser.js';
import {
  attachErrorSnippets,
  formatSnippet,
  MAX_SNIPPET_LOCATIONS,
} from '../../src/lib/errorSnippets.js';

const BROKEN_FIXTURE = path.resolve(__dirname, '../fixtures/sample-latex/main-broken.tex');

/** A project dir holding one file, so the real (sandboxed) FileService can read it. */
async function projectWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'snippets-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }
  return dir;
}

describe('attachErrorSnippets', () => {
  it('lines the snippet up with the reported line of a real failing compile', async () => {
    const source = readFileSync(BROKEN_FIXTURE, 'utf8');
    const dir = await projectWith({ 'main.tex': source });
    // The log pdflatex actually emits for this fixture, in -file-line-error form.
    const log = [
      'This is pdfTeX, Version 3.141592653',
      '(./main.tex',
      './main.tex:3: Undefined control sequence.',
      'l.3 This line uses an undefined macro: \\thismacrodoesnotexist',
      '?',
    ].join('\n');
    const parsed = parseLog(log);
    const { errors, omittedLocations } = await attachErrorSnippets(
      new FileService(),
      dir,
      parsed.errors,
    );

    expect(omittedLocations).toBe(0);
    expect(errors).toHaveLength(1);
    const err = errors[0]!;
    expect(err.line).toBe(3);
    // The file is short, so ±2 around line 3 clamps to the top of the file.
    expect(err.snippetStartLine).toBe(1);
    // 4 source lines plus the empty one after the file's trailing newline.
    const lines = err.snippet!.split('\n');
    expect(lines).toHaveLength(5);
    // The reported line is where the snippet says it is.
    expect(lines[err.line! - err.snippetStartLine!]).toContain('\\thismacrodoesnotexist');
    expect(lines[0]).toBe('\\documentclass{article}');
  });

  it('takes 2 lines either side, clamped at the file bounds', async () => {
    const dir = await projectWith({
      'main.tex': Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n'),
    });
    const at = async (line: number) =>
      (
        await attachErrorSnippets(new FileService(), dir, [
          { severity: 'error', file: 'main.tex', line, message: 'boom' },
        ])
      ).errors[0]!;

    const middle = await at(10);
    expect(middle.snippetStartLine).toBe(8);
    expect(middle.snippet!.split('\n')).toEqual([
      'line 8',
      'line 9',
      'line 10',
      'line 11',
      'line 12',
    ]);

    const top = await at(1);
    expect(top.snippetStartLine).toBe(1);
    expect(top.snippet!.split('\n')).toEqual(['line 1', 'line 2', 'line 3']);

    const bottom = await at(20);
    expect(bottom.snippetStartLine).toBe(18);
    expect(bottom.snippet!.split('\n')).toEqual(['line 18', 'line 19', 'line 20']);
  });

  it('shares one snippet across diagnostics on the same line and reads the file once', async () => {
    const dir = await projectWith({ 'main.tex': 'a\nb\nc\nd\ne' });
    const reads: string[] = [];
    const files = new FileService();
    const spy = {
      readExcerpt: (
        projectDir: string,
        opts: { path: string; startLine: number; endLine: number },
      ) => {
        reads.push(`${opts.path}:${opts.startLine}`);
        return files.readExcerpt(projectDir, opts);
      },
    };
    const { errors } = await attachErrorSnippets(spy, dir, [
      { severity: 'error', file: 'main.tex', line: 3, message: 'first' },
      { severity: 'error', file: 'main.tex', line: 3, message: 'second' },
    ]);

    expect(reads).toHaveLength(1);
    expect(errors[0]!.snippet).toBe(errors[1]!.snippet);
    expect(errors[0]!.snippetStartLine).toBe(1);
  });

  it('leaves an unattributed diagnostic without a guessed snippet', async () => {
    const dir = await projectWith({ 'main.tex': 'a\nb\nc' });
    const { errors } = await attachErrorSnippets(new FileService(), dir, [
      { severity: 'error', line: 2, message: 'no file' },
      { severity: 'error', file: 'main.tex', message: 'no line' },
    ]);
    expect(errors[0]!.snippet).toBeUndefined();
    expect(errors[1]!.snippet).toBeUndefined();
  });

  it('skips a file it cannot read rather than failing the compile result', async () => {
    const dir = await projectWith({ 'main.tex': 'a\nb\nc' });
    const { errors } = await attachErrorSnippets(new FileService(), dir, [
      { severity: 'error', file: 'gone.tex', line: 2, message: 'deleted since' },
      {
        severity: 'error',
        file: '/usr/share/texmf/tex/latex/foo.sty',
        line: 9,
        message: 'outside',
      },
      { severity: 'error', file: 'main.tex', line: 99, message: 'past the end' },
    ]);
    expect(errors.map((e) => e.snippet)).toEqual([undefined, undefined, undefined]);
  });

  it('caps the number of distinct locations and reports how many were left out', async () => {
    const dir = await projectWith({
      'main.tex': Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n'),
    });
    const many = Array.from({ length: MAX_SNIPPET_LOCATIONS + 3 }, (_, i) => ({
      severity: 'error' as const,
      file: 'main.tex',
      line: i + 1,
      message: `err ${i}`,
    }));
    const { errors, omittedLocations } = await attachErrorSnippets(new FileService(), dir, many);

    expect(omittedLocations).toBe(3);
    expect(errors.filter((e) => e.snippet !== undefined)).toHaveLength(MAX_SNIPPET_LOCATIONS);
    expect(errors[MAX_SNIPPET_LOCATIONS]!.snippet).toBeUndefined();
  });
});

describe('formatSnippet', () => {
  it('numbers the lines and marks the reported one', () => {
    const text = formatSnippet({
      severity: 'error',
      file: 'main.tex',
      line: 10,
      message: 'boom',
      snippet: 'eight\nnine\nten\neleven\ntwelve',
      snippetStartLine: 8,
    });
    expect(text.split('\n')).toEqual([
      '       8 | eight',
      '       9 | nine',
      '    > 10 | ten',
      '      11 | eleven',
      '      12 | twelve',
    ]);
  });

  it('returns nothing when there is no snippet', () => {
    expect(formatSnippet({ severity: 'error', message: 'boom' })).toBe('');
  });
});
