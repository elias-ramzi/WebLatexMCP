// @ts-check
// The live PDF beside the chat: the server's own viewer (the `viewer` tool's page), framed, as
// cc-servers frames it in its LaTeX tab. The page's colours go to it as cc-servers sends them to
// its embedded apps (`cc-theme`), once it says it is ready.
import { $, h, api, sideStore } from "./dom.js";

const view = { /** @type {string | null} */ paper: null, /** @type {string | null} */ url: null, gen: 0 };

/** @param {string} url */
function embedUrl(url) {
  const u = new URL(url);
  u.searchParams.set("embed", "1");
  return u.toString();
}

/** @param {string | null} paper */
export async function showViewer(paper) {
  const gen = ++view.gen;
  view.paper = paper;
  const frame = $("#tx-frame"), none = $("#tx-none");
  if (!paper) { frame.hidden = true; frame.removeAttribute("src"); view.url = null; return; }
  $("#tx-what").textContent = "Starting the viewer…";
  try {
    const r = await api("GET", "/api/viewer?paper=" + encodeURIComponent(paper));
    if (gen !== view.gen) return;
    const url = embedUrl(r.url);
    $("#tx-what").textContent = r.rootFile ? r.rootFile : paper;
    $("#tx-what").title = "The viewer follows " + (r.rootFile || "the detected root file") + "; it reloads on each compile";
    $("#tx-open").href = r.url;
    none.hidden = true;
    frame.hidden = false;
    if (view.url !== url) { view.url = url; frame.src = url; }
  } catch (e) {
    if (gen !== view.gen) return;
    frame.hidden = true;
    view.url = null;
    $("#tx-what").textContent = "";
    none.hidden = false;
    none.replaceChildren(h("b", {}, "No viewer for this paper. "), /** @type {Error} */ (e).message);
  }
}

/** The page's colours, as cc-servers sends them to the apps it frames (its jobsTheme). */
export function sendTheme() {
  const frame = $("#tx-frame");
  if (!frame || !frame.contentWindow || !view.url) return;
  const cs = getComputedStyle(document.documentElement), v = (/** @type {string} */ k) => cs.getPropertyValue("--" + k).trim();
  const bg = v("bg"), m = bg.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i);
  const light = m ? (0.2126 * parseInt(m[1], 16) + 0.7152 * parseInt(m[2], 16) + 0.0722 * parseInt(m[3], 16)) > 140
    : !matchMedia("(prefers-color-scheme: dark)").matches;
  const vars = { bg, panel: v("card"), text: v("fg"), muted: v("muted"), line: v("line"), accent: v("accent"),
    "accent-soft": v("soft"), run: v("ok"), pend: v("warn"), bad: v("bad"), ok: v("ok"), bar: v("soft") };
  frame.contentWindow.postMessage({ type: "cc-theme", vars, scheme: light ? "light" : "dark" }, new URL(view.url).origin);
}

export function wireViewer() {
  window.addEventListener("message", (e) => {
    const frame = $("#tx-frame");
    if (frame && e.source === frame.contentWindow && e.data &&
        (e.data.type === "wlm-ready" || e.data.type === "jz-ready")) sendTheme();
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => setTimeout(sendTheme, 50));
  $("#tx-reload").onclick = () => {
    const f = $("#tx-frame");
    if (view.url) { f.src = "about:blank"; setTimeout(() => { f.src = view.url; }, 30); }
    else if (view.paper) showViewer(view.paper);
  };
  const setLeft = (/** @type {boolean} */ on) => { document.body.classList.toggle("view-left", on); sideStore("view-left", on); };
  if (sideStore("view-left") === true) document.body.classList.add("view-left");
  $("#tx-swap").onclick = () => setLeft(!document.body.classList.contains("view-left"));
  const toggle = () => {
    document.body.classList.toggle("arts-on");
    sideStore("arts-off", !document.body.classList.contains("arts-on"));
  };
  if (sideStore("arts-off") === true) document.body.classList.remove("arts-on");
  $("#a-close").onclick = toggle;
  $("#c-arts-btn").onclick = toggle;
  document.addEventListener("keydown", (e) => {
    if (e.altKey && (e.key === "a" || e.key === "A")) { e.preventDefault(); toggle(); }
  });
}
