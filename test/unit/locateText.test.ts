import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import {
  dropInstruction,
  LocateTextRefusal,
  locateTextInProject,
  pastedTextReadings,
  stripMarginNumbers,
} from '../../src/lib/locateText.js';
import {
  buildLocateTextResult,
  LOCATE_TEXT_CONTENT_BUDGET,
  renderLocatedEntry,
} from '../../src/lib/locateTextBudget.js';
import {
  fullMatches,
  quoteWords,
  sourceWords,
  windowMatches,
  type QuoteSourceReader,
} from '../../src/lib/quoteLocate.js';
import { FileService } from '../../src/services/fileService.js';

/** An in-memory project: canned file contents behind the reader interface. */
function reader(files: Record<string, string>): QuoteSourceReader {
  return {
    list: async () =>
      Object.entries(files).map(([p, c]) => ({ path: p, sizeBytes: Buffer.byteLength(c) })),
    readText: async (_dir, rel) => files[rel] ?? '',
  };
}

describe('pasted-text normalisation', () => {
  it('drops the trailing instruction and the margin number glued after a hyphen', () => {
    const r = pastedTextReadings('in non-reactive traf-103\nfic for Odyssey --> drop');
    expect(r.instructionDropped).toBe(true);
    expect(r.asPasted).toContain('103');
    expect(r.stripped).toEqual(['in', 'non', 'reactive', 'traffic', 'for', 'odyssey']);
    expect(r.marginNumbersRemoved).toBe(1);
  });

  it('removes a number after a hyphen-and-space break, and an instruction on its own line', () => {
    const r = pastedTextReadings('[TODO: update the contribu- 119\ntion list] \n--> remove');
    expect(r.instructionDropped).toBe(true);
    expect(r.stripped).toEqual(['todo', 'update', 'the', 'contribution', 'list']);
  });

  it('removes a standalone number ending a line, and leaves an inline one alone', () => {
    const r = pastedTextReadings('except 105\nagainst SafeDrive in reactive traffic (Tab. 2).');
    expect(r.instructionDropped).toBe(false);
    expect(r.stripped).toEqual([
      'except',
      'against',
      'safedrive',
      'in',
      'reactive',
      'traffic',
      'tab',
      '2',
    ]);
  });

  it('removes a number opening a line', () => {
    expect(stripMarginNumbers('the contribu-\n119 tion list')).toEqual({
      text: 'the contribu-\n tion list',
      removed: 1,
    });
    expect(quoteWords(stripMarginNumbers('the contribu-\n119 tion list').text)).toEqual([
      'the',
      'contribution',
      'list',
    ]);
  });

  it('keeps no stripped reading when nothing was removed', () => {
    const r = pastedTextReadings('a plain sentence with no numbers');
    expect(r.stripped).toBeNull();
    expect(r.marginNumbersRemoved).toBe(0);
  });

  it('folds ligatures (NFKD) on the pasted side', () => {
    expect(quoteWords('ﬁne-tuning the eﬃcient model')).toEqual([
      'fine',
      'tuning',
      'the',
      'efficient',
      'model',
    ]);
  });

  it('cuts at the first --> only', () => {
    expect(dropInstruction('a b c --> x --> y')).toEqual({
      text: 'a b c ',
      instructionDropped: true,
    });
  });
});

describe('all-matches location', () => {
  const files = (o: Record<string, string>) =>
    Object.entries(o).map(([file, c]) => ({ file, words: sourceWords(c) }));

  it('returns every live occurrence, with start and end lines', () => {
    const m = fullMatches(
      quoteWords('the quick brown fox'),
      files({ 'a.tex': 'x\nthe quick\nbrown fox\n', 'b.tex': 'the quick brown fox\n' }),
    );
    expect(m).toEqual([
      { file: 'a.tex', line: 2, endLine: 3, matchedBy: 'full' },
      { file: 'b.tex', line: 1, endLine: 1, matchedBy: 'full' },
    ]);
  });

  it('never matches commented-out text', () => {
    const m = fullMatches(
      quoteWords('the quick brown fox'),
      files({ 'a.tex': '% the quick brown fox\nthe quick brown fox\n' }),
    );
    expect(m).toEqual([{ file: 'a.tex', line: 2, endLine: 2, matchedBy: 'full' }]);
  });

  it('falls back to windows, folding a closing tail into its lead', () => {
    const src = 'one two three four five six \\cite{k} seven eight nine ten eleven twelve\n';
    const needle = quoteWords('one two three four five six [3] seven eight nine ten eleven twelve');
    expect(fullMatches(needle, files({ 'a.tex': src }))).toEqual([]);
    expect(windowMatches(needle, files({ 'a.tex': src }))).toEqual([
      { file: 'a.tex', line: 1, endLine: 1, matchedBy: 'leading-window' },
    ]);
  });
});

describe('locateTextInProject', () => {
  // A generated table or a pgfplots data block repeats one phrase thousands of times. Snippets
  // used to re-split the whole file per candidate and the window pairing rescanned the tail list
  // per lead hit — both quadratic, on the server's only thread (5 s at 16,000 lines). Linear now.
  it('a highly repetitive file stays fast (no per-candidate rescans)', async () => {
    const big = 'alpha beta gamma\n'.repeat(16_000);
    const t0 = performance.now();
    const out = await locateTextInProject(reader({ 'data.tex': big }), '/p', 'alpha beta gamma');
    expect(out.candidates.length).toBeGreaterThan(1000);
    const words = quoteWords(`${'zero '.repeat(6)}missing ${'zero '.repeat(6)}`);
    const src = [{ file: 'z.tex', words: sourceWords('zero '.repeat(40_000)) }];
    const windows = windowMatches(words, src);
    expect(windows.length).toBeGreaterThan(1000);
    expect(performance.now() - t0).toBeLessThan(3000);
  });

  it('two live occurrences: two results, not unique', async () => {
    const out = await locateTextInProject(
      reader({
        'main.tex': 'We evaluate in reactive traffic here.\n',
        'sec/b.tex': 'Also we evaluate in reactive traffic.\n',
      }),
      '/p',
      'we evaluate in reactive traffic',
    );
    const { result } = buildLocateTextResult(out, 5);
    expect(result.matchCount).toBe(2);
    expect(result.unique).toBe(false);
    expect(result.results.map((r) => r.file)).toEqual(['main.tex', 'sec/b.tex']);
  });

  it('one live and one commented: one result, unique, snippet of the live line only', async () => {
    const out = await locateTextInProject(
      reader({
        'main.tex':
          '% We evaluate in reactive traffic.\nWe evaluate in reactive\n% old\ntraffic now.\n',
      }),
      '/p',
      'we evaluate in reactive traffic',
    );
    const { result, text } = buildLocateTextResult(out, 5);
    expect(result.matchCount).toBe(1);
    expect(result.unique).toBe(true);
    expect(result.results[0]).toEqual({
      file: 'main.tex',
      line: 2,
      endLine: 4,
      matchedBy: 'full',
      snippet: 'We evaluate in reactive\ntraffic now.',
    });
    expect(text).toContain('main.tex:2–4 (full)');
  });

  it('locates the CVPR margin-number paste only through the stripped reading', async () => {
    const out = await locateTextInProject(
      reader({ 'main.tex': 'Results in non-reactive traffic for Odyssey are shown.\n' }),
      '/p',
      'in non-reactive traf-103\nfic for Odyssey --> drop',
    );
    const { result } = buildLocateTextResult(out, 5);
    expect(result.variant).toBe('margin-numbers-removed');
    expect(result.instructionDropped).toBe(true);
    expect(result.marginNumbersRemoved).toBe(1);
    expect(result.matchCount).toBe(1);
  });

  it('a real trailing number still matches as pasted', async () => {
    const out = await locateTextInProject(
      reader({
        'main.tex': 'The model scores 74\non the benchmark.\nThe model scores on the benchmark.\n',
      }),
      '/p',
      'The model scores 74\non the benchmark',
    );
    const { result } = buildLocateTextResult(out, 5);
    expect(result.variant).toBe('as-pasted');
    expect(result.results).toEqual([
      expect.objectContaining({ file: 'main.tex', line: 1, endLine: 2 }),
    ]);
  });

  it('matches a ligature in the paste against the plain source', async () => {
    const out = await locateTextInProject(
      reader({ 'main.tex': 'We fine-tune the efficient model.\n' }),
      '/p',
      'ﬁne-tune the eﬃcient model',
    );
    expect(out.candidates).toHaveLength(1);
  });

  it('refuses fewer than three words', async () => {
    await expect(
      locateTextInProject(reader({ 'main.tex': 'a b c' }), '/p', 'two words --> fix'),
    ).rejects.toThrow(LocateTextRefusal);
  });

  it('refuses a path that is not a .tex file of the project', async () => {
    await expect(
      locateTextInProject(reader({ 'main.tex': 'a b c' }), '/p', 'one two three', {
        paths: ['nope.tex'],
      }),
    ).rejects.toThrow(/Not a \.tex file of this project: "nope\.tex"/);
  });

  it('restricts to paths', async () => {
    const out = await locateTextInProject(
      reader({ 'a.tex': 'one two three\n', 'b.tex': 'one two three\n' }),
      '/p',
      'one two three',
      { paths: ['./b.tex'] },
    );
    expect(out.candidates.map((c) => c.file)).toEqual(['b.tex']);
    expect(out.filesSearched).toBe(1);
  });

  it('reads through FileService on a real directory', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wlm-locate-'));
    try {
      await writeFile(path.join(dir, 'main.tex'), 'Some text\nwe keep here.\n');
      await writeFile(path.join(dir, 'notes.md'), 'Some text we keep here.\n');
      const out = await locateTextInProject(new FileService(), dir, 'some text we keep');
      expect(out.candidates).toEqual([
        expect.objectContaining({ file: 'main.tex', line: 1, endLine: 2 }),
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('locate_text payload budget', () => {
  it('stays within the budget across both channels, counting what it cut', async () => {
    const long = `alpha beta gamma ${'x'.repeat(3000)}\n`;
    const files: Record<string, string> = {};
    for (let i = 0; i < 20; i++) files[`${'d'.repeat(150)}/f${i}.tex`] = long.repeat(8);
    const out = await locateTextInProject(reader(files), '/p', 'alpha beta gamma');
    const { result } = buildLocateTextResult(out, 20);
    expect(result.matchCount).toBe(160);
    const rendered =
      JSON.stringify(result.results).length +
      result.results.map((e) => renderLocatedEntry(e).join('\n')).join('\n').length;
    expect(rendered).toBeLessThanOrEqual(LOCATE_TEXT_CONTENT_BUDGET);
    expect(result.results.length + result.resultsOmitted).toBe(160);
    for (const e of result.results) {
      if (e.snippet !== null) expect(e.snippet.length).toBeLessThanOrEqual(241);
    }
  });

  it('cuts snippets before locations when they do not fit', async () => {
    // Each match spans six live lines whose trailing comments make them long, so each snippet
    // costs ~3k characters across both channels: 20 of them cannot fit in 20000.
    const block = Array.from({ length: 6 }, (_, k) => `word${k} %${'y'.repeat(400)}`);
    const files: Record<string, string> = {};
    for (let i = 0; i < 20; i++)
      files[`f${String(i).padStart(2, '0')}.tex`] = `${block.join('\n')}\n`;
    const out = await locateTextInProject(
      reader(files),
      '/p',
      'word0 word1 word2 word3 word4 word5',
    );
    const { result, text } = buildLocateTextResult(out, 20);
    expect(result.matchCount).toBe(20);
    expect(result.results).toHaveLength(20);
    expect(result.resultsOmitted).toBe(0);
    expect(result.snippetsOmitted).toBeGreaterThan(0);
    expect(result.results.filter((e) => e.snippet === null)).toHaveLength(result.snippetsOmitted);
    // Locations first: the kept snippets are the earliest entries.
    expect(result.results[0]?.snippet).not.toBeNull();
    expect(result.results[19]?.snippet).toBeNull();
    const rendered =
      JSON.stringify(result.results).length +
      result.results.map((e) => renderLocatedEntry(e).join('\n')).join('\n').length;
    expect(rendered).toBeLessThanOrEqual(LOCATE_TEXT_CONTENT_BUDGET);
    expect(result.note).toMatch(/snippet\(s\) cut by the payload budget/);
    expect(text).toContain('(snippet omitted by the payload budget');
  });
});
