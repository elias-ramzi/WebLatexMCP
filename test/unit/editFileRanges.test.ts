import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { FileService } from '../../src/services/fileService.js';
import { lineSpan } from '../../src/lib/lines.js';
import { sliceLineRange } from '../../src/lib/lines.js';
import { createPreserveTransform } from '../../src/lib/rewriteMode.js';

/**
 * Line-range edits (`{startLine, endLine, newString}`) on `FileService.applyEdits`: the
 * numbering contract, the refusals that keep a mistyped range from silently rewriting the wrong
 * text, and — the part that touches the most heavily caveated code in the repo — that the
 * preserved-block ledger and the resolved-range ledger stay correct when both shapes of edit
 * appear in one call.
 */

const FIVE_LINES = 'one\ntwo\nthree\nfour\nfive\n';

describe('lineSpan (the offsets behind a range edit)', () => {
  // The write-side scan is separate code from `sliceLineRange`, which `read_file` uses. A caller
  // reads lines 3-5 and then edits lines 3-5: if the two scans ever disagree about which bytes
  // those are, the edit silently lands somewhere else. This pins them together over a matrix of
  // line-ending shapes rather than trusting that the two loops stay identical by inspection.
  const texts = [
    'one\ntwo\nthree\nfour\nfive\n',
    'one\ntwo\nthree\nfour\nfive',
    'a\r\nb\r\nc\r\n',
    'a\rb\rc',
    'single',
    'first\n\nthird\n',
  ];
  for (const text of texts) {
    const total = text
      .split(/\r\n|\n|\r/)
      .filter((_, i, a) => !(i === a.length - 1 && a[i] === '')).length;
    for (let start = 1; start <= total; start++) {
      for (let end = start; end <= total; end++) {
        const wholeFile = start === 1 && end === total;
        it(`matches sliceLineRange for ${JSON.stringify(text)} lines ${start}-${end}${
          wholeFile ? ' (whole-file: the one documented divergence)' : ''
        }`, () => {
          const span = lineSpan(text, start, end);
          expect(span).not.toBeNull();
          const sliced = text.slice(span!.start, span!.end);
          if (wholeFile) {
            // The documented divergence: a whole-file READ hands back the trailing newline,
            // a whole-file RANGE EDIT must not consume it (or replacing every line would strip
            // the file's final newline as an unasked-for side effect).
            expect(sliceLineRange(text, start, end)).toBe(text);
            expect(sliced).toBe(text.replace(/(\r\n|\n|\r)$/, ''));
          } else {
            expect(sliced).toBe(sliceLineRange(text, start, end));
          }
        });
      }
    }
  }

  it('returns null out of range rather than clamping the way a read does', () => {
    // sliceLineRange clamps: a read that shows fewer lines than asked is visible to the caller.
    // A clamped WRITE rewrites a region the caller never named, and they cannot see that.
    expect(sliceLineRange(FIVE_LINES, 4, 99)).toBe('four\nfive');
    expect(lineSpan(FIVE_LINES, 4, 99)).toBeNull();
    expect(lineSpan(FIVE_LINES, 0, 2)).toBeNull();
    expect(lineSpan(FIVE_LINES, 3, 2)).toBeNull();
  });
});

describe('FileService.applyEdits — line ranges', () => {
  let dir: string;
  const files = new FileService();

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-range-'));
    await writeFile(path.join(dir, 'main.tex'), FIVE_LINES);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const read = () => readFile(path.join(dir, 'main.tex'), 'utf8');

  it('replaces exactly the named lines, 1-based with endLine inclusive', async () => {
    const res = await files.applyEdits(dir, 'main.tex', [
      { startLine: 2, endLine: 3, newString: 'TWO\nTHREE' },
    ]);
    expect(res.appliedEdits).toBe(1);
    expect(await read()).toBe('one\nTWO\nTHREE\nfour\nfive\n');
  });

  it('replaces a whole file without eating its trailing newline', async () => {
    await files.applyEdits(dir, 'main.tex', [{ startLine: 1, endLine: 5, newString: 'only' }]);
    expect(await read()).toBe('only\n');
  });

  it('deletes the named lines when newString is empty (no preservation configured)', async () => {
    await files.applyEdits(dir, 'main.tex', [{ startLine: 2, endLine: 3, newString: '' }]);
    // The terminator after line 3 is not part of the range, so the emptied lines collapse into
    // one empty line rather than swallowing line 4.
    expect(await read()).toBe('one\n\nfour\nfive\n');
  });

  it(
    'does not expand $-patterns in a range edit’s newString ' +
      "(String.prototype.replace treats $$, $&, $`, $', $1 in a replacement as substitution " +
      'patterns; the range path must splice by index like every other path here)',
    async () => {
      const dollarLaden = "price is $100, then $$200$$, ref $& tick $` back $' fwd $1 group";
      await files.applyEdits(dir, 'main.tex', [
        { startLine: 2, endLine: 2, newString: dollarLaden },
      ]);
      expect(await read()).toBe(`one\n${dollarLaden}\nthree\nfour\nfive\n`);
    },
  );

  it('does not expand $-patterns when the replaced LINES are full of $ either', async () => {
    // The other half of the same trap: `replace(old, new)` also interprets the *pattern*
    // argument's specials via the match ($&). A range edit never builds a pattern at all, and
    // this pins that the bytes it replaces are found by offset, not by matching.
    const mathy = 'a $x$ and $$y$$ and $& and $1';
    await writeFile(path.join(dir, 'math.tex'), `head\n${mathy}\ntail\n`);
    await files.applyEdits(dir, 'math.tex', [{ startLine: 2, endLine: 2, newString: 'plain' }]);
    expect(await readFile(path.join(dir, 'math.tex'), 'utf8')).toBe('head\nplain\ntail\n');
  });

  it('a range naming a blank line inserts into it rather than failing on an empty span', async () => {
    await writeFile(path.join(dir, 'gap.tex'), 'a\n\nb\n');
    await files.applyEdits(dir, 'gap.tex', [{ startLine: 2, endLine: 2, newString: 'filled' }]);
    expect(await readFile(path.join(dir, 'gap.tex'), 'utf8')).toBe('a\nfilled\nb\n');
  });

  it('keeps CRLF terminators outside the range intact', async () => {
    await writeFile(path.join(dir, 'crlf.tex'), 'a\r\nb\r\nc\r\n');
    await files.applyEdits(dir, 'crlf.tex', [{ startLine: 2, endLine: 2, newString: 'B' }]);
    expect(await readFile(path.join(dir, 'crlf.tex'), 'utf8')).toBe('a\r\nB\r\nc\r\n');
  });

  it('refuses a range past the end of the file, naming the line count, and writes nothing', async () => {
    await expect(
      files.applyEdits(dir, 'main.tex', [{ startLine: 4, endLine: 99, newString: 'x' }]),
    ).rejects.toThrow(/lines 4-99 are outside main\.tex, which has 5 line\(s\)/);
    expect(await read()).toBe(FIVE_LINES);
  });

  it('refuses an inverted range', async () => {
    await expect(
      files.applyEdits(dir, 'main.tex', [{ startLine: 4, endLine: 2, newString: 'x' }]),
    ).rejects.toThrow(/startLine 4 is after endLine 2/);
    expect(await read()).toBe(FIVE_LINES);
  });

  it('refuses a range whose current text already equals newString (the no-op guard)', async () => {
    await expect(
      files.applyEdits(dir, 'main.tex', [{ startLine: 2, endLine: 2, newString: 'two' }]),
    ).rejects.toThrow(/lines 2-2 and newString are identical/);
    expect(await read()).toBe(FIVE_LINES);
  });

  it('is atomic across mixed shapes: a later failing string edit reverts the range edit too', async () => {
    await expect(
      files.applyEdits(dir, 'main.tex', [
        { startLine: 1, endLine: 1, newString: 'ONE' },
        { oldString: 'nonexistent', newString: 'X' },
      ]),
    ).rejects.toThrow(/not found/);
    expect(await read()).toBe(FIVE_LINES);
  });

  describe('line numbers refer to the file as the call found it', () => {
    it('a string edit that grows the text earlier in the file does not slide a later range', async () => {
      const res = await files.applyEdits(dir, 'main.tex', [
        { oldString: 'one', newString: 'one\nEXTRA\nLINES' },
        { startLine: 4, endLine: 4, newString: 'FOUR' },
      ]);
      expect(res.appliedEdits).toBe(2);
      // "four" was line 4 in the file the caller read; it is line 6 by the time the second edit
      // runs. The resolved span is shifted by the first splice, so it still covers "four".
      expect(await read()).toBe('one\nEXTRA\nLINES\ntwo\nthree\nFOUR\nfive\n');
    });

    it('a shrinking replaceAll earlier in the file does not slide a later range either', async () => {
      await writeFile(path.join(dir, 'many.tex'), 'xx\nxx\nkeep\nxx\ntarget\n');
      await files.applyEdits(dir, 'many.tex', [
        { oldString: 'xx', newString: 'y', replaceAll: true },
        { startLine: 5, endLine: 5, newString: 'HIT' },
      ]);
      // Three separate splices, each shortening the file by one character: the range must have
      // moved by the sum of them, not by one of them and not by none.
      expect(await readFile(path.join(dir, 'many.tex'), 'utf8')).toBe('y\ny\nkeep\ny\nHIT\n');
    });

    it('two ranges in one call are both resolved against the original numbering', async () => {
      await files.applyEdits(dir, 'main.tex', [
        { startLine: 1, endLine: 2, newString: 'A' },
        { startLine: 4, endLine: 5, newString: 'B' },
      ]);
      expect(await read()).toBe('A\nthree\nB\n');
    });

    it('refuses a string edit that would change text a later range covers', async () => {
      await expect(
        files.applyEdits(dir, 'main.tex', [
          { oldString: 'three', newString: 'THREE' },
          { startLine: 3, endLine: 4, newString: 'block' },
        ]),
      ).rejects.toThrow(/Edit 1 changes text that edit 2's line range covers/);
      expect(await read()).toBe(FIVE_LINES);
    });

    it('refuses two ranges that overlap each other', async () => {
      await expect(
        files.applyEdits(dir, 'main.tex', [
          { startLine: 2, endLine: 3, newString: 'X' },
          { startLine: 3, endLine: 4, newString: 'Y' },
        ]),
      ).rejects.toThrow(/Edit 1 changes text that edit 2's line range covers/);
      expect(await read()).toBe(FIVE_LINES);
    });

    it('refuses a replaceAll whose LATER occurrence lands in a pending range', async () => {
      // The first occurrence is outside the range and splices fine; the refusal has to come from
      // the second one, which is the case a check that only looked at the first would miss.
      await writeFile(path.join(dir, 'many.tex'), 'hit\nkeep\nhit\n');
      await expect(
        files.applyEdits(dir, 'many.tex', [
          { oldString: 'hit', newString: 'HIT', replaceAll: true },
          { startLine: 3, endLine: 3, newString: 'block' },
        ]),
      ).rejects.toThrow(/Edit 1 changes text that edit 2's line range covers/);
      expect(await readFile(path.join(dir, 'many.tex'), 'utf8')).toBe('hit\nkeep\nhit\n');
    });
  });

  describe('rewrite preservation composes with a range edit', () => {
    const PARAGRAPH =
      'The quick brown fox jumps over the lazy dog while the sun sets slowly behind the hills.';

    it('preserves the replaced lines as a %-commented block above the replacement', async () => {
      await writeFile(path.join(dir, 'p.tex'), `head\n${PARAGRAPH}\ntail\n`);
      const preserve = createPreserveTransform('always');
      await files.applyEdits(dir, 'p.tex', [{ startLine: 2, endLine: 2, newString: 'rewritten' }], {
        preserve,
      });
      expect(preserve.preservedEdits()).toBe(1);
      expect(await readFile(path.join(dir, 'p.tex'), 'utf8')).toBe(
        `head\n% ${PARAGRAPH}\nrewritten\ntail\n`,
      );
    });

    it('a range edit with an empty newString under `always` comments the block out in place', async () => {
      // This is the answer to the "commentOut range operation" half of the feature request: no
      // new operation, just the two existing pieces composing. The preserved block IS the output.
      await writeFile(path.join(dir, 'p.tex'), 'head\nred\ngreen\nblue\ntail\n');
      const preserve = createPreserveTransform('always');
      await files.applyEdits(dir, 'p.tex', [{ startLine: 2, endLine: 4, newString: '' }], {
        preserve,
      });
      expect(await readFile(path.join(dir, 'p.tex'), 'utf8')).toBe(
        'head\n% red\n% green\n% blue\ntail\n',
      );
    });

    it('a later string edit may not match inside a block a range edit preserved', async () => {
      // The preserved-range ledger has to be fed by the range path too. Without the push, this
      // edit would silently rewrite dead commented-out text and report success.
      await writeFile(path.join(dir, 'p.tex'), `head\n${PARAGRAPH}\ntail\n`);
      await expect(
        files.applyEdits(
          dir,
          'p.tex',
          [
            { startLine: 2, endLine: 2, newString: 'rewritten' },
            { oldString: 'quick brown fox', newString: 'slow green turtle' },
          ],
          { preserve: createPreserveTransform('always') },
        ),
      ).rejects.toThrow(/only matches text preserved \(commented out\) by an earlier edit/);
      expect(await readFile(path.join(dir, 'p.tex'), 'utf8')).toBe(`head\n${PARAGRAPH}\ntail\n`);
    });

    it('a preserved string edit shifts a later range by the WHOLE inserted block', async () => {
      // The ledger the other way round: the preserved comment is bytes the caller never sent, so
      // a later range has to move by the comment block plus the replacement, not by the
      // replacement alone. Getting this wrong lands the range one line high — silently.
      await writeFile(path.join(dir, 'p.tex'), `${PARAGRAPH}\nsecond\nthird\ntarget\n`);
      const preserve = createPreserveTransform('always');
      await files.applyEdits(
        dir,
        'p.tex',
        [
          { oldString: PARAGRAPH, newString: 'rewritten' },
          { startLine: 4, endLine: 4, newString: 'HIT' },
        ],
        { preserve },
      );
      // Both edits preserve under `always` — the range edit's own original is commented in
      // place too, which only lands on the right line if the range moved by the full insertion.
      expect(preserve.preservedEdits()).toBe(2);
      expect(await readFile(path.join(dir, 'p.tex'), 'utf8')).toBe(
        `% ${PARAGRAPH}\nrewritten\nsecond\nthird\n% target\nHIT\n`,
      );
    });
  });
});
