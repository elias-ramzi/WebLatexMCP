import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, rm, utimes } from 'node:fs/promises';
import { ViewerService } from '../../src/services/viewer.js';

describe('ViewerService', () => {
  let dir: string;
  let pdf: string;
  let hasPdf = true;
  let viewer: ViewerService;
  let base: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-viewer-'));
    pdf = path.join(dir, 'main.pdf');
    await writeFile(pdf, Buffer.from('%PDF-1.4\n%stub\n'));
    viewer = new ViewerService({
      knownIds: () => ['demo'],
      resolvePdfPath: async (id) => (id === 'demo' && hasPdf ? pdf : null),
    });
    const url = await viewer.start(0);
    expect(url).toBeDefined();
    base = url!;
  });

  afterAll(async () => {
    await viewer.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('binds to loopback', () => {
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(viewer.isRunning()).toBe(true);
  });

  it('serves the viewer HTML for a known project', async () => {
    const r = await fetch(`${base}/p/demo`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/html/);
    expect(await r.text()).toContain('demo');
  });

  it('404s an unknown project', async () => {
    const r = await fetch(`${base}/p/nope`);
    expect(r.status).toBe(404);
  });

  it('streams the PDF bytes with the right content type', async () => {
    const r = await fetch(`${base}/p/demo/pdf`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/pdf');
    expect(await r.text()).toContain('%PDF-1.4');
  });

  it('reports a version that changes when the PDF is rewritten', async () => {
    const r1 = await fetch(`${base}/p/demo/version`);
    expect(r1.status).toBe(200);
    const v1 = await r1.text();

    // Bump mtime to simulate a recompile.
    const later = new Date(Date.now() + 5000);
    await utimes(pdf, later, later);
    const v2 = await (await fetch(`${base}/p/demo/version`)).text();
    expect(v2).not.toBe(v1);
  });

  it('404s the PDF and version before anything is compiled', async () => {
    hasPdf = false;
    try {
      expect((await fetch(`${base}/p/demo/pdf`)).status).toBe(404);
      expect((await fetch(`${base}/p/demo/version`)).status).toBe(404);
      // The viewer page itself still loads so it can poll until the first compile.
      expect((await fetch(`${base}/p/demo`)).status).toBe(200);
    } finally {
      hasPdf = true;
    }
  });

  it('rejects non-GET methods', async () => {
    const r = await fetch(`${base}/p/demo`, { method: 'POST' });
    expect(r.status).toBe(405);
  });

  it('urlFor composes the project URL', () => {
    expect(viewer.urlFor('demo')).toBe(`${base}/p/demo`);
  });

  it('serves bundled pdf.js assets with a JS content type', async () => {
    const r = await fetch(`${base}/pdfjs/build/pdf.mjs`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/javascript/);
    expect(Number(r.headers.get('content-length'))).toBeGreaterThan(0);
  });

  it('serves the pdf.js viewer stylesheet', async () => {
    const r = await fetch(`${base}/pdfjs/web/pdf_viewer.css`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/css/);
  });

  it('does not serve files outside the pdfjs root via traversal', async () => {
    // URL normalization pops `..` before routing (404); the sendStatic root check is a further
    // backstop. Either way, no out-of-root file is served.
    const r = await fetch(`${base}/pdfjs/%2e%2e/package.json`);
    expect(r.status).not.toBe(200);
    expect(await r.text()).not.toContain('pdfjs-dist');
  });

  it('404s a missing pdf.js asset', async () => {
    const r = await fetch(`${base}/pdfjs/build/nope.mjs`);
    expect(r.status).toBe(404);
  });
});
