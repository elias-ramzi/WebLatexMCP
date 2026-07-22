import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

/**
 * A lazily-started localhost web server that shows a project's compiled PDF in the browser and
 * hot-reloads it on every compile. Aimed at Claude Desktop, which has no PDF surface: instead of
 * squeezing rasterized page images through the tool-result channel (size-capped, and not reliably
 * rendered in the transcript), the `viewer` tool hands back a `http://127.0.0.1:<port>/p/<id>` URL
 * the user opens once.
 *
 * The page is a small viewer built on pdf.js's virtualized `PDFViewer` component (the engine
 * Firefox ships): it renders only visible pages, and polls a version endpoint so that when
 * `compile` writes a fresh PDF it reloads the document **in place, preserving the current page and
 * scroll position** — a plain `<embed>` can't do that (no scroll/page API). pdf.js's own assets
 * are served from the bundled `pdfjs-dist` package under `/pdfjs/`.
 *
 * Bound to loopback only — the PDF never leaves the machine. Started on demand from the tool (not
 * at boot), so no listener exists until the user asks for the viewer.
 */

export interface ViewerDeps {
  /** Known project ids, for routing/validation (configured + runtime-registered). */
  knownIds(): string[];
  /** Absolute path to a project's current PDF, or null when nothing is compiled yet. */
  resolvePdfPath(id: string): Promise<string | null>;
}

/** Root of the installed `pdfjs-dist` package, whose `build/`, `web/`, `cmaps/`… we serve. */
const PDFJS_ROOT = path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));

const NOT_FOUND = 'Not found.\n';

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

function contentType(file: string): string {
  switch (path.extname(file).toLowerCase()) {
    case '.mjs':
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.wasm':
      return 'application/wasm';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.png':
      return 'image/png';
    case '.gif':
      return 'image/gif';
    case '.svg':
      return 'image/svg+xml';
    case '.otf':
      return 'font/otf';
    case '.ttf':
      return 'font/ttf';
    default:
      // .bcmap, .pfb, .icc, and anything else pdf.js fetches as bytes.
      return 'application/octet-stream';
  }
}

/** The viewer page: pdf.js `PDFViewer` + a poll loop that hot-reloads while preserving position. */
function viewerHtml(id: string): string {
  const jid = JSON.stringify(id);
  const safe = escapeHtml(id);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safe} — web-latex-mcp</title>
<link rel="stylesheet" href="/pdfjs/web/pdf_viewer.css">
<style>
  :root { color-scheme: light dark; }
  html, body { margin: 0; height: 100%; background: #525659; }
  #bar { position: absolute; top: 0; left: 0; right: 0; height: 22px; z-index: 5;
    font: 13px/1.4 -apple-system, system-ui, sans-serif; color: #ddd; background: #111;
    padding: 6px 12px; display: flex; gap: 10px; align-items: center; }
  #bar b { color: #fff; } #msg { color: #9aa; }
  #dot { width: 8px; height: 8px; border-radius: 50%; background: #3fb950; transition: background .3s; }
  #tools { margin-left: auto; display: flex; gap: 6px; align-items: center; }
  #bar button { font: 13px system-ui, sans-serif; color: #ddd; background: #2a2a2a; border: 1px solid #444;
    border-radius: 4px; padding: 0 8px; height: 20px; cursor: pointer; line-height: 18px; }
  #bar button:hover { background: #3a3a3a; }
  #zlvl { color: #9aa; min-width: 40px; text-align: center; font-variant-numeric: tabular-nums; cursor: default; }
  #viewerContainer { position: absolute; inset: 34px 0 0 0; overflow: auto; }
  #empty { position: absolute; inset: 34px 0 0 0; color: #ddd; font: 14px/1.5 system-ui, sans-serif;
    padding: 24px; display: none; }
  #empty[data-show] { display: block; }
  code { color: #fff; }
</style></head>
<body>
<div id="bar"><span id="dot"></span><b>${safe}</b><span id="msg">live — reloads on compile</span>
  <span id="tools">
    <button id="zout" title="Zoom out (⌘/Ctrl -)">&minus;</button>
    <span id="zlvl">—</span>
    <button id="zin" title="Zoom in (⌘/Ctrl +)">+</button>
    <button id="fit" title="Fit width (⌘/Ctrl 0)">fit</button>
  </span>
</div>
<div id="viewerContainer"><div id="viewer" class="pdfViewer"></div></div>
<div id="empty">No compiled PDF yet. Run <code>compile</code> in Claude — this updates automatically.</div>
<script type="module">
import * as pdfjsLib from '/pdfjs/build/pdf.mjs';
import * as pdfjsViewer from '/pdfjs/web/pdf_viewer.mjs';
globalThis.pdfjsLib = pdfjsLib;
globalThis.pdfjsViewer = pdfjsViewer;
pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdfjs/build/pdf.worker.mjs';

const ID = ${jid};
const container = document.getElementById('viewerContainer');
const empty = document.getElementById('empty');
const dot = document.getElementById('dot');
const msg = document.getElementById('msg');

const eventBus = new pdfjsViewer.EventBus();
const linkService = new pdfjsViewer.PDFLinkService({ eventBus });
const pdfViewer = new pdfjsViewer.PDFViewer({
  container, viewer: document.getElementById('viewer'), eventBus, linkService,
});
linkService.setViewer(pdfViewer);

// 'auto' is pdf.js's own default: fits width but caps the zoom (~1.25x max) so wide windows
// don't blow the page up the way 'page-width' does. A user's own zoom is preserved via restore.
let restore = null;
eventBus.on('pagesinit', () => {
  pdfViewer.currentScaleValue = restore?.scale ?? 'auto';
  if (restore) {
    const top = restore.scrollTop;
    // Re-apply after the scale relayout settles so the pixel offset lands on the same spot.
    requestAnimationFrame(() => requestAnimationFrame(() => { container.scrollTop = top; }));
    restore = null;
  }
  refreshZoom();
});

let cur = null;
function setDot(c) { dot.style.background = c; }
function flash(t) { msg.textContent = t; setTimeout(() => { msg.textContent = 'live — reloads on compile'; }, 1500); }

// Zoom controls (the PDFViewer component has no toolbar of its own). Manual currentScale
// arithmetic so it works regardless of pdf.js version; clamps well below the default so you can
// zoom out further than 'auto' allows.
const ZOOM_STEP = 1.1, ZOOM_MIN = 0.1, ZOOM_MAX = 10;
const zlvl = document.getElementById('zlvl');
function refreshZoom() { zlvl.textContent = Math.round(pdfViewer.currentScale * 100) + '%'; }
function zoomBy(factor) {
  pdfViewer.currentScale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, pdfViewer.currentScale * factor));
}
eventBus.on('scalechanging', refreshZoom);
document.getElementById('zin').onclick = () => zoomBy(ZOOM_STEP);
document.getElementById('zout').onclick = () => zoomBy(1 / ZOOM_STEP);
document.getElementById('fit').onclick = () => { pdfViewer.currentScaleValue = 'auto'; };
container.addEventListener('wheel', (e) => {
  if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomBy(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP); }
}, { passive: false });
window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  if (e.key === '=' || e.key === '+') { e.preventDefault(); zoomBy(ZOOM_STEP); }
  else if (e.key === '-') { e.preventDefault(); zoomBy(1 / ZOOM_STEP); }
  else if (e.key === '0') { e.preventDefault(); pdfViewer.currentScaleValue = 'auto'; }
});

async function load(v) {
  const url = '/p/' + encodeURIComponent(ID) + '/pdf?v=' + encodeURIComponent(v);
  const doc = await pdfjsLib.getDocument({
    url,
    cMapUrl: '/pdfjs/cmaps/', cMapPacked: true,
    standardFontDataUrl: '/pdfjs/standard_fonts/',
    wasmUrl: '/pdfjs/wasm/',
  }).promise;
  pdfViewer.setDocument(doc);
  linkService.setDocument(doc, null);
}

async function tick() {
  try {
    const r = await fetch('/p/' + encodeURIComponent(ID) + '/version', { cache: 'no-store' });
    if (r.ok) {
      const v = await r.text();
      if (v !== cur) {
        if (cur !== null) {
          restore = { page: pdfViewer.currentPageNumber, scale: pdfViewer.currentScaleValue, scrollTop: container.scrollTop };
        }
        cur = v;
        empty.removeAttribute('data-show');
        await load(v);
        if (restore) flash('updated');
      }
      setDot('#3fb950');
    } else {
      cur = null;
      empty.setAttribute('data-show', '');
      setDot('#d29922');
    }
  } catch { setDot('#f85149'); }
  setTimeout(tick, 1500);
}
tick();
</script>
</body></html>`;
}

export class ViewerService {
  private server?: http.Server;
  private baseUrl?: string;

  constructor(private readonly deps: ViewerDeps) {}

  isRunning(): boolean {
    return this.baseUrl !== undefined;
  }

  /** `http://127.0.0.1:<port>/p/<id>` for a project, or undefined if the server isn't running. */
  urlFor(id: string): string | undefined {
    return this.baseUrl ? `${this.baseUrl}/p/${encodeURIComponent(id)}` : undefined;
  }

  /**
   * Start listening (idempotent — a second call returns the existing URL). Binds to loopback.
   * Resolves to the base URL, or undefined if the port could not be bound (viewer stays off, the
   * MCP server is unaffected).
   */
  async start(port = 0, host = '127.0.0.1'): Promise<string | undefined> {
    if (this.baseUrl) return this.baseUrl;
    const server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    return new Promise((resolve) => {
      const onError = (err: NodeJS.ErrnoException): void => {
        server.removeListener('error', onError);
        console.error(`[web-latex-mcp] PDF viewer could not start: ${err.message}`);
        resolve(undefined);
      };
      server.once('error', onError);
      server.listen(port, host, () => {
        server.removeListener('error', onError);
        const addr = server.address() as AddressInfo;
        this.server = server;
        this.baseUrl = `http://${host}:${addr.port}`;
        resolve(this.baseUrl);
      });
    });
  }

  async close(): Promise<void> {
    const server = this.server;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    this.server = undefined;
    this.baseUrl = undefined;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' }).end();
        return;
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);

      // /                    -> index of known projects
      if (parts.length === 0) {
        this.sendHtml(res, this.indexHtml());
        return;
      }
      // /pdfjs/**            -> static pdf.js assets from the bundled package
      if (parts[0] === 'pdfjs' && parts.length > 1) {
        await this.sendStatic(res, parts.slice(1));
        return;
      }
      // /p/<id>[/pdf|/version]
      if (parts[0] === 'p' && parts[1] !== undefined) {
        const id = decodeURIComponent(parts[1]);
        if (!this.deps.knownIds().includes(id)) {
          res.writeHead(404, { 'Content-Type': 'text/plain' }).end(NOT_FOUND);
          return;
        }
        if (parts.length === 2) {
          this.sendHtml(res, viewerHtml(id));
          return;
        }
        if (parts.length === 3 && parts[2] === 'pdf') {
          await this.sendPdf(res, id);
          return;
        }
        if (parts.length === 3 && parts[2] === 'version') {
          await this.sendVersion(res, id);
          return;
        }
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end(NOT_FOUND);
    } catch (err) {
      res
        .writeHead(500, { 'Content-Type': 'text/plain' })
        .end(`viewer error: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  private sendHtml(res: http.ServerResponse, html: string): void {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  }

  private indexHtml(): string {
    const items = this.deps
      .knownIds()
      .map((id) => `<li><a href="/p/${encodeURIComponent(id)}">${escapeHtml(id)}</a></li>`)
      .join('');
    return `<!doctype html><meta charset="utf-8"><title>web-latex-mcp</title>
<body style="font:14px system-ui,sans-serif;max-width:40em;margin:3em auto">
<h1>web-latex-mcp — PDF viewer</h1>
<ul>${items || '<li>No projects.</li>'}</ul></body>`;
  }

  /** Serve a file from under the bundled `pdfjs-dist` package; guards against path traversal. */
  private async sendStatic(res: http.ServerResponse, relParts: string[]): Promise<void> {
    const rel = relParts.map((p) => decodeURIComponent(p)).join('/');
    const resolved = path.resolve(PDFJS_ROOT, rel);
    if (resolved !== PDFJS_ROOT && !resolved.startsWith(PDFJS_ROOT + path.sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Forbidden.\n');
      return;
    }
    let st;
    try {
      st = await stat(resolved);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end(NOT_FOUND);
      return;
    }
    if (!st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end(NOT_FOUND);
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentType(resolved),
      'Content-Length': st.size,
      'Cache-Control': 'no-store',
    });
    if (res.req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(resolved).pipe(res);
  }

  private async sendPdf(res: http.ServerResponse, id: string): Promise<void> {
    const pdf = await this.deps.resolvePdfPath(id);
    if (!pdf) {
      res
        .writeHead(404, { 'Content-Type': 'text/plain' })
        .end('No compiled PDF yet — run compile.\n');
      return;
    }
    const st = await stat(pdf);
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': st.size,
      'Cache-Control': 'no-store',
    });
    if (res.req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(pdf).pipe(res);
  }

  private async sendVersion(res: http.ServerResponse, id: string): Promise<void> {
    const pdf = await this.deps.resolvePdfPath(id);
    if (!pdf) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end();
      return;
    }
    const st = await stat(pdf);
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    res.end(String(st.mtimeMs));
  }
}
