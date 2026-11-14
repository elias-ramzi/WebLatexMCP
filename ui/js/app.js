// @ts-check
// The page: the papers at the left, the conversation in the middle, the live PDF at the right.
// Routes: #paper/<id> opens a paper; no hash, the last one opened.
import { $, api, fillIcons, flash, sideStore, S } from "./dom.js";
import { side, renderSide, toggleSide, openAdd, newGroup, paperMenu, renamePaper, paperTitle } from "./side.js";
import { chat, openChat, wireChat, resetChat } from "./chat.js";
import { showViewer, wireViewer } from "./viewer.js";
import { wireSettings } from "./settings.js";

if (document.documentElement.classList.contains("side-off-early")) document.body.classList.add("side-off");
fillIcons();

async function refresh() {
  try {
    S.state = await api("GET", "/api/state");
  } catch (e) {
    flash("The UI server does not answer: " + /** @type {Error} */ (e).message, 6000);
    return;
  }
  $("#s-version").textContent = "web-latex-mcp " + S.state.version;
  renderSide();
  updateHead();
  if (S.paper && !S.state.papers.some((/** @type {any} */ p) => p.id === S.paper)) route();
}
side.refresh = refresh;

function current() {
  return S.state && S.state.papers.find((/** @type {any} */ p) => p.id === S.paper);
}

function updateHead() {
  const p = current();
  $("#c-title").textContent = p ? paperTitle(p) : "WebLatexMCP";
  $("#c-meta").textContent = p ? p.id : "";
  document.title = p ? paperTitle(p) + " · WebLatexMCP" : "WebLatexMCP";
}

function route() {
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
  if (p) paperMenu(p, /** @type {Element} */ (e.currentTarget), { onReset: resetChat });
};
document.addEventListener("keydown", (e) => {
  if (e.altKey && (e.key === "s" || e.key === "S")) { e.preventDefault(); toggleSide(); }
});
window.addEventListener("hashchange", route);
// the side bar's dots and the papers: every 4 s (the conversation polls on its own)
setInterval(refresh, 4000);
refresh().then(route);
void chat;
