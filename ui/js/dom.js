// @ts-check
// The page's small helpers, ported from cc-servers (h, the icons, dot, api, flash): the same names
// and behaviour, so code moves between the two as is.

/** The page's token: in its address (`web-latex-mcp ui` prints it), sent with every call. */
export const TOKEN = new URLSearchParams(location.search).get("token") || "";

/** @param {string} s @returns {any} */
export const $ = (s) => document.querySelector(s);

/**
 * An element: `h("a", { class: "x", href, onclick }, ...children)`. Text children are text nodes,
 * never markup.
 * @param {string} tag @param {Record<string, any> | null} [props] @param {...any} kids
 * @returns {any}
 */
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

// Icons, as SVG (static markup: no data goes in)
/** @type {Record<string, string>} */
export const ICONS = {
  enter: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 5v7a3 3 0 0 1-3 3H6M10 11l-4 4 4 4"/></svg>',
  // the Claude Code creature (as the tab's icon), its eyes cut out: the orange button shows through them
  stop: '<svg class="crit" viewBox="0 -3 16 16" aria-hidden="true"><path fill-rule="evenodd" d="M2 0h12v4h2v2h-2v2H2' +
    'V6H0V4h2zM4 2v2h1V2zM11 2v2h1V2zM3 8h1v2H3zM5 8h1v2H5zM10 8h1v2h-1zM12 8h1v2h-1z"/></svg>',
  sidebar: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="2.5"/>' +
    '<path d="M9 5v14"/></svg>',
  gear: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 ' +
    '.3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 ' +
    '0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 ' +
    '2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9' +
    'a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1' +
    '.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  slash: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3"/>' +
    '<path d="M14 8l-4 8"/></svg>',
  folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7A1.5 1.5 0 0 1 5 5.5h4.2l2 2.2H19A1.5 ' +
    '1.5 0 0 1 20.5 9.2V17A1.5 1.5 0 0 1 19 18.5H5A1.5 1.5 0 0 1 3.5 17z"/></svg>',
  tag: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 12.2V4.5a1 1 0 0 1 1-1h7.7l8.3 8.3a1.4 1.4 0 0 1 0 ' +
    '2l-6.7 6.7a1.4 1.4 0 0 1-2 0z"/><circle cx="8" cy="8" r="1.4"/></svg>',
  pen: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 19.5l1-4L16 5a2 2 0 0 1 3 3L8.5 18.5z"/>' +
    '<path d="M14 7l3 3"/></svg>',
};
export function fillIcons(root = document) {
  root.querySelectorAll("[data-icon]").forEach((el) => {
    const e = /** @type {HTMLElement} */ (el);
    e.innerHTML = ICONS[e.dataset.icon || ""] || "";
  });
}

// A status dot as SVG: crisp at any display scaling, where a CSS circle of 8 px lands between pixels.
const SVGNS = "http://www.w3.org/2000/svg";
/** @param {string} kind @param {boolean} [square] */
export function dot(kind, square) {
  const svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("viewBox", "0 0 10 10");
  svg.setAttribute("class", "dot " + kind);
  svg.setAttribute("aria-hidden", "true");
  /** @param {string} tag @param {Record<string, any>} attrs */
  const add = (tag, attrs) => {
    const el = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.append(el);
  };
  if (kind === "waiting") add("circle", { cx: 5, cy: 5, r: 5, class: "halo" });
  if (square) add("rect", { x: 1.2, y: 1.2, width: 7.6, height: 7.6, rx: 2 });
  else add("circle", { cx: 5, cy: 5, r: kind === "waiting" ? 3.2 : 4 });
  return svg;
}

/** @param {string} method @param {string} path @param {any} [body] @returns {Promise<any>} */
export async function api(method, path, body) {
  /** @type {RequestInit & { headers: Record<string, string> }} */
  const opts = { method, cache: "no-store", headers: { "X-WLM-Token": TOKEN } };
  if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  const r = await fetch(path, opts);
  let data = null;
  try { data = await r.json(); } catch (e) { data = { error: "HTTP " + r.status }; }
  if (!r.ok || data.error) throw new Error(data.error || ("HTTP " + r.status));
  return data;
}

/** @type {any} */
let flashTimer = null;
/** @param {string} msg @param {number} [ms] */
export function flash(msg, ms) {
  const el = $("#flash");
  el.textContent = msg; el.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { el.hidden = true; }, ms || 4000);
}

/** This browser's memory of the page (cc-servers' sideStore, under `wlm-side-`). */
export function sideStore(/** @type {string} */ key, /** @type {any} */ value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem("wlm-side-" + key) || "null");
    localStorage.setItem("wlm-side-" + key, JSON.stringify(value));
  } catch (e) { /* no storage: defaults */ }
  return null;
}

/** @param {string | number} t */
export function ago(t) {
  const s = Math.max(0, (Date.now() - new Date(t).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + " min ago";
  if (s < 86400) return Math.floor(s / 3600) + " h ago";
  return Math.floor(s / 86400) + " d ago";
}

/** @param {string} t */
export function when(t) {
  if (!t) return "";
  const d = new Date(t);
  return isNaN(d.getTime()) ? "" : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** A label's colour, the same each time (cc-servers' apHue). @param {string} s */
export function hue(s) {
  let x = 0;
  for (const c of s) x = (x * 31 + (c.codePointAt(0) || 0)) % 360;
  return x;
}

/** The app's shared state: what /api/state answered, and the paper open. */
export const S = {
  /** @type {any} */ state: null,
  /** @type {string | null} */ paper: null,
};
