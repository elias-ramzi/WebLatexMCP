import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { Comment, NewComment } from './commentStore.js';

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

/** A comment POSTed from the viewer: a text selection + note at a PDF point (top-left points). */
export interface CommentInput {
  page: number;
  x: number;
  y: number;
  quote?: string;
  note: string;
}

export interface ViewerDeps {
  /** Known project ids, for routing/validation (configured + runtime-registered). */
  knownIds(): string[];
  /** Absolute path to a project's current PDF, or null when nothing is compiled yet. */
  resolvePdfPath(id: string): Promise<string | null>;
  /** Store a viewer comment (resolving its source location via synctex); returns the stored comment. */
  addComment(id: string, input: NewComment): Promise<Comment>;
  /** Open comments for a project (for the viewer to render markers). */
  listComments(id: string): Comment[];
  /** Edit a comment's note; returns the updated comment or null if not found. */
  updateComment(id: string, commentId: string, note: string): Comment | null;
  /** Delete a single comment; returns whether it existed. */
  deleteComment(id: string, commentId: string): boolean;
  /** Restore the most recently deleted comment; null if there is nothing to undo. */
  undoDelete(id: string): Comment | null;
  /** Mark comments resolved (all open ones when `ids` omitted); returns the count. */
  resolveComments(id: string, ids?: string[]): number;
}

/** Cap on a comment POST body so a bad client can't stream unbounded data into the server. */
const MAX_BODY_BYTES = 256 * 1024;

/** Keep only well-formed `[x1,y1,x2,y2]` finite-number rects (bounded), else undefined. */
function sanitizeRects(raw: unknown): number[][] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const rects = raw
    .filter(
      (r): r is number[] =>
        Array.isArray(r) &&
        r.length === 4 &&
        r.every((n) => typeof n === 'number' && Number.isFinite(n)),
    )
    .slice(0, 500);
  return rects.length ? rects : undefined;
}

/** Root of the installed `pdfjs-dist` package, whose `build/`, `web/`, `cmaps/`… we serve. */
const PDFJS_ROOT = path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));

const NOT_FOUND = 'Not found.\n';

/** Read a request body (bounded) and JSON-parse it; resolves null on overflow or invalid JSON. */
function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on('data', (c: Buffer) => {
      if (aborted) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

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
  #ctoggle.on { background: #2d4a7a; border-color: #3a5f9a; }
  .wlm-fab { position: fixed; z-index: 20; display: none; font: 12px system-ui, sans-serif;
    background: #2d4a7a; color: #fff; border: 1px solid #3a5f9a; border-radius: 6px;
    padding: 4px 9px; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.4); }
  .wlm-pop { position: fixed; z-index: 21; display: none; width: 264px; background: #1e1e1e;
    border: 1px solid #444; border-radius: 8px; padding: 10px; box-shadow: 0 4px 16px rgba(0,0,0,.5);
    font: 13px system-ui, sans-serif; color: #ddd; }
  .wlm-pop .q { color: #9aa; font-size: 11px; margin-bottom: 6px; max-height: 44px; overflow: auto;
    border-left: 2px solid #3a5f9a; padding-left: 6px; }
  .wlm-pop textarea { width: 100%; box-sizing: border-box; height: 64px; resize: vertical;
    background: #111; color: #eee; border: 1px solid #444; border-radius: 4px; padding: 6px;
    font: 13px system-ui, sans-serif; }
  .wlm-pop .row { display: flex; justify-content: flex-end; gap: 6px; margin-top: 8px; }
  .wlm-panel { position: absolute; top: 34px; right: 0; bottom: 0; width: 280px; z-index: 15;
    background: #181818; border-left: 1px solid #333; overflow: auto; display: none;
    font: 13px/1.4 system-ui, sans-serif; color: #ddd; }
  .wlm-panel.open { display: block; }
  .wlm-phead { position: sticky; top: 0; background: #181818; display: flex; align-items: center;
    justify-content: space-between; gap: 8px; padding: 9px 12px; border-bottom: 1px solid #262626;
    font: 600 12px system-ui, sans-serif; color: #9aa; text-transform: uppercase; letter-spacing: .04em; }
  .wlm-phbtns { display: flex; gap: 6px; }
  .wlm-phbtns button { font: 11px system-ui, sans-serif; text-transform: none; letter-spacing: 0;
    border-radius: 5px; padding: 3px 8px; cursor: pointer; white-space: nowrap; }
  #askclaude { color: #fff; background: #2d4a7a; border: 1px solid #3a5f9a; }
  #askclaude:hover { background: #345489; }
  #undodel { color: #ddd; background: #2a2a2a; border: 1px solid #444; }
  #undodel:hover { background: #333; }
  .wlm-hint { padding: 10px 12px; color: #777; font-size: 12px; }
  .wlm-item { padding: 8px 12px; border-top: 1px solid #262626; }
  .wlm-item:hover { background: #202020; }
  .wlm-itop { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
  .wlm-item .loc { color: #6ea8fe; font: 11px ui-monospace, SFMono-Regular, monospace;
    cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wlm-item .note { margin-top: 2px; cursor: pointer; white-space: pre-wrap; }
  .wlm-acts { display: flex; gap: 4px; opacity: 0; transition: opacity .1s; flex: none; }
  .wlm-item:hover .wlm-acts { opacity: 1; }
  .wlm-acts button { background: #262626; color: #ccc; border: 1px solid #3a3a3a; border-radius: 4px;
    font-size: 11px; padding: 1px 6px; cursor: pointer; line-height: 16px; }
  .wlm-acts button:hover { background: #333; }
  .wlm-acts .wlm-del:hover { background: #5a2020; border-color: #7a3030; color: #fff; }
  .wlm-edit textarea { width: 100%; box-sizing: border-box; height: 52px; resize: vertical; margin-top: 4px;
    background: #111; color: #eee; border: 1px solid #444; border-radius: 4px; padding: 5px;
    font: 12px system-ui, sans-serif; }
  .wlm-edit .row { display: flex; justify-content: flex-end; gap: 6px; margin-top: 4px; }
  .wlm-edit .row button { font: 11px system-ui, sans-serif; padding: 2px 8px; border-radius: 4px;
    cursor: pointer; background: #2a2a2a; color: #ddd; border: 1px solid #444; }
  .wlm-hl-layer { position: absolute; left: 0; top: 0; right: 0; bottom: 0; pointer-events: none; z-index: 2; }
  .wlm-hl { position: absolute; background: rgba(255, 213, 0, 0.35); border-radius: 2px;
    mix-blend-mode: multiply; transition: background .1s; }
  .wlm-hl.hot { background: rgba(255, 145, 0, 0.6); }
  .wlm-num { color: #e0863a; font-weight: 600; }
</style></head>
<body>
<div id="bar"><span id="dot"></span><b>${safe}</b><span id="msg">live — reloads on compile</span>
  <span id="tools">
    <button id="ctoggle" title="Comments — select PDF text to add one">💬 <span id="ccount">0</span></button>
    <button id="zout" title="Zoom out (⌘/Ctrl -)">&minus;</button>
    <span id="zlvl">—</span>
    <button id="zin" title="Zoom in (⌘/Ctrl +)">+</button>
    <button id="fit" title="Fit width (⌘/Ctrl 0)">fit</button>
  </span>
</div>
<div id="viewerContainer"><div id="viewer" class="pdfViewer"></div></div>
<div id="empty">No compiled PDF yet. Run <code>compile</code> in Claude — this updates automatically.</div>
<button class="wlm-fab" id="fab">💬 Comment</button>
<div class="wlm-pop" id="pop">
  <div class="q" id="popq"></div>
  <textarea id="popnote" placeholder="Describe the change you want…"></textarea>
  <div class="row"><button id="popcancel">Cancel</button><button id="popsave">Save</button></div>
</div>
<div class="wlm-panel" id="panel">
  <div class="wlm-phead"><span>Comments</span><span class="wlm-phbtns"><button id="undodel" title="Restore the last deleted comment">↶ Undo</button><button id="askclaude" title="Copy a prompt to paste into the Claude chat">📋 Ask Claude</button></span></div>
  <div id="panellist"></div>
</div>
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

// --- Comments: select PDF text -> attach a note -> POST it; SyncTeX maps it to source. ---
const fab = document.getElementById('fab');
const pop = document.getElementById('pop');
const popq = document.getElementById('popq');
const popnote = document.getElementById('popnote');
const ctoggle = document.getElementById('ctoggle');
const ccount = document.getElementById('ccount');
const panel = document.getElementById('panel');
const panellist = document.getElementById('panellist');
let pending = null;

// The selection's start point, converted to PDF points from the page's top-left (synctex space).
function selectionAnchor() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const quote = sel.toString().trim();
  if (!quote) return null;
  const range = sel.getRangeAt(0);
  const rects = range.getClientRects();
  if (!rects.length) return null;
  const r = rects[0];
  let node = range.startContainer;
  if (node.nodeType === 3) node = node.parentElement;
  const pageEl = node && node.closest ? node.closest('.page') : null;
  if (!pageEl || !pageEl.dataset.pageNumber) return null;
  const page = Number(pageEl.dataset.pageNumber);
  const view = pdfViewer.getPageView(page - 1);
  if (!view || !view.viewport) return null;
  const vp = view.viewport;
  const pr = pageEl.getBoundingClientRect();
  // The page has a border (--page-border), so its content origin is inset by the border width;
  // measure offsets from the content box (clientLeft/Top = border widths) to match where the
  // highlight layer — an absolutely-positioned child — is anchored. Without this, highlights sit
  // a couple of px low.
  const bl = pageEl.clientLeft, bt = pageEl.clientTop;
  const px = (cx) => cx - pr.left - bl, py = (cy) => cy - pr.top - bt;
  const [pdfX, pdfY] = vp.convertToPdfPoint(px(r.left), py(r.top));
  // Capture every selection rect on this page (in PDF coords) for a persistent highlight. Uses
  // pdf.js's own convert fns both ways, so rendering later round-trips back to the same spot.
  const hlRects = [];
  for (const cr of range.getClientRects()) {
    if (cr.right < pr.left || cr.left > pr.right || cr.bottom < pr.top || cr.top > pr.bottom) continue;
    const [x1, y1] = vp.convertToPdfPoint(px(cr.left), py(cr.top));
    const [x2, y2] = vp.convertToPdfPoint(px(cr.right), py(cr.bottom));
    if ([x1, y1, x2, y2].every(Number.isFinite)) hlRects.push([x1, y1, x2, y2]);
  }
  return { page, x: pdfX - vp.viewBox[0], y: vp.viewBox[3] - pdfY, quote, cx: r.left, cy: r.top, rects: hlRects };
}

document.addEventListener('selectionchange', () => {
  if (pop.style.display === 'block') return;
  const a = selectionAnchor();
  if (a) {
    fab._anchor = a;
    fab.style.left = Math.min(window.innerWidth - 110, a.cx) + 'px';
    fab.style.top = Math.max(40, a.cy - 34) + 'px';
    fab.style.display = 'block';
  } else {
    fab.style.display = 'none';
  }
});

fab.addEventListener('mousedown', (e) => e.preventDefault()); // don't drop the selection
fab.addEventListener('click', () => {
  const a = fab._anchor;
  if (!a) return;
  pending = a;
  popq.textContent = a.quote.length > 180 ? a.quote.slice(0, 180) + '…' : a.quote;
  fab.style.display = 'none';
  pop.style.left = Math.min(window.innerWidth - 280, a.cx) + 'px';
  pop.style.top = Math.min(window.innerHeight - 170, a.cy + 8) + 'px';
  pop.style.display = 'block';
  popnote.value = '';
  popnote.focus();
});

document.getElementById('popcancel').onclick = () => { pop.style.display = 'none'; pending = null; };
document.getElementById('popsave').onclick = async () => {
  if (!pending) return;
  const note = popnote.value.trim();
  if (!note) { popnote.focus(); return; }
  pop.style.display = 'none';
  try {
    await fetch('/p/' + encodeURIComponent(ID) + '/comments', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ page: pending.page, x: pending.x, y: pending.y, quote: pending.quote, rects: pending.rects, note }),
    });
    flash('comment added');
    refreshComments();
  } catch { flash('comment failed'); }
  pending = null;
};

ctoggle.addEventListener('click', () => {
  const open = panel.classList.toggle('open');
  ctoggle.classList.toggle('on', open);
});

const undoBtn = document.getElementById('undodel');
undoBtn.addEventListener('click', async () => {
  try {
    const { restored } = await (await fetch(cbase() + '/undo', { method: 'POST' })).json();
    if (restored) refreshComments();
  } catch {}
});

// "Ask Claude" copies a ready-made prompt to the clipboard. A browser button can't drive the Claude
// Desktop chat (nor can the MCP server inject a turn), so the flow is: copy here, paste into chat.
async function copyText(t) {
  try {
    await navigator.clipboard.writeText(t);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy'); ta.remove();
      return ok;
    } catch { return false; }
  }
}
const askBtn = document.getElementById('askclaude');
askBtn.addEventListener('click', async () => {
  const label = askBtn.textContent;
  const n = Number(ccount.textContent) || 0;
  if (!n) { askBtn.textContent = 'No open comments'; setTimeout(() => { askBtn.textContent = label; }, 1400); return; }
  const prompt = 'Please address my ' + n + ' PDF review comment' + (n === 1 ? '' : 's') +
    ' on "' + ID + '": call list_comments, make each edit at its file:line (use the quoted text ' +
    'to pin the exact spot), recompile, then call resolve_comments.';
  const ok = await copyText(prompt);
  askBtn.textContent = ok ? '✓ Copied — paste in Claude' : 'Copy failed';
  setTimeout(() => { askBtn.textContent = label; }, 1800);
});

let editingId = null; // pause auto-refresh while a note is being edited, so it isn't wiped
let lastComments = [];
const cbase = () => '/p/' + encodeURIComponent(ID) + '/comments';

// Persistent highlights over commented regions. Rects are stored in PDF space, so they re-project
// correctly at any zoom; layers are children of each page div, so they scroll with the page.
function clearHighlights() {
  for (const l of document.querySelectorAll('.wlm-hl-layer')) l.remove();
}
function renderHighlights() {
  // Best-effort: never let a highlighting error break the panel or pdf.js event handlers.
  try {
    clearHighlights();
    for (const c of lastComments) {
      if (!c.rects || !c.rects.length) continue;
      const view = pdfViewer.getPageView(c.page - 1);
      if (!view || !view.viewport || !view.div) continue;
      const vp = view.viewport;
      const layer = document.createElement('div');
      layer.className = 'wlm-hl-layer';
      layer.dataset.cid = c.id;
      for (const r of c.rects) {
        // v6 has no rectangle converter — map the two corner points individually.
        const [ax, ay] = vp.convertToViewportPoint(r[0], r[1]);
        const [bx, by] = vp.convertToViewportPoint(r[2], r[3]);
        const left = Math.min(ax, bx), top = Math.min(ay, by);
        const w = Math.abs(bx - ax), h = Math.abs(by - ay);
        if (!(w > 0 && h > 0)) continue;
        const hl = document.createElement('div');
        hl.className = 'wlm-hl';
        hl.style.cssText = 'left:' + left + 'px;top:' + top + 'px;width:' + w + 'px;height:' + h + 'px';
        layer.appendChild(hl);
      }
      view.div.appendChild(layer);
    }
  } catch {
    /* highlights are cosmetic; ignore */
  }
}
eventBus.on('pagerendered', renderHighlights);
eventBus.on('scalechanging', () => requestAnimationFrame(renderHighlights));

async function refreshComments() {
  if (editingId) return;
  let list = [];
  try {
    list = await (await fetch(cbase(), { cache: 'no-store' })).json();
  } catch { return; }
  ccount.textContent = String(list.length);
  lastComments = list;
  // Build the panel first so nothing (e.g. a highlight error) can keep the list from rendering.
  panellist.innerHTML = '';
  if (!list.length) {
    const d = document.createElement('div');
    d.className = 'wlm-hint';
    d.textContent = 'No open comments. Select text in the PDF, then click “Comment”.';
    panellist.appendChild(d);
  } else {
    for (const c of list) panellist.appendChild(renderComment(c));
  }
  renderHighlights();
}

function setHot(cid, on) {
  for (const hl of document.querySelectorAll('.wlm-hl-layer[data-cid="' + cid + '"] .wlm-hl')) {
    hl.classList.toggle('hot', on);
  }
}

function renderComment(c) {
  const item = document.createElement('div');
  item.className = 'wlm-item';
  // Hovering a row emphasizes its highlight so you can spot where it is on the page.
  item.onmouseenter = () => setHot(c.id, true);
  item.onmouseleave = () => setHot(c.id, false);

  const top = document.createElement('div');
  top.className = 'wlm-itop';
  const loc = document.createElement('span');
  loc.className = 'loc';
  const num = document.createElement('span');
  num.className = 'wlm-num';
  num.textContent = '#' + c.number;
  loc.append(num, document.createTextNode(' ' + (c.file ? c.file + ':' + c.line : 'page ' + c.page)));
  loc.title = 'Jump to page ' + c.page;
  loc.onclick = () => { pdfViewer.currentPageNumber = c.page; };
  const acts = document.createElement('span');
  acts.className = 'wlm-acts';
  const editBtn = document.createElement('button');
  editBtn.textContent = '✎'; editBtn.title = 'Edit note';
  const delBtn = document.createElement('button');
  delBtn.className = 'wlm-del'; delBtn.textContent = '🗑'; delBtn.title = 'Delete comment';
  acts.append(editBtn, delBtn);
  top.append(loc, acts);

  const note = document.createElement('div');
  note.className = 'note';
  note.textContent = c.note;
  note.title = 'Jump to page ' + c.page;
  note.onclick = () => { pdfViewer.currentPageNumber = c.page; };

  item.append(top, note);

  editBtn.onclick = () => startEdit(item, c);
  delBtn.onclick = async () => {
    delBtn.disabled = true;
    try { await fetch(cbase() + '/' + encodeURIComponent(c.id) + '/delete', { method: 'POST' }); } catch {}
    refreshComments();
  };
  return item;
}

function startEdit(item, c) {
  editingId = c.id;
  item.querySelector('.wlm-acts').style.display = 'none';
  const note = item.querySelector('.note');
  const box = document.createElement('div');
  box.className = 'wlm-edit';
  const ta = document.createElement('textarea');
  ta.value = c.note;
  const row = document.createElement('div');
  row.className = 'row';
  const cancel = document.createElement('button');
  cancel.textContent = 'Cancel';
  const save = document.createElement('button');
  save.textContent = 'Save';
  row.append(cancel, save);
  box.append(ta, row);
  note.replaceWith(box);
  ta.focus();
  const done = () => { editingId = null; refreshComments(); };
  cancel.onclick = done;
  save.onclick = async () => {
    const text = ta.value.trim();
    if (!text) { ta.focus(); return; }
    try {
      await fetch(cbase() + '/' + encodeURIComponent(c.id) + '/update', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ note: text }),
      });
    } catch {}
    done();
  };
}
setInterval(refreshComments, 3000);
refreshComments();
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
      const method = req.method ?? 'GET';
      if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
        res.writeHead(405, { Allow: 'GET, HEAD, POST' }).end();
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
      // /p/<id>[/pdf|/version|/comments[/resolve]]
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
        if (parts.length === 3 && parts[2] === 'comments') {
          if (method === 'POST') await this.addComment(req, res, id);
          else this.sendJson(res, 200, this.deps.listComments(id));
          return;
        }
        if (
          parts.length === 4 &&
          parts[2] === 'comments' &&
          parts[3] === 'resolve' &&
          method === 'POST'
        ) {
          await this.resolveComments(req, res, id);
          return;
        }
        if (
          parts.length === 4 &&
          parts[2] === 'comments' &&
          parts[3] === 'undo' &&
          method === 'POST'
        ) {
          this.sendJson(res, 200, { restored: this.deps.undoDelete(id) });
          return;
        }
        // /p/<id>/comments/<cid>/update|delete  (cid is never "resolve"/"undo", so no collision)
        if (parts.length === 5 && parts[2] === 'comments' && method === 'POST') {
          const cid = decodeURIComponent(parts[3]!);
          if (parts[4] === 'update') {
            await this.updateComment(req, res, id, cid);
            return;
          }
          if (parts[4] === 'delete') {
            const ok = this.deps.deleteComment(id, cid);
            this.sendJson(res, ok ? 200 : 404, { deleted: ok });
            return;
          }
        }
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end(NOT_FOUND);
    } catch (err) {
      res
        .writeHead(500, { 'Content-Type': 'text/plain' })
        .end(`viewer error: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  private sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  /** POST /p/<id>/comments — body {page,x,y,quote?,note}; synctex-resolves and stores it. */
  private async addComment(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    id: string,
  ): Promise<void> {
    const body = await readJsonBody(req);
    if (!body || typeof body !== 'object') {
      this.sendJson(res, 400, { error: 'Invalid JSON body.' });
      return;
    }
    const b = body as Record<string, unknown>;
    if (
      typeof b.page !== 'number' ||
      typeof b.x !== 'number' ||
      typeof b.y !== 'number' ||
      typeof b.note !== 'string'
    ) {
      this.sendJson(res, 400, {
        error: 'Expected {page:number, x:number, y:number, note:string}.',
      });
      return;
    }
    const input: NewComment = {
      page: b.page,
      x: b.x,
      y: b.y,
      note: b.note,
      quote: typeof b.quote === 'string' ? b.quote : undefined,
      rects: sanitizeRects(b.rects),
    };
    const comment = await this.deps.addComment(id, input);
    this.sendJson(res, 201, comment);
  }

  /** POST /p/<id>/comments/resolve — body {ids?:string[]}; marks comments resolved. */
  private async resolveComments(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    id: string,
  ): Promise<void> {
    const body = await readJsonBody(req);
    const ids =
      body && Array.isArray((body as { ids?: unknown }).ids)
        ? ((body as { ids: unknown[] }).ids.filter((x) => typeof x === 'string') as string[])
        : undefined;
    const resolved = this.deps.resolveComments(id, ids);
    this.sendJson(res, 200, { resolved });
  }

  /** POST /p/<id>/comments/<cid>/update — body {note}; edits the note. */
  private async updateComment(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    id: string,
    cid: string,
  ): Promise<void> {
    const body = await readJsonBody(req);
    const note =
      body && typeof (body as { note?: unknown }).note === 'string'
        ? (body as { note: string }).note
        : undefined;
    if (note === undefined) {
      this.sendJson(res, 400, { error: 'Expected {note:string}.' });
      return;
    }
    const comment = this.deps.updateComment(id, cid, note);
    if (!comment) {
      this.sendJson(res, 404, { error: 'No such comment.' });
      return;
    }
    this.sendJson(res, 200, comment);
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
