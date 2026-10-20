import MarkdownIt from 'markdown-it';
import type { RendererRule, StateCore } from 'markdown-it';

/**
 * Render a project's markdown document to an HTML fragment for the browser viewer.
 *
 * A comment the user leaves on selected text has to point back at a line of the `.md` source, so
 * every block element carries `data-src="<first>-<last>"` (1-based, inclusive) taken from
 * markdown-it's own token map, trailing blank lines dropped — set on the token by a core rule,
 * never pieced together from the HTML afterwards. The fence and indented-code renderers are replaced because the stock ones put a
 * token's attributes on the inner `<code>` (or drop them for a fence with a language); here they
 * land on the `<pre>`, the element a selection sits in.
 *
 * The page renders a document the user did not necessarily write (a collaborator's, a pull's), so
 * nothing in it may act: raw HTML is off (it comes out as escaped text), markdown-it's
 * `validateLink` still refuses `javascript:`/`vbscript:`/`file:` links and a wrapper round it
 * every `data:` one (its image types included), every link opens in a new tab without an opener, and **no `<img>` is ever emitted** — an image becomes its alt
 * text, since rendering one would fetch a URL the document chose.
 */
const md = new MarkdownIt('default', { html: false, linkify: false, typographer: false });
const { escapeHtml, unescapeAll } = md.utils;

// markdown-it's own `validateLink` still allows `data:image/{gif,png,jpeg,webp}`; no `data:` URL
// is ever a link here, whatever its type.
const stockValidateLink = md.validateLink.bind(md);
md.validateLink = (url: string): boolean =>
  !url.trim().toLowerCase().startsWith('data:') && stockValidateLink(url);

md.core.ruler.push('data_src', (state: StateCore) => {
  // Runs after markdown-it's `normalize`, so `src` holds `\n` line endings only.
  const lines = state.src.split('\n');
  for (const token of state.tokens) {
    // Opening (nesting 1) and leaf (nesting 0) block tokens; `inline` holds a paragraph's text
    // and renders no tag of its own.
    if (!token.block || token.nesting < 0 || token.type === 'inline' || !token.map) continue;
    const [start] = token.map;
    let [, end] = token.map;
    // A list's map runs over the blank line that ends it; the range names the last line with text.
    while (end - 1 > start && /^[ \t]*$/.test(lines[end - 1] ?? '')) end--;
    if (!(end > start)) continue;
    token.attrSet('data-src', `${start + 1}-${end}`);
  }
});

const renderCode =
  (withLang: boolean): RendererRule =>
  (tokens, idx, options, _env, slf) => {
    const token = tokens[idx];
    if (!token) return '';
    const info = withLang && token.info ? unescapeAll(token.info).trim() : '';
    const lang = info.split(/\s+/)[0] ?? '';
    const cls = lang ? ` class="${escapeHtml(options.langPrefix + lang)}"` : '';
    return `<pre${slf.renderAttrs(token)}><code${cls}>${escapeHtml(token.content)}</code></pre>\n`;
  };

md.renderer.rules.fence = renderCode(true);
md.renderer.rules.code_block = renderCode(false);

md.renderer.rules.image = (tokens, idx, options, env, slf) => {
  const alt = slf.renderInlineAsText(tokens[idx]?.children ?? [], options, env);
  return `<span class="md-img">[image${alt ? `: ${escapeHtml(alt)}` : ''}]</span>`;
};

md.renderer.rules.link_open = (tokens, idx, options, _env, slf) => {
  const token = tokens[idx];
  if (!token) return '';
  token.attrSet('target', '_blank');
  token.attrSet('rel', 'noopener noreferrer');
  return slf.renderToken(tokens, idx, options);
};

/** The HTML fragment (no `<html>`/`<body>`) for one markdown document. */
export function renderMarkdown(text: string): string {
  return md.render(text);
}
