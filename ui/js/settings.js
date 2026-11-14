// @ts-check
// Settings (theme, font, text size) and the bars' widths, ported from cc-servers: the same
// themes, the same menus that open beside the settings, the same drag handles.
import { $, h, sideStore } from "./dom.js";
import { sendTheme } from "./viewer.js";

const THEMES = [["", "System", "#888", "#ccc", "#e07a55"], ["light", "Light", "#f5f6f8", "#ffffff", "#c65f3d"],
  ["dark", "Dark", "#15171c", "#1e2128", "#e07a55"], ["claude-dark", "Claude dark", "#262624", "#1f1e1d", "#d97757"],
  ["claude-light", "Claude light", "#faf9f5", "#ffffff", "#c6613f"], ["claude-code", "Claude Code", "#191919",
    "#1f1f1f", "#d97757"], ["nord", "Nord", "#2e3440", "#3b4252", "#d08770"],
  ["solarized", "Solarized", "#fdf6e3", "#eee8d5", "#cb4b16"],
  ["midnight", "Midnight", "#000000", "#17171a", "#e07a55"]];
const FONTS = [["", "Claude", "claude.ai/code's sans (Anthropic Sans, else the system's)"], ["system", "System", ""],
  ["serif", "Serif", ""], ["mono", "Monospace", ""]];
const SIZES = [13, 14, 15, 16, 17, 18];

/** @param {string} t */
function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  sendTheme();  // the framed viewer follows
}
/** @param {string} t */
function setTheme(t) {
  if (t && !THEMES.some((x) => x[0] === t)) t = "";
  applyTheme(t);
  sideStore("theme", t || null);
  document.querySelectorAll("#set-theme button").forEach((b) => {
    const on = /** @type {HTMLElement} */ (b).dataset.v === (t || "");
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", on ? "true" : "false");
    const ck = b.querySelector(".ck");
    if (ck) ck.textContent = on ? "✓" : "";
  });
  $("#set-theme-cur").textContent = (THEMES.find((x) => x[0] === (t || "")) || THEMES[0])[1];
}
// each setting's choices open on the right while the pointer is over its row or them
/** @param {string} head @param {string} list */
function setSection(head, list) {
  const hd = $(head), ls = $(list);
  /** @type {any} */
  let timer = null;
  const open = (/** @type {boolean} */ o) => {
    clearTimeout(timer);
    if (o) ls.style.top = Math.max(0, hd.offsetTop - 7) + "px";
    ls.hidden = !o;
    if (o) {
      const over = ls.getBoundingClientRect().bottom - (window.innerHeight - 8);
      if (over > 0) ls.style.top = (hd.offsetTop - 7 - over) + "px";
    }
    hd.setAttribute("aria-expanded", o ? "true" : "false");
  };
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { if (!hd.matches(":hover") && !ls.matches(":hover")) open(false); }, 200);
  };
  hd.addEventListener("mouseenter", () => open(true));
  ls.addEventListener("mouseenter", () => clearTimeout(timer));
  hd.addEventListener("mouseleave", later);
  ls.addEventListener("mouseleave", later);
  hd.onclick = () => open(ls.hidden);
  $("#set-btn").addEventListener("click", () => open(false));
}
/** @param {string} f */
function applyFont(f) { if (f) document.documentElement.dataset.font = f; else delete document.documentElement.dataset.font; }
/** @param {number} z */
function applySize(z) { document.documentElement.style.setProperty("--chat-size", (z || 16) + "px"); }
/** @param {any} list @param {any[]} rows @param {any} cur @param {(v: any) => void} pick @param {(v: any) => void} preview @param {() => void} restore */
function menuRows(list, rows, cur, pick, preview, restore) {
  list.replaceChildren(...rows.map(([v, label, sub]) => h("button", { type: "button", role: "menuitemradio",
    "data-v": String(v), "aria-checked": v === cur ? "true" : "false", onclick: () => pick(v),
    onmouseenter: () => preview(v) }, h("span", { class: "nm" }, label, sub ? h("span", { class: "small" },
    " · " + sub) : null), h("span", { class: "ck" }, v === cur ? "✓" : ""))));
  list.onmouseleave = restore;
}
/** @param {string} f */
function setFont(f) {
  sideStore("font", f || null); applyFont(f);
  $("#set-font-cur").textContent = (FONTS.find((x) => x[0] === (f || "")) || FONTS[0])[1];
  menuRows($("#set-font"), FONTS, f || "", setFont, applyFont, () => applyFont(sideStore("font") || ""));
}
/** @param {number} z */
function setSize(z) {
  sideStore("size", z === 16 ? null : z); applySize(z);
  $("#set-size-cur").textContent = z + " px";
  menuRows($("#set-size"), SIZES.map((v) => [v, v + " px", v === 16 ? "claude.ai's" : ""]), z, setSize, applySize,
    () => applySize(sideStore("size") || 16));
}

// ---- the bars' widths: drag their inner edge (kept in this browser); a double-click puts it back
/** @param {string} which @param {number | null} w */
function setWidth(which, w) {
  const [v, lo, hi] = which === "side" ? ["--side-w", 200, 560] : ["--tex-w", 300, 1600];
  if (w) document.documentElement.style.setProperty(v, Math.max(lo, Math.min(hi, Math.round(w))) + "px");
  else document.documentElement.style.removeProperty(v);
}

export function wireSettings() {
  $("#set-theme").replaceChildren(...THEMES.map(([id, label, bg, card, acc]) => h("button", { type: "button",
    role: "menuitemradio", "data-v": id, onclick: () => setTheme(id), onmouseenter: () => applyTheme(id) },
  h("span", { class: "sw", style: id ? "background: linear-gradient(90deg, " + bg + " 50%, " + card + " 50%)"
    : "background: linear-gradient(90deg, #f5f6f8 50%, #15171c 50%)" }, h("i", { style: "background: " + acc })),
  h("span", { class: "nm" }, label), h("span", { class: "ck" }))));
  $("#set-theme").addEventListener("mouseleave", () => applyTheme(sideStore("theme") || ""));
  setSection("#set-theme-head", "#set-theme");
  setFont(sideStore("font") || "");
  setSize(sideStore("size") || 16);
  setSection("#set-font-head", "#set-font");
  setSection("#set-size-head", "#set-size");
  setTheme(sideStore("theme") || "");
  $("#set-btn").onclick = (/** @type {MouseEvent} */ e) => {
    e.stopPropagation();
    const pop = $("#set-pop");
    if (!pop.hidden) { pop.hidden = true; return; }
    const r = /** @type {HTMLElement} */ (e.currentTarget).getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(r.right - 260, window.innerWidth - 308)) + "px";
    pop.style.bottom = (window.innerHeight - r.top + 6) + "px";
    pop.hidden = false;
  };
  document.addEventListener("click", (e) => {
    const pop = $("#set-pop");
    if (!pop.hidden && !e.composedPath().includes(pop)) pop.hidden = true;
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("#set-pop").hidden = true; });

  setWidth("side", sideStore("side-w")); setWidth("tex", sideStore("tex-w"));
  [["side", "#side-rs", "#c-side"], ["tex", "#arts-rs", "#c-arts"]].forEach(([which, handle, bar]) => {
    const el = $(handle);
    el.addEventListener("pointerdown", (/** @type {PointerEvent} */ e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      el.classList.add("on"); document.body.classList.add("resizing");
      const r = $(bar).getBoundingClientRect();
      // the side bar grows from its left edge; the PDF from the edge facing the chat
      const fromLeft = which === "side" || document.body.classList.contains("view-left");
      const move = (/** @type {PointerEvent} */ ev) => setWidth(which, fromLeft ? ev.clientX - r.left : r.right - ev.clientX);
      const up = () => {
        el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up);
        el.classList.remove("on"); document.body.classList.remove("resizing");
        sideStore(which + "-w", Math.round($(bar).getBoundingClientRect().width));
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
    });
    el.addEventListener("dblclick", () => { sideStore(which + "-w", null); setWidth(which, null); });
  });
}
