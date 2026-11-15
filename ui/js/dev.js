// @ts-check
// Dev mode (`web-latex-mcp ui --dev`), after cc-servers': a small chat at the bottom left — a Claude that
// changes WebLatexMCP itself (in its own worktree of the checkout, PR into dev, merged when green, then the
// dev build), and the page reloads itself once the UI runs the new build. Ported from cc-servers'
// miniChat; permission cards and questions are answered in the full view (#dev), which is the main chat.
// Live mode (`--dev --live`): the UI runs from a worktree Claude edits in place; Ship sends it as one PR.
import { $, h, api, flash, S } from "./dom.js";
import { md } from "./md.js";

export const DEV = ".dev";

const SHIP = "Ship the live changes: one pull request into dev with their tests, docs and CHANGELOG " +
  "entries, merged once its checks pass, then bring the live worktree back to dev.";

const m = { offset: 0, epoch: /** @type {string | null} */ (null), timer: /** @type {any} */ (null),
  loading: false, /** @type {{ el: HTMLElement, names: string[] } | null} */ steps: null, gen: 0 };

const store = (/** @type {string} */ key, /** @type {any} */ value) => {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem("wlm-dev-" + key) || "null");
    localStorage.setItem("wlm-dev-" + key, JSON.stringify(value));
  } catch (e) { /* no storage */ }
  return null;
};

const note = (/** @type {string} */ text, /** @type {string} */ cls = "") => {
  $("#dev-log").append(h("div", { class: cls || "note" }, text));
};

/** @param {any} it */
function add(it) {
  const log = $("#dev-log");
  if (it.k === "tool") {
    if (!m.steps) { m.steps = { el: h("div", { class: "st" }), names: [] }; log.append(m.steps.el); }
    m.steps.names.push(String(it.name || "").replace(/^mcp__\w+?__/, ""));
    const n = m.steps.names.length;
    m.steps.el.textContent = "· " + n + " step" + (n > 1 ? "s" : "") + ": " +
      [...new Set(m.steps.names)].slice(-5).join(", ");
    return;
  }
  if (it.k === "user") {
    m.steps = null;
    log.querySelectorAll(".u.pending").forEach((/** @type {Element} */ x) => {
      if (x.textContent === String(it.text).trim()) x.remove();
    });
    log.append(h("div", { class: "u" }, it.text));
  } else if (it.k === "text") {
    m.steps = null;
    const el = h("div", { class: "a" });
    el.innerHTML = md(it.text);  // md() escapes all of the text
    log.append(el);
  } else if (it.k === "note") {
    note(String(it.text));
  }
}

const shown = () => !$("#dev-chat").hidden;
function tick(/** @type {number} */ ms) { clearTimeout(m.timer); if (shown()) m.timer = setTimeout(poll, ms); }

function intro() {
  const d = (S.state && S.state.dev) || {};
  if (d.live) {
    note("Live mode: the UI runs from " + d.live.dir + ", and Claude edits it in place. A change shows " +
      "when its turn ends, with no pull request. Press Ship when you are happy: Claude then opens one pull " +
      "request into dev for all of it and merges it once its checks pass.");
    return;
  }
  note("Tell Claude what to change in this page, the viewer or the server. It works in its own worktree of " +
    (d.repo || "the checkout") + ", opens a pull request into dev and merges it once its checks pass, then " +
    "updates the build: the UI restarts on it when no chat is working, and this page reloads.");
}

async function poll() {
  if (m.loading || !shown()) return;
  m.loading = true;
  const gen = m.gen, log = $("#dev-log");
  try {
    const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    const r = await api("GET", "/api/chat?paper=" + encodeURIComponent(DEV) + "&offset=" + m.offset +
      (m.epoch ? "&epoch=" + m.epoch : ""));
    if (gen !== m.gen) return;
    if (r.restart && m.offset > 0) { log.replaceChildren(); m.steps = null; }
    m.epoch = r.epoch;
    log.querySelectorAll(".note.intro, .note.bad").forEach((/** @type {Element} */ x) => x.remove());
    r.items.forEach(add);
    m.offset = r.next;
    if (!log.childElementCount) { intro(); if (log.lastElementChild) log.lastElementChild.classList.add("intro"); }
    const busy = r.status === "working" || r.status === "starting";
    $("#dev-btn").classList.toggle("busy", busy || r.status === "waiting");
    $("#dev-work").hidden = !busy;
    $("#dev-work").textContent = busy ? "✳ Working…" : "";
    $("#dev-sub").textContent = r.status === "waiting" ? "waiting for you" : busy ? "working" : "";
    log.querySelectorAll(".wait").forEach((/** @type {Element} */ x) => x.remove());
    if (r.status === "waiting" || (r.asks && r.asks.length)) {
      log.append(h("div", { class: "wait" }, "Claude is waiting for you (a permission or a question): ",
        h("a", { href: "#dev" }, "answer it in the full view")));
    }
    if (r.error) note(r.error, "note bad");
    if (atEnd) log.scrollTop = log.scrollHeight;
    tick(busy || r.status === "waiting" ? 1200 : 4000);
  } catch (e) {
    if (gen !== m.gen) return;
    $("#dev-sub").textContent = "";
    log.querySelectorAll(".bad").forEach((/** @type {Element} */ x) => x.remove());
    note(/** @type {Error} */ (e).message, "note bad");
    tick(4000);
  } finally {
    m.loading = false;
  }
}

/** @param {boolean} on */
export function openDev(on) {
  $("#dev-chat").hidden = !on;
  store("open", on);
  if (on) { poll(); if (!reduced()) $("#dev-input").focus(); } else clearTimeout(m.timer);
}

const reduced = () => $("#dev-chat").classList.contains("min");

/** Reduce the chat to its title bar, or bring it back (it keeps polling: the bar says when Claude works). */
function reduce(/** @type {boolean} */ on) {
  $("#dev-chat").classList.toggle("min", on);
  $("#dev-min").textContent = on ? "□" : "–";
  $("#dev-min").title = on ? "Bring it back" : "Reduce to its title bar (click the bar to bring it back)";
  $("#dev-min").setAttribute("aria-label", on ? "Restore" : "Reduce");
  $("#dev-min").setAttribute("aria-expanded", String(!on));
  store("min", on);
  if (!on && shown()) {
    const log = $("#dev-log");
    log.scrollTop = log.scrollHeight;
    $("#dev-input").focus();
  }
}

async function send(/** @type {string} */ given = "") {
  const text = given || $("#dev-input").value.trim();
  if (!text) return;
  if (!given) { $("#dev-input").value = ""; store("draft", ""); }
  const log = $("#dev-log");
  log.querySelectorAll(".note.intro").forEach((/** @type {Element} */ x) => x.remove());
  log.append(h("div", { class: "u pending" }, text));
  log.scrollTop = log.scrollHeight;
  try {
    await api("POST", "/api/chat", { paper: DEV, text });
    setTimeout(poll, 400);
  } catch (e) {
    log.querySelectorAll(".u.pending").forEach((/** @type {Element} */ x) => x.remove());
    if (!given) $("#dev-input").value = text;
    note(/** @type {Error} */ (e).message, "note bad");
  }
}

/** The dev state from /api/state: the button, the chip, the chat's availability. @param {any} st */
export function updateDev(st) {
  const d = st && st.dev;
  document.body.classList.toggle("dev-on", !!d);
  $("#dev-btn").hidden = !d;
  $("#dev").hidden = !d;
  if (!d) { $("#dev-chat").hidden = true; return; }
  const live = d.live, waiting = live ? live.ahead + live.changed : 0;
  $("#dev").textContent = (live ? "dev · live" : "dev") + (d.pending ? " · new build waits" : "");
  $("#dev").title = d.error ? "Running the build before: " + d.error
    : d.pending ? "A new build is ready: the UI restarts on it once no chat is working"
      : live ? "Live mode: the UI runs from " + live.dir + " (" + live.branch + ")" +
        (live.problem ? ": " + live.problem : ", " + liveCount(live) + " not shipped")
        : "Dev mode: the UI restarts on each new build";
  const busy = d.status === "working" || d.status === "starting" || d.status === "waiting";
  $("#dev-ship").hidden = !live;
  $("#dev-ship").textContent = waiting ? "Ship (" + waiting + ")" : "Ship";
  $("#dev-ship").disabled = !waiting || busy;
  $("#dev-ship").title = !live ? "" : busy ? "Wait for Claude's turn to end"
    : waiting ? "Ship " + liveCount(live) + ": one pull request into dev, merged when its checks pass"
      : "Nothing to ship: the live worktree is at dev";
  $("#dev").classList.toggle("attn", !!d.error || !!d.pending);
  $("#dev-btn").disabled = !d.chat;
  $("#dev-btn").title = d.chat ? "Ask Claude to change WebLatexMCP: a PR into dev, merged when green; the page reloads"
    : "The dev chat is off: " + (d.problem || "");
  $("#dev-btn").classList.toggle("busy", busy);
}

/** "2 commits and 1 changed file". @param {{ ahead: number, changed: number }} l */
function liveCount(l) {
  const n = (/** @type {number} */ k, /** @type {string} */ w) => k + " " + w + (k === 1 ? "" : "s");
  return [l.ahead ? n(l.ahead, "commit") : "", l.changed ? n(l.changed, "changed file") : ""]
    .filter(Boolean).join(" and ") || "nothing";
}

export function wireDev() {
  $("#dev-btn").onclick = () => {
    if (!$("#dev-chat").hidden && reduced()) reduce(false);
    else openDev($("#dev-chat").hidden);
  };
  $("#dev-min").onclick = (/** @type {Event} */ e) => { e.stopPropagation(); reduce(!reduced()); };
  $(".mini .d-head").addEventListener("click", (/** @type {MouseEvent} */ e) => {
    if (reduced() && !(/** @type {Element} */ (e.target)).closest("button")) reduce(false);
  });
  if (store("min") === true) reduce(true);
  $("#dev-close").onclick = () => openDev(false);
  $("#dev-full").onclick = () => { location.hash = "#dev"; };
  $("#dev-ship").onclick = () => {
    if (!confirm("Ship the live changes? Claude opens one pull request into dev and merges it once its checks pass.")) return;
    send(SHIP);
  };
  $("#dev-reset").onclick = () => {
    if (!confirm("Start over in a new conversation? This one is set aside (kept on disk).")) return;
    api("POST", "/api/chat", { paper: DEV, reset: true }).then(() => {
      m.gen++; m.offset = 0; m.epoch = null; m.steps = null;
      $("#dev-log").replaceChildren(); $("#dev-work").hidden = true;
      poll();
    }).catch((e) => flash(e.message, 6000));
  };
  $("#dev-form").addEventListener("submit", (/** @type {Event} */ e) => { e.preventDefault(); send(); });
  $("#dev-input").addEventListener("keydown", (/** @type {KeyboardEvent} */ e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    if (e.key === "Escape") openDev(false);
  });
  $("#dev-input").addEventListener("input", () => store("draft", $("#dev-input").value));
  $("#dev-input").value = store("draft") || "";
}

/** Once the state says dev mode is on: reopen the chat if it was open before the reload. */
export function restoreDev() {
  if (store("open") && $("#dev-chat").hidden && !$("#dev-btn").disabled) openDev(true);
}
