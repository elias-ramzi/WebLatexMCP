// @ts-check
// Markdown, links and pull-request chips, as cc-servers renders them (ported from its PAGE as is:
// keep the two in step). md() escapes all of the text it is given: see esc().
import { h } from "./dom.js";

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
// Links: an http(s) URL anywhere, or a local server written without its http:// (localhost:8000, 127.0.0.1:8787/x);
// the punctuation or markup that closes the sentence (".", "**", an unopened ")") is not part of it.
const LOCAL_HOST = "(?:localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1\\])";
const LINK_SRC = "(?<![\\w/])https?://[^\\s<>\"'`]+|(?<![\\w/.@:-])" + LOCAL_HOST +
  ":\\d{2,5}(?:/[^\\s<>\"'`]*)?(?![\\w:])";
const LINK_RE = new RegExp(LINK_SRC, "g");
const LINK_WHOLE_RE = new RegExp("^(?:https?://\\S+|" + LOCAL_HOST + ":\\d{2,5}(?:/\\S*)?)$");
const PR_URL_RE = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/;
// a code span, a [text](url), an <url>, or a bare link
const INLINE_RE = new RegExp("`([^`\\n]+)`|\\[([^\\]\\n]+)\\]\\(((?:https?://|" + LOCAL_HOST +
  ":\\d)[^\\s)]*)\\)|<((?:https?://|" + LOCAL_HOST + ":\\d)[^\\s<>]*)>|" + LINK_SRC, "g");
function linkTrim(u) {
  for (;;) {
    const c = u.slice(-1);
    const open = c === ")" ? "(" : c === "]" ? "[" : null;
    if (/[.,;:!?*_~'"]/.test(c) || (open && u.split(open).length < u.split(c).length)) u = u.slice(0, -1);
    else return u;
  }
}
function linkHref(u) {
  // 0.0.0.0 is where a server listens, not where a browser goes
  return (/^https?:\/\//.test(u) ? u : "http://" + u).replace(/^(https?:\/\/)0\.0\.0\.0(?=[:/]|$)/, "$1localhost");
}
const PR_SVG = '<svg class="pr-ic" viewBox="0 0 16 16" aria-hidden="true"><circle cx="4.5" cy="3.5" r="1.6"/>' +
  '<circle cx="4.5" cy="12.5" r="1.6"/><circle cx="11.5" cy="12.5" r="1.6"/><path d="M4.5 5.1v5.8M11.5 10.9V6.5' +
  'a2 2 0 0 0-2-2H7M8.6 2.9 7 4.5l1.6 1.6"/></svg>';
// A GitHub pull request shows as a chip: its repo and number, its icon coloured by its state, its title on hover
// (once gh answered); see hydratePrs()
function prChip(href, m, cls) {
  const a = h("a", { class: "pr-chip " + (cls || ""), href, "data-pr": m[0], target: "_blank",
    rel: "noopener noreferrer", title: href });
  a.innerHTML = PR_SVG;  // static markup
  a.append(h("span", { class: "pr-ref" }, m[2] + " #" + m[3]));
  return a;
}
function linkEl(u, chips) {
  const href = linkHref(u), m = chips && href.match(PR_URL_RE);
  return m ? prChip(href, m) : h("a", { href, target: "_blank", rel: "noopener noreferrer" }, u);
}
function linkHtml(u, inner) {
  if (inner == null) return linkEl(u, true).outerHTML;
  return '<a href="' + esc(linkHref(u)) + '" target="_blank" rel="noopener noreferrer">' + inner + "</a>";
}
// plain text (a tool's output, a message you sent) with its links: text nodes and <a>s
function linkNodes(text, chips) {
  if (!text || text.length > 500000) return [text];
  const out = [];
  let last = 0;
  for (const m of text.matchAll(LINK_RE)) {
    const u = linkTrim(m[0]);
    if (!u || m.index < last) continue;
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(linkEl(u, chips));
    last = m.index + u.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
function mdInline(s, noLinks) {
  // links and code spans are cut out first (so that "**" around a link or "_" inside one stays as it is), and the
  // text between them escaped
  s = String(s).replace(/\u0000/g, "");
  const keep = [];
  const put = (html) => { keep.push(html); return "\u0000" + (keep.length - 1) + "\u0000"; };
  let out = "", last = 0;
  for (const m of s.matchAll(INLINE_RE)) {
    if (m.index < last) continue;
    let html, len = m[0].length;
    if (m[1] != null) {  // a code span: a link if it is only one (`http://127.0.0.1:8787/`)
      const c = m[1].trim();
      html = "<code>" + esc(m[1]) + "</code>";
      if (!noLinks && LINK_WHOLE_RE.test(c) && !c.includes("…")) html = linkHtml(c, html);
    } else if (noLinks) {
      html = esc(m[0]);
    } else if (m[2] != null) {
      const href = linkHref(m[3]);
      html = m[2].trim() === m[3] && PR_URL_RE.test(href) ? linkHtml(m[3]) : linkHtml(m[3], mdInline(m[2], true));
    } else if (m[4] != null) {
      html = linkHtml(m[4]);
    } else {
      const u = linkTrim(m[0]);
      if (!u) continue;
      len = u.length;
      html = linkHtml(u);
    }
    out += esc(s.slice(last, m.index)) + put(html);
    last = m.index + len;
  }
  out += esc(s.slice(last));
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_([^_\s][^_\n]*?)_(?!\w)/g, "$1<em>$2</em>")
    .replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
  return out.replace(/\u0000(\d+)\u0000/g, (m, i) => keep[+i]);
}
function mdTableRow(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}
const COPY_SVG = '<svg viewBox="0 0 24 24"><rect x="8.5" y="8.5" width="11" height="11" rx="2"/>' +
  '<path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/></svg>';
function md(text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const html = [];
  let i = 0;
  const isList = (l) => /^\s*([-*+]|\d+[.)])\s+/.test(l);
  const blockStart = (l) => /^\s*(```|~~~|#{1,6}\s|>|\|)/.test(l) || isList(l) || /^\s*([-*_])(\s*\1){2,}\s*$/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    let m;
    if (!line.trim()) { i++; continue; }
    if ((m = line.match(/^\s*(`{3,}|~{3,})\s*([\w+-]*)/))) {
      // a code block ends at a fence of its own kind, at least as long: ```` keeps the ``` inside it
      const fence = m[1], body = [];
      const close = new RegExp("^\\s*" + (fence[0] === "`" ? "`" : "~") + "{" + fence.length + ",}\\s*$");
      i++;
      while (i < lines.length && !close.test(lines[i])) body.push(lines[i++]);
      i++;
      html.push('<div class="code"><button type="button" class="cp" title="Copy" aria-label="Copy">' + COPY_SVG +
        "</button><pre><code>" + linkNodes(body.join("\n")).map((n) => (typeof n === "string" ? esc(n) :
        n.outerHTML)).join("") + "</code></pre></div>");
      continue;
    }
    if ((m = line.match(/^\s*(#{1,6})\s+(.*)$/))) {
      const n = Math.min(4, m[1].length);
      html.push("<h" + n + ">" + mdInline(m[2].replace(/\s#+\s*$/, "")) + "</h" + n + ">");
      i++; continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { html.push("<hr>"); i++; continue; }
    if (/^\s*>/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
      html.push("<blockquote>" + md(body.join("\n")) + "</blockquote>");
      continue;
    }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const head = mdTableRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(mdTableRow(lines[i++]));
      html.push("<table><thead><tr>" + head.map((c) => "<th>" + mdInline(c) + "</th>").join("") +
        "</tr></thead><tbody>" +
        rows.map((r) => "<tr>" + r.map((c) => "<td>" + mdInline(c) + "</td>").join("") + "</tr>").join("") +
        "</tbody></table>");
      continue;
    }
    if (isList(line)) {
      // a list, with its nested lists: indentation decides the level
      const items = [];
      while (i < lines.length && (isList(lines[i]) || (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length))) {
        const l = lines[i++];
        const lm = l.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (lm) items.push({ indent: lm[1].replace(/\t/g, "    ").length, ordered: /\d/.test(lm[2]),
          start: parseInt(lm[2], 10), text: lm[3] });
        else items[items.length - 1].text += " " + l.trim();
      }
      let pos = 0;
      const build = (indent) => {
        const ordered = items[pos].ordered;
        const start = ordered && items[pos].start > 1 ? ' start="' + items[pos].start + '"' : "";
        let out = (ordered ? "<ol" + start + ">" : "<ul>");
        while (pos < items.length && items[pos].indent >= indent) {
          const it = items[pos++];
          let li = mdInline(it.text.replace(/^\[([ xX])\]\s+/, (mm, x) => (x === " " ? "☐ " : "☑ ")));
          if (pos < items.length && items[pos].indent > it.indent) li += build(items[pos].indent);
          out += "<li>" + li + "</li>";
        }
        return out + (ordered ? "</ol>" : "</ul>");
      };
      while (pos < items.length) html.push(build(items[pos].indent));
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && (!para.length || !blockStart(lines[i]))) para.push(lines[i++]);
    html.push("<p>" + para.map(mdInline).join("<br>") + "</p>");
  }
  return html.join("");
}

// cc-servers asks gh for each pull request's state; WebLatexMCP shows the chips without it.
export function hydratePrs() {}

export { esc, linkNodes, mdInline, md, COPY_SVG };
