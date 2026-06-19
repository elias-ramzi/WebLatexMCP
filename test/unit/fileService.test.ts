import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { FileService } from '../../src/services/fileService.js';

describe('FileService', () => {
  let dir: string;
  const files = new FileService();

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-fs-'));
    await mkdir(path.join(dir, 'chapters'), { recursive: true });
    await mkdir(path.join(dir, '.git'), { recursive: true });
    await writeFile(path.join(dir, 'main.tex'), 'line1\nline2\nline3\n');
    await writeFile(path.join(dir, 'refs.bib'), '@book{x, title={T}}\n');
    await writeFile(path.join(dir, 'chapters', 'intro.tex'), 'intro\n');
    await writeFile(path.join(dir, 'figure.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/master\n');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('lists all files except .git, sorted', async () => {
    const all = await files.list(dir, { filter: 'all' });
    expect(all.map((f) => f.path)).toEqual([
      'chapters/intro.tex',
      'figure.png',
      'main.tex',
      'refs.bib',
    ]);
  });

  it('filters by type', async () => {
    expect((await files.list(dir, { filter: 'tex' })).map((f) => f.path)).toEqual([
      'chapters/intro.tex',
      'main.tex',
    ]);
    expect((await files.list(dir, { filter: 'bib' })).map((f) => f.path)).toEqual(['refs.bib']);
    expect((await files.list(dir, { filter: 'assets' })).map((f) => f.path)).toEqual([
      'figure.png',
    ]);
  });

  it('restricts to a subdirectory', async () => {
    expect((await files.list(dir, { subdir: 'chapters' })).map((f) => f.path)).toEqual([
      'chapters/intro.tex',
    ]);
  });

  it('reads a full text file', async () => {
    const res = await files.read(dir, { path: 'main.tex' });
    expect(res.content).toBe('line1\nline2\nline3\n');
    expect(res.totalLines).toBe(4); // trailing newline => 4 split parts
    expect(res.truncated).toBe(false);
  });

  it('reads a line range', async () => {
    const res = await files.read(dir, { path: 'main.tex', startLine: 2, endLine: 2 });
    expect(res.content).toBe('line2');
    expect(res.truncated).toBe(true);
  });

  it('does not return binary content inline', async () => {
    const res = await files.read(dir, { path: 'figure.png' });
    expect(res.content).toBe('');
    expect(res.truncated).toBe(true);
    expect(res.note).toMatch(/Binary or large file/);
  });

  it('rejects path traversal on read', async () => {
    await expect(files.read(dir, { path: '../escape.tex' })).rejects.toThrow(/escapes/);
  });
});
