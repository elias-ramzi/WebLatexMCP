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

  describe('an empty newString deletes the lines, terminator included', () => {
    // The span stops before the terminator that ends endLine, so replacing it with '' used to
    // leave that terminator behind as a blank line — a \par in LaTeX, which is not what "delete
    // these lines" means. A deletion takes the terminator after endLine (or, for an unterminated
    // last line, the one before startLine) so the lines disappear outright.
    // A fresh file per call: the shared FileService records a baseline on every write, so
    // rewriting one file on disk between calls would (rightly) trip ExternalChangeError.
    let n = 0;
    const del = async (content: string, startLine: number, endLine: number) => {
      const name = `del${n++}.tex`;
      await writeFile(path.join(dir, name), content);
      await files.applyEdits(dir, name, [{ startLine, endLine, newString: '' }]);
      return readFile(path.join(dir, name), 'utf8');
    };

    it('deletes lines from the middle of the file', async () => {
      await files.applyEdits(dir, 'main.tex', [{ startLine: 2, endLine: 3, newString: '' }]);
      expect(await read()).toBe('one\nfour\nfive\n');
      expect(await del('one\ntwo\nthree\nfour\n', 2, 3)).toBe('one\nfour\n');
      expect(await del('Para one a.\nline b.\nline c.\nline d.\n', 2, 3)).toBe(
        'Para one a.\nline d.\n',
      );
    });

    it('deletes the last lines, keeping the file newline-terminated', async () => {
      expect(await del('one\ntwo\nthree\n', 2, 3)).toBe('one\n');
    });

    it('deletes every line to an empty file', async () => {
      expect(await del('one\ntwo\nthree\n', 1, 3)).toBe('');
      expect(await del('one\ntwo\nthree', 1, 3)).toBe('');
    });

    it('takes the terminator BEFORE an unterminated last line', async () => {
      expect(await del('one\ntwo\nthree', 3, 3)).toBe('one\ntwo');
      expect(await del('one\ntwo\nthree', 2, 3)).toBe('one');
    });

    it("uses the file's own terminators (CRLF and CR-only)", async () => {
      expect(await del('a\r\nb\r\nc\r\nd\r\n', 2, 3)).toBe('a\r\nd\r\n');
      expect(await del('a\r\nb\r\nc', 3, 3)).toBe('a\r\nb');
      expect(await del('a\rb\rc\r', 2, 2)).toBe('a\rc\r');
    });

    it('deletes a blank line', async () => {
      expect(await del('a\n\nb\n', 2, 2)).toBe('a\nb\n');
    });

    it('two deletions in one call compose, in either order', async () => {
      for (const order of [
        [2, 3],
        [3, 2],
      ]) {
        const name = `order${order.join('')}.tex`;
        await writeFile(path.join(dir, name), 'one\ntwo\nthree');
        await files.applyEdits(
          dir,
          name,
          order.map((line) => ({ startLine: line, endLine: line, newString: '' })),
        );
        expect(await readFile(path.join(dir, name), 'utf8')).toBe('one');
      }
    });

    // Whether a deletion is a no-op is decided against the file the caller read, not against the
    // file an earlier deletion left. Deleting an unterminated last line takes the terminator
    // before it — here a blank line's own terminator — so a blank-line deletion that ran after it
    // found nothing left to take and was refused as "identical", while the other order succeeded.
    it('deletions that share a terminator compose in every order', async () => {
      const cases: [string, [number, number][]][] = [
        [
          '\nfoo',
          [
            [2, 2],
            [1, 1],
          ],
        ],
        [
          'line0\rline1\r\rx3',
          [
            [1, 2],
            [4, 4],
            [3, 3],
          ],
        ],
        [
          '\r\n\r\n\r\nline3\r\nline4',
          [
            [2, 3],
            [4, 4],
            [5, 5],
            [1, 1],
          ],
        ],
      ];
      let k = 0;
      for (const [content, ranges] of cases) {
        for (const order of [ranges, [...ranges].reverse()]) {
          const name = `share${k++}.tex`;
          await writeFile(path.join(dir, name), content);
          await files.applyEdits(
            dir,
            name,
            order.map(([startLine, endLine]) => ({ startLine, endLine, newString: '' })),
          );
          expect(await readFile(path.join(dir, name), 'utf8')).toBe('');
        }
      }
    });

    // Deleting an unterminated last line takes the terminator of the line before it — in the
    // file the caller read. An earlier deletion can leave a bare '\r' and a later line's '\n'
    // adjacent, where they read as one CRLF; measuring "the terminator before" in the current
    // content then took both, eating the '\r' of a line nobody deleted, and only in that order.
    it('takes only the previous line’s own terminator, whatever an earlier deletion left adjacent', async () => {
      const cases: [string, [number, number, string][], string][] = [
        [
          'line0\nx1\r\n\rline3\n\nx5',
          [
            [2, 3, 'N2'],
            [4, 4, ''],
            [6, 6, ''],
          ],
          'line0\nN2\r',
        ],
        [
          'x0\r\n\nx2\rx3\n\nx5',
          [
            [4, 4, ''],
            [6, 6, ''],
          ],
          'x0\r\n\nx2\r',
        ],
        // The line before the deleted last one was itself deleted: its own `prev` carries over.
        [
          '\rx1\n\r\n\nx4\nline5',
          [
            [5, 5, ''],
            [2, 3, ''],
            [6, 6, ''],
            [1, 1, 'N1'],
          ],
          'N1\r',
        ],
      ];
      let k = 0;
      for (const [content, ranges, expected] of cases) {
        for (const order of [ranges, [...ranges].reverse()]) {
          const name = `adj${k++}.tex`;
          await writeFile(path.join(dir, name), content);
          await files.applyEdits(
            dir,
            name,
            order.map(([startLine, endLine, newString]) => ({ startLine, endLine, newString })),
          );
          expect(await readFile(path.join(dir, name), 'utf8')).toBe(expected);
        }
      }
    });

    // A deletion between a bare-'\r' line and a blank LF line left that '\r' and the '\n'
    // adjacent, where they read as ONE CRLF: the blank line after the deletion vanished with the
    // deleted one. The line before takes a '\n' instead — the terminator the blank line after it
    // already uses, so no terminator type the file lacks — and the line count drops by exactly
    // the lines deleted, whichever deletion in the call completes the run.
    it('never lets a deletion fuse a bare \\r with the next blank line’s \\n', async () => {
      const cases: [string, [number, number][], string][] = [
        ['a\r\r\n\nb\n', [[2, 2]], 'a\n\nb\n'],
        // Two adjacent deletions: the same bytes whichever of the two completes the run.
        [
          'a\rX\r\nY\n\nb',
          [
            [2, 2],
            [3, 3],
          ],
          'a\n\nb',
        ],
        // The bare-'\r' line is deleted as well.
        [
          'z\na\rX\r\n\nb',
          [
            [2, 2],
            [3, 3],
          ],
          'z\n\nb',
        ],
        // The blank line after is deleted as well: nothing is left to fuse with, so the '\r' stays.
        [
          'a\rX\r\n\nb',
          [
            [2, 2],
            [3, 3],
          ],
          'a\rb',
        ],
        // A run of bare-'\r' lines before: each would fuse with the one after it in turn.
        ['o\r\rX\n\nb', [[3, 3]], 'o\n\n\nb'],
      ];
      const lineCount = (text: string) => text.split(/\r\n|\n|\r/).length;
      let k = 0;
      for (const [content, ranges, expected] of cases) {
        const deleted = ranges.reduce((sum, [s, e]) => sum + e - s + 1, 0);
        for (const order of [ranges, [...ranges].reverse()]) {
          const name = `fuse${k++}.tex`;
          await writeFile(path.join(dir, name), content);
          await files.applyEdits(
            dir,
            name,
            order.map(([startLine, endLine]) => ({ startLine, endLine, newString: '' })),
          );
          const got = await readFile(path.join(dir, name), 'utf8');
          expect(got).toBe(expected);
          expect(lineCount(got)).toBe(lineCount(content) - deleted);
        }
      }
    });

    it('a blank-line deletion is a no-op only in an empty file', async () => {
      await writeFile(path.join(dir, 'empty.tex'), '');
      await expect(
        files.applyEdits(dir, 'empty.tex', [{ startLine: 1, endLine: 1, newString: '' }]),
      ).rejects.toThrow(/lines 1-1 and newString are identical/);
      expect(await del('\n', 1, 1)).toBe('');
    });

    it('a deletion next to a replaced line leaves that line intact, in either order', async () => {
      await writeFile(path.join(dir, 'del.tex'), 'one\ntwo\nthree');
      await files.applyEdits(dir, 'del.tex', [
        { startLine: 3, endLine: 3, newString: '' },
        { startLine: 2, endLine: 2, newString: 'TWO' },
      ]);
      expect(await readFile(path.join(dir, 'del.tex'), 'utf8')).toBe('one\nTWO');

      await files.applyEdits(dir, 'main.tex', [
        { startLine: 2, endLine: 2, newString: 'TWO' },
        { startLine: 3, endLine: 3, newString: '' },
      ]);
      expect(await read()).toBe('one\nTWO\nfour\nfive\n');
    });
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

    it('refuses a string edit that starts at a pending BLANK line (an empty span)', async () => {
      // A blank line's span is [r, r): `start < range.end && end > range.start` can never hold
      // for it, so a splice beginning at r slipped past the check. Under preservation the range
      // edit then landed in front of the comment block the first edit inserted — "L2%" — so the
      // preserved block was no longer the bytes that were there.
      for (const preserve of [createPreserveTransform('always'), undefined]) {
        await writeFile(path.join(dir, 'gap.tex'), 'a\n\nb\n');
        await expect(
          files.applyEdits(
            dir,
            'gap.tex',
            [
              { oldString: '\nb', newString: 'X' },
              { startLine: 2, endLine: 2, newString: 'L2' },
            ],
            preserve ? { preserve } : {},
          ),
        ).rejects.toThrow(/Edit 1 changes text that edit 2's line range covers/);
        expect(await readFile(path.join(dir, 'gap.tex'), 'utf8')).toBe('a\n\nb\n');
      }
    });

    it('refuses naming the same blank line twice, as it does any other line', async () => {
      await writeFile(path.join(dir, 'gap.tex'), 'a\n\nb\n');
      await expect(
        files.applyEdits(dir, 'gap.tex', [
          { startLine: 2, endLine: 2, newString: 'X' },
          { startLine: 2, endLine: 2, newString: 'Y' },
        ]),
      ).rejects.toThrow(/Edit 1 changes text that edit 2's line range covers/);
      expect(await readFile(path.join(dir, 'gap.tex'), 'utf8')).toBe('a\n\nb\n');
    });

    it('refuses a string edit that consumes the terminator after a pending range', async () => {
      // The newline ending endLine belongs to the range: a deletion takes it, so an earlier edit
      // that already rewrote it would leave the deletion eating someone else's text.
      await expect(
        files.applyEdits(dir, 'main.tex', [
          { oldString: '\nfour', newString: ' FOUR' },
          { startLine: 2, endLine: 3, newString: '' },
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

    it('a deletion of an unterminated last line never eats a preserved block’s newline', async () => {
      // The one terminator a deletion may take that its range does not own is the one BEFORE an
      // unterminated last line. When an earlier edit's preserved block ends there, taking it
      // would change the block's bytes — so the line's text goes and the newline stays. A hook
      // that preserves only the first edit stands in for `prose` mode judging the two differently.
      await writeFile(path.join(dir, 'p.tex'), 'a\nb');
      const always = createPreserveTransform('always');
      let calls = 0;
      let preservedThis = false;
      const firstOnly = {
        transform: (edit: Parameters<typeof always.transform>[0], at: number, c: string) => {
          preservedThis = calls++ === 0;
          return preservedThis ? always.transform(edit, at, c) : edit.newString;
        },
        lastInsertion: () => (preservedThis ? always.lastInsertion() : undefined),
      };
      await files.applyEdits(
        dir,
        'p.tex',
        [
          { oldString: 'a\n', newString: '' },
          { startLine: 2, endLine: 2, newString: '' },
        ],
        { preserve: firstOnly },
      );
      expect(await readFile(path.join(dir, 'p.tex'), 'utf8')).toBe('% a\n');
    });

    it('a blank line named for deletion goes, with nothing to preserve', async () => {
      await writeFile(path.join(dir, 'p.tex'), 'a\n\nb\n');
      const preserve = createPreserveTransform('always');
      await files.applyEdits(dir, 'p.tex', [{ startLine: 2, endLine: 2, newString: '' }], {
        preserve,
      });
      expect(preserve.preservedEdits()).toBe(0);
      expect(await readFile(path.join(dir, 'p.tex'), 'utf8')).toBe('a\nb\n');
    });

    /** Apply `edits` under `always` to a fresh file holding `content`; return the result. */
    let m = 0;
    const preserveAlways = async (
      content: string,
      edits: Parameters<FileService['applyEdits']>[2],
    ) => {
      const name = `pa${m++}.tex`;
      await writeFile(path.join(dir, name), content);
      const preserve = createPreserveTransform('always');
      await files.applyEdits(dir, name, edits, { preserve });
      return {
        text: await readFile(path.join(dir, name), 'utf8'),
        preserved: preserve.preservedEdits(),
      };
    };

    // A range ending on a blank line: the synthesized oldString ends in the terminator BETWEEN
    // the range's lines, which the hook used to read as "the caller consumed its own newline" —
    // so the blank line was left out of the block and put back live after the replacement (a
    // \par the edit never asked for, and a line the caller named that was neither preserved nor
    // replaced).
    it('comments out every line of a range, blank ones included', async () => {
      expect(
        await preserveAlways('line0\n\nline2\n', [{ startLine: 1, endLine: 2, newString: 'N1' }]),
      ).toEqual({ text: '% line0\n%\nN1\nline2\n', preserved: 1 });
      expect(
        await preserveAlways('line0\r\n\r\nline2\r\n', [
          { startLine: 1, endLine: 2, newString: 'N1' },
        ]),
      ).toEqual({ text: '% line0\r\n%\r\nN1\r\nline2\r\n', preserved: 1 });
      expect(
        await preserveAlways('line0\n\nline2\n', [{ startLine: 1, endLine: 2, newString: '' }]),
      ).toEqual({ text: '% line0\n%\nline2\n', preserved: 1 });
      expect(
        await preserveAlways('a\n\n\nb\n', [{ startLine: 2, endLine: 3, newString: 'X' }]),
      ).toEqual({ text: 'a\n%\n%\nX\nb\n', preserved: 1 });
    });

    // A CR-only file must stay CR-only: the separator used to be '\n' or '\r\n', never '\r', and
    // a middle line (followed by a bare '\r') was not recognised as ending a line, so under
    // `always` its deletion went through unpreserved.
    it('keeps a CR-only file CR-only, and preserves its middle lines', async () => {
      expect(
        await preserveAlways('a\rb\rc', [{ startLine: 3, endLine: 3, newString: 'C' }]),
      ).toEqual({ text: 'a\rb\r% c\rC', preserved: 1 });
      expect(
        await preserveAlways('a\rb\rc\r', [{ startLine: 2, endLine: 2, newString: 'B' }]),
      ).toEqual({ text: 'a\r% b\rB\rc\r', preserved: 1 });
      expect(
        await preserveAlways('a\rb\rc\r', [{ startLine: 2, endLine: 2, newString: '' }]),
      ).toEqual({ text: 'a\r% b\rc\r', preserved: 1 });
    });

    // The separator is judged against the file the caller read, like the line numbers: an
    // earlier deletion that removed the file's only CRLF must not turn a later block's separator
    // into LF.
    it('picks the separator from the file as the call found it, in either order', async () => {
      const edits = [
        { startLine: 1, endLine: 1, newString: '' },
        { startLine: 2, endLine: 2, newString: 'N2' },
      ];
      for (const order of [edits, [...edits].reverse()]) {
        expect(await preserveAlways('\r\nline1', order)).toEqual({
          text: '% line1\r\nN2',
          preserved: 1,
        });
      }
    });

    // A STRING edit's separator is judged there too, at the match's position in that file: an
    // earlier range deletion that changed the evidence (the file's only CRLF, its bare CR, or the
    // bytes right after the match) must not change it — nor write an LF into a CR-only file.
    it('picks a string edit’s separator from the file as the call found it, in either order', async () => {
      const cases: [string, Parameters<FileService['applyEdits']>[2], string][] = [
        [
          '\r\nx1q',
          [
            { startLine: 1, endLine: 1, newString: '' },
            { oldString: 'x1q', newString: 'S2' },
          ],
          '% x1q\r\nS2',
        ],
        [
          '\rl1q',
          [
            { startLine: 1, endLine: 1, newString: '' },
            { oldString: 'l1q', newString: 'S' },
          ],
          '% l1q\rS',
        ],
        // Deleting the blank line 2 leaves line 1's bare '\r' in front of line 3's '\n', where
        // the current content reads a CRLF after the match; the line's own terminator was '\r'.
        [
          'x1q\r\r\n\nb',
          [
            { startLine: 2, endLine: 2, newString: '' },
            { oldString: 'x1q', newString: 'S' },
          ],
          '% x1q\rS\n\nb',
        ],
      ];
      for (const [content, edits, expected] of cases) {
        for (const order of [edits, [...edits].reverse()]) {
          expect(await preserveAlways(content, order)).toEqual({ text: expected, preserved: 1 });
        }
      }
    });

    // A string edit whose oldString ends in its own bare '\r' gets that terminator put back after
    // the replacement. When a deletion then leaves the put-back '\r' right before a blank line's
    // '\n', the two read as ONE CRLF and the blank line (a \par) is lost — the unfuse rule used to
    // skip it as "inserted text". Spelling the edit without its '\r' (the '\r' stays in the file,
    // an original byte) already kept the blank line; both spellings must write the same bytes, in
    // either order of the edits.
    it('never lets a deletion fuse the terminator a preserved edit put back', async () => {
      const content = 'a\rt\r\r\n\nb';
      const expected = 'a\r% t\rS\n\nb';
      for (const oldString of ['t\r', 't']) {
        const edits = [
          { oldString, newString: 'S' },
          { startLine: 3, endLine: 3, newString: '' },
        ];
        for (const order of [edits, [...edits].reverse()]) {
          const { text, preserved } = await preserveAlways(content, order);
          expect({ oldString, text, preserved }).toEqual({
            oldString,
            text: expected,
            preserved: 1,
          });
          // One blank line of the two deleted, one comment line added: the other blank line stays.
          expect(text.split(/\r\n|\n|\r/)).toEqual(['a', '% t', 'S', '', 'b']);
        }
      }
    });

    // What a string edit's preservation reads around its match — whether it starts and ends a
    // line, whether its trailing '\r' is half of a CRLF, whether anything follows it — is judged
    // in the file as the call found it, like its separator. Judged in the current content, an
    // earlier deletion changed each answer, and with it the bytes, with the order of the edits.
    it('judges a string edit’s alignment and its put-back terminator in the file as found', async () => {
      const cases: [string, string, Parameters<FileService['applyEdits']>[2], string][] = [
        [
          // Deleting the trailing blank line first left the match at EOF: nothing was put back.
          'put-back at a new EOF',
          'a\nt\n\n',
          [
            { oldString: 't\n', newString: 'S' },
            { startLine: 3, endLine: 3, newString: '' },
          ],
          'a\n% t\nS\n',
        ],
        [
          // Deleting the blank line 2 first left line 1's '\r' before the match's '\n': the match
          // no longer started a line, and went through unpreserved.
          'line start inside a fused pair',
          'a\r\r\n\nP',
          [
            { oldString: '\nP', newString: 'N' },
            { startLine: 2, endLine: 2, newString: '' },
          ],
          'a\r%\n% P\r\nN',
        ],
      ];
      for (const [label, content, edits, expected] of cases) {
        for (const order of [edits, [...edits].reverse()]) {
          expect({ label, ...(await preserveAlways(content, order)) }).toEqual({
            label,
            text: expected,
            preserved: 1,
          });
        }
      }
    });

    // The end of the match is the one judgment that must ALSO hold in the current content: an
    // earlier edit that took the match's terminator left live text right after it, and preserving
    // the deletion would comment that text out with it.
    it('does not preserve a deletion whose terminator an earlier edit took', async () => {
      expect(
        await preserveAlways('P\nQ', [
          { oldString: '\nQ', newString: ' tail' },
          { oldString: 'P', newString: '' },
        ]),
      ).toEqual({ text: ' tail', preserved: 0 });
    });

    // The start must hold in the current content too, for the same reason: an earlier edit that
    // took the terminator before the match (a replacement, or a deletion) left live text in front
    // of it. A block opened there puts the separator's line break after the comment, and a
    // newString starting with its own line break then leaves a blank line — a \par that mode off,
    // where that line break just ends the live line, never produces.
    it('does not preserve a match an earlier edit joined onto a live line', async () => {
      const prose = 'The proposed method improves retrieval accuracy on three standard benchmarks.';
      const rewrite =
        'Our approach reduces memory by half while keeping the accuracy of prior work.';
      const cases: [string, Parameters<FileService['applyEdits']>[2], string][] = [
        [
          `A\n\n${prose}\nQ\n`,
          [
            { oldString: 'A\n', newString: 'A ' },
            { oldString: `\n${prose}`, newString: `\n${rewrite}` },
          ],
          `A \n${rewrite}\nQ\n`,
        ],
        [
          `X Y\n\n${prose}\nQ\n`,
          [
            { oldString: ' Y\n', newString: '' },
            { oldString: `\n${prose}`, newString: `\n${rewrite}` },
          ],
          `X\n${rewrite}\nQ\n`,
        ],
      ];
      for (const [content, edits, off] of cases) {
        const name = `pj${m++}.tex`;
        await writeFile(path.join(dir, name), content);
        const preserve = createPreserveTransform('prose');
        await files.applyEdits(dir, name, edits, { preserve });
        expect({
          text: await readFile(path.join(dir, name), 'utf8'),
          preserved: preserve.preservedEdits(),
        }).toEqual({ text: off, preserved: 0 });
      }
    });

    /** Apply `edits` under `always` to a fresh file holding `content`; return the refusal, after
     * checking the file was left untouched. */
    const refusedUnderAlways = async (
      content: string,
      edits: Parameters<FileService['applyEdits']>[2],
    ): Promise<string> => {
      const name = `pr${m++}.tex`;
      await writeFile(path.join(dir, name), content);
      const err = await files
        .applyEdits(dir, name, edits, { preserve: createPreserveTransform('always') })
        .then(
          () => null,
          (e: unknown) => (e as Error).message,
        );
      expect(await readFile(path.join(dir, name), 'utf8')).toBe(content);
      expect(err).not.toBeNull();
      return err as string;
    };

    // The other order of the case above. The first edit preserves `P` as `% P`, a comment that
    // ends at the newline after it; the second then takes that newline, and its replacement —
    // live text the caller asked for — used to land on the comment's line (`% P tail`), where
    // LaTeX drops it without a word. The newline ending a preserved block is part of what makes
    // it a comment, so taking it is refused like matching inside the block itself.
    it('refuses an edit that takes the newline ending a block preserved in the same call', async () => {
      const cases: [string, Parameters<FileService['applyEdits']>[2]][] = [
        [
          'P\nQ',
          [
            { oldString: 'P', newString: '' },
            { oldString: '\nQ', newString: ' tail' },
          ],
        ],
        // A replacement's separator ends its block just the same.
        [
          'P\nQ',
          [
            { oldString: 'P', newString: 'X' },
            { oldString: '\nX', newString: ' tail' },
          ],
        ],
        // A replaceAll never runs the hook, but its splices still reach the block's newline.
        [
          'P\r\nQ\r\n',
          [
            { oldString: 'P', newString: '' },
            { oldString: '\r\nQ', newString: ' tail', replaceAll: true },
          ],
        ],
        // A replaceAll rewriting the block's OWN terminator (the oldString took it) may rewrite
        // inside the comment, but not run the comment line on into the text that replaced `Q`.
        [
          'P\r\nQ',
          [
            { oldString: 'P\r\n', newString: '' },
            { oldString: '\r\nQ', newString: 'W', replaceAll: true },
          ],
        ],
        // A range-preserved block, and a string edit taking the range's terminator.
        [
          'P\nQ\n',
          [
            { startLine: 1, endLine: 1, newString: '' },
            { oldString: '\nQ', newString: ' tail' },
          ],
        ],
      ];
      for (const [content, edits] of cases) {
        expect(await refusedUnderAlways(content, edits)).toMatch(
          /^Edit 2 removes the line break that ends the text edit 1 preserved \(commented out\)/,
        );
      }
    });

    it('still lets a later edit rewrite that newline into another, or end the file there', async () => {
      // Only the swallow is refused: a line break put back keeps the block a comment, and a
      // deletion of the unterminated last line after it leaves the block ending the file.
      expect(
        await preserveAlways('P\nQ', [
          { oldString: 'P', newString: '' },
          { oldString: '\nQ', newString: '\nZ' },
        ]),
      ).toEqual({ text: '% P\nZ', preserved: 1 });
      expect(
        await preserveAlways('P\nQ', [
          { oldString: 'P', newString: '' },
          { oldString: '\nQ', newString: '' },
        ]),
      ).toEqual({ text: '% P', preserved: 1 });
      // A replaceAll through the block's own newline that deletes the live line after it leaves
      // the comment ending where it did.
      expect(
        await preserveAlways('P\nQ\nR', [
          { oldString: 'P\n', newString: '' },
          { oldString: '\nQ', newString: '', replaceAll: true },
        ]),
      ).toEqual({ text: '% P\nR', preserved: 1 });
    });

    // A block that ends in its own bare '\r' (the oldString took its line's terminator). A range
    // deletion of the blank line after it leaves that '\r' in front of the NEXT blank line's '\n',
    // and the two read as one CRLF: that blank line — a \par — merges into the comment. For an
    // original '\r' the unfuse rule turns it into '\n'; a preserved block's bytes are off limits,
    // so the call is refused instead, in either order of the edits. Deleting both blank lines
    // leaves nothing to fuse with and goes through.
    it('refuses a deletion that fuses a preserved block’s own bare CR with a blank line', async () => {
      const edits = [
        { oldString: 't\r', newString: '' },
        { startLine: 3, endLine: 3, newString: '' },
      ];
      for (const order of [edits, [...edits].reverse()]) {
        expect(await refusedUnderAlways('a\rt\r\r\n\nb', order)).toMatch(
          /line break right after the text edit \d preserved \(commented out\)/,
        );
      }
      const both = [...edits, { startLine: 4, endLine: 4, newString: '' }];
      for (const order of [both, [...both].reverse(), [both[1]!, both[0]!, both[2]!]]) {
        expect(await preserveAlways('a\rt\r\r\n\nb', order)).toEqual({
          text: 'a\r% t\rb',
          preserved: 1,
        });
      }
      // A CRLF the match split in two is the file's own pair, not a fusion.
      expect(await preserveAlways('a\nt\r\nb', [{ oldString: 't\r', newString: '' }])).toEqual({
        text: 'a\n% t\r\nb',
        preserved: 1,
      });
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
