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

  // Clicking the PDF dismisses the comment panel; everything named in PANEL_KEEP leaves it open.
  // A rename that leaves an id out of that list turns "click the note popup" into "close the
  // panel under me", which no parse check would catch.
  it('keeps the comment panel open only for chrome that still exists in the page', async () => {
    const html = await (await fetch(`${base}/p/demo`)).text();
    const script = /<script type="module">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
    const pointerdown = /document\.addEventListener\('pointerdown',[\s\S]*?\n\}\);/.exec(
      script,
    )?.[0];
    expect(pointerdown).toBeTruthy();
    // Strip the handler's own comments first: a guard named only in the rationale above it is not
    // a guard, and deleting the `if` while leaving that comment behind must still fail here.
    const body = pointerdown!.replace(/^\s*\/\/.*$/gm, '');
    // Wiring alone is not the behaviour: an empty handler body would satisfy a listener check.
    expect(body).toContain('setPanel(false)');
    // An incidental click must not close the panel over an in-progress note edit — that strands
    // editingId, and every later refreshComments() early-returns for the rest of the session.
    // Matched line-aligned: the comment strip above is line-leading only, so a *trailing* decoy
    // (`const el = e.target; // if (editingId) return;`) survives it and satisfies a loose probe
    // while the real guard is gone. Widening the strip to `//[^\n]*$` is not the fix — it would
    // eat `'http://'`-shaped string literals — so pin the guard's own line instead.
    expect(body).toMatch(/^\s*if \(editingId\) return;$/m);
    // Only a primary-button press dismisses, or right-clicking the PDF for the context menu (or
    // middle-clicking to autoscroll) would close the panel behind it.
    expect(body).toMatch(/^\s*if \(e\.button !== 0\) return;$/m);
    // Presence is not enough: a guard that runs after the statement it guards is not a guard. Both
    // of these sitting below `setPanel(false)` is dead code that disarms them while reading as
    // present, so pin the position too.
    expect(body.indexOf('if (editingId) return;')).toBeLessThan(body.indexOf('setPanel(false)'));
    expect(body.indexOf('if (e.button !== 0) return;')).toBeLessThan(
      body.indexOf('setPanel(false)'),
    );
    const keep = /const PANEL_KEEP = '([^']+)'/.exec(script)?.[1];
    expect(keep).toBeTruthy();
    const ids = keep!.split(',').map((s) => s.trim());
    // Pinned exactly, so dropping any one of the four fails here: `#bar` because the toggle would
    // otherwise close the panel it just opened, `#panel` because a click inside the list would
    // dismiss it, and `#fab`/`#pop` because clicking the Comment button or typing in the note
    // popup would close the panel underneath.
    expect(ids).toEqual(['#bar', '#panel', '#fab', '#pop']);
    // Check the ids against the markup half only. The script holds no attribute-shaped `id="…"`
    // literal today, but one future string there would let PANEL_KEEP corroborate itself.
    const scriptAt = html.indexOf('<script type="module">');
    expect(scriptAt).toBeGreaterThan(0);
    const markup = html.slice(0, scriptAt);
    for (const sel of ids) {
      expect(sel).toMatch(/^#[\w-]+$/);
      expect(markup).toContain(`id="${sel.slice(1)}"`);
    }
    // The popup's own Escape is bound to its textarea, so a click on the scrollable quote leaves
    // the key unhandled. Cancelling the popup has to come *before* the panel branch, or one
    // keypress closes the panel behind a popup that stays on screen.
    // Anchored on the Escape guard, not on the first `keydown` listener — the zoom shortcuts
    // register one earlier in the script. The anchor is *checked*, not trusted: `lastIndexOf`
    // never returns -1 here, so if this listener's spelling ever changes (`window.` → `document.`,
    // the natural consistency edit next to the `document.`-bound pointerdown handler two lines
    // above), the search silently falls back to the zoom listener and the slice widens from a few
    // hundred bytes to several kB — swallowing the popnote textarea handler and the pointerdown
    // handler, whose own `getElementById('popcancel')` and `setPanel(false)` then satisfy every
    // assertion below on code that is not this handler. Two independent checks close that, since
    // they fail for different reasons: nothing registers a listener between the anchor and the
    // guard, and each probed call appears exactly once in the slice.
    const escapeAt = script.indexOf("e.key !== 'Escape'");
    expect(escapeAt).toBeGreaterThan(0);
    const KEYDOWN_ANCHOR = "window.addEventListener('keydown'";
    const kdStart = script.lastIndexOf(KEYDOWN_ANCHOR, escapeAt);
    expect(kdStart).toBeGreaterThan(0);
    expect(script.slice(kdStart + KEYDOWN_ANCHOR.length, escapeAt)).not.toContain(
      'addEventListener',
    );
    const keydown = script
      .slice(kdStart, script.indexOf('\n});', escapeAt))
      // Comment-stripped like the pointerdown body above, and probed on the whole call rather than
      // the bare `popcancel` token: a rationale comment naming popcancel above the panel branch
      // satisfied both otherwise, with the branch itself moved below it.
      .replace(/^\s*\/\/.*$/gm, '');
    // Exactly one of each, so a slice that widened past this handler fails on the count instead of
    // passing on some other handler's occurrence.
    expect(keydown.match(/setPanel\(false\)/g)).toHaveLength(1);
    expect(keydown.match(/getElementById\('popcancel'\)/g)).toHaveLength(1);
    // Both Escape guards, since deleting either is what costs a user the note they were typing —
    // asserted on the comment-stripped slice, line-aligned, and *ahead of* what they guard. A
    // guard sitting below `setPanel(false)` is not a guard: every keypress would then cancel the
    // popup and close the panel, which is a live bug that presence alone reads as fixed.
    expect(keydown).toMatch(/e\.key !== 'Escape' \|\| e\.defaultPrevented \|\| editingId/);
    expect(keydown).toMatch(
      /^\s*if \(e\.key !== 'Escape' \|\| e\.defaultPrevented \|\| editingId\) return;$/m,
    );
    expect(keydown.indexOf("e.key !== 'Escape'")).toBeLessThan(keydown.indexOf('setPanel(false)'));
    expect(keydown).toContain("getElementById('popcancel').click()");
    expect(keydown.indexOf("getElementById('popcancel')")).toBeLessThan(
      keydown.indexOf('setPanel(false)'),
    );
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

  // Regression: a response whose body is never read leaves the socket *active*, and `server.close()`
  // alone only reaps idle ones — so closing stayed pending until that socket timed out, stalling
  // shutdown (and this suite's own teardown, which flaked in CI).
  it('closes promptly with an unread response body still open', async () => {
    const other = new ViewerService({
      knownIds: () => ['demo'],
      resolvePdfPath: async () => pdf,
      addComment: async (id, input) => store.add(id, { ...input, file: 'main.tex', line: 1 }),
      listComments: (id) => store.list(id),
      updateComment: (id, cid, note) => store.update(id, cid, { note }),
      deleteComment: (id, cid) => store.remove(id, cid),
      undoDelete: (id) => store.undo(id),
      resolveComments: (id, ids) => store.resolve(id, ids),
    });
    const url = await other.start(0);
    expect(url).toBeDefined();
    // Deliberately leave the body unconsumed, as several tests above do.
    expect((await fetch(`${url!}/pdfjs/build/pdf.mjs`)).status).toBe(200);

    await other.close();
    expect(other.isRunning()).toBe(false);
  }, 5_000);
});
