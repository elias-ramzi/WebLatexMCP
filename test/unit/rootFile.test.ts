import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { detectRootFile, resolveRootFile } from '../../src/lib/rootFile.js';
import { FileService } from '../../src/services/fileService.js';

const DOC = '\\documentclass{article}\n\\begin{document}x\\end{document}\n';

describe('detectRootFile', () => {
  let dir: string;
  const files = new FileService();

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-rootfile-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function put(rel: string, content: string): Promise<void> {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), content);
  }

  it('prefers a top-level main.tex over everything', async () => {
    await put('main.tex', 'no class here\n');
    await put('root.tex', DOC);
    expect(await detectRootFile(files, dir)).toBe('main.tex');
  });

  // The reported layout: a vendored template's main.tex in a subfolder (it \input's files one
  // level up, so it never compiles on its own) beside the real top-level root.
  it('prefers a top-level root with \\documentclass over a nested template main.tex', async () => {
    await put('cvpr-template/main.tex', DOC);
    await put('root.tex', DOC);
    await put('sections/intro.tex', 'Intro.\n');
    expect(await detectRootFile(files, dir)).toBe('root.tex');
  });

  it('takes a nested main.tex first among roots at the same depth', async () => {
    await put('paper/appendix.tex', DOC);
    await put('paper/main.tex', DOC);
    await put('notes.tex', 'just notes\n');
    expect(await detectRootFile(files, dir)).toBe('paper/main.tex');
  });

  it('prefers the shallowest \\documentclass', async () => {
    await put('a/b/deep.tex', DOC);
    await put('a/shallow.tex', DOC);
    expect(await detectRootFile(files, dir)).toBe('a/shallow.tex');
  });

  it('falls back to a nested main.tex, then the first .tex, when none has \\documentclass', async () => {
    await put('aaa.tex', 'x\n');
    await put('tpl/main.tex', 'y\n');
    expect(await detectRootFile(files, dir)).toBe('tpl/main.tex');
    await rm(path.join(dir, 'tpl'), { recursive: true });
    expect(await detectRootFile(files, dir)).toBe('aaa.tex');
  });

  it('throws when there is no .tex at all', async () => {
    await put('README.md', '# x\n');
    await expect(detectRootFile(files, dir)).rejects.toThrow(/No \.tex files/);
  });
});

describe('resolveRootFile', () => {
  let dir: string;
  const files = new FileService();

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-rootres-'));
    await writeFile(path.join(dir, 'main.tex'), DOC);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('takes the explicit root, then the registered one, then detection', async () => {
    expect(await resolveRootFile(files, dir, 'root.tex', 'other.tex')).toEqual({
      rootFile: 'other.tex',
      source: 'argument',
    });
    expect(await resolveRootFile(files, dir, 'root.tex')).toEqual({
      rootFile: 'root.tex',
      source: 'registered',
    });
    expect(await resolveRootFile(files, dir, undefined)).toEqual({
      rootFile: 'main.tex',
      source: 'detected',
    });
  });

  // A registered root is an assertion: used as given, not replaced by a guess when it is missing.
  it('does not second-guess a registered root that is not on disk', async () => {
    expect(await resolveRootFile(files, dir, 'missing.tex')).toEqual({
      rootFile: 'missing.tex',
      source: 'registered',
    });
  });
});
