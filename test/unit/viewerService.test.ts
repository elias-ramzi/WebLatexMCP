import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, rm, utimes, readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { connect } from 'node:net';
import { ViewerService } from '../../src/services/viewer.js';
import type { ViewerDeps } from '../../src/services/viewer.js';
import { CommentStore } from '../../src/services/commentStore.js';
import type { NewComment } from '../../src/services/commentStore.js';

/**
 * One request with headers fetch cannot set (`Host`), or none at all: `setHost: false` and no
 * `host` header sends the request without one.
 */
function rawRequest(
  base: string,
  opts: { method?: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; body: string }> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: u.hostname,
        port: Number(u.port),
        method: opts.method ?? 'GET',
        path: opts.path,
        headers: opts.headers ?? {},
        setHost: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(opts.body);
  });
}

describe('ViewerService', () => {
  let dir: string;
  let pdf: string;
  let hasPdf = true;
  let viewer: ViewerService;
  let base: string;
  let store: CommentStore;
  /** Root resolutions per request: `locatePdf` resolves once, `resolveRoot` once more. */
  let resolutions = 0;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-viewer-'));
    pdf = path.join(dir, 'main.pdf');
    await writeFile(pdf, Buffer.from('%PDF-1.4\n%stub\n'));
    store = new CommentStore();
    viewer = new ViewerService({
      knownIds: () => ['demo'],
      locatePdf: async (id) => {
        resolutions++;
        return {
          pdf: id === 'demo' && hasPdf ? pdf : null,
          root: id === 'demo' ? { rootFile: 'tpl/main.tex', source: 'detected' } : null,
        };
      },
      resolveRoot: async (id) => {
        resolutions++;
        return id === 'demo' ? { rootFile: 'tpl/main.tex', source: 'detected' } : null;
      },
      // Stand in for the synctex-backed resolver: attach a fixed source location.
      addComment: async (id, input) => store.add(id, { ...input, file: 'main.tex', line: 42 }),
      listComments: (id, document) => store.list(id, { document }),
      updateComment: (id, cid, note) => store.update(id, cid, { note }),
      deleteComment: (id, cid) => store.remove(id, cid),
      undoDelete: (id, document) => store.undo(id, document),
      resolveComments: (id, ids, document) => store.resolve(id, ids, document),
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

  it("scopes the PDF page's Ask Claude prompt to PDF comments and the ids handled", async () => {
    const html = await (await fetch(`${base}/p/demo`)).text();
    expect(html).toContain('call list_comments with pdfOnly: true');
    expect(html).toContain('resolve_comments with the ids you handled');
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

  // The page says WHICH root it waits for, so a build of another root is not read as "nothing
  // compiled" (the reported case: a nested template main.tex detected over the real root).
  it('names the root it waits for in the version 404, and in rootFor', async () => {
    hasPdf = false;
    try {
      const r = await fetch(`${base}/p/demo/version`);
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ rootFile: 'tpl/main.tex', source: 'detected' });
      expect(await viewer.rootFor('demo')).toEqual({
        rootFile: 'tpl/main.tex',
        source: 'detected',
      });
      expect(await viewer.rootFor('nope')).toBeNull();
    } finally {
      hasPdf = true;
    }
  });

  // The page polls /version every 1.5 s while nothing is built; the 404 needs the PDF AND the
  // root, and resolving the root once for each doubled an auto-detection on every poll.
  it('resolves the root once per 404 version poll, and still names it', async () => {
    hasPdf = false;
    try {
      resolutions = 0;
      const r = await fetch(`${base}/p/demo/version`);
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ rootFile: 'tpl/main.tex', source: 'detected' });
      expect(resolutions).toBe(1);
    } finally {
      hasPdf = true;
    }
  });

  // A dep that breaks its never-throw contract still yields a 404, not a dropped request.
  it('answers a 404 with an empty body when locating throws', async () => {
    const other = new ViewerService({
      knownIds: () => ['demo'],
      locatePdf: async () => {
        throw new Error('boom');
      },
      addComment: async (id, input) => store.add(id, { ...input, file: 'main.tex', line: 1 }),
      listComments: (id, document) => store.list(id, { document }),
      updateComment: (id, cid, note) => store.update(id, cid, { note }),
      deleteComment: (id, cid) => store.remove(id, cid),
      undoDelete: (id, document) => store.undo(id, document),
      resolveComments: (id, ids, document) => store.resolve(id, ids, document),
    });
    const url = await other.start(0);
    try {
      const r = await fetch(`${url!}/p/demo/version`);
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({});
      expect((await fetch(`${url!}/p/demo/pdf`)).status).toBe(404);
    } finally {
      await other.close();
    }
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
      locatePdf: async () => ({ pdf, root: null }),
      addComment: async (id, input) => store.add(id, { ...input, file: 'main.tex', line: 1 }),
      listComments: (id, document) => store.list(id, { document }),
      updateComment: (id, cid, note) => store.update(id, cid, { note }),
      deleteComment: (id, cid) => store.remove(id, cid),
      undoDelete: (id, document) => store.undo(id, document),
      resolveComments: (id, ids, document) => store.resolve(id, ids, document),
    });
    const url = await other.start(0);
    expect(url).toBeDefined();
    // Deliberately leave the body unconsumed, as several tests above do.
    expect((await fetch(`${url!}/pdfjs/build/pdf.mjs`)).status).toBe(200);

    await other.close();
    expect(other.isRunning()).toBe(false);
  }, 5_000);

  // DNS rebinding / cross-site POST: any page in the user's browser can reach the loopback port.
  describe('Host and Origin guard', () => {
    const port = () => Number(new URL(base).port);

    it('refuses a foreign Host on every route', async () => {
      for (const p of ['/', '/p/demo', '/pdfjs/build/pdf.mjs', '/p/demo/doc?path=review.md']) {
        const r = await rawRequest(base, { path: p, headers: { host: `evil.example:${port()}` } });
        expect(r.status, p).toBe(403);
        expect(r.body).toBe('Forbidden.\n');
      }
    });

    // A forwarded port (VS Code Remote-SSH, Dev Containers) reaches the server under another
    // local port; rebinding cannot forge a loopback name, so the port is no boundary.
    it('accepts a loopback name on any port, or with none', async () => {
      for (const host of [
        `127.0.0.1:${port() + 1}`,
        'localhost',
        '127.0.0.1',
        `[::1]:${port() + 7}`,
        '[::1]',
        'localhost:1',
        'localhost:65535',
      ]) {
        const r = await rawRequest(base, { path: '/', headers: { host } });
        expect(r.status, host).toBe(200);
      }
    });

    it('refuses names that only look like loopback, and an invalid port', async () => {
      for (const host of [
        `localhost.:${port()}`,
        'localhost.',
        `127.0.0.1.evil.example:${port()}`,
        `user@localhost:${port()}`,
        'localhost:99999',
        'localhost:0',
        'localhost:',
        'localhost:12a',
        `localhost:${port()}:1`,
        `::1:${port()}`,
        `[::1]x:${port()}`,
        `evil.example:${port()}`,
      ]) {
        const r = await rawRequest(base, { path: '/', headers: { host } });
        expect(r.status, host).toBe(403);
      }
    });

    it('refuses a missing Host', async () => {
      // Node's own parser answers an HTTP/1.1 request without Host with 400 before the handler
      // runs; HTTP/1.0 allows one, and that is the guard's to refuse.
      const none = await rawRequest(base, { path: '/' });
      expect(none.status).toBe(400);
      const http10 = await new Promise<string>((resolve, reject) => {
        const sock = connect(port(), '127.0.0.1', () => sock.end('GET / HTTP/1.0\r\n\r\n'));
        let out = '';
        sock.on('data', (c: Buffer) => (out += c.toString('utf8')));
        sock.on('end', () => resolve(out));
        sock.on('error', reject);
      });
      expect(http10).toMatch(/^HTTP\/1\.[01] 403 /);
    });

    it('accepts localhost and 127.0.0.1 on the bound port', async () => {
      for (const host of [`localhost:${port()}`, `127.0.0.1:${port()}`, `LOCALHOST:${port()}`]) {
        const r = await rawRequest(base, { path: '/', headers: { host } });
        expect(r.status, host).toBe(200);
      }
    });

    it('refuses a cross-origin POST, including Origin: null, and stores nothing', async () => {
      const before = store.list('demo', { includeResolved: true }).length;
      const body = JSON.stringify({ page: 1, x: 1, y: 1, note: 'csrf' });
      for (const origin of [
        'http://evil.example',
        'null',
        `http://evil.example:${port()}`,
        `https://localhost:${port()}`,
        `http://localhost.:${port()}`,
        `http://user@localhost:${port()}`,
        // Another LOCAL page — a dev server or notebook on another port — is still another origin.
        `http://localhost:${port()}`,
        `http://127.0.0.1:${port() + 1}`,
        'http://localhost',
        `http://[::1]:${port()}`,
      ]) {
        const r = await rawRequest(base, {
          method: 'POST',
          path: '/p/demo/comments',
          headers: { host: `127.0.0.1:${port()}`, origin, 'content-type': 'application/json' },
          body,
        });
        expect(r.status, origin).toBe(403);
      }
      expect(store.list('demo', { includeResolved: true })).toHaveLength(before);
    });

    // Same origin means the Origin the browser wrote for this very Host — including a forwarded
    // port, where both headers carry the forwarded host:port.
    it('accepts a same-origin POST (forwarded ports included), and one with no Origin', async () => {
      const body = JSON.stringify({ page: 1, x: 1, y: 1, note: 'same origin' });
      const variants: Array<{ host: string; origin?: string }> = [
        { host: `127.0.0.1:${port()}`, origin: `http://127.0.0.1:${port()}` },
        { host: `localhost:${port()}`, origin: `http://localhost:${port()}` },
        { host: `localhost:${port() + 1}`, origin: `http://localhost:${port() + 1}` },
        { host: `LOCALHOST:${port()}`, origin: `http://localhost:${port()}` },
        { host: `[::1]:${port() + 2}`, origin: `http://[::1]:${port() + 2}` },
        { host: `127.0.0.1:${port()}` },
      ];
      for (const { host, origin } of variants) {
        const r = await rawRequest(base, {
          method: 'POST',
          path: '/p/demo/comments',
          headers: {
            host,
            'content-type': 'application/json',
            ...(origin === undefined ? {} : { origin }),
          },
          body,
        });
        expect(r.status, `${host} ${origin ?? '(no origin)'}`).toBe(201);
      }
    });
  });
});

describe('ViewerService document view', () => {
  const REVIEW = '# Title\n\nFirst line of para\nsecond line of para\n';
  let docs: Record<string, string> = {};
  let store = new CommentStore();
  let viewer: ViewerService;
  let base: string;
  let calls: string[] = [];

  const deps = (withDocs: boolean): ViewerDeps => ({
    knownIds: () => ['demo'],
    locatePdf: async () => ({ pdf: null, root: null }),
    addComment: async (id, input) => store.add(id, { ...input, file: 'main.tex', line: 1 }),
    listComments: (id, document) => store.list(id, { document }),
    updateComment: (id, cid, note) => store.update(id, cid, { note }),
    deleteComment: (id, cid) => store.remove(id, cid),
    undoDelete: (id, document) => store.undo(id, document),
    resolveComments: (id, ids, document) => store.resolve(id, ids, document),
    ...(withDocs
      ? {
          readDocument: async (_id: string, relPath: string) => {
            calls.push(relPath);
            const text = Object.hasOwn(docs, relPath) ? docs[relPath] : undefined;
            if (text === undefined) throw new Error(`No such document: ${JSON.stringify(relPath)}`);
            return { path: relPath, text };
          },
          addDocComment: (id: string, input: NewComment) => store.add(id, input),
        }
      : {}),
  });

  beforeAll(async () => {
    viewer = new ViewerService(deps(true));
    const url = await viewer.start(0);
    expect(url).toBeDefined();
    base = url!;
  });

  afterAll(async () => {
    await viewer.close();
  });

  // Each test gets a fresh store and document set, so numbering is checked from #1.
  const reset = () => {
    store = new CommentStore();
    docs = { 'review.md': REVIEW, 'a</script>.md': '# Odd name\n' };
    calls = [];
  };

  const q = (p: string) => `?path=${encodeURIComponent(p)}`;

  async function postDoc(body: unknown, docPath = 'review.md') {
    return fetch(`${base}/p/demo/doc/comments${q(docPath)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async function postPdf(note: string): Promise<{ id: string; number: number }> {
    const r = await fetch(`${base}/p/demo/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ page: 1, x: 1, y: 1, note }),
    });
    return (await r.json()) as { id: string; number: number };
  }

  function pageScript(html: string): { nonce: string; body: string } {
    const m = /<script nonce="([^"]+)">([\s\S]*?)<\/script>/.exec(html);
    expect(m).toBeTruthy();
    return { nonce: m![1]!, body: m![2]! };
  }

  it('serves the document page with a nonce CSP whose nonce is the script one', async () => {
    reset();
    const r = await fetch(`${base}/p/demo/doc${q('review.md')}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/html/);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const csp = r.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("img-src 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("base-uri 'none'");
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    const html = await r.text();
    const script = pageScript(html);
    expect(script.nonce).toBe(nonce);
    // Compiled, not run: a SyntaxError here blanks the whole page.
    expect(() => new Function(script.body)).not.toThrow();
    expect(html).toContain('review.md');
    // A fresh nonce per response.
    const again = await fetch(`${base}/p/demo/doc${q('review.md')}`);
    expect(again.headers.get('content-security-policy')).not.toBe(csp);
  });

  it('validates the path before reading anything', async () => {
    reset();
    for (const p of ['/p/demo/doc', `/p/demo/doc${q('')}`, `/p/demo/doc/render${q('notes.tex')}`]) {
      expect((await fetch(`${base}${p}`)).status, p).toBe(400);
    }
    const dot = await fetch(`${base}/p/demo/doc/render${q('.md')}`);
    expect(dot.status).toBe(400);
    expect(((await dot.json()) as { error: string }).error).toContain('".md"');
    const long = 'a'.repeat(1025 - 3) + '.md';
    expect(long).toHaveLength(1025);
    expect((await fetch(`${base}/p/demo/doc/render${q(long)}`)).status).toBe(400);
    expect(calls).toEqual([]);
    // Exactly at the cap it reaches readDocument (whose fake 404s it).
    const max = 'a'.repeat(1024 - 3) + '.md';
    expect((await fetch(`${base}/p/demo/doc/render${q(max)}`)).status).toBe(404);
    expect(calls).toEqual([max]);
  });

  it('escapes invisible characters when it names a refused path', async () => {
    reset();
    const r = await fetch(`${base}/p/demo/doc/render${q('x\u202e.tex')}`);
    expect(r.status).toBe(400);
    const { error } = (await r.json()) as { error: string };
    expect(error).toContain('\\u{202E}');
    expect(error).not.toContain('\u202e');
  });

  it("404s an unknown document with readDocument's message", async () => {
    reset();
    const r = await fetch(`${base}/p/demo/doc/render${q('missing.md')}`);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'No such document: "missing.md"' });
    const page = await fetch(`${base}/p/demo/doc${q('missing.md')}`);
    expect(page.status).toBe(404);
    expect(page.headers.get('content-type')).toMatch(/text\/html/);
    expect(await page.text()).toContain('No such document: &quot;missing.md&quot;');
  });

  it('404s every document route when document viewing is not wired', async () => {
    reset();
    const other = new ViewerService(deps(false));
    const url = await other.start(0);
    try {
      const r = await fetch(`${url!}/p/demo/doc/render${q('review.md')}`);
      expect(r.status).toBe(404);
      expect(((await r.json()) as { error: string }).error).toBe(
        'Document viewing is not available.',
      );
      expect((await fetch(`${url!}/p/demo/doc${q('review.md')}`)).status).toBe(404);
    } finally {
      await other.close();
    }
  });

  it("scopes the document page's Ask Claude prompt to that document, JSON-quoted", async () => {
    reset();
    const html = await (await fetch(`${base}/p/demo/doc${q('review.md')}`)).text();
    const script = pageScript(html).body;
    expect(script).toContain('call list_comments with document ');
    expect(script).toContain('JSON.stringify(DOC)');
    expect(script).toContain('JSON.stringify(ID)');
    expect(script).toContain('call resolve_comments with the ids you handled.');
    // The name is never put between hand-written quotes.
    expect(script).not.toMatch(/'"' \+ (DOC|ID)/);
  });

  it('refuses a drive-qualified or absolute document path before reading it', async () => {
    reset();
    for (const p of [
      'C:notes.md',
      'c:/x/notes.md',
      '/abs/a.md',
      '\\\\server\\share\\a.md',
      '\\a.md',
    ]) {
      const r = await fetch(`${base}/p/demo/doc/render${q(p)}`);
      expect(r.status, p).toBe(400);
      expect(((await r.json()) as { error: string }).error, p).toContain(
        'Not a project-relative path',
      );
      await expect(viewer.checkDocument('demo', p), p).rejects.toThrow(
        'Not a project-relative path',
      );
    }
    expect(calls).toEqual([]);
    docs['notes.md'] = '# n\n';
    expect((await fetch(`${base}/p/demo/doc/render${q('notes.md')}`)).status).toBe(200);
    await expect(viewer.checkDocument('demo', 'notes.md')).resolves.toBe('notes.md');
  });

  it('keeps a </script> in the path out of the page script', async () => {
    reset();
    const r = await fetch(`${base}/p/demo/doc${q('a</script>.md')}`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    const script = pageScript(html);
    expect(script.body).toContain('\\u003c/script\\u003e.md');
    expect(() => new Function(script.body)).not.toThrow();
  });

  it('renders the document with source ranges, and versions it by content', async () => {
    reset();
    const r = await fetch(`${base}/p/demo/doc/render${q('review.md')}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const { html, version } = (await r.json()) as { html: string; version: string };
    expect(html).toContain('data-src="3-4"');
    expect(version).toMatch(/^[0-9a-f]{40}$/);
    const v1 = await (await fetch(`${base}/p/demo/doc/version${q('review.md')}`)).text();
    expect(v1).toBe(version);
    docs['review.md'] = REVIEW + '\nmore\n';
    const v2 = await (await fetch(`${base}/p/demo/doc/version${q('review.md')}`)).text();
    expect(v2).not.toBe(v1);
    expect((await fetch(`${base}/p/demo/doc/version${q('missing.md')}`)).status).toBe(404);
  });

  it('stores a document comment at the line the server resolves', async () => {
    reset();
    const r = await postDoc({ note: 'fix', quote: 'second line', blockStart: 3, blockEnd: 4 });
    expect(r.status).toBe(201);
    const c = (await r.json()) as Record<string, unknown>;
    expect(c).toMatchObject({ document: 'review.md', file: 'review.md', line: 4, note: 'fix' });
    expect(c.page).toBeUndefined();
  });

  it('never stores a client line: out-of-file blocks clamp, a line field is ignored', async () => {
    reset();
    const far = (await (
      await postDoc({ note: 'far', quote: 'nowhere', blockStart: 999, blockEnd: 1000 })
    ).json()) as { line: number };
    expect(far.line).toBeGreaterThanOrEqual(1);
    expect(far.line).toBeLessThanOrEqual(4);
    const lied = (await (
      await postDoc({ note: 'x', quote: 'second line', blockStart: 3, blockEnd: 4, line: 1 })
    ).json()) as { line: number };
    expect(lied.line).toBe(4);
  });

  it('rejects an empty or missing note', async () => {
    reset();
    expect((await postDoc({ note: '' })).status).toBe(400);
    expect((await postDoc({ note: '   ' })).status).toBe(400);
    expect((await postDoc({ quote: 'x' })).status).toBe(400);
    expect(store.list('demo')).toHaveLength(0);
  });

  it('keeps the PDF surface and each document apart, numbering each from #1', async () => {
    reset();
    const docRes = await postDoc({ note: 'doc note', blockStart: 1 });
    const doc = (await docRes.json()) as { id: string; number: number };
    expect(doc.number).toBe(1);
    const pdfC = await postPdf('pdf note');
    expect(pdfC.number).toBe(1);
    const pdfList = (await (await fetch(`${base}/p/demo/comments`)).json()) as { id: string }[];
    expect(pdfList.map((c) => c.id)).toEqual([pdfC.id]);
    const docListRes = await fetch(`${base}/p/demo/doc/comments${q('review.md')}`);
    const docList = (await docListRes.json()) as { id: string }[];
    expect(docList.map((c) => c.id)).toEqual([doc.id]);
    // Resolving "all" from the PDF page leaves the document's comment open.
    await fetch(`${base}/p/demo/comments/resolve`, { method: 'POST' });
    expect(store.list('demo', { document: 'review.md' })).toHaveLength(1);
    expect(store.list('demo', { document: null })).toHaveLength(0);
  });

  it('undoes only the surface it is asked on', async () => {
    reset();
    const doc = (await (await postDoc({ note: 'doc', blockStart: 1 })).json()) as { id: string };
    const pdfC = await postPdf('pdf');
    // The PDF comment deleted first, the document's last: each undo still restores its own.
    await fetch(`${base}/p/demo/comments/${pdfC.id}/delete`, { method: 'POST' });
    await fetch(`${base}/p/demo/comments/${doc.id}/delete`, { method: 'POST' });
    const pdfUndo = await fetch(`${base}/p/demo/comments/undo`, { method: 'POST' });
    expect(((await pdfUndo.json()) as { restored: { id: string } | null }).restored?.id).toBe(
      pdfC.id,
    );
    const docUndoUrl = `${base}/p/demo/doc/comments/undo${q('review.md')}`;
    const docUndo = await fetch(docUndoUrl, { method: 'POST' });
    expect(((await docUndo.json()) as { restored: { id: string } | null }).restored?.id).toBe(
      doc.id,
    );
    const none = await fetch(docUndoUrl, { method: 'POST' });
    expect(((await none.json()) as { restored: unknown }).restored).toBeNull();
  });

  it('urlForDocument composes and encodes the path', () => {
    expect(viewer.urlForDocument('demo', 'notes/a b&c.md')).toBe(
      `${base}/p/demo/doc?path=notes%2Fa%20b%26c.md`,
    );
    expect(new ViewerService(deps(true)).urlForDocument('demo', 'x.md')).toBeUndefined();
  });
});
