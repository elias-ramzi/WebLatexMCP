import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { EditPlansWriteError, FileService } from '../../src/services/fileService.js';
import type { MutationRecorder } from '../../src/services/fileService.js';

/**
 * `FileService.writeEditPlans`, the write half of `edit_file` with `files`: plans are written in
 * order, and when one fails, every file already written is put back THROUGH the service, so the
 * mutation recorder sees the reverse change and the session's shadow does not keep an edit that
 * is no longer on disk.
 */

describe('FileService.writeEditPlans', () => {
  let dir: string;
  let files: FileService;
  let recorded: Array<[string, unknown, unknown]>;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'wlm-editplans-'));
    files = new FileService();
    recorded = [];
    const recorder: MutationRecorder = {
      record: (_dir, rel, before, after) => {
        recorded.push([rel, before, after]);
        return Promise.resolve();
      },
    } as MutationRecorder;
    files.setMutationRecorder(recorder);
    await writeFile(path.join(dir, 'a.tex'), 'alpha\n', 'utf8');
    await writeFile(path.join(dir, 'b.tex'), 'beta\n', 'utf8');
  });

  afterEach(async () => {
    await chmod(path.join(dir, 'b.tex'), 0o644).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  });

  const read = (name: string) => readFile(path.join(dir, name), 'utf8');

  async function plans() {
    return [
      await files.planEdits(dir, 'a.tex', [{ oldString: 'alpha', newString: 'ALPHA' }]),
      await files.planEdits(dir, 'b.tex', [{ oldString: 'beta', newString: 'BETA' }]),
    ];
  }

  it('planning writes nothing and records nothing', async () => {
    await plans();
    expect(await read('a.tex')).toBe('alpha\n');
    expect(await read('b.tex')).toBe('beta\n');
    expect(recorded).toEqual([]);
  });

  it('writes every plan in order', async () => {
    const res = await files.writeEditPlans(await plans());
    expect(res.map((r) => r.path)).toEqual(['a.tex', 'b.tex']);
    expect(await read('a.tex')).toBe('ALPHA\n');
    expect(await read('b.tex')).toBe('BETA\n');
    expect(recorded).toEqual([
      ['a.tex', 'alpha\n', 'ALPHA\n'],
      ['b.tex', 'beta\n', 'BETA\n'],
    ]);
  });

  it('a file edited by hand after planning is left alone, and earlier writes are restored', async () => {
    const planned = await plans();
    await writeFile(path.join(dir, 'b.tex'), 'beta\nby hand\n', 'utf8');
    const err = await files.writeEditPlans(planned).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EditPlansWriteError);
    const e = err as EditPlansWriteError;
    expect(e.failedPath).toBe('b.tex');
    expect(e.restored).toEqual(['a.tex']);
    expect(e.unrestored).toEqual([]);
    expect(e.message).toContain('Restored to their previous content: "a.tex"');
    expect(await read('a.tex')).toBe('alpha\n');
    expect(await read('b.tex')).toBe('beta\nby hand\n');
    // The recorder saw the write AND its reversal, so the shadow nets to nothing.
    expect(recorded).toEqual([
      ['a.tex', 'alpha\n', 'ALPHA\n'],
      ['a.tex', 'ALPHA\n', 'alpha\n'],
    ]);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'a write that fails part-way restores the files already written',
    async () => {
      const planned = await plans();
      await chmod(path.join(dir, 'b.tex'), 0o444);
      const err = await files.writeEditPlans(planned).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EditPlansWriteError);
      const e = err as EditPlansWriteError;
      expect(e.message).toContain('Writing "b.tex" failed');
      expect(e.restored).toEqual(['a.tex']);
      expect(await read('a.tex')).toBe('alpha\n');
      expect(await read('b.tex')).toBe('beta\n');
    },
  );

  it('does not restore a written file someone changed again, and says so', async () => {
    const planned = await plans();
    // Wrap the second write so a hand edit lands on a.tex after it was written.
    const real = files.writeEditPlan.bind(files);
    let calls = 0;
    files.writeEditPlan = async (plan, opts) => {
      calls += 1;
      if (calls === 2) {
        await writeFile(path.join(dir, 'a.tex'), 'ALPHA\nnewer\n', 'utf8');
        throw new Error('disk full');
      }
      return real(plan, opts);
    };
    const err = (await files
      .writeEditPlans(planned)
      .catch((x: unknown) => x)) as EditPlansWriteError;
    expect(err.restored).toEqual([]);
    expect(err.unrestored).toHaveLength(1);
    expect(err.unrestored[0]).toContain('a.tex');
    expect(err.message).toContain('Could NOT restore');
    expect(await read('a.tex')).toBe('ALPHA\nnewer\n');
  });
});
