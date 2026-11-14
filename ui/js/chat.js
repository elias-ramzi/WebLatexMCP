// @ts-check
// A paper's conversation with Claude: the items (cc-servers' addItem, stepsGroup, toolInput,
// userBubble), the working line, the cards Claude asks with (questions, plans, permissions), the
// message box with its command picker, and the model, effort and mode pills. Ported from
// cc-servers' chat view; what differs is the source: /api/chat of web-latex-mcp ui, fed by the
// Agent SDK, instead of a transcript and a terminal.
import { $, h, api, flash, ICONS, ago, when, sideStore, S } from "./dom.js";
import { md, mdInline, linkNodes, COPY_SVG, hydratePrs } from "./md.js";

export const chat = {
  /** @type {string | null} */ paper: null,
  offset: 0,
  /** @type {string | null} */ epoch: null,
  /** @type {Map<string, any>} */ tools: new Map(),
  /** @type {any} */ last: null,
  /** @type {any} */ timer: null,
  gen: 0,
  /** @type {Array<{ text: string, el: any }>} */ pending: [],
  /** @type {string | null} */ spin: null,
  spinAt: 0,
  spinFor: 0,
  stick: true,
  askKey: "",
  /** @type {any[] | null} */ commands: null,
  picker: { on: false, sel: 0, /** @type {any[]} */ rows: [] },
};

const VIEW = { stepsOpen: sideStore("steps-open") === true };

// ---- items
function stepsGroup() {
  const log = $("#c-log"), last = log.lastElementChild;
  if (last && last.classList.contains("m-steps")) return last._g;
  const g = { n: 0, names: new Map(), errors: 0, touched: false, sum: h("summary", {}), body: h("div", { class: "steps" }),
    /** @type {any} */ el: null };
  g.el = h("details", { class: "m-steps", open: VIEW.stepsOpen }, g.sum, g.body);
  g.el._g = g;
  g.el.addEventListener("click", (/** @type {Event} */ e) => { if (e.target === g.sum) g.touched = true; });
  log.append(g.el);
  return g;
}
/** @param {any} g */
function stepsLabel(g) {
  const names = [...g.names].map(([n, c]) => (c > 1 ? n + " ×" + c : n)).join(", ");
  g.sum.textContent = g.n + (g.n === 1 ? " step" : " steps") + (names ? " · " + names : "") +
    (g.errors ? " · " + g.errors + " failed" : "");
}
function closeSteps() {
  const last = $("#c-log").lastElementChild;
  if (last && last.classList.contains("m-steps") && !last._g.touched && !VIEW.stepsOpen) last.open = false;
}

/** @param {any} it */
function answerActs(it) {
  const copy = h("button", { type: "button", title: "Copy", "aria-label": "Copy", onclick: () => {
    (navigator.clipboard ? navigator.clipboard.writeText(it.text) : Promise.reject(new Error()))
      .then(() => flash("Copied", 1500)).catch(() => prompt("The answer:", it.text));
  } });
  copy.innerHTML = COPY_SVG;  // constant SVG
  const exact = it.t ? new Date(it.t).toLocaleString() : "";
  return h("div", { class: "m-acts" }, copy,
    it.t ? h("span", { class: "ago", "data-t": it.t, title: exact }, ago(it.t)) : null);
}
setInterval(() => {
  document.querySelectorAll(".m-acts .ago[data-t]").forEach((e) => {
    e.textContent = ago(/** @type {HTMLElement} */ (e).dataset.t || "");
  });
}, 30000);

/** @param {string} text @param {string} whenText @param {boolean} [pending] */
function userBubble(text, whenText, pending) {
  return h("div", { class: "m-user" + (pending ? " pending" : "") }, linkNodes(text, true),
    h("span", { class: "when" }, whenText));
}

/** @param {any} it */
function addItem(it) {
  let log = $("#c-log");
  if (it.k === "user") {  // the message the page showed while it was being sent
    const i = chat.pending.findIndex((x) => x.text === it.text.trim());
    if (i >= 0) {
      const el = chat.pending[i].el;
      chat.pending.splice(i, 1);
      if (el.isConnected) {
        if (el === log.lastElementChild) closeSteps();
        const b = userBubble(it.text, when(it.t));
        if (el.classList.contains("arrive")) {
          b.classList.add("arrive");
          b.style.animationDelay = (70 - (performance.now() - el._t0)) + "ms";
          b.addEventListener("animationend", () => b.classList.remove("arrive"), { once: true });
        }
        el.replaceWith(b);
        return;
      }
      el.remove();
    }
  }
  if (it.k === "tool" && it.name === "ExitPlanMode") {  // Claude's plan: in the conversation, not among its steps
    closeSteps();
    const state = h("span", { class: "tstate run" }, "…");
    const body = h("div", { class: "m-text plan-md" });
    body.innerHTML = md(String((it.input && it.input.plan) || ""));
    const el = h("details", { class: "m-plan", open: true }, h("summary", {}, h("span", { class: "tname" }, "Plan"),
      state), body);
    if (it.id) chat.tools.set(it.id, { el, state, body, plan: true });
    log.append(el);
    return;
  }
  if (it.k === "tool" || it.k === "thinking") {
    const g = stepsGroup();
    g.n++;
    if (it.k === "tool") g.names.set(it.name, (g.names.get(it.name) || 0) + 1);
    stepsLabel(g);
    log = g.body;
  } else if (it.k !== "result") closeSteps();
  if (it.k === "user") {
    log.append(userBubble(it.text, when(it.t)));
  } else if (it.k === "text") {
    const el = h("div", { class: "m-text" });
    el.innerHTML = md(it.text);  // md() escapes all of the text: see esc()
    hydratePrs();
    log.append(el);
    log.append(answerActs(it));
  } else if (it.k === "thinking") {
    log.append(h("details", { class: "m-think" }, h("summary", {}, "Thinking"),
      h("div", { class: "tbody" }, h("pre", {}, it.text))));
  } else if (it.k === "tool") {
    const state = h("span", { class: "tstate run" }, "…");
    const body = h("div", { class: "tbody" }, toolInput(it));
    const el = h("details", { class: "m-tool" },
      h("summary", {}, h("span", { class: "tname" }, it.name), h("span", { class: "tsum" }, it.summary), state), body);
    if (it.id) chat.tools.set(it.id, { el, state, body, it });
    log.append(el);
  } else if (it.k === "result") {
    const t = chat.tools.get(it.id);
    if (!t) return;
    t.done = true;
    if (t.plan) {
      const text = it.text || "", ok = !it.error;
      t.state.className = "tstate " + (ok ? "ok" : "bad");
      t.state.textContent = ok ? "✓ approved" : "changes asked";
      if (!ok) {
        t.el.open = false;
        if (text) t.el.append(h("div", { class: "pc-said" }, text));
      }
      return;
    }
    t.state.className = "tstate " + (it.error ? "bad" : "ok");
    const g = t.el.closest(".m-steps");
    if (it.error && g) { g._g.errors++; stepsLabel(g._g); }
    t.state.textContent = it.error ? "✗ error" : "✓";
    t.body.append(h("div", { class: "lbl" }, it.error ? "Error" : "Result"),
      h("pre", { class: it.error ? "err" : "" }, it.text ? linkNodes(it.text) : "(no output)"));
  } else if (it.k === "cmd") {
    log.append(h("div", { class: "m-cmd" }, it.text));
  } else if (it.k === "note") {
    const el = h("div", { class: "m-note" });
    el.innerHTML = mdInline(it.text);  // escaped by mdInline: see esc()
    log.append(el);
  }
}

/** A diff of two texts, line by line: what goes (−) and what comes (+). @param {any} pre */
function diffLines(pre, oldS, newS) {
  for (const l of String(oldS ?? "").split("\n")) pre.append(h("span", { class: "del" }, "- " + l + "\n"));
  for (const l of String(newS ?? "").split("\n")) pre.append(h("span", { class: "add" }, "+ " + l + "\n"));
}

/** What a call was asked to do, readable: a command, a diff, a file. @param {any} it */
function toolInput(it) {
  const inp = it.input || {};
  if (it.name === "Bash" && inp.command) {
    return [inp.description ? h("div", { class: "lbl" }, inp.description) : null,
      h("pre", {}, linkNodes("$ " + inp.command))];
  }
  if ((it.name === "Edit" || it.name === "MultiEdit") && (inp.old_string != null || inp.edits)) {
    const pre = h("pre", {});
    const edits = Array.isArray(inp.edits) ? inp.edits : [{ old_string: inp.old_string, new_string: inp.new_string }];
    for (const e of edits) diffLines(pre, e.old_string, e.new_string);
    return [h("div", { class: "lbl" }, inp.file_path || ""), pre];
  }
  if (it.name === "edit_file" && Array.isArray(inp.edits)) {
    const pre = h("pre", {});
    for (const e of inp.edits) {
      if (!e || typeof e !== "object") continue;
      if (e.startLine != null) pre.append(h("span", {}, "lines " + e.startLine + "–" + e.endLine + ":\n"));
      diffLines(pre, e.oldString ?? "", e.newString);
    }
    return [h("div", { class: "lbl" }, inp.path || ""), pre];
  }
  if ((it.name === "Write" || it.name === "write_file") && inp.content != null) {
    return [h("div", { class: "lbl" }, inp.file_path || inp.path || ""), h("pre", {}, String(inp.content))];
  }
  const keys = Object.keys(inp);
  if (!keys.length) return [];
  return [h("pre", {}, keys.map((k) => k + ": " + (typeof inp[k] === "string" ? inp[k] : JSON.stringify(inp[k])))
    .join("\n"))];
}

// ---- the cards: Claude's questions, its plan, and the calls it asks to make
const ASK_VERB = { Bash: "run a command", Edit: "edit a file", MultiEdit: "edit a file", Write: "write a file",
  NotebookEdit: "edit a notebook", WebFetch: "fetch a page", WebSearch: "search the web", Read: "read a file",
  Glob: "list files", Grep: "search files" };

/** @param {string} id @param {any} body */
async function sendAnswer(id, body) {
  try {
    await api("POST", "/api/answer", { paper: chat.paper, id, ...body });
  } catch (e) { flash(/** @type {Error} */ (e).message, 6000); }
  chat.askKey = "";
  pollSoon();
}

/** @param {any} a @param {any} more */
function askQuestions(a, more) {
  const qs = (a.input && a.input.questions) || [];
  /** @type {Set<string>[]} */
  const picks = qs.map(() => new Set());
  /** @type {string[]} */
  const others = qs.map(() => "");
  const submit = h("button", { type: "button", class: "primary", disabled: true }, "Submit");
  const ready = () => { submit.disabled = !qs.every((/** @type {any} */ q, /** @type {number} */ i) => picks[i].size || others[i].trim()); };
  /** @type {any[]} */
  const blocks = qs.map((/** @type {any} */ q, /** @type {number} */ i) => {
    const name = "ask-" + a.id + "-" + i, multi = !!q.multiSelect;
    const rows = (q.options || []).map((/** @type {any} */ o) => {
      const box = h("input", { type: multi ? "checkbox" : "radio", name, value: o.label });
      const row = h("label", { class: "opt" }, box, h("span", {}, o.label,
        o.description && o.description !== o.label ? h("span", { class: "d" }, o.description) : null));
      box.addEventListener("change", () => {
        if (!multi) { picks[i].clear(); others[i] = ""; }
        if (box.checked) picks[i].add(o.label); else picks[i].delete(o.label);
        blocks[i].querySelectorAll(".opt").forEach((/** @type {any} */ x) => x.classList.toggle("on", x.querySelector("input").checked));
        if (!multi) blocks[i].querySelector(".other input[type=text]").value = "";
        ready();
      });
      return row;
    });
    const otherText = h("input", { type: "text", placeholder: "Something else: type it", "aria-label": "Other answer" });
    otherText.addEventListener("input", () => {
      others[i] = otherText.value;
      if (!multi && otherText.value) {
        picks[i].clear();
        blocks[i].querySelectorAll(".opt input").forEach((/** @type {any} */ x) => { x.checked = false; });
        blocks[i].querySelectorAll(".opt").forEach((/** @type {any} */ x) => x.classList.remove("on"));
      }
      ready();
    });
    rows.push(h("label", { class: "opt other" }, h("span", { class: "small" }, "✎"), otherText));
    return h("div", { class: "q" }, h("div", { class: "qh" }, q.header ? h("span", { class: "chip" }, q.header) : null,
      h("span", { class: "qt" }, q.question)), ...rows);
  });
  submit.onclick = () => {
    /** @type {Record<string, string>} */
    const answers = {};
    qs.forEach((/** @type {any} */ q, /** @type {number} */ i) => {
      const chosen = (q.options || []).map((/** @type {any} */ o) => o.label).filter((/** @type {string} */ l) => picks[i].has(l));
      if (others[i].trim()) chosen.push(others[i].trim());
      answers[q.question] = chosen.join(", ");
    });
    sendAnswer(a.id, { decision: "allow", answers });
  };
  const skip = h("button", { type: "button", onclick: () => sendAnswer(a.id, { decision: "deny" }) }, "Skip");
  return [h("div", { class: "ah" }, qs.length > 1 ? "Claude has " + qs.length + " questions" : "Claude asks", more),
    ...blocks, h("div", { class: "btns" }, submit, skip)];
}

const PLAN_MODES = [["acceptEdits", "Approve, accept edits"], ["default", "Approve, ask before edits"],
  ["auto", "Approve, auto mode"]];
/** @param {any} a @param {any} more */
function planCard(a, more) {
  const body = h("div", { class: "m-text plan-md" });
  body.innerHTML = md(String((a.input && a.input.plan) || ""));
  const note = h("textarea", { placeholder: "What should change in the plan? (Keep planning sends it to Claude)" });
  return [h("div", { class: "ah" }, "Claude's plan", more), body,
    h("div", { class: "btns" }, ...PLAN_MODES.map(([mode, label], i) => h("button", { type: "button",
      class: i === 0 ? "primary" : "", onclick: () => sendAnswer(a.id, { decision: "allow", mode }) }, label))),
    note,
    h("div", { class: "btns" }, h("button", { type: "button", onclick: () =>
      sendAnswer(a.id, { decision: "deny", message: note.value.trim() || undefined }) }, "Keep planning"))];
}

/** @param {any} a @param {any} more */
function permCard(a, more) {
  const inp = a.input || {};
  const verb = ASK_VERB[/** @type {keyof typeof ASK_VERB} */ (a.tool)] || "use " + a.tool;
  const details = a.tool === "Bash" || a.tool === "Edit" || a.tool === "MultiEdit" || a.tool === "Write" ||
    a.tool === "edit_file" || a.tool === "write_file"
    ? toolInput({ name: a.tool, input: inp })
    : a.tool === "WebFetch" ? [h("div", { class: "path" }, String(inp.url || "")), inp.prompt ? h("div", { class: "desc" }, String(inp.prompt)) : null]
      : toolInput({ name: a.tool, input: inp });
  const why = h("input", { type: "text", placeholder: "Deny, and tell Claude why or what to do instead" });
  const deny = () => sendAnswer(a.id, { decision: "deny", message: why.value.trim() || undefined });
  why.addEventListener("keydown", (/** @type {KeyboardEvent} */ e) => { if (e.key === "Enter") { e.preventDefault(); deny(); } });
  return [h("div", { class: "ah" }, "Claude wants to " + verb, h("span", { class: "tool" }, a.tool), more),
    a.reason ? h("div", { class: "why" }, a.reason) : null,
    a.blockedPath ? h("div", { class: "path" }, "Outside the allowed folders: " + a.blockedPath) : null,
    ...details,
    h("div", { class: "btns" },
      h("button", { type: "button", class: "primary", onclick: () => sendAnswer(a.id, { decision: "allow" }) }, "Allow"),
      a.always ? h("button", { type: "button", title: "Adds: " + a.always.join(", "),
        onclick: () => sendAnswer(a.id, { decision: "always" }) }, "Always allow") : null,
      h("button", { type: "button", class: "danger", onclick: deny }, "Deny")),
    a.always ? h("div", { class: "rules" }, "Always allow adds: " + a.always.join(", ")) : null,
    h("div", { class: "deny-box" }, why)];
}

/** @param {any} r */
function renderAsks(r) {
  const el = $("#c-ask"), asks = r.asks || [];
  const key = asks.map((/** @type {any} */ a) => a.id).join(",");
  if (key === chat.askKey) return;
  chat.askKey = key;
  el.hidden = !asks.length;
  el.classList.toggle("plan", !!asks.length && asks[0].kind === "plan");
  if (!asks.length) { el.replaceChildren(); return; }
  const a = asks[0], more = asks.length > 1 ? h("span", { class: "more" }, "1 of " + asks.length) : null;
  el.replaceChildren(...(a.kind === "question" ? askQuestions(a, more) : a.kind === "plan" ? planCard(a, more)
    : permCard(a, more)).filter(Boolean));
}

// ---- polling
function pollSoon() { for (const ms of [150, 500]) setTimeout(() => pollChat(), ms); }

export async function pollChat(first) {
  const paper = chat.paper, gen = chat.gen;
  if (!paper) return;
  clearTimeout(chat.timer);
  /** @type {any} */
  let r = null;
  try {
    r = await api("GET", "/api/chat?paper=" + encodeURIComponent(paper) + "&offset=" + chat.offset +
      (chat.epoch ? "&epoch=" + chat.epoch : ""));
  } catch (e) {
    if (gen === chat.gen) {
      $("#c-badge").className = "badge bad"; $("#c-badge").textContent = "unreachable";
      chat.timer = setTimeout(() => pollChat(), 4000);
    }
    return;
  }
  if (gen !== chat.gen) return;
  if (r.restart && chat.offset > 0) { $("#c-log").replaceChildren(); chat.tools.clear(); }
  chat.epoch = r.epoch;
  const sc = $("#c-scroll");
  const live = $("#c-log .m-text.live");
  if (live) live.remove();
  for (const it of r.items) addItem(it);
  chat.offset = r.next;
  if (r.live) {
    const el = h("div", { class: "m-text live" });
    el.innerHTML = md(r.live);
    $("#c-log").append(el);
  }
  if (first) { $("#c-log").scrollTop = 0; sc.scrollTop = sc.scrollHeight; }
  chat.last = r;
  renderAsks(r);
  renderStatus(r);
  renderQueue(r);
  updateHead(r);
  updatePills(r);
  updateSendBtn();
  if (first && !r.items.length && !r.live) showIntro();
  const working = r.status === "working" || r.status === "starting" || r.status === "waiting";
  chat.timer = setTimeout(() => pollChat(), working ? 500 : 1500);
}

/** The chat's empty state: what to ask, and whether the chat can run at all. */
function showIntro() {
  const st = S.state, p = st && st.papers.find((/** @type {any} */ x) => x.id === chat.paper);
  if (!p) return;
  const sdk = st.sdk && !st.sdk.ok
    ? h("div", { class: "err", id: "c-sdk" }, h("span", {}, "The chat is off: " + st.sdk.error)) : null;
  $("#c-log").append(h("div", { class: "home" }, h("h2", {}, p.title || p.id),
    h("p", {}, "Claude works on this paper with every Claude Code tool and the web-latex-mcp ones; the PDF " +
      "beside the chat reloads on each compile. Try:"),
    h("ul", {}, h("li", {}, "“Compile and tell me what the warnings mean”"),
      h("li", {}, "“Tighten the abstract to 150 words”"), h("li", {}, h("code", {}, "/review-writing"),
        " or ", h("code", {}, "/hunt-typo"), " (type / for the commands)")),
    sdk));
}

const STATUS = { off: ["idle", "idle"], idle: ["ok", "idle"], starting: ["busy", "starting"],
  working: ["busy", "working"], waiting: ["warn", "waiting for you"] };
/** @param {any} r */
function updateHead(r) {
  const [cls, text] = STATUS[/** @type {keyof typeof STATUS} */ (r.status)] || STATUS.off;
  $("#c-badge").className = "badge " + cls;
  $("#c-badge").textContent = text;
  $("#c-working").hidden = true;
}

// ---- the working line: one of cc-servers' animations, a new one now and then
function fmtElapsed(/** @type {number} */ ms) {
  const s = Math.max(0, Math.round(ms / 1000)), m = Math.floor(s / 60);
  return m >= 60 ? Math.floor(m / 60) + "h " + (m % 60) + "min" : m ? m + "min " + (s % 60) + "s" : s + "s";
}
const SPINS = ["dots4", "star", "bounce", "orbit", "bars", "breathe", "ripple", "comet", "square", "wave", "flip"];
function nextSpin(/** @type {number} */ now) {
  const others = SPINS.filter((x) => x !== chat.spin);
  chat.spin = others[Math.floor(Math.random() * others.length)];
  chat.spinAt = now;
  chat.spinFor = 25000 + Math.random() * 35000;
  $("#c-status .spin").className = "spin " + chat.spin;
}
/** @param {any} r */
function renderStatus(r) {
  const working = r.status === "working" || r.status === "starting";
  const el = $("#c-status");
  el.hidden = !working;
  if (!working) { chat.spin = null; return; }
  const now = Date.now();
  if (!chat.spin || now - chat.spinAt > chat.spinFor) nextSpin(now);
  const parts = [];
  if (r.busySince) parts.push(fmtElapsed(now - r.busySince));
  parts.push(r.status === "starting" ? "Starting Claude" : r.live ? "Writing" : "Working");
  $("#c-status-txt").textContent = parts.join("  ·  ");
}

/** @param {any} r */
function renderQueue(r) {
  const ul = $("#c-queue"), q = r.queued || [];
  ul.hidden = !q.length;
  ul.replaceChildren(...q.map((/** @type {string} */ t) => h("li", {}, h("span", { class: "q" }, "next step"),
    h("span", { class: "txt", title: t }, t))));
}

// ---- sending
export async function chatSend() {
  const input = $("#c-input"), text = input.value;
  if (!text.trim() || !chat.paper) return;
  if (chat.picker.on && pickerKey({ key: "Enter", preventDefault() {} })) return;
  const working = !!chat.last && (chat.last.status === "working" || chat.last.status === "waiting");
  liftText(input);
  const isCmd = /^\/[\w:-]+(\s|$)/.test(text.trim());
  if (!isCmd) {
    const pending = userBubble(text, working ? "Claude reads it at its next step" : "", true);
    pending.classList.add("arrive");
    pending._t0 = performance.now();
    pending.addEventListener("animationend", () => pending.classList.remove("arrive"), { once: true });
    $("#c-log").append(pending);
    chat.pending.push({ text: text.trim(), el: pending });
  }
  input.value = "";
  saveDraft();
  growInput();
  pickerClose();
  const sc = $("#c-scroll");
  sc.scrollTo({ top: sc.scrollHeight, behavior: "smooth" });
  try {
    await api("POST", "/api/chat", { paper: chat.paper, text });
    pollSoon();
  } catch (e) {
    const p = chat.pending.find((x) => x.text === text.trim());
    if (p) { p.el.remove(); chat.pending = chat.pending.filter((x) => x !== p); }
    if (!input.value) { input.value = text; growInput(); saveDraft(); }
    flash(/** @type {Error} */ (e).message, 8000);
  }
}

// The text leaves the box: a copy of it, where it was typed, that rises and fades while the box empties
/** @param {any} input */
function liftText(input) {
  if (!input.value.trim() || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const r = input.getBoundingClientRect(), cs = getComputedStyle(input);
  const g = h("div", { class: "send-ghost", "aria-hidden": "true" }, input.value);
  Object.assign(g.style, { left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px",
    font: cs.font, lineHeight: cs.lineHeight, letterSpacing: cs.letterSpacing,
    padding: `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}` });
  document.body.append(g);
  g.scrollTop = input.scrollTop;
  input.classList.add("lifting");
  setTimeout(() => input.classList.remove("lifting"), 220);
  g.addEventListener("animationend", () => g.remove(), { once: true });
  setTimeout(() => g.remove(), 600);
}

const NATIVE_GROW = window.CSS && CSS.supports && CSS.supports("field-sizing", "content");
export function growInput() {
  if (NATIVE_GROW) return;
  const t = $("#c-input");
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight + 2, window.innerHeight * 0.4) + "px";
}

// One button for both, as in claude.ai: while Claude works and the box is empty, it stops it (Esc)
function stopMode() {
  const r = chat.last;
  return !!r && !$("#c-input").value.trim() && (r.status === "working" || r.status === "starting" ||
    r.status === "waiting");
}
export function updateSendBtn() {
  const b = $("#c-send"), stop = stopMode();
  b.classList.toggle("stop", stop);
  const r = chat.last, queues = !!r && r.status === "working";
  b.title = stop ? "Interrupt (Esc): stops what Claude is doing"
    : queues ? "Send (Enter): Claude reads it at its next step" : "Send (Enter)";
  b.setAttribute("aria-label", stop ? "Interrupt" : "Send");
  const icon = stop ? "stop" : "enter";
  if (b.dataset.icon !== icon) { b.dataset.icon = icon; b.innerHTML = ICONS[icon]; }
}
export async function interrupt() {
  if (!chat.paper) return;
  try { await api("POST", "/api/chat", { paper: chat.paper, interrupt: true }); } catch (e) {
    flash(/** @type {Error} */ (e).message, 6000);
  }
  pollSoon();
}

// ---- drafts: what is typed in a paper's box, kept when another paper is opened (this browser)
const DRAFT = "wlm-draft-";
export function saveDraft() {
  if (!chat.paper) return;
  try {
    const v = $("#c-input").value;
    if (v.trim()) localStorage.setItem(DRAFT + chat.paper, v); else localStorage.removeItem(DRAFT + chat.paper);
  } catch (e) { /* no storage */ }
}
function loadDraft() {
  let v = "";
  try { v = (chat.paper && localStorage.getItem(DRAFT + chat.paper)) || ""; } catch (e) { /* none */ }
  $("#c-input").value = v;
  growInput();
}

// ---- the command picker: type / for the skills and commands (from the running Claude, else its last list)
async function loadCommands() {
  if (chat.commands) return chat.commands;
  try { chat.commands = (await api("GET", "/api/commands")).commands || []; } catch (e) { chat.commands = []; }
  setTimeout(() => { chat.commands = null; }, 60000);
  return chat.commands;
}
export async function pickerUpdate() {
  const v = $("#c-input").value;
  const m = v.match(/^\/([\w:-]*)$/);
  if (!m) { pickerClose(); return; }
  const all = await loadCommands();
  const q = m[1].toLowerCase();
  const rows = (all || []).filter((c) => c.name.toLowerCase().includes(q))
    .sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)))
    .slice(0, 40);
  chat.picker.on = true;
  chat.picker.rows = rows;
  chat.picker.sel = Math.min(chat.picker.sel, Math.max(0, rows.length - 1));
  renderPicker();
}
function renderPicker() {
  const ul = $("#c-picker"), rows = chat.picker.rows;
  ul.hidden = false;
  ul.replaceChildren(...(rows.length ? rows.map((c, i) => h("li", { class: i === chat.picker.sel ? "sel" : "",
    onmousedown: (/** @type {Event} */ e) => { e.preventDefault(); pickCommand(c); } },
  h("span", { class: "cmd" }, "/" + c.name + (c.argumentHint ? " " + c.argumentHint : "")),
  h("span", { class: "desc", title: c.description || "" }, c.description || "")))
    : [h("li", { class: "none" }, chat.commands && chat.commands.length ? "no matching command" :
      "The commands are listed once Claude has started: send a first message")]));
}
/** @param {any} c */
function pickCommand(c) {
  $("#c-input").value = "/" + c.name + " ";
  pickerClose();
  $("#c-input").focus();
}
export function pickerClose() { chat.picker.on = false; chat.picker.sel = 0; $("#c-picker").hidden = true; }
/** @param {{ key: string, preventDefault(): void }} e @returns {boolean} whether the picker took the key */
export function pickerKey(e) {
  if (!chat.picker.on) return false;
  const rows = chat.picker.rows;
  if (e.key === "Escape") { e.preventDefault(); pickerClose(); return true; }
  if (!rows.length) return false;
  if (e.key === "ArrowDown") chat.picker.sel = (chat.picker.sel + 1) % rows.length;
  else if (e.key === "ArrowUp") chat.picker.sel = (chat.picker.sel + rows.length - 1) % rows.length;
  else if (e.key === "Tab" || e.key === "Enter") {
    const c = rows[chat.picker.sel];
    const typed = $("#c-input").value.trim();
    if (e.key === "Enter" && typed === "/" + c.name) { pickerClose(); return false; }  // complete: send it
    e.preventDefault();
    pickCommand(c);
    return true;
  } else return false;
  e.preventDefault();
  renderPicker();
  return true;
}

// ---- model, effort and mode menus (as claude.ai's)
const pop = { /** @type {string | null} */ kind: null };
export function closePop() { $("#c-pop").hidden = true; $("#c-pop2").hidden = true; pop.kind = null; }
/** @param {string} kind @param {string | null} head @param {any[]} rows */
function showPop(kind, head, rows) {
  pop.kind = kind;
  const el = $("#c-pop");
  const kids = head ? [h("div", { class: "ph" }, head)] : [];
  rows.forEach((o, i) => {
    if (o.sep) kids.push(h("hr", {}));
    kids.push(h("button", { type: "button", class: "row", role: "menuitem", onclick: (/** @type {Event} */ e) => {
      e.stopPropagation(); o.go();
    }, onmouseenter: o.side ? () => o.go() : () => { if (pop.kind === "model") $("#c-pop2").hidden = true; } },
    h("span", { class: "what" }, o.label, o.desc ? h("span", { class: "d" }, o.desc) : null),
    o.val ? h("span", { class: "val" }, o.val + " ›") : null,
    h("span", { class: "ck" }, o.on ? "✓" : ""),
    h("span", { class: "num" }, o.num === undefined ? (i < 9 ? String(i + 1) : "") : o.num)));
  });
  el.replaceChildren(...kids);
  el.hidden = false;
}

const MODELS = [["", "Default", "Your account's default model"], ["fable", "Fable"], ["opus", "Opus"],
  ["sonnet", "Sonnet"], ["haiku", "Haiku"]];
const EFFORT_LABEL = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra", max: "Max" };
const EFFORT_ROWS = ["low", "medium", "high", "xhigh", "max"];
const MODE_ROWS = [
  ["default", "Manual", "Ask before edits and commands", "manual mode"],
  ["acceptEdits", "Accept edits", "Accept file edits; still ask for commands", "accept edits"],
  ["plan", "Plan", "Make a plan before changing anything", "plan mode"],
  ["auto", "Auto", "Claude handles the permission decisions", "auto mode"],
];

/** @param {any} patch @param {string} label */
async function setSetting(patch, label) {
  closePop();
  try {
    await api("POST", "/api/chat", { paper: chat.paper, ...patch });
    flash(label, 2500);
  } catch (e) { flash(/** @type {Error} */ (e).message, 7000); }
  pollSoon();
}

/** The model the pill names: the one set for this paper, else the one Claude runs. @param {string} [m] */
function modelLabel(m) {
  if (!m) return "Default";
  const known = MODELS.find(([id]) => id && m.toLowerCase().includes(id));
  return known ? known[1] : m;
}

export function openModelPop() {
  if (pop.kind === "model") { closePop(); return; }
  const r = chat.last || {};
  const cur = r.model || "";
  showPop("model", null, [...MODELS.map(([id, label, desc]) => ({ label, desc,
    on: id ? cur.toLowerCase().includes(id) : !cur,
    go: () => setSetting({ model: id }, "Model: " + label + (r.status === "working" ? " (after this turn)" : "")) })),
  { label: "Effort", val: EFFORT_LABEL[/** @type {keyof typeof EFFORT_LABEL} */ (r.effort)] || "Default", sep: true,
    num: "", side: true, go: openEffortPanel }]);
}
function openEffortPanel() {
  const r = chat.last || {}, el = $("#c-pop2");
  const kids = [h("div", { class: "ph" }, "Higher effort means more thorough answers, but takes longer and " +
    "uses your limits faster.")];
  ["", ...EFFORT_ROWS].forEach((e, i) => {
    kids.push(h("button", { type: "button", class: "row", role: "menuitemradio",
      onclick: () => setSetting({ effort: e }, "Effort: " + (EFFORT_LABEL[/** @type {keyof typeof EFFORT_LABEL} */ (e)] || "default")) },
    h("span", { class: "what" }, e ? EFFORT_LABEL[/** @type {keyof typeof EFFORT_LABEL} */ (e)] : "Default",
      e === "medium" ? h("span", { class: "badge2" }, "Recommended") : null,
      e === "max" ? h("span", { class: "badge2 warn" }, "⚠ Uses your limits much faster") : null),
    h("span", { class: "ck" }, e === (r.effort || "") ? "✓" : ""), h("span", { class: "num small" }, String(i + 1))));
  });
  el.replaceChildren(...kids);
  el.style.left = "";
  el.style.right = ($("#c-pop").offsetWidth + 8) + "px";
  el.hidden = false;
}
export function openModePop() {
  if (pop.kind === "mode") { closePop(); return; }
  const cur = (chat.last && chat.last.mode) || "default";
  showPop("mode", "Permission mode, for this paper", MODE_ROWS.map(([id, label, desc, said]) => ({ label, desc,
    on: id === cur, go: () => setSetting({ mode: id }, said + " on") })));
}

/** @param {any} r */
function updatePills(r) {
  $("#c-model-btn").textContent = modelLabel(r.model) +
    (r.effort ? " · " + (EFFORT_LABEL[/** @type {keyof typeof EFFORT_LABEL} */ (r.effort)] || r.effort) : "");
  const mode = MODE_ROWS.find(([id]) => id === (r.mode || "default"));
  $("#c-mode-btn").textContent = mode ? mode[1] : r.mode;
  const c = r.context, btn = $("#c-ctx-btn");
  btn.hidden = !c;
  if (c) {
    const pct = Math.min(100, Math.round(100 * c.tokens / c.window));
    const fill = $("#c-ctx-fill");
    fill.style.width = pct + "%";
    fill.className = pct >= 85 ? "bad" : pct >= 65 ? "warn" : "";
    $("#c-ctx-pct").textContent = pct + "%";
    btn.title = "Context: " + fmtTokens(c.tokens) + " of " + fmtTokens(c.window) + " tokens" +
      (r.costUsd ? " · $" + r.costUsd.toFixed(2) + " this run" : "");
  }
}
/** @param {number} n */
function fmtTokens(n) { return n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1000 ? Math.round(n / 1000) + "k" : String(n); }

// ---- opening a paper
/** @param {string | null} paper */
export function openChat(paper) {
  saveDraft();
  chat.gen++;
  clearTimeout(chat.timer);
  chat.paper = paper;
  chat.offset = 0;
  chat.epoch = null;
  chat.tools.clear();
  chat.pending = [];
  chat.last = null;
  chat.askKey = "";
  $("#c-log").replaceChildren();
  $("#c-ask").hidden = true;
  $("#c-queue").hidden = true;
  $("#c-status").hidden = true;
  closePop();
  pickerClose();
  if (!paper) return;
  loadDraft();
  pollChat(true);
}

export async function resetChat() {
  if (!chat.paper) return;
  if (!confirm("Start a new conversation on this paper? The current one is set aside (kept on disk).")) return;
  try { await api("POST", "/api/chat", { paper: chat.paper, reset: true }); } catch (e) {
    flash(/** @type {Error} */ (e).message, 6000); return;
  }
  openChat(chat.paper);
}

// ---- wiring
export function wireChat() {
  $("#c-scroll").addEventListener("scroll", () => {
    const sc = $("#c-scroll");
    chat.stick = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 80;
  }, { passive: true });
  if (window.ResizeObserver) {
    const keep = () => { const sc = $("#c-scroll"); if (chat.stick) sc.scrollTop = sc.scrollHeight; };
    new ResizeObserver(keep).observe($("#c-scroll"));
    new ResizeObserver(keep).observe($("#c-log"));
  }
  $("#c-box").addEventListener("submit", (/** @type {Event} */ e) => { e.preventDefault(); chatSend(); });
  $("#c-input").addEventListener("keydown", (/** @type {KeyboardEvent} */ e) => {
    if (e.isComposing) return;
    if (["ArrowUp", "ArrowDown", "Tab", "Escape"].includes(e.key) || (e.key === "Enter" && !e.shiftKey)) {
      if (pickerKey(e)) return;
    }
    if (e.key === "Escape" && stopMode()) { e.preventDefault(); interrupt(); return; }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); chatSend(); }
  });
  $("#c-input").addEventListener("input", () => { growInput(); updateSendBtn(); pickerUpdate(); saveDraft(); });
  $("#c-send").addEventListener("click", (/** @type {Event} */ e) => {
    if (!stopMode()) return;
    e.preventDefault();
    interrupt();
  }, true);
  $("#c-add").onclick = () => {
    const t = $("#c-input");
    if (!t.value.startsWith("/")) t.value = "/" + t.value;
    t.focus();
    pickerUpdate();
  };
  $("#c-model-btn").onclick = (/** @type {Event} */ e) => { e.stopPropagation(); openModelPop(); };
  $("#c-mode-btn").onclick = (/** @type {Event} */ e) => { e.stopPropagation(); openModePop(); };
  document.addEventListener("click", (e) => {
    if (pop.kind && !e.composedPath().some((x) => x === $("#c-pop") || x === $("#c-pop2"))) closePop();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && pop.kind) closePop();
    // Esc anywhere but in a field (and with no menu open) stops Claude, as in claude.ai
    const a = document.activeElement;
    const inField = a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a !== $("#c-input");
    if (e.key === "Escape" && a !== $("#c-input") && !inField && stopMode() && !pop.kind &&
        $("#row-menu").hidden) {
      interrupt();
    }
  });
  $("#c-log").addEventListener("click", (/** @type {any} */ e) => {  // a code block's copy button
    const b = e.target.closest(".code > .cp");
    if (!b) return;
    const text = b.parentElement.querySelector("pre").innerText;
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject(new Error()))
      .then(() => { b.classList.add("done"); setTimeout(() => b.classList.remove("done"), 1200); })
      .catch(() => prompt("The code:", text));
  });
}
