// @ts-check
// The side bar: the papers, in their groups (folders), each with its labels and the state of its
// Claude. Ported from cc-servers' session side bar (renderSide, sideBlock, sideRow, sortable,
// beginDrag): a group is what a project is there, a paper what a session is.
import { $, h, api, dot, flash, sideStore, hue, S } from "./dom.js";

export const side = {
  /** @type {Set<string>} groups folded */ closed: new Set(),
  /** @type {string | null} the label the list is filtered on */ label: null,
  key: "",
  /** @type {any} */ drag: null,
  pressing: false,
  pendingRender: false,
  justDropped: false,
  /** @type {(id: string) => void} */ onOpen: () => {},
  /** @type {() => Promise<void>} */ refresh: async () => {},
  /** @type {((id: string, name: string) => void) | null} the ⋯ menu's Reset conversation */ resetPaper: null,
};
(() => {
  const c = sideStore("closed");
  if (Array.isArray(c)) c.forEach((n) => side.closed.add(n));
  if (sideStore("off") === true) document.body.classList.add("side-off");
})();

const NO_GROUP = "";
const STATUS_DOT = { off: "ended", idle: "idle", starting: "busy", working: "busy", waiting: "waiting" };
const STATUS_TEXT = { off: "", idle: "idle", starting: "starting", working: "working", waiting: "waiting for you" };

/** @param {any} p */
export function paperTitle(p) { return p.title || p.id; }

/** @param {string} l */
export function labelChip(l, on, onclick) {
  const props = { class: "lab" + (on ? " on" : ""), style: "--h: " + hue(l), title: onclick ? "Show only " + l : l };
  return onclick ? h("button", { type: "button", ...props, onclick }, l) : h("span", props, l);
}

/** @param {any} p */
function sideRow(p) {
  const kind = STATUS_DOT[p.status] || "ended";
  const what = [p.title ? p.id : null, p.mode === "local" ? "local folder" : null,
    p.cloned ? null : (p.mode === "local" ? "folder missing" : "not cloned yet"), STATUS_TEXT[p.status] || null]
    .filter(Boolean).join(" · ");
  const a = h("a", { class: "s-row" + (p.id === S.paper ? " active" : ""), href: "#paper/" + encodeURIComponent(p.id),
    title: paperTitle(p) + (what ? "\n" + what : "") + (p.gitUrl ? "\n" + p.gitUrl : ""),
    onclick: () => document.body.classList.remove("side-open") },
  h("span", { class: "txt" }, h("div", { class: "t" }, paperTitle(p)),
    p.labels.length ? h("div", { class: "labs" }, p.labels.map((/** @type {string} */ l) => labelChip(l))) :
      what ? h("div", { class: "sub" }, what) : null),
  h("span", { class: "end" }, dot(kind),
    h("button", { type: "button", class: "more", title: "Rename, group, labels…", "aria-label": "Paper menu",
      onclick: (/** @type {any} */ e) => { e.preventDefault(); e.stopPropagation(); paperMenu(p, e.currentTarget); } },
    "⋯")));
  const li = h("li", { class: "s-li" }, a);
  sortable(a, li, "paper", p.id);
  return li;
}

/** @param {{ id: string, name: string } | null} g @param {any[]} papers @param {boolean} filtering */
function sideBlock(g, papers, filtering) {
  const gid = g ? g.id : NO_GROUP;
  const open = filtering || !side.closed.has(gid);
  const waiting = papers.filter((p) => p.status === "waiting").length;
  const working = papers.filter((p) => p.status === "working" || p.status === "starting").length;
  const cnt = waiting ? waiting + " waiting" : working ? working + " working" : String(papers.length);
  const head = h("button", { type: "button", class: "s-ph", title: g ? g.name : "Papers in no group",
    onclick: () => {
      if (side.closed.has(gid)) side.closed.delete(gid); else side.closed.add(gid);
      sideStore("closed", [...side.closed]);
      side.key = "";
      renderSide();
    } },
  h("span", { class: "pname" }, g ? g.name : "No group"),
  h("span", { class: "caret" + (open ? " open" : "") }, "⌄"),
  h("span", { class: "cnt" + (waiting ? " attn" : "") }, cnt));
  const kids = [h("div", { class: "s-phrow" }, head, g ? h("button", { type: "button", class: "add",
    title: "Rename or delete the group", "aria-label": "Group menu",
    onclick: (/** @type {any} */ e) => { e.stopPropagation(); groupMenu(g, e.currentTarget); } }, "⋯") : null)];
  const rows = open ? papers.map(sideRow) : papers.filter((p) => p.id === S.paper).map(sideRow);
  kids.push(h("ul", { class: "s-rows" }, rows));
  if (open && !papers.length) kids.push(h("div", { class: "s-none" }, "Drag a paper here"));
  const block = h("div", { class: "s-proj" + (g ? "" : " ungrouped"), "data-gid": gid }, kids);
  if (g) sortable(head, block, "group", g.id);
  return block;
}

/** @param {any} p @param {string} f */
function matches(p, f) {
  if (side.label && !p.labels.includes(side.label)) return false;
  if (!f) return true;
  return p.id.toLowerCase().includes(f) || (p.title || "").toLowerCase().includes(f) ||
    p.labels.some((/** @type {string} */ l) => l.toLowerCase().includes(f));
}

export function renderSide() {
  const st = S.state;
  if (!st) return;
  if (side.drag || side.pressing) { side.pendingRender = true; return; }  // not under a pressed or moved row
  const f = $("#s-filter").value.trim().toLowerCase();
  if (side.label && !st.labels.includes(side.label)) side.label = null;
  const key = JSON.stringify([st.papers, st.groups, f, side.label, S.paper, [...side.closed]]);
  if (key === side.key) return;
  side.key = key;
  $("#s-labels").replaceChildren(...st.labels.map((/** @type {string} */ l) => labelChip(l, side.label === l, () => {
    side.label = side.label === l ? null : l;
    side.key = "";
    renderSide();
  })));
  const filtering = !!f || !!side.label;
  const shown = st.papers.filter((/** @type {any} */ p) => matches(p, f));
  const groupIds = new Set(st.groups.map((/** @type {any} */ g) => g.id));
  const out = [];
  for (const g of st.groups) {
    const papers = shown.filter((/** @type {any} */ p) => p.group === g.id);
    if (filtering && !papers.length) continue;
    out.push(sideBlock(g, papers, filtering));
  }
  const loose = shown.filter((/** @type {any} */ p) => !p.group || !groupIds.has(p.group));
  if (loose.length || (!st.groups.length && !filtering)) {
    if (st.groups.length) out.push(sideBlock(null, loose, filtering));
    else out.push(h("ul", { class: "s-rows", "data-gid": NO_GROUP }, loose.map(sideRow)));
  }
  if (!st.papers.length) {
    out.push(h("div", { class: "s-none" }, "No paper yet: + Add paper registers one."));
  } else if (!shown.length) out.push(h("div", { class: "s-none" }, "No paper matches."));
  const list = $("#s-list"), top = list.scrollTop;
  list.replaceChildren(...out);
  list.scrollTop = top;
}

// ---- menus: the ⋯ of a paper or a group (cc-servers' #row-menu)
/** @param {Element} anchor @param {(menu: any) => any[]} build */
export function openMenu(anchor, build) {
  const m = $("#row-menu");
  const fill = () => m.replaceChildren(...build(fill).filter(Boolean));
  fill();
  m.hidden = false;
  const r = anchor.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(r.left, window.innerWidth - m.offsetWidth - 8)) + "px";
  const below = r.bottom + 4, above = r.top - m.offsetHeight - 4;
  m.style.top = (below + m.offsetHeight < window.innerHeight - 8 || above < 8 ? below : above) + "px";
}
export function closeMenu() { $("#row-menu").hidden = true; }
document.addEventListener("click", (e) => {
  const m = $("#row-menu");
  if (!m.hidden && !e.composedPath().includes(m)) closeMenu();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });

/** @param {any} body @param {string} [ok] */
export async function papersOp(body, ok) {
  try {
    await api("POST", "/api/papers", body);
    if (ok) flash(ok, 2000);
  } catch (e) { flash(/** @type {Error} */ (e).message, 6000); }
  await side.refresh();
}

/** @param {string} label @param {() => void} go @param {string} [cls] */
const item = (label, go, cls) => h("button", { type: "button", class: cls || "", role: "menuitem",
  onclick: (/** @type {Event} */ e) => { e.stopPropagation(); go(); } }, label);

/** @param {any} p @param {Element} anchor */
export function paperMenu(p, anchor) {
  let sub = "";
  openMenu(anchor, (redraw) => {
    const st = S.state;
    const rows = [
      item("Rename…", () => { closeMenu(); renamePaper(p); }),
      item("Move to group ›", () => { sub = sub === "group" ? "" : "group"; redraw(); }, "more-sub" + (sub === "group" ? " open" : "")),
    ];
    if (sub === "group") {
      rows.push(...st.groups.map((/** @type {any} */ g) => item(g.name, () => { closeMenu();
        papersOp({ op: "set", paper: p.id, group: g.id }, "Moved to " + g.name); }, "sub tick" + (p.group === g.id ? " on" : ""))),
      item("No group", () => { closeMenu(); papersOp({ op: "set", paper: p.id, group: null }); },
        "sub tick" + (!p.group ? " on" : "")),
      item("New group…", async () => {
        closeMenu();
        const name = prompt("Name of the new group:");
        if (!name || !name.trim()) return;
        try {
          const r = await api("POST", "/api/papers", { op: "group-add", name });
          await papersOp({ op: "set", paper: p.id, group: r.group.id }, "Moved to " + r.group.name);
        } catch (e) { flash(/** @type {Error} */ (e).message, 6000); }
      }, "sub"));
    }
    rows.push(item("Labels ›", () => { sub = sub === "labels" ? "" : "labels"; redraw(); },
      "more-sub" + (sub === "labels" ? " open" : "")));
    if (sub === "labels") {
      const all = [...new Set([...st.labels, ...p.labels])].sort();
      rows.push(...all.map((l) => {
        const on = p.labels.includes(l);
        return item(l, () => {
          p.labels = on ? p.labels.filter((/** @type {string} */ x) => x !== l) : [...p.labels, l];
          papersOp({ op: "set", paper: p.id, labels: p.labels });
          redraw();
        }, "sub tick" + (on ? " on" : ""));
      }));
      const input = h("input", { type: "text", placeholder: "New label, then Enter", maxlength: "40",
        onclick: (/** @type {Event} */ e) => e.stopPropagation(),
        onkeydown: (/** @type {KeyboardEvent} */ e) => {
          const v = /** @type {HTMLInputElement} */ (e.target).value.trim();
          if (e.key !== "Enter" || !v) return;
          e.preventDefault();
          if (!p.labels.includes(v)) p.labels = [...p.labels, v];
          papersOp({ op: "set", paper: p.id, labels: p.labels });
          redraw();
        } });
      rows.push(input);
      setTimeout(() => input.focus(), 0);
    }
    rows.push(h("hr", {}));
    if (side.resetPaper) {
      rows.push(item("Reset conversation…", () => { closeMenu(); side.resetPaper?.(p.id, paperTitle(p)); }));
    }
    rows.push(item("Copy its name (" + p.id + ")", () => {
      closeMenu();
      (navigator.clipboard ? navigator.clipboard.writeText(p.id) : Promise.reject(new Error()))
        .then(() => flash("Copied", 1500)).catch(() => prompt("The paper's name:", p.id));
    }));
    rows.push(item("Remove paper…", () => { closeMenu(); removePaper(p); }, "danger"));
    return rows;
  });
}

/** The ⋯ menu's Remove: unregister_project forgets the paper; no file is deleted. @param {any} p */
async function removePaper(p) {
  const msg = "Remove " + JSON.stringify(paperTitle(p)) + " from the list?\n\nNothing is deleted: its files" +
    (p.path ? " (" + p.path + ")" : "") + " stay on disk, and adding it again under the name " +
    JSON.stringify(p.id) + " picks them up.";
  if (!confirm(msg)) return;
  try {
    await api("POST", "/api/unregister", { paper: p.id });
    flash("Removed: " + p.id, 3000);
    if (location.hash === "#paper/" + encodeURIComponent(p.id)) location.hash = "";
    await side.refresh();
  } catch (e) {
    flash(/** @type {Error} */ (e).message, 6000);
  }
}

/** @param {any} p */
export function renamePaper(p) {
  const t = prompt("Title shown for " + p.id + " (empty: its name):", p.title || "");
  if (t === null) return;
  papersOp({ op: "set", paper: p.id, title: t.trim() || null });
}

/** @param {any} g @param {Element} anchor */
function groupMenu(g, anchor) {
  openMenu(anchor, () => [
    item("Rename…", () => {
      closeMenu();
      const name = prompt("Rename the group:", g.name);
      if (name && name.trim() && name !== g.name) papersOp({ op: "group-rename", id: g.id, name });
    }),
    item("Delete the group", () => {
      closeMenu();
      if (confirm("Delete the group " + JSON.stringify(g.name) + "? Its papers stay, in no group.")) {
        papersOp({ op: "group-delete", id: g.id });
      }
    }, "danger"),
  ]);
}

export async function newGroup() {
  const name = prompt("Name of the new group:");
  if (!name || !name.trim()) return;
  await papersOp({ op: "group-add", name }, "Group added: drag papers onto it");
}

// ---- the order of the side bar, which a drag changes (cc-servers' sortable and beginDrag)
const LONG_PRESS = 350;  // ms a finger holds a row before it can be moved (a mouse just drags it)
/** @param {any} handle @param {any} item @param {string} kind @param {string} id */
function sortable(handle, item, kind, id) {
  item.dataset.sortId = id;
  handle.draggable = false;
  handle.addEventListener("dragstart", (/** @type {Event} */ e) => e.preventDefault());
  /** @type {any} */
  let timer = null;
  /** @type {any} */
  let start = null;
  const pre = (/** @type {PointerEvent} */ e) => {
    if (!start || side.drag) return;
    const d = Math.hypot(e.clientX - start.x, e.clientY - start.y);
    if (start.mouse && (e.buttons & 1) && d > 5) { const s0 = start; stop(); beginDrag(e, item, kind, s0.y); }
    else if (!start.mouse && d > 8) stop();  // a finger that moves scrolls
  };
  const stop = () => {
    clearTimeout(timer);
    timer = null;
    start = null;
    window.removeEventListener("pointermove", pre);
    window.removeEventListener("pointerup", stop);
    window.removeEventListener("pointercancel", stop);
  };
  handle.addEventListener("pointerdown", (/** @type {PointerEvent} */ e) => {
    if (e.button !== 0 || /** @type {Element} */ (e.target).closest("button.more, button.add")) return;
    start = { x: e.clientX, y: e.clientY, mouse: e.pointerType === "mouse" };
    side.pressing = true;
    window.addEventListener("pointermove", pre);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    if (!start.mouse) {
      timer = setTimeout(() => {
        if (start) { const s0 = start; stop(); beginDrag(e, item, kind, s0.y); }
      }, LONG_PRESS);
    }
  });
  handle.addEventListener("contextmenu", (/** @type {Event} */ e) => { if (timer || side.drag) e.preventDefault(); });
  handle.addEventListener("click", (/** @type {Event} */ e) => {  // the click that ends a move opens nothing
    if (side.justDropped) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
}

// The row follows the pointer, and moves in the list as soon as its middle passes another's. A paper
// can move into another group: past its rows, or onto its header (an empty group too).
/** @param {PointerEvent} e @param {any} item @param {string} kind @param {number} pressY */
function beginDrag(e, item, kind, pressY) {
  const siblings = () => (kind === "group" ? [...$("#s-list").querySelectorAll(".s-proj[data-sort-id]")] :
    [...$("#s-list").querySelectorAll("li.s-li")]);
  const r0 = item.getBoundingClientRect(), grab = pressY - r0.top;
  const fromGroup = kind === "paper" ? groupOf(item) : null;
  side.drag = { item, kind, before: siblings() };
  item.classList.add("dragging");
  document.body.classList.add("reordering");
  /** @type {any} */
  let target = null;  // a group header the paper is over
  let y = e.clientY, x = e.clientX;
  /** @type {any} */
  let frame = null;
  const place = () => {
    frame = null;
    const list = $("#s-list"), lr = list.getBoundingClientRect();
    if (y < lr.top + 30) list.scrollTop -= 10;
    else if (y > lr.bottom - 30) list.scrollTop += 10;
    item.style.transform = "";
    if (kind === "paper") {
      const over = document.elementsFromPoint(x, y).find((el) => el.classList.contains("s-phrow"));
      const block = over ? over.closest(".s-proj") : null;
      if (target && target !== block) target.classList.remove("drop-on");
      target = block;
      if (target) target.classList.add("drop-on");
    }
    if (!target) {
      const mid = y - grab + r0.height / 2, others = siblings().filter((o) => o !== item);
      const next = others.find((o) => { const b = o.getBoundingClientRect(); return mid < b.top + b.height / 2; });
      if (next) { if (item.nextElementSibling !== next) next.parentElement.insertBefore(item, next); }
      else if (others.length) {
        const last = others[others.length - 1];
        if (last.nextElementSibling !== item) last.parentElement.insertBefore(item, last.nextSibling);
      }
    }
    item.style.transform = "translateY(" + (y - grab - item.getBoundingClientRect().top) + "px)";
    if (y < lr.top + 30 || y > lr.bottom - 30) frame = requestAnimationFrame(place);
  };
  const move = (/** @type {PointerEvent} */ ev) => {
    ev.preventDefault();
    y = ev.clientY; x = ev.clientX;
    if (!frame) frame = requestAnimationFrame(place);
  };
  const end = async () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
    if (frame) { cancelAnimationFrame(frame); place(); }
    item.style.transform = "";
    item.classList.remove("dragging");
    document.body.classList.remove("reordering");
    side.justDropped = true;
    setTimeout(() => { side.justDropped = false; }, 300);
    const d = side.drag;
    side.drag = null;
    side.pressing = false;
    const id = item.dataset.sortId;
    try {
      if (kind === "group") {
        const now = siblings();
        if (now.some((o, i) => o !== d.before[i])) {
          await api("POST", "/api/papers", { op: "order", groups: now.map((o) => o.dataset.sortId) });
        }
      } else {
        const into = target ? target.dataset.gid : groupOf(item);
        if (target) {
          target.classList.remove("drop-on");
          target.querySelector(".s-rows").append(item);  // at the end of the group it was dropped on
        }
        if (into !== fromGroup) await api("POST", "/api/papers", { op: "set", paper: id, group: into || null });
        const now = siblings();
        if (now.some((o, i) => o !== d.before[i])) {
          // the whole list in its new order: the papers hidden by a filter keep their place after
          const shown = now.map((o) => o.dataset.sortId);
          const rest = S.state.papers.map((/** @type {any} */ p) => p.id).filter((/** @type {string} */ p) => !shown.includes(p));
          await api("POST", "/api/papers", { op: "order", papers: [...shown, ...rest] });
        }
      }
    } catch (err) { flash(/** @type {Error} */ (err).message, 6000); }
    side.key = "";
    await side.refresh();
  };
  window.addEventListener("pointermove", move, { passive: false });
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
}

/** @param {Element} li */
function groupOf(li) {
  const block = li.closest("[data-gid]");
  return block ? /** @type {HTMLElement} */ (block).dataset.gid || "" : "";
}

window.addEventListener("pointerup", sideReleased);  // before the click that follows: it may redraw
window.addEventListener("pointercancel", sideReleased);
function sideReleased() {
  side.pressing = false;
  if (side.pendingRender && !side.drag) { side.pendingRender = false; side.key = ""; renderSide(); }
}

export function toggleSide() {
  if (window.matchMedia("(max-width: 900px)").matches) {
    document.body.classList.toggle("side-open");
  } else {
    document.body.classList.toggle("side-off");
    sideStore("off", document.body.classList.contains("side-off"));
  }
}

// ---- + Add paper: register_project, through the server
export function openAdd() {
  const dlg = $("#add-dlg");
  let kind = "git";
  const seg = dlg.querySelectorAll(".seg button");
  const setKind = (/** @type {string} */ k) => {
    kind = k;
    seg.forEach((/** @type {HTMLElement} */ b) => b.classList.toggle("on", b.dataset.kind === k));
    $("#add-git-row").hidden = k !== "git";
    $("#add-path-row").hidden = k !== "local";
  };
  seg.forEach((/** @type {HTMLElement} */ b) => { b.onclick = () => setKind(b.dataset.kind || "git"); });
  setKind("git");
  ["#add-git", "#add-path", "#add-id", "#add-root"].forEach((s) => { $(s).value = ""; });
  $("#add-err").textContent = "";
  $("#add-cancel").onclick = () => dlg.close();
  $("#add-go").onclick = async () => {
    const body = {
      ...(kind === "git" ? { gitUrl: $("#add-git").value } : { path: $("#add-path").value }),
      project: $("#add-id").value, rootFile: $("#add-root").value,
    };
    $("#add-go").disabled = true;
    $("#add-err").textContent = "";
    try {
      const r = await api("POST", "/api/register", body);
      dlg.close();
      flash("Added" + (r.project ? ": " + r.project : ""), 3000);
      await side.refresh();
      if (r.project) location.hash = "#paper/" + encodeURIComponent(r.project);
    } catch (e) {
      $("#add-err").textContent = /** @type {Error} */ (e).message;
    } finally { $("#add-go").disabled = false; }
  };
  dlg.showModal();
  setTimeout(() => (kind === "git" ? $("#add-git") : $("#add-path")).focus(), 0);
}
