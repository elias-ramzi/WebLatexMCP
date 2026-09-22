/**
 * Deciding how much of a `list_comments` result may be returned, against a character budget charged
 * on the RENDERED payload in BOTH channels. A pure planner over plain data, the same shape as
 * `src/lib/conflictBudget.ts`, `src/lib/citationsBudget.ts`, `src/lib/searchBudget.ts` and
 * `src/lib/diffBudget.ts`: a budget, a plan, a human-readable note, and a tool layer that only maps
 * the plan onto response shapes. It imports nothing from the tool layer and touches no
 * fs/process/clock, so it stays testable without a live MCP client.
 *
 * Why it exists (issue #163). `list_comments` had no bound of any kind — no cap, no `maxResults`,
 * no counter — and it rendered its whole payload **twice**: once into `structuredContent.comments`
 * and once, field for field, into the result text. Three of the four fields that carry any size are
 * outside the server's control:
 *
 *  - `quote` is the **PDF text the user selected**, so it is whatever the document rendered there.
 *    A selection can be a page.
 *  - `snippet` is five lines of project source. `sliceSnippet` already clips each *line* at
 *    `MAX_SNIPPET_LINE_CHARS`, so one snippet is ~1KB — but nothing bounded how many of them
 *    a single result carries.
 *  - `note` is the user's own typed text, which is not hostile, but is uncapped; and a review pass
 *    leaving 200 comments on a paper is the ordinary case rather than the bad one.
 *
 * 200 comments x (note + a paragraph-sized quote + five long source lines) x 2 channels reaches the
 * ~67k-character payload a client rejected **undelivered** in #68 without anything unusual
 * happening.
 *
 * Three decisions carry this module.
 *
 *  1. **The priority order is WITHIN a comment, not between comments.** Unlike
 *     `citationsBudget.ts`, there is no advisory/blocking split to allocate by: every comment is
 *     equally something the user asked about, and there is no basis on which comment #7 deserves
 *     the budget more than comment #93. So the allocation runs in *field* lanes across the whole
 *     list — see {@link ALLOCATION_ORDER} — and every comment's identity and note are paid for
 *     before any comment's quote, and every comment's quote before any comment's snippet.
 *  2. **A cut comment must stay identifiable, so the recoverable fields go first and comments go
 *     last.** Dropping the 150th comment whole means the user's 150th note is invisible *and*
 *     `resolve_comments` — which takes `ids`, and ids come from here — can never be called on it.
 *     `quote` and `snippet` are recoverable elsewhere (the selection is still highlighted in the
 *     viewer; the snippet is one `read_file` at the comment's `file`:`line`), so they are cut
 *     across every comment before a single comment is dropped. When comments are dropped anyway,
 *     the count and the route back are stated.
 *  3. **Charge BOTH channels.** #68's second round, and #153 after it, established that a budget
 *     must be charged against what is *rendered*, not against raw content. Here the same comment is
 *     emitted twice, so a budget counting it once is wrong by 2x. {@link commentRenderCost} charges
 *     `renderCommentText(c).length + JSON.stringify(c).length`, i.e. the real text template plus
 *     the real escaping cost (LaTeX is backslash-dense; a raw-length charge under-counts the JSON
 *     side badly).
 *
 * The render functions live here beside the cost function, and the cost function **calls** them —
 * `diffBudget.ts`'s technique, and stronger than `conflictBudget.ts`'s pinned constants: a template
 * and its charge that are the same call cannot drift apart at all. The constants below are only for
 * the pieces rendered *outside* this module (the JSON scaffolding `structuredContent` wraps around
 * the payload), and a test stringifies a real result to check they still account for it.
 *
 * What this module deliberately does **not** do: it never restores a location. A comment whose
 * `file` was withheld by `unopenablePaths`/`withoutUnopenableLocation` (a synctex record is written
 * by the *document*, so a path leaving the project through a symlink is not handed back as
 * somewhere to read) arrives here already stripped, and the planner only ever removes fields.
 */

import { formatSnippet } from './sourceSnippet.js';

/**
 * Total character budget for one `list_comments` result across BOTH channels combined.
 *
 * 20000 is this codebase's house figure for a rendered content budget — `CONFLICT_CONTENT_BUDGET`,
 * `FLOATS_CONTENT_BUDGET`, `SEARCH_CONTENT_BUDGET`, `CITATIONS_CONTENT_BUDGET`,
 * `DIFF_CONTENT_BUDGET` — sized so the worst case lands well under the ~67k a client actually
 * rejected (#68). Nothing about a comment list argues for a different number, and a second figure
 * for the same class of defect only invites the question of which one is right.
 */
export const COMMENTS_CONTENT_BUDGET = 20000;

/**
 * Longest single note carried, before an ellipsis.
 *
 * An unconditional per-field cap, not a budget mechanism, so one comment's size is the same whether
 * it is listed alone or alongside two hundred others — the same shape (and the same reasoning) as
 * `MAX_SNIPPET_LINE_CHARS` in `sourceSnippet.ts`, which clips every snippet line at 200
 * characters on every call. Generous on purpose: a note is the user's own words and the single most
 * valuable field here, and a thousand characters is several paragraphs of review comment.
 */
export const COMMENT_NOTE_CAP = 1000;

/**
 * Longest single quote carried, before an ellipsis. Half the note cap, because the quote is not
 * something anyone typed for this purpose: it is whatever text the selection happened to cover, and
 * its job is to say *where in the PDF* the note points. Five hundred characters identifies a
 * location in a paper several times over, and the full selection is still highlighted in the viewer.
 */
export const COMMENT_QUOTE_CAP = 500;

/**
 * Withheld from the budget to pay for the single aggregate {@link CommentsPlan.budgetNote} in both
 * channels. The note describes the cuts, so charging it per-part would be circular; reserving a flat
 * allowance and pinning (in `test/unit/commentsBudget.test.ts`) that the longest note this module
 * can produce fits inside it gives the same guarantee without the circularity. Roughly twice the
 * note's own length, because it too ships in both channels.
 */
export const COMMENTS_NOTE_RESERVE = 1200;

/**
 * The JSON punctuation and key names `structuredContent` wraps around a `list_comments` result —
 * every key except the `comments` array's elements, which are charged exactly — plus room for the
 * counters' digits. Pinned by a test that stringifies a real result and checks this still accounts
 * for it, the technique `diffBudget.ts` and `conflictBudget.ts` both use.
 */
export const COMMENTS_JSON_SCAFFOLD_OVERHEAD = 200;

/** The `[` and `]` around the JSON `comments` array, charged up front. */
const COMMENTS_ARRAY_JSON_OVERHEAD = 2;

/**
 * Charged once per comment: the `\n\n` the text channel puts between two comment blocks (2) plus
 * the `,` between two JSON array elements (1). Charging it for the last element too over-charges by
 * three characters, which is the right direction.
 */
const COMMENT_SEPARATOR_OVERHEAD = 3;

/**
 * The order the character budget is ALLOCATED in — highest value first, so the field cut FIRST is
 * the one written last. Reading it as a cut priority, back to front:
 *
 *  1. `snippet` is cut first. It is five lines of project source that `read_file` at the comment's
 *     own `file`:`line` fetches back exactly, so cutting it costs one call and loses nothing.
 *  2. `quote` next. The selection it echoes is still painted over the PDF in the viewer, where the
 *     user made it, so the information is not gone — only the convenience of having it inline.
 *  3. `note` is never dropped, only clipped at {@link COMMENT_NOTE_CAP}. A comment without its note
 *     is not something anyone can act on, and the note is the one field with no copy anywhere else
 *     a tool can reach.
 *  4. The comment's **identity and location** (`id`, `number`, `page`, `file`, `line`, `resolved`)
 *     survive last of all, together with the note: they are what makes a comment addressable at
 *     all, and `resolve_comments` takes `ids` that come only from here.
 *
 * Dropping a whole comment is not a lane; it is what happens when even lane 4 cannot be paid, and
 * it is counted in {@link CommentsPlan.commentsOmitted} with the route back stated in the note.
 */
export const ALLOCATION_ORDER = ['identity+note', 'quote', 'snippet'] as const;

/** One comment as the tool builds it, after the unopenable-path guard has had its say. */
export interface CommentLike {
  id: string;
  number: number;
  page: number;
  note: string;
  quote?: string;
  file?: string;
  line?: number;
  snippet?: string;
  snippetStartLine?: number;
  resolved: boolean;
}

/**
 * One comment as it will be sent.
 *
 * The three `…OmittedChars` counters keep "cut" structurally unconfusable from "absent", which is
 * the distinction that matters most here: a comment with no `quote` is one where the user selected
 * no text, and a comment whose quote the budget removed is a different fact. So an absent `quote`
 * with no `quoteOmittedChars` means there was none; an absent `quote` *with* one means it was cut,
 * and says how much went. The same reading applies to `snippet`, whose absence has three innocent
 * causes already (no synctex location, a file that has since moved, a withheld path).
 */
export interface PlannedComment extends CommentLike {
  /** Characters cut from the end of `note` by {@link COMMENT_NOTE_CAP}. Absent when nothing was. */
  noteOmittedChars?: number;
  /** Characters of `quote` not shown — a clip, or the whole quote. Absent when nothing was cut. */
  quoteOmittedChars?: number;
  /** Characters of `snippet` not shown. A snippet is all-or-nothing, so this is its full length. */
  snippetOmittedChars?: number;
}

/** What the tool may send. `src/tools/listComments.ts` renders BOTH channels from this and from
 * nothing else, so the text and `structuredContent` can never disagree about what was cut. */
export interface CommentsPlan {
  comments: PlannedComment[];
  /** Comments not in the list at all. They are still in the viewer, and still resolvable there. */
  commentsOmitted: number;
  /** Listed comments whose `quote` was dropped entirely (a clip is not counted here — it is
   * reported per comment as `quoteOmittedChars`, since the quote is still shown). */
  quotesOmitted: number;
  /** Listed comments whose `snippet` was dropped. */
  snippetsOmitted: number;
  /** True iff anything at all was cut, clips included. Never inferred from an empty `comments`: an
   * empty list means there are no open comments, and the two must never be confusable. */
  truncated: boolean;
  /** What was cut and how to get it back. Present only when something actually was cut.
   *
   * Named `budgetNote` rather than the house `note` for one reason: `comments[].note` is the user's
   * own typed text, and two fields called `note` meaning entirely different things in one result is
   * a reading someone will get wrong. */
  budgetNote?: string;
}

export interface CommentsPlanOptions {
  budget?: number;
  noteCap?: number;
  quoteCap?: number;
}

/**
 * One string cut to `max` characters, with what was lost.
 *
 * `slice` counts UTF-16 code units, so a cut landing between the halves of an astral character (an
 * emoji, a rare CJK ideograph, a maths alphanumeric) would leave a lone surrogate: not text, and
 * something JSON encoders either reject or silently replace on the way through
 * `structuredContent`. Backing off the orphaned half loses one more character from a string that is
 * already elided — `sourceSnippet.ts`'s `clip` makes the same trade.
 */
export function clipText(s: string, max: number): { text: string; omitted: number } {
  if (s.length <= max) return { text: s, omitted: 0 };
  const last = s.charCodeAt(max - 1);
  const isLeadingHalf = last >= 0xd800 && last <= 0xdbff;
  const keep = max - (isLeadingHalf ? 1 : 0);
  return { text: `${s.slice(0, keep)}…`, omitted: s.length - keep };
}

/**
 * One comment's block in the result text, rendered here beside the cost function that charges it so
 * the charge and the text are the same call and cannot drift.
 *
 * The un-cut shape is byte-for-byte what this tool has always emitted; the markers are additions
 * that appear only where something went, so a result with nothing cut reads exactly as before.
 */
export function renderCommentText(c: PlannedComment): string {
  const loc = c.file ? `${c.file}:${c.line}` : `(unresolved — page ${c.page})`;
  const noteCut = c.noteOmittedChars ? ` (+${c.noteOmittedChars} chars cut)` : '';
  const quote = c.quote
    ? `\n   quote: "${c.quote}"${c.quoteOmittedChars ? ` (+${c.quoteOmittedChars} chars cut)` : ''}`
    : c.quoteOmittedChars
      ? `\n   quote: (${c.quoteOmittedChars} chars cut — the selection is still in the viewer)`
      : '';
  const snip = c.snippet
    ? `\n   source:\n${formatSnippet(c, c.line, '     ')}`
    : c.snippetOmittedChars
      ? `\n   source: (${c.snippetOmittedChars} chars cut — read_file ${c.file}:${c.line})`
      : '';
  return `#${c.number} [${c.id}] ${loc}\n   note: ${c.note}${noteCut}${quote}${snip}`;
}

/** The whole text channel, built from the plan and nothing else — never from the uncut list. */
export function renderCommentsText(plan: CommentsPlan): string {
  if (plan.comments.length === 0) return 'No open comments.';
  const parts = plan.comments.map(renderCommentText);
  if (plan.budgetNote) parts.push(plan.budgetNote);
  return parts.join('\n\n');
}

/**
 * What one comment costs once this server has rendered it: as a block of the result text AND
 * JSON-encoded into `structuredContent`, plus the separator that joins it to the next one.
 * `JSON.stringify` drops `undefined`-valued keys, which is exactly what the wire form does, so the
 * charge is the wire cost rather than the in-memory object's.
 */
export function commentRenderCost(c: PlannedComment): number {
  return renderCommentText(c).length + JSON.stringify(c).length + COMMENT_SEPARATOR_OVERHEAD;
}

/** A comment mid-plan: the source record plus which of its optional fields are currently kept. */
interface Frame {
  src: CommentLike;
  note: { text: string; omitted: number };
  /** The quote as it will be shown, or undefined when it is dropped (or there never was one). */
  quote?: { text: string; omitted: number };
  snippetShown: boolean;
  /** Cost of {@link materialize}(this) as last charged. */
  cost: number;
}

/** The object the tool will actually send for one frame — and the object the budget charges. */
function materialize(f: Frame): PlannedComment {
  const src = f.src;
  const quoteCut = f.quote ? f.quote.omitted : (src.quote?.length ?? 0);
  const snippetCut = f.snippetShown ? 0 : (src.snippet?.length ?? 0);
  return {
    id: src.id,
    number: src.number,
    page: src.page,
    note: f.note.text,
    ...(f.note.omitted > 0 ? { noteOmittedChars: f.note.omitted } : {}),
    quote: f.quote?.text,
    ...(quoteCut > 0 ? { quoteOmittedChars: quoteCut } : {}),
    file: src.file,
    line: src.line,
    snippet: f.snippetShown ? src.snippet : undefined,
    snippetStartLine: f.snippetShown ? src.snippetStartLine : undefined,
    ...(snippetCut > 0 ? { snippetOmittedChars: snippetCut } : {}),
    resolved: src.resolved,
  };
}

/**
 * Plan a `list_comments` result: which comments are listed, and which of their fields survive.
 *
 * Three passes, in {@link ALLOCATION_ORDER}. Pass 1 charges every comment's identity, location and
 * (clipped) note — **including, up front, the exact `…OmittedChars` markers it would need if it
 * lost both its quote and its snippet**, so the boilerplate that explains a cut can never itself
 * cause one. Passes 2 and 3 then spend whatever is left on quotes and then snippets, in list order.
 *
 * Each pass cuts a **tail**: once one comment's quote does not fit, no later comment's does either.
 * Nothing is reordered and the small ones are never preferred — a cherry-picked list is a different
 * answer to the question asked, the same rule `floatsBudget.ts`, `searchBudget.ts` and
 * `diffBudget.ts` all keep. The tail is cut per pass, not carried between passes: exhausting the
 * quote lane says nothing about the snippet lane, which starts from whatever the quote lane left.
 *
 * One comment is kept even if it alone exceeds the budget (`citationsBudget.ts`'s `keepFirst`, for
 * the same reason): a result listing nothing tells the caller nothing at all, and the per-field
 * caps bound what that one comment can cost anyway.
 */
export function planCommentsPayload(
  comments: CommentLike[],
  opts: CommentsPlanOptions = {},
): CommentsPlan {
  const budget = opts.budget ?? COMMENTS_CONTENT_BUDGET;
  const noteCap = opts.noteCap ?? COMMENT_NOTE_CAP;
  const quoteCap = opts.quoteCap ?? COMMENT_QUOTE_CAP;

  if (comments.length === 0) {
    return {
      comments: [],
      commentsOmitted: 0,
      quotesOmitted: 0,
      snippetsOmitted: 0,
      truncated: false,
    };
  }

  let remaining =
    budget - COMMENTS_JSON_SCAFFOLD_OVERHEAD - COMMENTS_ARRAY_JSON_OVERHEAD - COMMENTS_NOTE_RESERVE;

  // Pass 1 — identity, location and note. A comment that cannot be paid for is dropped, and so is
  // every comment after it, so the listed set stays a prefix of the user's own #1..#N numbering.
  const kept: Frame[] = [];
  let commentsOmitted = 0;
  for (const [i, src] of comments.entries()) {
    const frame: Frame = {
      src,
      note: clipText(src.note, noteCap),
      snippetShown: false,
      cost: 0,
    };
    frame.cost = commentRenderCost(materialize(frame));
    if (frame.cost > remaining && kept.length > 0) {
      commentsOmitted = comments.length - i;
      break;
    }
    remaining -= frame.cost;
    kept.push(frame);
  }

  // Pass 2 — quotes.
  let quotesOmitted = 0;
  let quoteLaneOpen = true;
  for (const f of kept) {
    const raw = f.src.quote;
    if (raw === undefined) continue;
    if (quoteLaneOpen) {
      const candidate: Frame = { ...f, quote: clipText(raw, quoteCap) };
      const cost = commentRenderCost(materialize(candidate));
      if (cost - f.cost <= remaining) {
        remaining -= cost - f.cost;
        f.quote = candidate.quote;
        f.cost = cost;
        continue;
      }
      quoteLaneOpen = false;
    }
    quotesOmitted += 1;
  }

  // Pass 3 — snippets.
  let snippetsOmitted = 0;
  let snippetLaneOpen = true;
  for (const f of kept) {
    if (f.src.snippet === undefined) continue;
    if (snippetLaneOpen) {
      const candidate: Frame = { ...f, snippetShown: true };
      const cost = commentRenderCost(materialize(candidate));
      if (cost - f.cost <= remaining) {
        remaining -= cost - f.cost;
        f.snippetShown = true;
        f.cost = cost;
        continue;
      }
      snippetLaneOpen = false;
    }
    snippetsOmitted += 1;
  }

  const planned = kept.map(materialize);
  const notesClipped = planned.filter((c) => c.noteOmittedChars !== undefined).length;
  const quotesClipped = planned.filter(
    (c) => c.quote !== undefined && c.quoteOmittedChars !== undefined,
  ).length;
  const truncated =
    commentsOmitted > 0 ||
    quotesOmitted > 0 ||
    snippetsOmitted > 0 ||
    notesClipped > 0 ||
    quotesClipped > 0;

  const plan: CommentsPlan = {
    comments: planned,
    commentsOmitted,
    quotesOmitted,
    snippetsOmitted,
    truncated,
  };
  if (!truncated) return plan;
  plan.budgetNote = describeCommentCuts({
    shown: planned.length,
    commentsOmitted,
    quotesOmitted,
    snippetsOmitted,
    notesClipped,
    quotesClipped,
    budget,
  });
  return plan;
}

/**
 * The `budgetNote`, naming ONLY the cut that actually happened — reporting a bound that did not
 * fire sends the reader looking for a cause that is not there (`conflictBudget.ts`'s rule, kept by
 * `searchBudget.ts`, `citationsBudget.ts` and `diffBudget.ts` after it).
 *
 * Every branch's text is bounded, and `test/unit/commentsBudget.test.ts` renders the worst
 * combination of them to pin that it fits inside {@link COMMENTS_NOTE_RESERVE} in both channels.
 */
function describeCommentCuts(c: {
  shown: number;
  commentsOmitted: number;
  quotesOmitted: number;
  snippetsOmitted: number;
  notesClipped: number;
  quotesClipped: number;
  budget: number;
}): string {
  const parts: string[] = [];
  if (c.commentsOmitted > 0) {
    parts.push(
      `showing ${c.shown} of ${c.shown + c.commentsOmitted} comment(s) — the other ` +
        `${c.commentsOmitted} are still in the viewer, so resolve_comments the ones you have ` +
        'handled and list again to reach them',
    );
  }
  if (c.quotesOmitted > 0) {
    parts.push(`${c.quotesOmitted} quote(s) dropped (still selectable in the viewer)`);
  }
  if (c.snippetsOmitted > 0) {
    parts.push(`${c.snippetsOmitted} source snippet(s) dropped (read_file at the file:line)`);
  }
  if (c.notesClipped > 0) parts.push(`${c.notesClipped} note(s) clipped`);
  if (c.quotesClipped > 0) parts.push(`${c.quotesClipped} quote(s) clipped`);
  return (
    `${parts.join('; ')}. The ${c.budget}-character budget is charged across both channels ` +
    '(every comment is rendered as text AND into structuredContent.comments). Cut in this order: ' +
    'snippet first, then quote, then whole comments last — identity and note always survive, so ' +
    'every listed comment can still be passed to resolve_comments.'
  );
}
