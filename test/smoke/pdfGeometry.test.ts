import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, cp, rm, readFile, appendFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { LatexmkCompiler } from '../../src/services/compiler.js';
import { PdfRenderer } from '../../src/services/pdfRender.js';
import { readAuxFloats } from '../../src/lib/auxFloats.js';

const execFile = promisify(execFileCb);

/**
 * Geometry against a **real** compiled PDF and a **real** .aux.
 *
 * The unit tests drive `geometry` through a fake pdf.js loader, which proves the CTM-walk and
 * text-merge logic but not that a document TeX actually produced yields real, non-degenerate
 * boxes, or that the .aux this server reads is the one a real compile writes. Gated on latexmk
 * like every other smoke here, so it skips in the fast CI job and runs in the dedicated
 * `tex-smoke` one.
 */

const compiler = new LatexmkCompiler();
const available = await compiler.isAvailable();
const hasPdflscape = await execFile('kpsewhich', ['pdflscape.sty'])
  .then(() => true)
  .catch(() => false);

const FIXTURE = fileURLToPath(new URL('../fixtures/sample-latex', import.meta.url));

describe.skipIf(!available)('pdf_geometry smoke (real latexmk PDF + .aux)', () => {
  let dir: string;
  let pdfPath: string;
  const renderer = new PdfRenderer();

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-geometry-'));
    await cp(FIXTURE, dir, { recursive: true });
    // The shared fixture has no \label — append one to this copy only (never the shared fixture
    // other smokes use) so the "floats" assertion below is real coverage of \newlabel extraction,
    // not just "an empty .aux parses without throwing".
    await appendFile(
      path.join(dir, 'sections', 'intro.tex'),
      '\n\\label{sec:smoke-intro}\n',
      'utf8',
    );

    if (hasPdflscape) {
      // A real /Rotate 90 page (FIX2's target case): pdflscape rotates the *printed* content but
      // leaves the PDF page itself portrait-in-MediaBox with a /Rotate entry, which is exactly
      // where a manual y-flip (rather than pdf.js's own rotation-aware viewport transform) goes
      // wrong. Added to this copy only, never the shared fixture other smokes use.
      const mainTexPath = path.join(dir, 'main.tex');
      const mainTex = await readFile(mainTexPath, 'utf8');
      const withLandscape = mainTex
        .replace('\\documentclass{article}', '\\documentclass{article}\n\\usepackage{pdflscape}')
        .replace(
          '\\end{document}',
          [
            '\\begin{landscape}',
            '\\section{Landscape section}',
            'This page is rotated 90 degrees by pdflscape.',
            '\\end{landscape}',
            '\\end{document}',
          ].join('\n'),
        );
      expect(withLandscape).not.toBe(mainTex);
      await writeFile(mainTexPath, withLandscape, 'utf8');
    }

    const outcome = await compiler.compile({ projectDir: dir, rootFile: 'main.tex' });
    expect(outcome.success).toBe(true);
    expect(outcome.pdfPath).toBeDefined();
    pdfPath = outcome.pdfPath!;
  }, 90_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('finds non-empty text boxes on page 1, lying within the page box', async () => {
    const result = await renderer.geometry({ pdfPath, pages: [1], kinds: ['text'] });
    expect(result.pages).toHaveLength(1);
    const page = result.pages[0]!;
    expect(page.text).toBeDefined();
    expect(page.text!.length).toBeGreaterThan(0);

    for (const box of page.text!) {
      expect(box.x0).toBeGreaterThanOrEqual(0);
      expect(box.y0).toBeGreaterThanOrEqual(0);
      expect(box.x1).toBeLessThanOrEqual(page.pageWidthPt);
      expect(box.y1).toBeLessThanOrEqual(page.pageHeightPt);
      expect(box.x1).toBeGreaterThan(box.x0);
      expect(box.y1).toBeGreaterThan(box.y0);
    }
    // The title page has "Sample Project" on it somewhere, merged into some line.
    expect(page.text!.some((b) => (b.text ?? '').includes('Sample'))).toBe(true);
  }, 30_000);

  it('parses the label this smoke run added, from the real build-dir .aux', async () => {
    // Through readAuxFloats — the actual function pdf_geometry's tool layer calls — not the pure
    // parseAuxLabels, so this smoke also proves the production read path (buildAuxPath + the
    // ENOENT/ok split) against a real compile, not just the parser in isolation.
    const result = await readAuxFloats(dir, 'main.tex');
    expect(result.note).toBeUndefined();
    const own = result.floats.find((l) => l.label === 'sec:smoke-intro');
    expect(own).toBeDefined();
    // The section containing the label is the second \section (Introduction is \input after
    // \maketitle) — its exact number is TeX's business, not this test's; the meaningful assertion
    // is that a real \label produced a real \newlabel this parser can read back.
    expect(own!.number.length).toBeGreaterThan(0);
    expect(own!.page.length).toBeGreaterThan(0);
  }, 30_000);

  it.skipIf(!hasPdflscape)(
    'reports the landscape page body text as a horizontal (wider-than-tall) box, not transposed, on a real /Rotate 90 (pdflscape) page',
    async () => {
      const result = await renderer.geometry({ pdfPath, kinds: ['text', 'images'] });
      // pdf.js's viewport width/height are already rotation-aware, so the landscape page (added
      // last, before \end{document}) should report wider-than-tall — confirming this run actually
      // exercises a rotated page, not just re-proving the portrait case above.
      const landscapePages = result.pages.filter((p) => p.pageWidthPt > p.pageHeightPt);
      expect(landscapePages.length).toBeGreaterThan(0);

      for (const page of result.pages) {
        for (const box of [...(page.text ?? []), ...(page.images ?? [])]) {
          expect(box.x0).toBeGreaterThanOrEqual(0);
          expect(box.y0).toBeGreaterThanOrEqual(0);
          expect(box.x1).toBeLessThanOrEqual(page.pageWidthPt);
          expect(box.y1).toBeLessThanOrEqual(page.pageHeightPt);
          expect(box.x1).toBeGreaterThan(box.x0);
          expect(box.y1).toBeGreaterThan(box.y0);
        }
      }
      // The rotated page's own text is found and stays in bounds, not just earlier portrait pages.
      const landscapeText = landscapePages.flatMap((p) => p.text ?? []);
      expect(landscapeText.some((b) => (b.text ?? '').includes('Landscape'))).toBe(true);

      // Falsifiable check for Finding 1: every assertion above (containment within the page box)
      // is satisfied equally by a *transposed* box, so none of them actually prove the rotation
      // was handled correctly. The `\section{Landscape section}` heading is a horizontal line of
      // printed text, so its reported box must be WIDER than TALL — a transposed box (width and
      // height swapped onto +x/+y regardless of the text's own rotation) would instead come back
      // narrow and tall, and this assertion is what catches that.
      const headingBox = landscapeText.find((b) => (b.text ?? '').includes('Landscape'));
      expect(headingBox).toBeDefined();
      expect(headingBox!.x1 - headingBox!.x0).toBeGreaterThan(headingBox!.y1 - headingBox!.y0);
    },
    30_000,
  );
});
