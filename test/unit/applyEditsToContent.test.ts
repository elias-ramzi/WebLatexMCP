import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { FileService, applyEditsToContent } from '../../src/services/fileService.js';
import type { AnyEditOp } from '../../src/services/fileService.js';
import { matchIsCommented } from '../../src/lib/rewriteMode.js';

/*
 * The pure half of `applyEdits`, which `compile`'s overlay calls without any I/O. It is a move,
 * not a rewrite: the parity block runs the same edits through `FileService.applyEdits` on a temp
 * file and requires the same bytes, so the two can never drift apart.
 */

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const DOC = 'line one\nline two\n% a comment with two\nline four $x$\n';

describe('applyEditsToContent', () => {
  it('applies a string edit', () => {
    const { content } = applyEditsToContent(DOC, 'a.tex', [
      { oldString: 'line one', newString: 'LINE 1' },
    ]);
    expect(content).toBe('LINE 1\nline two\n% a comment with two\nline four $x$\n');
  });

  it('applies a line range edit against the original numbering', () => {
    const { content } = applyEditsToContent(DOC, 'a.tex', [
      { startLine: 2, endLine: 2, newString: 'second' },
    ]);
    expect(content).toBe('line one\nsecond\n% a comment with two\nline four $x$\n');
  });

  it('applies replaceAll, and excludeComments with its report', () => {
    const all = applyEditsToContent(DOC, 'a.tex', [
      { oldString: 'two', newString: '2', replaceAll: true },
    ]);
    expect(all.content).toBe('line one\nline 2\n% a comment with 2\nline four $x$\n');
    const live = applyEditsToContent(
      DOC,
      'a.tex',
      [{ oldString: 'two', newString: '2', replaceAll: true, excludeComments: true }],
      { excludeMatch: matchIsCommented },
    );
    expect(live.content).toBe('line one\nline 2\n% a comment with two\nline four $x$\n');
    expect(live.commentMatches).toEqual([{ edit: 1, replaced: 1, skippedInComments: 1 }]);
  });

  it('refuses a string that is not found, naming the file', () => {
    expect(() =>
      applyEditsToContent(DOC, 'sections/a.tex', [{ oldString: 'absent', newString: 'x' }]),
    ).toThrow('Edit 1: oldString not found in sections/a.tex.');
  });

  it('refuses an empty edit list', () => {
    expect(() => applyEditsToContent(DOC, 'a.tex', [])).toThrow('No edits provided.');
  });

  it('lands $-patterns literally', () => {
    const { content } = applyEditsToContent(DOC, 'a.tex', [
      { oldString: 'line four $x$', newString: "$$ $& $` $' $1 $a$" },
    ]);
    expect(content).toBe("line one\nline two\n% a comment with two\n$$ $& $` $' $1 $a$\n");
  });

  it('produces exactly what FileService.applyEdits writes', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-aetc-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const cases: AnyEditOp[][] = [
      [{ oldString: 'line one', newString: 'LINE 1' }],
      [
        { startLine: 4, endLine: 4, newString: '' },
        { oldString: 'two\n%', newString: '2\n%' },
      ],
      [{ oldString: 'two', newString: '$1', replaceAll: true, excludeComments: true }],
      [
        { startLine: 1, endLine: 2, newString: 'merged' },
        { oldString: 'comment', newString: 'remark' },
      ],
    ];
    const files = new FileService();
    for (const [i, edits] of cases.entries()) {
      const rel = `case${i}.tex`;
      await writeFile(path.join(dir, rel), DOC, 'utf8');
      await files.applyEdits(dir, rel, edits, { excludeMatch: matchIsCommented });
      const written = await readFile(path.join(dir, rel), 'utf8');
      const pure = applyEditsToContent(DOC, rel, edits, { excludeMatch: matchIsCommented });
      expect(pure.content, `case ${i}`).toBe(written);
      expect(written, `case ${i} changed something`).not.toBe(DOC);
    }
  });
});
