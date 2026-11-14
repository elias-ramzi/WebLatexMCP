// @ts-check
// The page: the papers at the left, the conversation in the middle, the live PDF at the right.
// Routes: #paper/<id> opens a paper; no hash, the last one opened.
import { $, api, fillIcons, flash, sideStore, S } from "./dom.js";
import { side, renderSide, toggleSide, openAdd, newGroup, paperMenu, renamePaper, paperTitle } from "./side.js";
import { chat, openChat, wireChat, resetChat } from "./chat.js";
import { showViewer, wireViewer } from "./viewer.js";
import { wireSettings } from "./settings.js";
import { DEV, openDev, restoreDev, updateDev, wireDev } from "./dev.js";

if (document.documentElement.classList.contains("side-off-early")) document.body.classList.add("side-off");
fillIcons();

/** @type {string | null} */
let rev0 = null;
async function refresh() {
  const wasDev = !!(S.state && S.state.dev);
  try {
    S.state = await api("GET", "/api/state");
  } catch (e) {
    // dev mode: the UI is starting again on a new build (it keeps its port and token)
    flash(wasDev ? "The UI is restarting on a new build…"
      : "The UI server does not answer: " + /** @type {Error} */ (e).message, 6000);
    return;
  }
  // a new build answers (dev mode restarted the UI): load the page that goes with it
  if (S.state.rev) {
    if (rev0 === null) rev0 = S.state.rev;
    else if (S.state.rev !== rev0) { location.reload(); return; }
  }
  $("#s-version").textContent = "web-latex-mcp " + S.state.version;
  updateDev(S.state);
  if (!wasDev && S.state.dev) restoreDev();
  renderSide();
  updateHead();
  if (S.paper && S.paper !== DEV && !S.state.papers.some((/** @type {any} */ p) => p.id === S.paper)) route();
}
side.refresh = refresh;
side.resetPaper = resetChat;

function current() {
  return S.state && S.state.papers.find((/** @type {any} */ p) => p.id === S.paper);
}

/** The header's Pull: the paper's remote (Overleaf…) into its clone, then a compile for the PDF. */
async function pullPaper() {
  const p = current(), btn = $("#c-pull");
  if (!p || btn.disabled) return;
  btn.disabled = true;
  const label = btn.lastChild.textContent;
  btn.lastChild.textContent = " Pulling…";
  try {
    const r = await api("POST", "/api/sync", { paper: p.id });
    if (r.action === "up-to-date") flash(paperTitle(p) + " is up to date.", 3000);
    else if (r.action === "pulled" || r.action === "cloned") {
      const what = r.action === "cloned" ? "Cloned " + paperTitle(p) : "Pulled the latest version";
      flash(what + (r.compiled ? "; the PDF is recompiled." : r.compiled === false
        ? ". The compile failed: " + (r.compileText || "ask Claude to look.") : "."), r.compiled === false ? 9000 : 4000);
    } else flash(r.text || r.action, 12000);
    await refresh();
  } catch (e) {
    flash("Pull failed: " + /** @type {Error} */ (e).message, 12000);
  } finally {
    btn.disabled = false;
    btn.lastChild.textContent = label;
  }
}

function updateHead() {
  if (S.paper === DEV) {
    $("#c-title").textContent = "Improve WebLatexMCP";
    $("#c-meta").textContent = (S.state && S.state.dev && S.state.dev.repo) || "";
    document.title = "Improve WebLatexMCP";
    $("#c-pull").hidden = true;
    return;
  }
  const p = current();
  // a local folder has no remote to pull from
  $("#c-pull").hidden = !p || p.mode === "local";
  $("#c-title").textContent = p ? paperTitle(p) : "WebLatexMCP";
  $("#c-meta").textContent = p ? p.id : "";
  document.title = p ? paperTitle(p) + " · WebLatexMCP" : "WebLatexMCP";
}

/** The dev chat in the main view (#dev): its permission cards and questions are answered here. */
function routeDev() {
  if (S.paper === DEV) return;
  S.paper = DEV;
  document.body.classList.remove("homing");
  side.key = "";
  renderSide();
  updateHead();
  openDev(false);
  openChat(DEV);
  showViewer(null);
  $("#tx-what").textContent = "";
  $("#tx-none").hidden = false;
  $("#tx-none").textContent = "The dev chat has no PDF: pick a paper at the left to see one.";
}

function route() {
  if (location.hash === "#dev" && S.state && S.state.dev && S.state.dev.chat) { routeDev(); return; }
  const m = location.hash.match(/^#paper\/(.+)$/);
  let id = m ? decodeURIComponent(m[1]) : sideStore("last");
  if (S.state && id && !S.state.papers.some((/** @type {any} */ p) => p.id === id)) id = null;
  if (!id && S.state && S.state.papers.length) id = S.state.papers[0].id;
  if (id === S.paper) return;
  S.paper = id || null;
  if (id) sideStore("last", id);
  document.body.classList.toggle("homing", !id);
  side.key = "";
  renderSide();
  updateHead();
  openChat(S.paper);
  showViewer(S.paper);
  if (!id) {
    $("#c-log").replaceChildren();
    const home = document.createElement("div");
    home.className = "home";
    home.innerHTML = "<h2>WebLatexMCP</h2><p>Add a paper (a git URL or a local folder) with <b>+ Add paper</b>, " +
      "then talk to Claude about it beside its live PDF.</p>";  // static markup
    $("#c-log").append(home);
  }
}

wireSettings();
wireViewer();
wireChat();
wireDev();
$("#s-fold").onclick = toggleSide;
$("#c-side-btn").onclick = toggleSide;
$("#s-backdrop").onclick = () => document.body.classList.remove("side-open");
$("#s-add-paper").onclick = openAdd;
$("#s-add-group").onclick = newGroup;
$("#s-filter").addEventListener("input", () => { side.key = ""; renderSide(); });
$("#c-title").onclick = () => { const p = current(); if (p) renamePaper(p); };
$("#c-more").onclick = (/** @type {MouseEvent} */ e) => {
  e.stopPropagation();
  const p = current();
  if (p) paperMenu(p, /** @type {Element} */ (e.currentTarget));
};
$("#c-pull").onclick = pullPaper;
document.addEventListener("keydown", (e) => {
  if (e.altKey && (e.key === "s" || e.key === "S")) { e.preventDefault(); toggleSide(); }
});
window.addEventListener("hashchange", route);
// the side bar's dots and the papers: every 4 s (the conversation polls on its own)
setInterval(refresh, 4000);
refresh().then(route);
void chat;
