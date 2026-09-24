import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { minimalPdf } from '../helpers/minimalPdf.js';

const execFileP = promisify(execFile);

/**
 * The PDF service on a machine where `@napi-rs/canvas` does not load — which is every Claude
 * Desktop extension install: the .mcpb is built once, on ubuntu, and a per-platform native binary
 * cannot usefully ship in a cross-platform bundle, so `.mcpbignore` drops it.
 *
 * This cannot be tested in-process. pdf.js decides at IMPORT time whether it can install the
 * `DOMMatrix` global it evaluates at module scope, and the vitest process has long since imported
 * it with the backend present — so an injected loader that throws "DOMMatrix is not defined"
 * pins only the error classification, never whether the real module loads without the backend.
 * A fresh Node process with the backend hidden from the module resolver is the only faithful
 * stand-in, and it hides it the way a missing package fails: `MODULE_NOT_FOUND` from the
 * resolver that pdf.js's own `createRequire(...)('@napi-rs/canvas')` goes through. Under tsx the
 * main package can still resolve (tsx answers that request itself) and the failure then surfaces
 * one level down, as the package's "Cannot find native binding" when its per-platform binary is
 * refused — which is the other real shape of this machine (the JS package present, its binary
 * not), so either way the backend does not load, and the first test pins that it did not.
 */

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PDF_RENDER_URL = pathToFileURL(path.join(REPO_ROOT, 'src', 'services', 'pdfRender.ts')).href;

const HIDE_CANVAS_CJS = `
const Module = require('node:module');
const original = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@napi-rs/canvas' || request.startsWith('@napi-rs/canvas-')) {
    const err = new Error("Cannot find module '" + request + "'");
    err.code = 'MODULE_NOT_FOUND';
    throw err;
  }
  return original.call(this, request, ...rest);
};
`;

const CHILD_MJS = `
import { createRequire } from 'node:module';
const [modUrl, pdfPath, outDir] = process.argv.slice(2);
let canvasHidden = false;
try {
  createRequire(modUrl)('@napi-rs/canvas');
} catch {
  canvasHidden = true;
}
const settle = async (fn) => {
  try {
    return { ok: await fn() };
  } catch (err) {
    return { err: String(err && err.message) };
  }
};
const { PdfRenderer } = await import(modUrl);
const r = new PdfRenderer();
const out = {
  canvasHidden,
  pageCount: await settle(() => r.pageCount(pdfPath)),
  pageLabels: await settle(() => r.pageLabels(pdfPath)),
  text: await settle(async () => (await r.text({ pdfPath, pages: [1, 2] })).pages.map((p) => p.lines)),
  geometry: await settle(async () =>
    (await r.geometry({ pdfPath, pages: [1], kinds: ['text', 'images'] })).pages.map((p) => ({
      text: (p.text ?? []).map((b) => b.text),
      images: (p.images ?? []).length,
      width: p.pageWidthPt,
    })),
  ),
  render: await settle(() => r.render({ pdfPath, outDir, pages: [1] })),
  canRasterize: await r.canRasterize(),
  canReadPdf: typeof r.canReadPdf === 'function' ? await r.canReadPdf() : 'absent',
};
process.stdout.write(JSON.stringify(out));
`;

interface ChildResult {
  canvasHidden: boolean;
  pageCount: { ok?: number; err?: string };
  pageLabels: { ok?: string[] | null; err?: string };
  text: { ok?: string[][]; err?: string };
  geometry: { ok?: Array<{ text: string[]; images: number; width: number }>; err?: string };
  render: { ok?: unknown; err?: string };
  canRasterize: boolean;
  canReadPdf: unknown;
}

describe('the PDF service without the native canvas backend (fresh process)', () => {
  let dir: string;
  let result: ChildResult;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-nocanvas-'));
    const preload = path.join(dir, 'hide-canvas.cjs');
    const child = path.join(dir, 'child.mjs');
    const pdfPath = path.join(dir, 'doc.pdf');
    await writeFile(preload, HIDE_CANVAS_CJS);
    await writeFile(child, CHILD_MJS);
    await writeFile(
      pdfPath,
      minimalPdf(2, 300, 200, {
        pageLabels: ['iv', '1'],
        text: (p) => `Hello from page ${p}`,
      }),
    );
    const res = await execFileP(
      process.execPath,
      [
        '--require',
        preload,
        '--import',
        'tsx',
        child,
        PDF_RENDER_URL,
        pdfPath,
        path.join(dir, 'out'),
      ],
      { cwd: REPO_ROOT, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
    );
    // The whole of stdout must parse: it is the JSON-RPC channel, and pdf.js warns at import time
    // when the backend is absent — those warnings have to land on stderr, not here.
    result = JSON.parse(res.stdout) as ChildResult;
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('really runs without the backend (the probe fired)', () => {
    // Without this, every assertion below could pass against a process that loaded the canvas.
    expect(result.canvasHidden).toBe(true);
  });

  it('counts pages, reads /PageLabels, extracts text and measures text geometry', () => {
    expect(result.pageCount).toEqual({ ok: 2 });
    expect(result.pageLabels).toEqual({ ok: ['iv', '1'] });
    expect(result.text).toEqual({ ok: [['Hello from page 1'], ['Hello from page 2']] });
    expect(result.geometry.err).toBeUndefined();
    expect(result.geometry.ok?.[0]?.text).toEqual(['Hello from page 1']);
    expect(result.geometry.ok?.[0]?.width).toBe(300);
  });

  it('refuses render as a missing backend that names the Desktop extension, not a broken PDF', () => {
    expect(result.render.ok).toBeUndefined();
    expect(result.render.err).toMatch(/@napi-rs\/canvas/);
    expect(result.render.err).toMatch(/Desktop extension/);
    expect(result.render.err).not.toMatch(/Failed to open PDF/);
  });

  it('reports the split doctor grades on: can read, cannot rasterize', () => {
    expect(result.canRasterize).toBe(false);
    expect(result.canReadPdf).toEqual({ ok: true });
  });
});
