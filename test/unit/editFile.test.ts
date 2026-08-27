import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { FileService } from '../../src/services/fileService.js';
import { createPreserveTransform } from '../../src/lib/rewriteMode.js';

describe('FileService write + edit', () => {
  let dir: string;
  const files = new FileService();

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-edit-'));
    await writeFile(path.join(dir, 'main.tex'), 'alpha\nbeta\nalpha\n');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes a new file and reports created', async () => {
    const res = await files.write(dir, { path: 'new.tex', content: 'hello' });
    expect(res.created).toBe(true);
    expect(res.bytesWritten).toBe(5);
    expect(await readFile(path.join(dir, 'new.tex'), 'utf8')).toBe('hello');
  });

  it('overwrites an existing file and reports created=false', async () => {
    const res = await files.write(dir, { path: 'main.tex', content: 'x' });
    expect(res.created).toBe(false);
  });

  it('creates parent dirs when requested', async () => {
    await files.write(dir, { path: 'sections/intro.tex', content: 'i', createDirs: true });
    expect(await readFile(path.join(dir, 'sections/intro.tex'), 'utf8')).toBe('i');
  });

  it('applies a unique single edit', async () => {
    const res = await files.applyEdits(dir, 'main.tex', [{ oldString: 'beta', newString: 'BETA' }]);
    expect(res.appliedEdits).toBe(1);
    expect(await readFile(path.join(dir, 'main.tex'), 'utf8')).toBe('alpha\nBETA\nalpha\n');
  });

  it(
    'does not let $-patterns in a caller-supplied newString corrupt the replacement ' +
      "(String.prototype.replace special-cases $$, $&, $`, $', $1 in the replacement string; " +
      'LaTeX is full of literal $, so a plain replace() call mangles ordinary content)',
    async () => {
      const dollarLaden = "price is $100, then $$200$$, ref $& tick $` back $' fwd $1 group";
      const res = await files.applyEdits(dir, 'main.tex', [
        { oldString: 'beta', newString: dollarLaden },
      ]);
      expect(res.appliedEdits).toBe(1);
      expect(await readFile(path.join(dir, 'main.tex'), 'utf8')).toBe(
        `alpha\n${dollarLaden}\nalpha\n`,
      );
    },
  );

  it('rejects an ambiguous match unless replaceAll', async () => {
    await expect(
      files.applyEdits(dir, 'main.tex', [{ oldString: 'alpha', newString: 'A' }]),
    ).rejects.toThrow(/matches 2 times/);
    // file unchanged
    expect(await readFile(path.join(dir, 'main.tex'), 'utf8')).toBe('alpha\nbeta\nalpha\n');
  });

  it('replaces all occurrences when replaceAll is set', async () => {
    const res = await files.applyEdits(dir, 'main.tex', [
      { oldString: 'alpha', newString: 'A', replaceAll: true },
    ]);
    expect(res.appliedEdits).toBe(1);
    expect(await readFile(path.join(dir, 'main.tex'), 'utf8')).toBe('A\nbeta\nA\n');
  });

  it('applies multiple edits in order', async () => {
    const res = await files.applyEdits(dir, 'main.tex', [
      { oldString: 'beta', newString: 'gamma' },
      { oldString: 'gamma', newString: 'delta' },
    ]);
    expect(res.appliedEdits).toBe(2);
    expect(await readFile(path.join(dir, 'main.tex'), 'utf8')).toBe('alpha\ndelta\nalpha\n');
  });

  it('is atomic: a later failing edit reverts the whole batch', async () => {
    await expect(
      files.applyEdits(dir, 'main.tex', [
        { oldString: 'beta', newString: 'BETA' },
        { oldString: 'nonexistent', newString: 'X' },
      ]),
    ).rejects.toThrow(/not found/);
    expect(await readFile(path.join(dir, 'main.tex'), 'utf8')).toBe('alpha\nbeta\nalpha\n');
  });

  it('rejects path traversal on write and edit', async () => {
    await expect(files.write(dir, { path: '../x', content: 'y' })).rejects.toThrow(/escapes/);
    await expect(
      files.applyEdits(dir, '../x', [{ oldString: 'a', newString: 'b' }]),
    ).rejects.toThrow(/escapes/);
  });

  it('readText returns content, and empty string for a missing file', async () => {
    expect(await files.readText(dir, 'main.tex')).toBe('alpha\nbeta\nalpha\n');
    expect(await files.readText(dir, 'does-not-exist.bib')).toBe('');
  });

  // `opts.preserve` (see `EditTransform` in fileService.ts) is a `transform` hook that returns
  // the replacement string, plus a `lastInsertion()` accessor reporting the preserved-comment
  // length of that *same, most recent* `transform()` call — the ledger of already-preserved
  // ranges across the whole call is owned by `applyEdits` itself, not by the hook. These tests
  // exercise the transform half by handing a minimal ad hoc object satisfying that structural
  // interface, with `lastInsertion` always reporting nothing preserved (these tests aren't
  // exercising the intersection guard, so nothing should ever be reported as preserved).
  describe('opts.preserve (rewrite-preservation hook wiring)', () => {
    it(
      'calls the hook after the existing guards, with the match index in the current content, ' +
        'and uses its returned text as the replacement',
      async () => {
        const calls: Array<{ oldString: string; matchIndex: number; content: string }> = [];
        const res = await files.applyEdits(
          dir,
          'main.tex',
          [{ oldString: 'beta', newString: 'BETA' }],
          {
            preserve: {
              transform: (edit, matchIndex, content) => {
                calls.push({ oldString: edit.oldString, matchIndex, content });
                return 'REPLACED';
              },
              lastInsertion: () => undefined,
            },
          },
        );
        expect(res.appliedEdits).toBe(1);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toEqual({
          oldString: 'beta',
          matchIndex: 'alpha\n'.length,
          content: 'alpha\nbeta\nalpha\n',
        });
        // The hook's returned text — not edit.newString — is what actually lands in the file.
        expect(await readFile(path.join(dir, 'main.tex'), 'utf8')).toBe('alpha\nREPLACED\nalpha\n');
      },
    );

    it('is not called for a replaceAll edit (replaceAll is never preserved)', async () => {
      let called = false;
      await files.applyEdits(
        dir,
        'main.tex',
        [{ oldString: 'alpha', newString: 'A', replaceAll: true }],
        {
          preserve: {
            transform: () => {
              called = true;
              return 'SHOULD NOT APPEAR';
            },
            lastInsertion: () => undefined,
          },
        },
      );
      expect(called).toBe(false);
      expect(await readFile(path.join(dir, 'main.tex'), 'utf8')).toBe('A\nbeta\nA\n');
    });

    it('the identical oldString/newString guard still fires before the hook is ever consulted', async () => {
      let called = false;
      await expect(
        files.applyEdits(dir, 'main.tex', [{ oldString: 'beta', newString: 'beta' }], {
          preserve: {
            transform: () => {
              called = true;
              return 'X';
            },
            lastInsertion: () => undefined,
          },
        }),
      ).rejects.toThrow(/identical/);
      expect(called).toBe(false);
    });

    it('the not-found and non-unique guards still fire before the hook is ever consulted', async () => {
      let called = false;
      const preserve = {
        transform: () => {
          called = true;
          return 'X';
        },
        lastInsertion: () => undefined,
      };
      await expect(
        files.applyEdits(dir, 'main.tex', [{ oldString: 'nonexistent', newString: 'X' }], {
          preserve,
        }),
      ).rejects.toThrow(/not found/);
      expect(called).toBe(false);

      await expect(
        files.applyEdits(dir, 'main.tex', [{ oldString: 'alpha', newString: 'A' }], {
          preserve,
        }),
      ).rejects.toThrow(/matches 2 times/);
      expect(called).toBe(false);
    });
  });

  // Regression for the bug where preservation and applyEdits' own within-call loop disagreed:
  // `applyEdits` recomputes `content.indexOf(edit.oldString)` against the *current* content on
  // every iteration, so a comment block that `createPreserveTransform` spliced in for edit N is
  // plain text to edit N+1 in the same call — a later edit can match *inside* that comment
  // (mangling the "byte-exact copy of the caller's own oldString" the feature exists to
  // guarantee) or, worse, match a fragment that only survives inside the dead comment and no
  // longer exists in the live document, and get silently "applied" against text nobody will ever
  // see rendered. This must throw instead. It is distinct from the already-covered, accepted case
  // of a *separate* later `edit_file` call matching both the comment and the live text (refused
  // as non-unique) — this is entirely within one `applyEdits` call.
  describe('opts.preserve (refusing an edit that only matches an earlier preserved comment)', () => {
    const storyPath = 'story.tex';
    const storyContent = 'intro\nAlpha beta gamma delta epsilon zeta eta theta.\noutro\n';

    beforeEach(async () => {
      await writeFile(path.join(dir, storyPath), storyContent);
    });

    it('throws when edit 2 only matches text edit 1 already preserved as a comment, and leaves the file untouched', async () => {
      const preserve = createPreserveTransform('always');
      await expect(
        files.applyEdits(
          dir,
          storyPath,
          [
            {
              oldString: 'Alpha beta gamma delta epsilon zeta eta theta.',
              newString: 'Totally different replacement text now.',
            },
            { oldString: 'gamma', newString: 'GAMMA' },
          ],
          { preserve },
        ),
      ).rejects.toThrow(
        /Edit 2: oldString only matches text preserved \(commented out\) by an earlier edit in this same call, not the live document; the live occurrence was already replaced by that edit\./,
      );
      // applyEdits builds the new content in memory and writes once at the end — a throw partway
      // through the edits loop must leave the on-disk file completely untouched, including by
      // edit 1 (which, taken alone, would have succeeded).
      expect(await readFile(path.join(dir, storyPath), 'utf8')).toBe(storyContent);
    });

    it('still applies both edits when edit 2 matches only the live document, not a preserved comment', async () => {
      const preserve = createPreserveTransform('always');
      const res = await files.applyEdits(
        dir,
        storyPath,
        [
          {
            oldString: 'Alpha beta gamma delta epsilon zeta eta theta.',
            newString: 'Totally different replacement text now.',
          },
          // "Totally different" only exists in edit 1's live replacement, never in the comment
          // (which still reads "Alpha beta gamma ..."), so this does not intersect edit 1's
          // preserved range.
          { oldString: 'Totally different', newString: 'TOTALLY DIFFERENT' },
        ],
        { preserve },
      );
      expect(res.appliedEdits).toBe(2);
      expect(preserve.preservedEdits()).toBe(1);
      expect(await readFile(path.join(dir, storyPath), 'utf8')).toBe(
        'intro\n% Alpha beta gamma delta epsilon zeta eta theta.\nTOTALLY DIFFERENT replacement text now.\noutro\n',
      );
    });

    it('a replaceAll edit is still allowed to rewrite text inside an earlier preserved comment (documented behaviour)', async () => {
      const preserve = createPreserveTransform('always');
      const res = await files.applyEdits(
        dir,
        storyPath,
        [
          {
            oldString: 'Alpha beta gamma delta epsilon zeta eta theta.',
            newString: 'Totally different replacement text now.',
          },
          // After edit 1, "gamma" only survives inside the preserved comment (the live
          // replacement text doesn't contain it) — replaceAll never checks the preserved-range
          // ledger, so this must still apply, rewriting the comment right along with the (nonexistent, here)
          // live occurrences.
          { oldString: 'gamma', newString: 'GAMMA', replaceAll: true },
        ],
        { preserve },
      );
      expect(res.appliedEdits).toBe(2);
      expect(await readFile(path.join(dir, storyPath), 'utf8')).toBe(
        'intro\n% Alpha beta GAMMA delta epsilon zeta eta theta.\nTotally different replacement text now.\noutro\n',
      );
    });

    // The preserved-range ledger now lives entirely inside `applyEdits` itself (see the
    // `preserved` array there) rather than being read back from the hook, so there is nothing
    // separate a caller could forget to wire up: passing the single `preserve` option (built the
    // only way a real caller can, via `createPreserveTransform`) is sufficient on its own to get
    // the refusal below.
    it('passing only opts.preserve (no separate wiring) is enough to get the intersection refusal', async () => {
      const preserve = createPreserveTransform('always');
      await expect(
        files.applyEdits(
          dir,
          storyPath,
          [
            {
              oldString: 'Alpha beta gamma delta epsilon zeta eta theta.',
              newString: 'Totally different replacement text now.',
            },
            { oldString: 'gamma', newString: 'GAMMA' },
          ],
          { preserve },
        ),
      ).rejects.toThrow(/oldString only matches text preserved \(commented out\)/);
    });
  });

  // Regression coverage for the "replaceAll never shifts the preserved-range ledger" bug: the
  // ledger's shift bookkeeping used to live inside `createPreserveTransform`'s own `transform`
  // hook (`src/lib/rewriteMode.ts`), which `applyEdits` only ever calls for a non-`replaceAll`
  // edit — so a `replaceAll` edit elsewhere in the same call spliced text (changing every
  // subsequent offset) without the ledger ever hearing about it. Two failure directions, both
  // reproduced against the pre-fix code before this fix landed:
  //  (a) a replaceAll BEFORE the preserved range shrinks the file, the recorded range goes stale
  //      (too far to the right), and a later edit that should have been refused for matching only
  //      inside the dead comment instead silently mutates it — the false negative.
  //  (b) a replaceAll BEFORE the preserved range grows the file, the recorded range again goes
  //      stale (too far to the left this time), and a later edit that matches only the live
  //      document gets wrongly refused as if it matched inside the comment — the false positive.
  describe('opts.preserve (a replaceAll edit must shift the preserved-range ledger too)', () => {
    it(
      'case (a): a replaceAll edit that SHRINKS the file before the preserved range must not ' +
        'let a later edit silently rewrite the preserved comment — it must throw, and the file ' +
        'must be byte-identical to what it was before the call',
      async () => {
        const shrinkPath = 'shrink.tex';
        const content = 'L'.repeat(58) + '\nAlpha beta gamma delta epsilon zeta eta theta.\ntail\n';
        await writeFile(path.join(dir, shrinkPath), content);
        const preserve = createPreserveTransform('always');
        await expect(
          files.applyEdits(
            dir,
            shrinkPath,
            [
              {
                oldString: 'Alpha beta gamma delta epsilon zeta eta theta.',
                newString: 'Totally different replacement text now.',
              },
              // Shrinks the file by 57 characters before the preserved range: with a stale
              // (unshifted) ledger, edit 3 below lands squarely inside the recorded range's old
              // coordinates and gets silently applied to the dead comment instead of being
              // refused.
              { oldString: 'L'.repeat(58), newString: 'z', replaceAll: true },
              { oldString: 'gamma', newString: 'GAMMA' },
            ],
            { preserve },
          ),
        ).rejects.toThrow(/oldString only matches text preserved \(commented out\)/);
        expect(await readFile(path.join(dir, shrinkPath), 'utf8')).toBe(content);
      },
    );

    it(
      'case (b): a replaceAll edit that GROWS the file before the preserved range must not cause ' +
        'a later edit matching only the live document to be wrongly refused',
      async () => {
        const growPath = 'grow.tex';
        const content = 'pad\nAlpha beta gamma delta epsilon zeta eta theta.\ntail\n';
        await writeFile(path.join(dir, growPath), content);
        const preserve = createPreserveTransform('always');
        const res = await files.applyEdits(
          dir,
          growPath,
          [
            {
              oldString: 'Alpha beta gamma delta epsilon zeta eta theta.',
              newString: 'Totally different replacement text now.',
            },
            // Grows the file by 51 characters before the preserved range: with a stale
            // (unshifted) ledger, edit 3 below — which only ever matched the live document, never
            // the comment — gets wrongly refused as "preserved" because the ledger's recorded
            // range drifted right past it.
            {
              oldString: 'pad',
              newString: 'a'.repeat(20) + 'UNIQUETOKEN' + 'a'.repeat(20),
              replaceAll: true,
            },
            { oldString: 'UNIQUETOKEN', newString: 'Q' },
          ],
          { preserve },
        );
        expect(res.appliedEdits).toBe(3);
        expect(await readFile(path.join(dir, growPath), 'utf8')).toBe(
          `${'a'.repeat(20)}Q${'a'.repeat(20)}\n` +
            '% Alpha beta gamma delta epsilon zeta eta theta.\n' +
            'Totally different replacement text now.\ntail\n',
        );
      },
    );

    it(
      'a replaceAll edit whose only occurrence sits strictly INSIDE the preserved comment still ' +
        'applies (documented behaviour) and rewrites the comment, and a following edit after the ' +
        'range is still judged against a correctly-resized range',
      async () => {
        const insidePath = 'inside.tex';
        const content =
          'intro\nAlpha beta gamma delta epsilon zeta eta theta.\nouter tail marker here.\n';
        await writeFile(path.join(dir, insidePath), content);
        const preserve = createPreserveTransform('always');
        const res = await files.applyEdits(
          dir,
          insidePath,
          [
            {
              oldString: 'Alpha beta gamma delta epsilon zeta eta theta.',
              newString: 'Totally different replacement text now.',
            },
            // "gamma" only survives inside the preserved comment (the live replacement text
            // doesn't contain it); growing it here grows the comment block itself, which must
            // resize the recorded range's end (not just shift ranges positioned after it).
            { oldString: 'gamma', newString: 'GAMMAGAMMAGAMMA', replaceAll: true },
            // Must still match, and be judged against the file's *current* content, after the
            // preserved range's end grew above.
            { oldString: 'outer tail marker here.', newString: 'OUTER TAIL MARKER HERE.' },
          ],
          { preserve },
        );
        expect(res.appliedEdits).toBe(3);
        // Mode 'always' preserves every eligible (line-aligned) edit regardless of length, so
        // edit 3 is preserved too.
        expect(await readFile(path.join(dir, insidePath), 'utf8')).toBe(
          'intro\n% Alpha beta GAMMAGAMMAGAMMA delta epsilon zeta eta theta.\n' +
            'Totally different replacement text now.\n' +
            '% outer tail marker here.\nOUTER TAIL MARKER HERE.\n',
        );
      },
    );

    it(
      'a replaceAll edit with MULTIPLE occurrences both before and after a recorded preserved ' +
        'range shifts every occurrence correctly, so a later unique edit after all of them still ' +
        'resolves against the right offset',
      async () => {
        const multiPath = 'multi.tex';
        const content =
          'mark one here.\nmark two here.\n' +
          'Alpha beta gamma delta epsilon zeta eta theta.\n' +
          'mark three here.\nmark four here.\n';
        await writeFile(path.join(dir, multiPath), content);
        const preserve = createPreserveTransform('always');
        const res = await files.applyEdits(
          dir,
          multiPath,
          [
            {
              oldString: 'Alpha beta gamma delta epsilon zeta eta theta.',
              newString: 'Totally different replacement text now.',
            },
            // 4 occurrences: 2 before the preserved range, 2 after — each must shift the ledger
            // by its own delta, one splice at a time.
            { oldString: 'mark', newString: 'MARKER', replaceAll: true },
            // Only occurrence is after every prior splice, including the range growth above and
            // the 4 replaceAll occurrences; must resolve against the correctly-shifted offset.
            { oldString: 'four here.', newString: 'FOUR HERE.' },
          ],
          { preserve },
        );
        expect(res.appliedEdits).toBe(3);
        expect(await readFile(path.join(dir, multiPath), 'utf8')).toBe(
          'MARKER one here.\nMARKER two here.\n' +
            '% Alpha beta gamma delta epsilon zeta eta theta.\n' +
            'Totally different replacement text now.\n' +
            'MARKER three here.\nMARKER FOUR HERE.\n',
        );
      },
    );
  });

  // Regression coverage for the CRLF-at-EOF separator bug: `createPreserveTransform`'s
  // `computeResult` derives the line ending that separates the preserved comment block from its
  // replacement only from `content[end]` (the byte right after the match) — which gives no
  // answer at all when the match ends at EOF with no trailing terminator, so it used to fall back
  // to a hardcoded '\n' even in a file that is unambiguously CRLF end to end.
  describe('CRLF line endings in preserved rewrite blocks', () => {
    const crlfPath = 'crlf.tex';

    it(
      'a CRLF file with no trailing newline, whose match ends at EOF, gets a CRLF separator ' +
        '(not the LF the missing-signal fallback used to produce)',
      async () => {
        // No trailing newline at all: the match for oldString ends exactly at EOF, so
        // content[end] is undefined and there is nothing after the match to inspect directly.
        const content = 'x\r\na line here\r\nb line here';
        await writeFile(path.join(dir, crlfPath), content, 'utf8');
        const preserve = createPreserveTransform('always');
        await files.applyEdits(
          dir,
          crlfPath,
          [{ oldString: 'a line here\r\nb line here', newString: 'NEW' }],
          { preserve },
        );
        expect(await readFile(path.join(dir, crlfPath), 'utf8')).toBe(
          'x\r\n% a line here\r\n% b line here\r\nNEW',
        );
      },
    );

    it(
      'a CRLF file WITH a trailing newline (the already-correct case) still gets a CRLF ' +
        'separator, guarding against a regression here',
      async () => {
        // Here content[end] is the literal '\r\n' pair right after the match, which the
        // original code already read correctly — kept as a guard that the EOF-fallback fix
        // above does not disturb this case.
        const content = 'x\r\na line here\r\nb line here\r\n';
        await writeFile(path.join(dir, crlfPath), content, 'utf8');
        const preserve = createPreserveTransform('always');
        await files.applyEdits(
          dir,
          crlfPath,
          [{ oldString: 'a line here\r\nb line here', newString: 'NEW' }],
          { preserve },
        );
        expect(await readFile(path.join(dir, crlfPath), 'utf8')).toBe(
          'x\r\n% a line here\r\n% b line here\r\nNEW\r\n',
        );
      },
    );

    // The "related case" named alongside the EOF bug: an oldString ending in a lone '\r' (its
    // own last byte, with no '\n' after it inside oldString) makes commentOut carry that '\r'
    // through as the literal last character of the comment block (see commentOut's docstring —
    // it only strips a '\r' as an end-of-line marker when a '\n' closes that same line *inside*
    // the string being commented). Getting this wrong is easy in both directions: this session's
    // own first attempt at the EOF fix (checking `oldString.endsWith('\r')` and forcing a full
    // '\r\n' separator) doubled the '\r' into '\r\r\n' here, since commented's own trailing '\r'
    // already supplies half the pair.
    it(
      "an oldString ending in a lone '\\r' (its own trailing byte, no paired '\\n') still " +
        'produces a single, correct CRLF pair before the replacement — never a doubled \\r and ' +
        'never an LF-only ending',
      async () => {
        // The match ends at EOF; oldString's last byte is a bare '\r' with nothing after it.
        const content = 'x\r\nsome line\r';
        await writeFile(path.join(dir, crlfPath), content, 'utf8');
        const preserve = createPreserveTransform('always');
        await files.applyEdits(dir, crlfPath, [{ oldString: 'some line\r', newString: 'NEW' }], {
          preserve,
        });
        expect(await readFile(path.join(dir, crlfPath), 'utf8')).toBe('x\r\n% some line\r\nNEW');
      },
    );
  });
});
