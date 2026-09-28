import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { parseEngineOutput, readAuxFloats, readBuildTimes } from '../../src/lib/auxFloats.js';
import { pdfLabelPageReader, resolveLabelPages } from '../../src/lib/labelPages.js';
import type { PdfRenderService, TextResult } from '../../src/services/pdfRender.js';
import { buildAuxPath, buildDir } from '../../src/services/compiler.js';

/**
 * Three holes in the stale-PDF records (#220 follow-ups): a closing-record marker inside the
 * engine's own "Output written on <path>" record, a build file reached through a symbolic link,
 * and a label lookup whose `.aux` index was read without the PDF it is then paired with.
 */

describe('parseEngineOutput: a marker inside the written record is part of its file name', () => {
  // The build directory embeds the project directory's name, and a project may be called
  // "No pages of output. draft": the engine then writes that text inside its own written record.
  const dir = '/tmp/web-latex-mcp-build-1001/No pages of output. draft-1a2b3c4d';
  const fatalDir =
    '/tmp/web-latex-mcp-build-1001/==> Fatal error occurred, no output PDF file produced!-9f';

  it('reads the written record, not the marker in its path', () => {
    expect(
      parseEngineOutput(`Output written on ${dir}/main.pdf (2 pages, 31337 bytes).\n`),
    ).toEqual({ kind: 'written', pages: 2, ext: '.pdf' });
    expect(
      parseEngineOutput(`Output written on ${fatalDir}/main.xdv (4 pages, 9 bytes).\n`),
    ).toEqual({ kind: 'written', pages: 4, ext: '.xdv' });
  });

  it('holds when TeX wraps the record at 79 columns, and PDF statistics follow it', () => {
    const record = `Output written on ${dir}/main.pdf (2 pages, 31337 bytes).`;
    const wrapped = (record.match(/.{1,79}/g) ?? []).join('\n');
    expect(
      parseEngineOutput(`[1] [2]\n${wrapped}\nPDF statistics:\n 12 PDF objects out of 1000\n`),
    ).toEqual({ kind: 'written', pages: 2, ext: '.pdf' });
  });
});

let tmp: string | undefined;
afterEach(async () => {
  if (tmp) {
    await rm(buildDir(tmp), { recursive: true, force: true });
    await rm(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
});

/** A symlink, or `false` where the platform refuses to make one (Windows without the right). */
async function trySymlink(target: string, at: string): Promise<boolean> {
  try {
    await symlink(target, at);
    return true;
  } catch (err) {
    if (['EPERM', 'EACCES'].includes((err as NodeJS.ErrnoException).code ?? '')) return false;
    throw err;
  }
}

describe('readBuildTimes judges the files themselves, never what a link points at', () => {
  it('gives no times for a linked .aux or a linked PDF', async (ctx) => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'laneb-times-'));
    const real = path.join(tmp, 'real.aux');
    const pdf = path.join(tmp, 'main.pdf');
    await writeFile(real, '\\relax\n');
    await writeFile(pdf, '%PDF-1.5\n');
    const linkedAux = path.join(tmp, 'main.aux');
    const linkedPdf = path.join(tmp, 'linked.pdf');
    if (!(await trySymlink(real, linkedAux)) || !(await trySymlink(pdf, linkedPdf))) {
      ctx.skip();
      return;
    }
    expect(await readBuildTimes(real, pdf)).toBeDefined();
    expect(await readBuildTimes(linkedAux, pdf)).toBeUndefined();
    expect(await readBuildTimes(real, linkedPdf)).toBeUndefined();
  });

  it('gives no times for a directory where a file should be', async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'laneb-times-'));
    const pdf = path.join(tmp, 'main.pdf');
    await writeFile(pdf, '%PDF-1.5\n');
    await mkdir(path.join(tmp, 'main.aux'));
    expect(await readBuildTimes(path.join(tmp, 'main.aux'), pdf)).toBeUndefined();
  });
});

describe('a label lookup must pair its .aux index with the PDF it reads', () => {
  /** A 3-page PDF whose pages print their own folio, through the renderer's interface. */
  const renderer: Pick<PdfRenderService, 'pageLabelsAndCount' | 'text'> = {
    pageLabelsAndCount: () => Promise.resolve({ pageLabels: null, pageCount: 3 }),
    text: ({ pages }) =>
      Promise.resolve({
        pageCount: 3,
        pages: (pages ?? []).map((p) => ({ page: p, lines: [`${'ABC'[p - 1]}`, `${p}`] })),
        skippedPages: [],
      } as unknown as TextResult),
  };

  /** A build whose `.aux` a stopped run rewrote AFTER the PDF (10 s after). */
  async function staleBuild(): Promise<string> {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'laneb-pair-'));
    await mkdir(buildDir(tmp), { recursive: true });
    const auxPath = buildAuxPath(tmp, 'main.tex');
    const pdfPath = path.join(buildDir(tmp), 'main.pdf');
    await writeFile(
      auxPath,
      '\\relax \n\\newlabel{a}{{}{1}{}{}{}}\n\\newlabel{b}{{}{2}{}{}{}}\n\\newlabel{c}{{}{3}{}{}{}}\n',
    );
    await writeFile(pdfPath, '%PDF-1.5 stand-in: the renderer here is canned\n');
    await writeFile(
      path.join(buildDir(tmp), 'main.log'),
      'This is pdfTeX\n(./main.tex [1] [2] [3] )\nOutput written on main.pdf (3 pages, 9 bytes).\n',
      'latin1',
    );
    const auxTime = new Date('2026-09-28T12:00:00Z');
    await utimes(auxPath, auxTime, auxTime);
    const pdfTime = new Date(auxTime.getTime() - 10_000);
    await utimes(pdfPath, pdfTime, pdfTime);
    return pdfPath;
  }

  it('refuses to run on an index read without the PDF, instead of skipping the timestamp check', async () => {
    const pdfPath = await staleBuild();
    const unpaired = await readAuxFloats(tmp!, 'main.tex', { max: 20_000, shipouts: true });
    await expect(
      resolveLabelPages(['b'], unpaired, pdfLabelPageReader(renderer, pdfPath)),
    ).rejects.toThrow(/was not read with the PDF this lookup reads/);
    // Read with that PDF, the same build is looked up — and refused for what its times show.
    const paired = await readAuxFloats(tmp!, 'main.tex', { max: 20_000, shipouts: true, pdfPath });
    const plan = await resolveLabelPages(['b'], paired, pdfLabelPageReader(renderer, pdfPath));
    expect(plan.failed.map((f) => f.reason)).toEqual(['stalePdf']);
  });

  it('refuses an index paired with another PDF than the one it reads', async () => {
    const pdfPath = await staleBuild();
    const other = await readAuxFloats(tmp!, 'main.tex', {
      max: 20_000,
      shipouts: true,
      pdfPath: `${pdfPath}.other`,
    });
    await expect(
      resolveLabelPages(['b'], other, pdfLabelPageReader(renderer, pdfPath)),
    ).rejects.toThrow(/was not read with the PDF this lookup reads/);
  });
});
