/**
 * Deciding how much of `list_files`' listing may be returned, against a character budget charged
 * on the RENDERED result in BOTH channels. A pure planner over plain data, the same shape as
 * `src/lib/conflictBudget.ts` (issue #68), `src/lib/floatsBudget.ts`, `src/lib/searchBudget.ts`,
 * `src/lib/citationsBudget.ts` and `src/lib/diffBudget.ts`: a budget, a plan, a human-readable
 * `note`, and a tool layer that only maps the plan onto response shapes. It imports nothing from
 * the tool layer (only the `FileEntry` *type*) and touches no fs/process/clock, so it stays
 * testable without a live MCP client.
 *
 * Why it exists (issue #164): `list_files` had no bound of any kind — no cap, no `maxResults`, no
 * counter — and it renders the whole listing **twice**, once as `structuredContent.files` and
 * once as a text line per entry. `filter` and `subdir` narrow it, but both are optional and the
 * default is `all` over the project root. A `figures/` tree with one PDF per seed per ablation, a
 * vendored conference style bundle, or a `mode: 'local'` project registered on a directory the
 * server does not control at all, all reach thousands of entries; at ~60 characters of path in two
 * channels, 5000 entries is ~600k, which is the #68 defect exactly — a payload the client rejects
 * **undelivered**, so the caller gets no listing and no reason. And this is the tool an agent
 * calls *first* to orient itself in a project it has never seen.
 *
 * What makes this budget different from the rest of the family, and the three decisions that
 * follow from it:
 *
 *  1. **The item IS the answer.** Every prior budget cut *content* out of items the caller asked
 *     for — a hunk, a context line, a BibTeX title. Here each item is tiny and it is the COUNT
 *     that is unbounded, so there is nothing inside an entry to trim: an entry is kept whole or
 *     not at all. That is why the house `capList` figure of 20 is plainly the wrong instrument —
 *     a listing tool that returns 20 of 5000 files is not a listing tool — and why the bound is
 *     {@link FILE_LIST_CONTENT_BUDGET} in **characters**: a flat project of 400 short paths comes
 *     back whole, while a deep tree of long ones is cut, which is the behaviour a fixed item count
 *     cannot express in either direction.
 *
 *  2. **Which entries survive is decided by {@link TYPE_PRIORITY}, not by walk order.** The walk
 *     sorts by path, so `assets/` beats `main.tex` on the letter `a` and a figures tree starves
 *     the `.tex` files the caller is almost certainly after. `type` is already on every entry and
 *     is the only thing in it that says what an entry is *for*.
 *
 *  3. **A cut must stay structurally distinguishable from an empty project.** `files: []` means
 *     "nothing matched" and must keep meaning only that, so this planner **never returns an empty
 *     array because of the budget**: see the keep-at-least-one rule in {@link planFileList}. A cut
 *     result always carries a non-zero `omittedBySize`/`omittedByCap`, a `note`, and
 *     `files.length < totalFiles`.
 *
 * The render functions live here beside the cost functions and the cost functions **call** them
 * (the `diffBudget.ts` technique), so the charge and the text are the same code and cannot drift
 * apart. The tool must hand the planner's own entries to `structuredContent` and build its text
 * with {@link renderFileListText}, or the charge stops describing what is sent — a unit test pins
 * the total of both channels against the budget to keep that honest.
 */

import type { FileEntry, FileType } from '../services/fileService.js';

/**
 * Total character budget for one `list_files` result across BOTH channels combined — the
 * JSON-encoded `files` array and the rendered text lines, which are the same information twice.
 *
 * 40000 is a deliberate **double** of this codebase's house figure (20000 —
 * `CONFLICT_CONTENT_BUDGET`, `FLOATS_CONTENT_BUDGET`, `SEARCH_CONTENT_BUDGET`,
 * `CITATIONS_CONTENT_BUDGET`, `DIFF_CONTENT_BUDGET`), and the doubling is the one figure in this
 * module that has to be argued rather than copied:
 *
 * - The house 20000 is "one document-controlled **field's share** of a tool result" — sized so
 *   that field still leaves room for everything else in the same result. `list_files` has no
 *   everything-else: there is no summary, no second payload, no log tail. The listing *is* the
 *   result, so the share and the whole are the same thing and there is nothing for it to leave
 *   room for.
 * - The charge here is across both channels, as in `diffBudget.ts`. Taking 20000 across both
 *   would put this tool's whole result at the size of a `diff`'s — roughly 200 entries at ordinary
 *   path lengths. For the tool an agent calls first to orient itself, 200 of 5000 is the same
 *   objection as 20 of 5000, only quieter. 40000 is therefore one house share **per channel**,
 *   which is what the house figure already grants any single rendered payload.
 * - The ceiling this whole family is sized against is the ~67k a client actually rejected in #68.
 *   A result bounded at 40000 characters in total (plus a bounded note and the small JSON
 *   scaffolding, both charged below) stays under that with room to spare, which is the property
 *   that matters; being under it twice over is not.
 *
 * It buys roughly 400 entries at short paths and roughly 200 at the ~60-character paths a deep
 * `figures/` tree produces — cut by priority, and counted.
 */
export const FILE_LIST_CONTENT_BUDGET = 40000;

/**
 * Withheld from the budget to pay for the single `note`, which also ships in both channels (as a
 * trailing text line and as `structuredContent.note`). The note describes the cuts, so charging it
 * per-part would be circular; reserving a flat allowance and pinning (in
 * `test/unit/fileListBudget.test.ts`) that the longest note this module can produce fits inside it
 * gives the same guarantee without the circularity. Same technique as `DIFF_NOTE_RESERVE`.
 */
export const FILE_LIST_NOTE_RESERVE = 1400;

/**
 * The JSON punctuation, key names and counter digits `structuredContent` wraps around the payload
 * — everything except the `files` elements and the `note` body, both charged exactly. Pinned by a
 * test that stringifies a real result and checks this still accounts for it.
 */
export const FILE_LIST_STRUCTURED_SCAFFOLD_OVERHEAD = 260;

/** The `[` and `]` around the JSON `files` array, charged up front. */
const ARRAY_JSON_OVERHEAD = 2;

/** The comma between two JSON array elements, charged per element. */
const ELEMENT_SEPARATOR_OVERHEAD = 1;

/** The `\n` between two text lines, charged per line. */
const TEXT_LINE_SEPARATOR_OVERHEAD = 1;

/**
 * The order entries are kept in when the budget cannot hold them all: **highest priority first**,
 * and once the budget is exhausted everything below the cut is dropped and counted. Selection
 * order only; the kept entries are emitted back in the original path order (see
 * {@link planFileList}), because a listing that jumps between types is a worse listing.
 *
 * Why each rank earns its place:
 *
 *  1. `tex` — the document itself. Every compile, every read, every edit starts from a `.tex`, and
 *     a listing that lost them cannot answer the question it was called for. They are also few:
 *     even a heavily split paper is tens of files, so ranking them first costs the ranks below
 *     almost nothing.
 *  2. `bib` — the bibliography. Usually one to three files, needed by `add_citation`,
 *     `check_citations` and `list_references` alike, and the guarded target whose *name* a caller
 *     has to know before it can pass `confirmBibEdit`. Cheap to keep whole.
 *  3. `doc` — prose documents (`.md`/`.txt`/`.rst`/`.org`). For a `mode: 'local'` draft with no
 *     `.tex` at all these *are* the source, and there the ranks above are empty so `doc` gets the
 *     whole budget anyway; ranked below `.tex` only because a project that has `.tex` files is a
 *     LaTeX project and they are what it is about.
 *  4. `other` — `.sty`, `.cls`, `.bbl`, a Makefile, a script. Ranked above `asset` on
 *     **recoverability**, the same reasoning that makes `conflictBudget.ts` cut the sides before
 *     the hunks: `filter` has a value that brings back assets whole (`assets`), and values for
 *     `tex`/`bib`/`docs`, but **no value isolates `other`** — a caller who loses these can only
 *     get them back by narrowing `subdir`, which requires already knowing where they are. They are
 *     also what explains a failed build: a missing `.sty` is the answer to a compile error.
 *  5. `asset` — images and PDFs. Last because this is the class that is unbounded in practice (one
 *     PDF per seed per ablation), the least informative per entry (a caller learns little from the
 *     4000th `.png` that they did not learn from the first), and the most precisely recoverable:
 *     `filter: "assets"` returns exactly this class, under its own budget, with nothing else
 *     competing for it. Cutting assets is the cut with a one-call remedy, so it is the cut to make.
 */
export const TYPE_PRIORITY: readonly FileType[] = ['tex', 'bib', 'doc', 'other', 'asset'];

/** A zeroed per-type tally, in {@link TYPE_PRIORITY} order. */
function emptyTally(): Record<FileType, number> {
  return { tex: 0, bib: 0, doc: 0, other: 0, asset: 0 };
}

/** What the planner decided about one listing. */
export interface FileListPlan {
  /** The kept entries, in the ORIGINAL (path-sorted) order — never re-ordered by priority. */
  files: FileEntry[];
  /** Every entry the walk produced, before any bound was applied. */
  totalFiles: number;
  /** Entries cut by the caller's `maxResults`. */
  omittedByCap: number;
  /** Entries cut by the character budget. */
  omittedBySize: number;
  /** What was cut, by `type` — present only when something was cut at all. */
  omittedByType?: Record<FileType, number>;
  /** Present only when something was actually cut; names only the bound that fired. */
  note?: string;
}

export interface FileListBudgetOptions {
  /** Total characters across both channels. Defaults to {@link FILE_LIST_CONTENT_BUDGET}. */
  budget?: number;
  /** Caller-supplied item cap. Absent means no item cap at all — only the character budget. */
  maxResults?: number;
}

/**
 * One entry as the text channel renders it. The template lives here so {@link entryCost} can call
 * it; `list_files` must render its text through {@link renderFileListText}, which uses this.
 */
export function renderFileLine(entry: FileEntry): string {
  return `${entry.path} (${entry.type}, ${entry.sizeBytes}B)`;
}

/**
 * What one entry costs once this server has rendered it: its JSON object in
 * `structuredContent.files` (escaping and all — a path can carry a backslash or a quote on some
 * filesystems, and `JSON.stringify` is the only honest measure of that) plus the element comma,
 * plus its text line and the newline after it. Both channels ship in the same result, so they add.
 */
export function entryCost(entry: FileEntry): number {
  return (
    JSON.stringify(entry).length +
    ELEMENT_SEPARATOR_OVERHEAD +
    renderFileLine(entry).length +
    TEXT_LINE_SEPARATOR_OVERHEAD
  );
}

/**
 * What a plain string costs in both channels: verbatim in the text and JSON-encoded into
 * `structuredContent`. Used to charge the `note` against {@link FILE_LIST_NOTE_RESERVE}.
 */
export function renderCost(s: string): number {
  return s.length + JSON.stringify(s).length;
}

/**
 * The whole text channel for a plan, rendered from the ALREADY-CUT entries — never from the full
 * listing, or the channel that was supposed to be trimmed would reintroduce the payload the budget
 * exists to prevent (the rule `searchFiles.ts` states, and `compile`'s `warningsFilter` for
 * `logTail`).
 *
 * With nothing cut the output is byte-identical to what `list_files` returned before this budget
 * existed: the same one line per entry, the same `No matching files.` for an empty listing, and no
 * extra header. The note is appended as a trailing line and only when there is one, so an
 * unbudgeted call is unchanged on the wire.
 */
export function renderFileListText(plan: FileListPlan): string {
  const body =
    plan.files.length === 0 ? 'No matching files.' : plan.files.map(renderFileLine).join('\n');
  return plan.note ? `${body}\n${plan.note}` : body;
}

/**
 * Plan which entries fit.
 *
 * Entries are considered in {@link TYPE_PRIORITY} order and, within one type, in the order given
 * (the walk's path order). Each is charged {@link entryCost} until the next would push the running
 * total past the budget; that entry and **every one after it** are cut and counted, so a cheap
 * `asset` can never slip in behind a cut `tex` — strict priority, the rule `citationsBudget.ts`
 * states for its lanes. The kept entries are then restored to the original order, because
 * selection order and presentation order answer different questions: the caller reads a listing as
 * a tree, not as a ranking.
 *
 * **Keep-at-least-one, and here it is load-bearing rather than a courtesy.** If the first entry
 * considered does not fit the whole budget it is kept regardless, because `files: []` is the
 * answer "nothing matched" and the budget must never be able to forge it. The exception cannot
 * compound: the running total absorbs the full cost, so everything after it is cut.
 *
 * At most one of `omittedByCap` and `omittedBySize` is ever non-zero, by construction — nothing is
 * kept after either bound fires, so the second can never be reached — which is what lets the
 * `note` name a single bound without having to choose between two that both fired.
 */
export function planFileList(
  entries: readonly FileEntry[],
  opts: FileListBudgetOptions = {},
): FileListPlan {
  const budget = opts.budget ?? FILE_LIST_CONTENT_BUDGET;
  const maxResults = opts.maxResults;
  // The note and the JSON scaffolding ship alongside the entries, so the entries never get the
  // whole budget; `Math.max` keeps a deliberately tiny test budget from going negative.
  const available = Math.max(
    budget - FILE_LIST_NOTE_RESERVE - FILE_LIST_STRUCTURED_SCAFFOLD_OVERHEAD,
    0,
  );

  const ranked = entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => rankOf(a.entry.type) - rankOf(b.entry.type) || a.index - b.index);

  const kept: Array<{ entry: FileEntry; index: number }> = [];
  const omittedByType = emptyTally();
  let used = ARRAY_JSON_OVERHEAD;
  let omittedByCap = 0;
  let omittedBySize = 0;
  let oversizedFirst = 0;

  for (const candidate of ranked) {
    if (maxResults !== undefined && kept.length >= maxResults) {
      omittedByCap++;
      omittedByType[candidate.entry.type]++;
      continue;
    }
    if (omittedBySize > 0) {
      omittedBySize++;
      omittedByType[candidate.entry.type]++;
      continue;
    }
    const cost = entryCost(candidate.entry);
    if (used + cost <= available) {
      used += cost;
      kept.push(candidate);
      continue;
    }
    if (kept.length === 0) {
      used += cost;
      kept.push(candidate);
      oversizedFirst = cost;
      continue;
    }
    omittedBySize++;
    omittedByType[candidate.entry.type]++;
  }

  kept.sort((a, b) => a.index - b.index);
  const plan: FileListPlan = {
    files: kept.map((k) => k.entry),
    totalFiles: entries.length,
    omittedByCap,
    omittedBySize,
  };
  if (omittedByCap + omittedBySize > 0) {
    plan.omittedByType = omittedByType;
    plan.note = buildFileListNote(plan, { budget, maxResults, oversizedFirst });
  }
  return plan;
}

function rankOf(type: FileType): number {
  const rank = TYPE_PRIORITY.indexOf(type);
  // An unranked type would otherwise sort first and outrank `.tex`; put it last instead.
  return rank === -1 ? TYPE_PRIORITY.length : rank;
}

/** `asset 1200, other 43`, in priority order, listing only what was actually cut. */
function tallyText(tally: Record<FileType, number>): string {
  return TYPE_PRIORITY.filter((t) => tally[t] > 0)
    .map((t) => `${t} ${tally[t]}`)
    .join(', ');
}

/**
 * The `note`, naming ONLY the bound that actually fired — reporting a cap that did not fire sends
 * the reader looking for a cause that is not there (`conflictBudget.ts`'s rule for its three
 * caps). Unlike most of this family the remedy here is real and already exists, so the note ends
 * by naming it: `subdir` and `filter` both narrow the walk itself, and the omitted entries come
 * back whole under either.
 *
 * Exported so a test can charge the WORST note this module can produce — every counter at seven
 * digits, the longest of the three causes — against {@link FILE_LIST_NOTE_RESERVE}, which is the
 * pin that lets the planner withhold a flat allowance instead of charging the note per-part.
 */
export function buildFileListNote(
  plan: FileListPlan,
  ctx: { budget: number; maxResults?: number; oversizedFirst: number },
): string {
  const omitted = plan.omittedByCap + plan.omittedBySize;
  const cause =
    plan.omittedByCap > 0
      ? `maxResults is ${ctx.maxResults}`
      : ctx.oversizedFirst > 0
        ? `the first entry alone renders to ${ctx.oversizedFirst} chars, over the whole ` +
          `${ctx.budget}-char payload budget — it is returned regardless, and everything after ` +
          `it was cut`
        : `the ${ctx.budget}-char payload budget was reached (charged across both channels: the ` +
          `JSON files array and the rendered text lines)`;
  const by = plan.omittedByType ? tallyText(plan.omittedByType) : '';
  return (
    `${omitted} of ${plan.totalFiles} file(s) omitted: ${cause}. ` +
    `Entries are kept in this priority order — ${TYPE_PRIORITY.join(', ')} — so the sources ` +
    `survive a cut and a large figures tree is what goes` +
    (by ? `; omitted by type: ${by}` : '') +
    '. Narrow the listing with subdir (a directory of the project) or filter ' +
    '(tex/bib/docs/assets): both narrow the walk itself, so the omitted entries come back whole.'
  );
}
