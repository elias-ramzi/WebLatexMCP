import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, rm, utimes, readFile } from 'node:fs/promises';
import { ViewerService } from '../../src/services/viewer.js';
import { CommentStore } from '../../src/services/commentStore.js';

describe('ViewerService', () => {
  let dir: string;
  let pdf: string;
  let hasPdf = true;
  let viewer: ViewerService;
  let base: string;
  let store: CommentStore;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-viewer-'));
    pdf = path.join(dir, 'main.pdf');
    await writeFile(pdf, Buffer.from('%PDF-1.4\n%stub\n'));
    store = new CommentStore();
    viewer = new ViewerService({
      knownIds: () => ['demo'],
      resolvePdfPath: async (id) => (id === 'demo' && hasPdf ? pdf : null),
      // Stand in for the synctex-backed resolver: attach a fixed source location.
      addComment: async (id, input) => store.add(id, { ...input, file: 'main.tex', line: 42 }),
      listComments: (id) => store.list(id),
      updateComment: (id, cid, note) => store.update(id, cid, { note }),
      deleteComment: (id, cid) => store.remove(id, cid),
      undoDelete: (id) => store.undo(id),
      resolveComments: (id, ids) => store.resolve(id, ids),
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

  it('serves a viewer module script that parses (guards against JS syntax regressions)', async () => {
    const html = await (await fetch(`${base}/p/demo`)).text();
    const script = /<script type="module">([\s\S]*?)<\/script>/.exec(html)?.[1];
    expect(script).toBeTruthy();
    // Drop the ESM imports (unresolvable here) and compile the rest without running it: this
    // throws SyntaxError on parse errors like a duplicate `const`, which blank the whole viewer.
    const body = script!.replace(/^\s*import .*$/gm, '');
    expect(() => new Function(body)).not.toThrow();
  });

  it('only calls pdf.js coordinate methods that exist in the bundled pdfjs-dist', async () => {
    const html = await (await fetch(`${base}/p/demo`)).text();
    const script = /<script type="module">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
    const used = new Set([...script.matchAll(/convertTo[A-Za-z]+/g)].map((m) => m[0]));
    expect(used.size).toBeGreaterThan(0);
    const pdfSrc = await readFile(
      new URL('../../node_modules/pdfjs-dist/build/pdf.mjs', import.meta.url),
      'utf8',
    );
    for (const name of used) expect(pdfSrc).toContain(name);
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

  it('rejects unsupported methods', async () => {
    const r = await fetch(`${base}/p/demo`, { method: 'PUT' });
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

  it('accepts a comment, lists it, and resolves it', async () => {
    const post = await fetch(`${base}/p/demo/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ page: 1, x: 100, y: 200, quote: 'the result', note: 'tighten this' }),
    });
    expect(post.status).toBe(201);
    const created = (await post.json()) as { id: string; [k: string]: unknown };
    expect(created).toMatchObject({
      note: 'tighten this',
      file: 'main.tex',
      line: 42,
      resolved: false,
    });
    expect(typeof created.id).toBe('string');

    const list = (await (await fetch(`${base}/p/demo/comments`)).json()) as Array<{
      quote: string;
    }>;
    expect(list).toHaveLength(1);
    expect(list[0]!.quote).toBe('the result');

    const res = await fetch(`${base}/p/demo/comments/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [created.id] }),
    });
    expect(((await res.json()) as { resolved: number }).resolved).toBe(1);
    // Resolved comments drop out of the default (open-only) listing.
    const after = (await (await fetch(`${base}/p/demo/comments`)).json()) as unknown[];
    expect(after).toHaveLength(0);
  });

  it('stores selection rects and drops malformed ones', async () => {
    const r = await fetch(`${base}/p/demo/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        page: 1,
        x: 1,
        y: 1,
        note: 'highlight me',
        rects: [[1, 2, 3, 4], [5, 6, 7, 8], 'bad', [1, 2, 3], [1, 2, 3, 'x']],
      }),
    });
    const c = (await r.json()) as { rects: number[][] };
    expect(c.rects).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
    ]);
  });

  it('rejects a malformed comment body', async () => {
    const r = await fetch(`${base}/p/demo/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ page: 1, note: 'missing coords' }),
    });
    expect(r.status).toBe(400);
  });

  async function makeComment(note: string): Promise<string> {
    const r = await fetch(`${base}/p/demo/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ page: 1, x: 1, y: 1, note }),
    });
    return ((await r.json()) as { id: string }).id;
  }

  it('edits a comment note', async () => {
    const cid = await makeComment('before');
    const r = await fetch(`${base}/p/demo/comments/${cid}/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: 'after' }),
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { note: string }).note).toBe('after');
    const list = (await (await fetch(`${base}/p/demo/comments`)).json()) as Array<{
      id: string;
      note: string;
    }>;
    expect(list.find((c) => c.id === cid)?.note).toBe('after');
  });

  it('404s editing an unknown comment', async () => {
    const r = await fetch(`${base}/p/demo/comments/nope/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: 'x' }),
    });
    expect(r.status).toBe(404);
  });

  it('deletes a comment', async () => {
    const cid = await makeComment('to delete');
    const del = await fetch(`${base}/p/demo/comments/${cid}/delete`, { method: 'POST' });
    expect(del.status).toBe(200);
    expect(((await del.json()) as { deleted: boolean }).deleted).toBe(true);
    const list = (await (await fetch(`${base}/p/demo/comments`)).json()) as Array<{ id: string }>;
    expect(list.some((c) => c.id === cid)).toBe(false);
    // Deleting again 404s.
    expect((await fetch(`${base}/p/demo/comments/${cid}/delete`, { method: 'POST' })).status).toBe(
      404,
    );
  });

  it('undoes the last delete', async () => {
    const cid = await makeComment('bring me back');
    await fetch(`${base}/p/demo/comments/${cid}/delete`, { method: 'POST' });

    const undo = await fetch(`${base}/p/demo/comments/undo`, { method: 'POST' });
    expect(undo.status).toBe(200);
    expect(((await undo.json()) as { restored: { id: string } | null }).restored?.id).toBe(cid);
    const list = (await (await fetch(`${base}/p/demo/comments`)).json()) as Array<{ id: string }>;
    expect(list.some((c) => c.id === cid)).toBe(true);
    // (The "nothing left to undo → null" path is covered in isolation in commentStore.test.ts.)
  });
});
