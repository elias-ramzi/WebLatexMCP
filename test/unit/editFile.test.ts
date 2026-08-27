import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { FileService } from '../../src/services/fileService.js';

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

  describe('opts.transformNewString (rewrite-preservation hook wiring)', () => {
    it(
      'calls the hook after the existing guards, with the match index in the current content, ' +
        'and uses its return value as the replacement',
      async () => {
        const calls: Array<{ oldString: string; matchIndex: number; content: string }> = [];
        const res = await files.applyEdits(
          dir,
          'main.tex',
          [{ oldString: 'beta', newString: 'BETA' }],
          {
            transformNewString: (edit, matchIndex, content) => {
              calls.push({ oldString: edit.oldString, matchIndex, content });
              return 'REPLACED';
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
        // The hook's return value — not edit.newString — is what actually lands in the file.
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
          transformNewString: () => {
            called = true;
            return 'SHOULD NOT APPEAR';
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
          transformNewString: () => {
            called = true;
            return 'X';
          },
        }),
      ).rejects.toThrow(/identical/);
      expect(called).toBe(false);
    });

    it('the not-found and non-unique guards still fire before the hook is ever consulted', async () => {
      let called = false;
      const hook = () => {
        called = true;
        return 'X';
      };
      await expect(
        files.applyEdits(dir, 'main.tex', [{ oldString: 'nonexistent', newString: 'X' }], {
          transformNewString: hook,
        }),
      ).rejects.toThrow(/not found/);
      expect(called).toBe(false);

      await expect(
        files.applyEdits(dir, 'main.tex', [{ oldString: 'alpha', newString: 'A' }], {
          transformNewString: hook,
        }),
      ).rejects.toThrow(/matches 2 times/);
      expect(called).toBe(false);
    });
  });
});
