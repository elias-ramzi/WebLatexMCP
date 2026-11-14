import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { synctexEditQuery } from '../../src/lib/synctexReader.js';
import { SyncTexService } from '../../src/services/synctex.js';
import {
  locateQuote,
  locateQuoteInProject,
  quoteWords,
  sourceWords,
} from '../../src/lib/quoteLocate.js';
import { FileService } from '../../src/services/fileService.js';

/** sp for a PDF point, as SyncTeX writes it (Unit:1). */
const SP = 65781.76;
const sp = (bp: number): number => Math.round(bp * SP);

/**
 * A two-line page, as pdfTeX writes it: an hbox per output line (h, v baseline : W, H, D), with
 * leaves marking where each source line's text starts. Line 1 of the output holds source lines 5
 * then 6; line 2 is source line 9 of `sec/a.tex`.
 */
function synctexFile(dir: string): string {
  return [
    'SyncTeX Version:1',
    `Input:1:${dir}/./main.tex`,
    `Input:2:${dir}/./sec/a.tex`,
    'Output:pdf',
    'Magnification:1000',
    'Unit:1',
    'X Offset:0',
    'Y Offset:0',
    'Content:',
    '!100',
    '{1',
    `[1,3:${sp(72)},${sp(700)}:${sp(450)},${sp(600)},0`,
    `(1,5:${sp(72)},${sp(100)}:${sp(450)},${sp(8)},${sp(2)}`,
    `x1,5:${sp(72)},${sp(100)}`,
    `g1,5:${sp(150)},${sp(100)}`,
    `x1,6:${sp(300)},${sp(100)}`,
    `k1,6:${sp(400)},${sp(100)}:${sp(1)}`,
    ')',
    `(2,9:${sp(72)},${sp(120)}:${sp(450)},${sp(8)},${sp(2)}`,
    `x2,9:${sp(72)},${sp(120)}`,
    ')',
    ']',
    '}1',
    '',
  ].join('\n');
}

describe('synctexEditQuery: the in-process SyncTeX reader', () => {
  const text = synctexFile('/proj');

  it('maps a point to the source run it falls in', () => {
    expect(synctexEditQuery(text, 1, 100, 98)).toEqual({ input: '/proj/./main.tex', line: 5 });
    expect(synctexEditQuery(text, 1, 350, 98)).toEqual({ input: '/proj/./main.tex', line: 6 });
    expect(synctexEditQuery(text, 1, 200, 118)).toEqual({ input: '/proj/./sec/a.tex', line: 9 });
  });

  it('falls back to the nearest record when no line box holds the point', () => {
    expect(synctexEditQuery(text, 1, 80, 300)).toEqual({ input: '/proj/./sec/a.tex', line: 9 });
  });

  it('answers null for a page the file does not have', () => {
    expect(synctexEditQuery(text, 2, 100, 98)).toBeNull();
  });
});

describe('SyncTexService without the synctex CLI', () => {
  it('reads <job>.synctex.gz beside the PDF when the CLI cannot run', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wlm-synctex-'));
    try {
      await writeFile(path.join(dir, 'main.synctex.gz'), gzipSync(synctexFile(dir)));
      const missing = async (): Promise<never> => {
        throw new Error('spawn synctex ENOENT');
      };
      const svc = new SyncTexService(missing);
      expect(await svc.resolve(path.join(dir, 'main.pdf'), dir, 1, 350, 98)).toEqual({
        file: 'main.tex',
        line: 6,
      });
      expect(await svc.resolve(path.join(dir, 'main.pdf'), dir, 1, 200, 118)).toEqual({
        file: 'sec/a.tex',
        line: 9,
      });
      // No synctex file at all: still null, as before.
      expect(await svc.resolve(path.join(dir, 'other.pdf'), dir, 1, 0, 0)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('locateQuote: a comment quote matched against the sources', () => {
  const main = [
    '\\section{Introduction}', // 1
    "We study the \\emph{caf\\'e} problem here. % not this", // 2
    '', // 3
    'Second paragraph. It has', // 4
    'several source lines that get', // 5
    'reflowed~together \\cite{knuth} into one paragraph.', // 6
    'The results are shown below.', // 7
    'The results are shown below.', // 8
  ].join('\n');
  const sec = 'Section text from an \\textbf{in}cluded file.\n';
  const sources = [
    { file: 'main.tex', content: main },
    { file: 'sec/a.tex', content: sec },
  ];

  it('normalises the PDF side: ligatures, accents, case, a hyphen at a line break', () => {
    expect(quoteWords('The ﬁrst Café exam- ple')).toEqual(['the', 'first', 'cafe', 'example']);
  });

  it('reads the source side through markup and comments', () => {
    const words = sourceWords(main).map((w) => w.text);
    expect(words).toContain('cafe');
    expect(words).not.toContain('emph');
    expect(words).not.toContain('cite');
    expect(words).not.toContain('this');
    expect(sourceWords(sec).map((w) => w.text)).toContain('included');
  });

  it('locates a quote spanning reflowed source lines, at the line it starts on', () => {
    expect(locateQuote('It has several source lines that', sources)).toEqual({
      file: 'main.tex',
      line: 4,
    });
    expect(locateQuote('the café problem', sources)).toEqual({ file: 'main.tex', line: 2 });
    expect(locateQuote('from an included file', sources)).toEqual({
      file: 'sec/a.tex',
      line: 1,
    });
  });

  it('gets past a citation the PDF renders but the source does not spell', () => {
    // "[1]" in the PDF; the leading words are unique.
    expect(
      locateQuote(
        'several source lines that get reflowed together [1] into one paragraph',
        sources,
      ),
    ).toEqual({ file: 'main.tex', line: 5 });
  });

  it('refuses an ambiguous, absent or too-short quote', () => {
    expect(locateQuote('The results are shown below.', sources)).toBeNull();
    expect(locateQuote('nothing like this appears anywhere', sources)).toBeNull();
    expect(locateQuote('Second paragraph', sources)).toBeNull();
  });

  it('searches the project’s own .tex files', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wlm-quote-'));
    try {
      await mkdir(path.join(dir, 'sec'));
      await writeFile(path.join(dir, 'main.tex'), main);
      await writeFile(path.join(dir, 'sec', 'a.tex'), sec);
      await writeFile(path.join(dir, 'notes.md'), 'It has several source lines that\n');
      expect(
        await locateQuoteInProject(new FileService(), dir, 'It has several source lines that'),
      ).toEqual({ file: 'main.tex', line: 4 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
