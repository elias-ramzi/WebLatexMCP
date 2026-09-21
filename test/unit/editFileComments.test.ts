import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { FileService } from '../../src/services/fileService.js';
import { createPreserveTransform, matchIsCommented } from '../../src/lib/rewriteMode.js';

/**
 * `excludeComments`: skipping matches that sit in a LaTeX comment, and saying how many were
 * skipped. The motivating measurement (issue #105.4) is a real file with 192 occurrences of a
 * method name, 10 of them live and 182 inside commented-out provenance blocks that are the audit
 * trail for the paper's numbers — a plain `replaceAll` rewrites all 192.
 */

describe('matchIsCommented', () => {
  /** Offset of `needle` in `text`, as a match span. */
  function span(text: string, needle: string, from = 0): [number, number] {
    const i = text.indexOf(needle, from);
    expect(i).toBeGreaterThanOrEqual(0);
    return [i, i + needle.length];
  }
  const check = (text: string, needle: string, from = 0) =>
    matchIsCommented(text, ...span(text, needle, from));

  it('a match on a fully commented line is commented', () => {
    expect(check('% old note about foo\n', 'foo')).toBe(true);
  });

  it('leading whitespace before the % does not make the line live', () => {
    expect(check('   \t% indented note foo\n', 'foo')).toBe(true);
  });

  it('a match in the commented TAIL of an otherwise live line is commented', () => {
    expect(check('live text here % trailing foo\n', 'foo')).toBe(true);
  });

  it('a match before the % on the same line is live', () => {
    expect(check('foo is live % foo is not\n', 'foo')).toBe(false);
  });

  it('the % itself does not leak onto the next line', () => {
    expect(check('% commented\nfoo\n', 'foo')).toBe(false);
  });

  describe('the escaping rule (parity of the backslash run before the %)', () => {
    it('\\% is a literal percent, not a comment', () => {
      expect(check('95\\% of foo cases\n', 'foo')).toBe(false);
    });

    it('\\\\% IS a comment: the \\\\ consumes both backslashes, leaving the % live', () => {
      // The boundary case the naive "is the previous character a backslash" rule gets backwards.
      expect(check('end of row \\\\% note foo\n', 'foo')).toBe(true);
    });

    it('\\\\\\% is not a comment (\\\\ then an escaped %)', () => {
      expect(check('end of row \\\\\\% still live foo\n', 'foo')).toBe(false);
    });

    it('an escaped percent earlier on the line does not hide a later real comment', () => {
      expect(check('50\\% done % really foo\n', 'foo')).toBe(true);
    });
  });

  it('a match straddling the boundary counts as commented (fail-safe)', () => {
    // "live % dead": replacing this would rewrite bytes inside the comment, which is exactly
    // what the option exists to prevent — so it is skipped, never half-replaced.
    expect(check('alpha live % dead omega\n', 'live % dead')).toBe(true);
  });

  it('a multi-line match touching one commented line counts as commented', () => {
    expect(check('alpha\n% beta\ngamma\n', 'alpha\n% beta\ngamma')).toBe(true);
  });

  it('a multi-line match over live lines only is live', () => {
    expect(check('alpha\nbeta\ngamma\n', 'alpha\nbeta\ngamma')).toBe(false);
  });

  it('handles CRLF and bare-CR line endings', () => {
    expect(check('% dead foo\r\nlive foo\r\n', 'foo')).toBe(true);
    expect(check('% dead foo\r\nlive foo\r\n', 'foo', 11)).toBe(false);
    expect(check('% dead foo\rlive foo\r', 'foo', 11)).toBe(false);
  });

  it('a match at end-of-file with no trailing newline terminates', () => {
    expect(check('live foo', 'foo')).toBe(false);
    expect(check('% dead foo', 'foo')).toBe(true);
  });
});

describe('FileService.applyEdits — excludeComments', () => {
  let dir: string;
  const files = new FileService();
  const opts = { excludeMatch: matchIsCommented };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-excl-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const write = (content: string, name = 'main.tex') =>
    writeFile(path.join(dir, name), content, 'utf8');
  const read = (name = 'main.tex') => readFile(path.join(dir, name), 'utf8');

  it('replaceAll rewrites only the live occurrences and reports the split', async () => {
    await write(
      'OldName is used here\n% OldName was used here in 2023\nand OldName again\n% OldName\n',
    );
    const res = await files.applyEdits(
      dir,
      'main.tex',
      [{ oldString: 'OldName', newString: 'NewName', replaceAll: true, excludeComments: true }],
      opts,
    );
    expect(res.commentMatches).toEqual([{ edit: 1, replaced: 2, skippedInComments: 2 }]);
    expect(await read()).toBe(
      'NewName is used here\n% OldName was used here in 2023\nand NewName again\n% OldName\n',
    );
  });

  it('without the flag, the same replaceAll rewrites the comments too (the default is unchanged)', async () => {
    await write('OldName\n% OldName\n');
    const res = await files.applyEdits(dir, 'main.tex', [
      { oldString: 'OldName', newString: 'NewName', replaceAll: true },
    ]);
    expect(res.commentMatches).toBeUndefined();
    expect(await read()).toBe('NewName\n% NewName\n');
  });

  it('refuses a replaceAll whose every match is commented, rather than silently doing nothing', async () => {
    await write('% OldName here\n% and OldName there\n');
    await expect(
      files.applyEdits(
        dir,
        'main.tex',
        [{ oldString: 'OldName', newString: 'NewName', replaceAll: true, excludeComments: true }],
        opts,
      ),
    ).rejects.toThrow(/all 2 occurrence\(s\) of oldString in main\.tex are inside comments/);
    expect(await read()).toBe('% OldName here\n% and OldName there\n');
  });

  it('judges uniqueness over the live occurrences alone', async () => {
    // The shape from the issue: one live occurrence, many commented ones. Without the flag this
    // is a non-unique refusal; with it, it is a unique match.
    await write('live OldName\n% OldName\n% OldName\n% OldName\n');
    await expect(
      files.applyEdits(dir, 'main.tex', [{ oldString: 'OldName', newString: 'NewName' }]),
    ).rejects.toThrow(/matches 4 times/);
    const res = await files.applyEdits(
      dir,
      'main.tex',
      [{ oldString: 'OldName', newString: 'NewName', excludeComments: true }],
      opts,
    );
    expect(res.commentMatches).toEqual([{ edit: 1, replaced: 1, skippedInComments: 3 }]);
    expect(await read()).toBe('live NewName\n% OldName\n% OldName\n% OldName\n');
  });

  it('still refuses an ambiguous match, counting only the live ones', async () => {
    await write('live OldName\nlive OldName\n% OldName\n');
    await expect(
      files.applyEdits(
        dir,
        'main.tex',
        [{ oldString: 'OldName', newString: 'NewName', excludeComments: true }],
        opts,
      ),
    ).rejects.toThrow(/matches 2 times outside comments in main\.tex \(1 further match/);
    expect(await read()).toBe('live OldName\nlive OldName\n% OldName\n');
  });

  it('refuses a unique-form edit whose only matches are commented', async () => {
    await write('% OldName\n');
    await expect(
      files.applyEdits(
        dir,
        'main.tex',
        [{ oldString: 'OldName', newString: 'NewName', excludeComments: true }],
        opts,
      ),
    ).rejects.toThrow(/all 1 occurrence\(s\) of oldString in main\.tex are inside comments/);
  });

  it('refuses the edit when excludeComments is set but no filter was supplied', async () => {
    // The one failure mode that must never be silent: ignoring the flag means rewriting exactly
    // the text the caller asked to protect.
    await write('OldName\n% OldName\n');
    await expect(
      files.applyEdits(dir, 'main.tex', [
        { oldString: 'OldName', newString: 'NewName', replaceAll: true, excludeComments: true },
      ]),
    ).rejects.toThrow(/excludeComments was requested but this call supplied no comment filter/);
    expect(await read()).toBe('OldName\n% OldName\n');
  });

  it('re-judges comment state after each splice, not from a mask taken once', async () => {
    // The replacement introduces a comment on its own line, so the second occurrence on that
    // line is inside a comment by the time the loop reaches it. A precomputed mask would say
    // "live" and rewrite it.
    await write('foo and foo\nfoo\n');
    const res = await files.applyEdits(
      dir,
      'main.tex',
      [{ oldString: 'foo', newString: 'X % note', replaceAll: true, excludeComments: true }],
      opts,
    );
    expect(await read()).toBe('X % note and foo\nX % note\n');
    expect(res.commentMatches).toEqual([{ edit: 1, replaced: 2, skippedInComments: 1 }]);
  });

  it('leaves a block an earlier edit preserved alone (a preserved block is a comment)', async () => {
    const paragraph =
      'The quick brown fox jumps over the lazy dog while the sun sets slowly behind the hills.';
    await write(`${paragraph}\nthe lazy dog sleeps\n`);
    const res = await files.applyEdits(
      dir,
      'main.tex',
      [
        { oldString: paragraph, newString: 'A rewritten sentence entirely.' },
        { oldString: 'lazy dog', newString: 'sleepy cat', replaceAll: true, excludeComments: true },
      ],
      { ...opts, preserve: createPreserveTransform('always') },
    );
    expect(await read()).toBe(
      `% ${paragraph}\nA rewritten sentence entirely.\nthe sleepy cat sleeps\n`,
    );
    expect(res.commentMatches).toEqual([{ edit: 2, replaced: 1, skippedInComments: 1 }]);
  });

  it('a skipped match does not disturb the preserved-range ledger', async () => {
    // Skips splice nothing, so nothing shifts; the later edit must still be refused for
    // matching inside the preserved block, and the live replacements must land correctly.
    const paragraph =
      'The quick brown fox jumps over the lazy dog while the sun sets slowly behind the hills.';
    await write(`${paragraph}\n% marker\nmarker\n`);
    await expect(
      files.applyEdits(
        dir,
        'main.tex',
        [
          { oldString: paragraph, newString: 'Short new sentence.' },
          { oldString: 'marker', newString: 'M', replaceAll: true, excludeComments: true },
          { oldString: 'quick brown fox', newString: 'slow turtle' },
        ],
        { ...opts, preserve: createPreserveTransform('always') },
      ),
    ).rejects.toThrow(/only matches text preserved \(commented out\) by an earlier edit/);
    expect(await read()).toBe(`${paragraph}\n% marker\nmarker\n`);
  });

  it('reports one entry per flagged edit, and none for the unflagged ones', async () => {
    await write('aaa\n% aaa\nbbb\n');
    const res = await files.applyEdits(
      dir,
      'main.tex',
      [
        { oldString: 'aaa', newString: 'AAA', excludeComments: true },
        { oldString: 'bbb', newString: 'BBB' },
      ],
      opts,
    );
    expect(res.commentMatches).toEqual([{ edit: 1, replaced: 1, skippedInComments: 1 }]);
    expect(await read()).toBe('AAA\n% aaa\nBBB\n');
  });
});
