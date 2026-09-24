import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, readdir, rm, writeFile, copyFile, symlink } from 'node:fs/promises';
import { readAuxFloats } from '../../src/lib/auxFloats.js';
import { buildAuxPath, buildDir } from '../../src/services/compiler.js';

/**
 * `\include` splits the label index across files: LaTeX writes each included chapter's
 * `\newlabel`s into that chapter's own `.aux` in the output directory, and the root `.aux` holds
 * only `\@input{chap.aux}`. `readAuxFloats` used to read the root `.aux` alone, so a book's
 * figures came back as zero labels with no note. The fixture under `aux-include/` is a real
 * pdflatex run of the `main.tex`/`chap.tex` beside it.
 */
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/aux-include');

describe('readAuxFloats across \\include (\\@input)', () => {
  let dir: string | undefined;
  const extra: string[] = [];

  afterEach(async () => {
    if (dir) {
      await rm(buildDir(dir), { recursive: true, force: true });
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
    for (const p of extra.splice(0)) await rm(p, { recursive: true, force: true });
  });

  async function freshBuild(): Promise<string> {
    dir = await mkdtemp(path.join(os.tmpdir(), 'auxinclude-'));
    const build = buildDir(dir);
    await mkdir(build, { recursive: true });
    return build;
  }

  it('merges the labels of an \\include-d chapter (real pdflatex .aux files)', async () => {
    const build = await freshBuild();
    await copyFile(path.join(FIXTURE, 'main.aux'), buildAuxPath(dir!, 'main.tex'));
    await copyFile(path.join(FIXTURE, 'chap.aux'), path.join(build, 'chap.aux'));

    const result = await readAuxFloats(dir!, 'main.tex');
    expect(result.floats).toEqual([{ label: 'fig:one', number: '1.1', page: '2' }]);
    expect(result.total).toBe(1);
    expect(result.note).toBeUndefined();
  });

  it('follows an input in a nested subdirectory, in the order the root .aux inputs it', async () => {
    const build = await freshBuild();
    await mkdir(path.join(build, 'chapters'), { recursive: true });
    await writeFile(
      buildAuxPath(dir!, 'main.tex'),
      [
        '\\relax ',
        '\\newlabel{fig:front}{{0}{1}}',
        '\\@input{chapters/one.aux}',
        '\\@input{two.aux}',
        '\\newlabel{fig:back}{{9}{9}}',
        '',
      ].join('\n'),
    );
    await writeFile(path.join(build, 'chapters', 'one.aux'), '\\newlabel{fig:one}{{1.1}{2}}\n');
    await writeFile(path.join(build, 'two.aux'), '\\newlabel{fig:two}{{2.1}{5}}\n');

    const result = await readAuxFloats(dir!, 'main.tex');
    expect(result.floats.map((f) => f.label)).toEqual([
      'fig:front',
      'fig:one',
      'fig:two',
      'fig:back',
    ]);
    expect(result.total).toBe(4);
    expect(result.note).toBeUndefined();
  });

  it('surfaces a note, rather than a silent zero, when an \\@input names no file in the build dir', async () => {
    await freshBuild();
    await writeFile(buildAuxPath(dir!, 'main.tex'), '\\relax \n\\@input{gone.aux}\n');

    const result = await readAuxFloats(dir!, 'main.tex');
    expect(result.floats).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.note).toBeDefined();
    expect(result.note).toContain('gone.aux');
    expect(result.note).toMatch(/not (found )?in the build directory/);
  });

  it('never reads a file an \\@input names outside the build dir (traversal)', async () => {
    const build = await freshBuild();
    // A real file one level above the build dir, where `../<name>` would land if the name were
    // ever resolved as a path; and the literal `../../etc/x.aux` shape as well.
    const outsideName = `outside-${path.basename(build)}.aux`;
    const outside = path.join(path.dirname(build), outsideName);
    await writeFile(outside, '\\newlabel{fig:evil}{{6}{66}}\n');
    extra.push(outside);
    await writeFile(
      buildAuxPath(dir!, 'main.tex'),
      `\\relax \n\\@input{../${outsideName}}\n\\@input{../../etc/x.aux}\n\\newlabel{fig:ok}{{1}{1}}\n`,
    );

    const result = await readAuxFloats(dir!, 'main.tex');
    expect(result.floats).toEqual([{ label: 'fig:ok', number: '1', page: '1' }]);
    expect(result.floats.some((f) => f.label === 'fig:evil')).toBe(false);
    // Both are reported as unresolved inputs, never silently skipped.
    expect(result.note).toContain(outsideName);
    expect(result.note).toContain('../../etc/x.aux');
  });

  it('does not follow a symbolic link inside the build dir', async (t) => {
    const build = await freshBuild();
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), 'auxinclude-out-'));
    extra.push(outsideDir);
    const target = path.join(outsideDir, 'secret.aux');
    await writeFile(target, '\\newlabel{fig:evil}{{6}{66}}\n');
    try {
      await symlink(target, path.join(build, 'chap.aux'));
    } catch {
      t.skip(); // symlink creation needs privileges on some Windows setups
      return;
    }
    await writeFile(buildAuxPath(dir!, 'main.tex'), '\\relax \n\\@input{chap.aux}\n');

    const result = await readAuxFloats(dir!, 'main.tex');
    expect(result.floats).toEqual([]);
    expect(result.note).toContain('chap.aux');
  });

  it('is not blinded by a build dir full of render PNGs', async () => {
    // render_pages writes one `page-<n>-<hash>.png` per distinct request under <build>/render/,
    // and nothing prunes them. The .aux lookup used to walk the whole build dir under a
    // 10000-entry budget, so enough renders used up the budget before a chapter subdirectory
    // was reached — which one depended on readdir order, hence twenty of them here.
    //
    // An \@input is now looked up along its own path, component by component, so there is no
    // budget for render files to use up and this no longer needs 10,001 of them (which cost
    // seconds of file creation on Windows CI). What it pins at a few hundred: a crowded sibling
    // directory costs the lookup nothing — every chapter is found, in order, with no note. It
    // does NOT reproduce the old budget exhaustion (that took more entries than any budget), so it
    // would not catch a return to a whole-tree enumeration under a large budget; it catches one
    // under a small budget, or any lookup that lets unrelated entries crowd out a chapter.
    const build = await freshBuild();
    const renders = path.join(build, 'render');
    await mkdir(renders, { recursive: true });
    const names = Array.from({ length: 300 }, (_, i) => `page-1-${i.toString(16)}.png`);
    await Promise.all(names.map((n) => writeFile(path.join(renders, n), '')));
    const parts = Array.from({ length: 20 }, (_, i) => `part${i}`);
    for (const part of parts) {
      await mkdir(path.join(build, part), { recursive: true });
      await writeFile(path.join(build, part, 'ch.aux'), `\\newlabel{fig:${part}}{{1}{1}}\n`);
    }
    await writeFile(
      buildAuxPath(dir!, 'main.tex'),
      ['\\relax ', ...parts.map((p) => `\\@input{${p}/ch.aux}`), ''].join('\n'),
    );

    const result = await readAuxFloats(dir!, 'main.tex');
    expect(result.note).toBeUndefined();
    expect(result.unreadInputs).toBe(0);
    expect(result.floats.map((f) => f.label)).toEqual(parts.map((p) => `fig:${p}`));
  });

  it('never takes a directory, or a link, for an \\@input on the way to it', async (t) => {
    const build = await freshBuild();
    await mkdir(path.join(build, 'dir.aux'), { recursive: true });
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), 'auxinclude-out-'));
    extra.push(outsideDir);
    await writeFile(path.join(outsideDir, 'ch.aux'), '\\newlabel{fig:evil}{{6}{66}}\n');
    await writeFile(
      buildAuxPath(dir!, 'main.tex'),
      '\\relax \n\\@input{dir.aux}\n\\@input{linked/ch.aux}\n\\@input{./sub/../dir.aux}\n',
    );
    try {
      await symlink(outsideDir, path.join(build, 'linked'), 'junction');
    } catch {
      t.skip(); // symlink creation needs privileges on some Windows setups
      return;
    }

    const result = await readAuxFloats(dir!, 'main.tex');
    expect(result.floats).toEqual([]);
    expect(result.unreadInputs).toBe(2);
    expect(result.note).toContain('dir.aux');
    expect(result.note).toContain('linked/ch.aux');
  });

  describe('an \\@input whose spelling differs only in case from the build dir entry', () => {
    // On a case-insensitive filesystem (Windows, macOS) LaTeX finds `chapters/one.aux` in a
    // `Chapters/` directory, or as `One.aux` — the build dir keeps the case an earlier compile
    // created, and mirrors the source tree's own spelling. The lookup is exact and stays exact
    // (it never reads a name it did not match literally), so this is a miss; but the note used to
    // say "compile the whole document", which can never fix a case difference.
    it('reports a directory spelled differently, without reading through it', async () => {
      const build = await freshBuild();
      await mkdir(path.join(build, 'Chapters'), { recursive: true });
      await writeFile(path.join(build, 'Chapters', 'one.aux'), '\\newlabel{fig:one}{{1}{2}}\n');
      await writeFile(buildAuxPath(dir!, 'main.tex'), '\\relax \n\\@input{chapters/one.aux}\n');

      const result = await readAuxFloats(dir!, 'main.tex');
      expect(result.floats).toEqual([]);
      expect(result.unreadInputs).toBe(1);
      expect(result.note).toContain('chapters/one.aux');
      expect(result.note).toMatch(/spelled differently/);
      expect(result.note).toContain('"Chapters"');
      expect(result.note).toMatch(/clean/);
      expect(result.note).not.toMatch(/compile the whole document/);
    });

    it('reports a file spelled differently, without reading it', async () => {
      const build = await freshBuild();
      await writeFile(path.join(build, 'One.aux'), '\\newlabel{fig:one}{{1}{2}}\n');
      await writeFile(buildAuxPath(dir!, 'main.tex'), '\\relax \n\\@input{one.aux}\n');

      const result = await readAuxFloats(dir!, 'main.tex');
      expect(result.floats).toEqual([]);
      expect(result.note).toMatch(/spelled differently/);
      expect(result.note).toContain('"One.aux"');
      expect(result.note).not.toMatch(/compile the whole document/);
    });

    it('keeps each advice to the input it fits when both kinds of miss occur', async () => {
      const build = await freshBuild();
      await writeFile(path.join(build, 'One.aux'), '\\newlabel{fig:one}{{1}{2}}\n');
      await writeFile(
        buildAuxPath(dir!, 'main.tex'),
        '\\relax \n\\@input{one.aux}\n\\@input{gone.aux}\n',
      );

      const result = await readAuxFloats(dir!, 'main.tex');
      expect(result.unreadInputs).toBe(2);
      expect(result.note).toMatch(/"one\.aux" \([^)]*spelled differently/);
      expect(result.note).toMatch(/"gone\.aux" \(not found in the build directory\)/);
      expect(result.note).toMatch(/compile the whole document/);
    });

    it('does not guess between two entries that differ from the name only in case', async () => {
      const build = await freshBuild();
      await writeFile(path.join(build, 'One.aux'), '\\newlabel{fig:a}{{1}{2}}\n');
      await writeFile(path.join(build, 'ONE.aux'), '\\newlabel{fig:b}{{1}{2}}\n');
      // Only a case-sensitive filesystem can hold both; elsewhere the second write overwrote the first.
      const names = await readdir(build);
      if (!(names.includes('One.aux') && names.includes('ONE.aux'))) return;
      await writeFile(buildAuxPath(dir!, 'main.tex'), '\\relax \n\\@input{one.aux}\n');

      const result = await readAuxFloats(dir!, 'main.tex');
      expect(result.floats).toEqual([]);
      expect(result.note).not.toMatch(/spelled differently/);
      expect(result.note).toMatch(/not found in the build directory/);
    });
  });

  it('terminates on an input cycle and reads each file once', async () => {
    const build = await freshBuild();
    await writeFile(
      buildAuxPath(dir!, 'main.tex'),
      '\\relax \n\\@input{chap.aux}\n\\@input{main.aux}\n',
    );
    await writeFile(
      path.join(build, 'chap.aux'),
      '\\newlabel{fig:one}{{1.1}{2}}\n\\@input{main.aux}\n\\@input{chap.aux}\n',
    );

    const result = await readAuxFloats(dir!, 'main.tex');
    expect(result.floats).toEqual([{ label: 'fig:one', number: '1.1', page: '2' }]);
    expect(result.total).toBe(1);
  });
});
