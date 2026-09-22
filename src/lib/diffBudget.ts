/**
 * Deciding how much of a unified diff may be returned, against a character budget charged on the
 * RENDERED result. A pure planner over plain strings, the same shape as `src/lib/conflictBudget.ts`
 * (issue #68), `src/lib/floatsBudget.ts` and `src/lib/searchBudget.ts`: a budget, a plan, a
 * human-readable `note`, and a tool layer that only maps the plan onto response shapes.
 *
 * Why it exists (issue #153). `diff` was the largest unbudgeted payload in the server and one of
 * the most-called tools: `GitService.diff` is a raw `git diff` plus a numstat, capping nothing, and
 * `src/tools/diff.ts` returned the patch **twice** — verbatim in the result text and again in
 * `structuredContent.diff`. A regenerated `.bbl`, a re-exported `.svg`, or `ref: "HEAD~20"` is one
 * call away from the ~67k-character payload that a client rejected outright in #68, delivering
 * nothing at all. Unlike the conflict case there is no anomaly to notice first: a diff is
 * *expected* to be large.
 *
 * Three decisions carry this module, and each is easy to get wrong:
 *
 *  1. **Cut at hunk boundaries, never inside one.** Unlike `fields` (droppable whole) or a rendered
 *     page (a tail), a patch is a sequence of hunks whose `@@ -a,b +c,d @@` headers are what give
 *     the lines underneath them meaning. Truncating mid-hunk produces text that looks like a diff
 *     and is not one — a reader (or a patch tool) cannot tell the difference. So the unit of
 *     inclusion is a whole hunk, the `diff --git`/`index`/`---`/`+++` headers of every file that
 *     got cut are kept, and what went is counted and named in place.
 *  2. **Charge BOTH channels.** #68's second round established that a budget must be charged
 *     against what is actually rendered, not against raw content. Here the very same patch string
 *     is emitted twice — once verbatim in the text channel, once JSON-encoded into
 *     `structuredContent.diff` — so a budget counting it once is wrong by 2x. {@link renderCost}
 *     charges a string at `s.length + JSON.stringify(s).length`, i.e. roughly twice its size plus the
 *     real escaping cost (LaTeX is backslash-dense; a raw-length charge under-counts the JSON
 *     side). This is a deliberate departure from `conflictBudget.ts`, which takes the MAX of its
 *     two channels: there the two channels are different *framings* of the same data (marker text
 *     vs. a JSON array), so each is bounded on its own; here they are byte-for-byte the same
 *     string, so they add.
 *  3. **Everything that renders is charged, including what replaces what was cut.** The per-file
 *     summary (`path +N -M` in the text, `files[]` in JSON), each kept file's mandatory header
 *     block, and each omission marker are all charged — the marker allowance up front, per
 *     included file, at the exact size the marker would be if that file lost *every* hunk, so the
 *     budget can never be overrun by the boilerplate that explains the overrun. Only the single
 *     aggregate `note` is not charged per-part (its text depends on the decisions it describes):
 *     a flat {@link DIFF_NOTE_RESERVE} is withheld from the budget for it instead, and a test pins
 *     that the worst note this module produces fits inside that reserve.
 *
 * The render functions live here beside the cost functions, and the cost functions call them. That
 * is stronger than `conflictBudget.ts`'s pinned-constant technique (which it needs because its
 * templates live in `conflictText.ts`): a template and its charge that are the same call cannot
 * drift apart at all. The constants below are for the pieces rendered *outside* this module — the
 * JSON scaffolding `structuredContent` wraps around the payload — and those are pinned by a test
 * that stringifies a real result and checks the constant still accounts for it.
 */

import type { DiffFile } from '../services/gitService.js';

/**
 * Total character budget for one `diff` result across BOTH channels combined.
 *
 * 20000 is this codebase's house figure for a rendered content budget — `CONFLICT_CONTENT_BUDGET`,
 * `FLOATS_CONTENT_BUDGET`, `SEARCH_CONTENT_BUDGET` — sized so the worst case lands well under the
 * ~67k a client actually rejected. Nothing about a patch argues for a different number, and a
 * second number for the same class only invites the question of which one is right.
 */
export const DIFF_CONTENT_BUDGET = 20000;

/**
 * The much smaller budget for a write/edit confirmation diff (`src/lib/changeDiff.ts`, feeding
 * `write_file`/`edit_file`/`add_citation`), charged the same way across both channels.
 *
 * Deliberately NOT the house content budget above, and the reason is the difference between the
 * two calls rather than a preference about size: `diff` returns the patch *the caller asked for*,
 * while a confirmation diff is a courtesy echo of a change the caller just made — nobody requested
 * it, and the answer to `write_file` is "written". A `write_file` that overwrites a 60k-character
 * file otherwise ships that whole file straight back as a `+`-prefixed hunk, twice. The headline
 * (`wrote main.tex (61234 bytes)`) and the summary already carry the fact that matters, the first
 * hunks still show the shape of the change, and the whole patch is one `diff` call away — which is
 * the escape hatch here, rather than a per-call flag on three write tools.
 *
 * 2000 is the house figure for a *diagnostic* share of a result (`SEARCH_SKIPPED_BUDGET`), which
 * is exactly what an unrequested echo is.
 */
export const CHANGE_DIFF_BUDGET = 2000;

/**
 * Hard cap on how many files appear in `files[]`, and on how many get a section in the patch.
 * 20 matches the house style for a capped list (`capList` in `gitService.ts`,
 * `CONFLICT_MAX_FILES`). What is cut is counted, never dropped silently, and `detail: "full"`
 * lifts it.
 */
export const DIFF_MAX_FILES = 20;

/**
 * Withheld from the budget to pay for the single aggregate `note` in both channels. The note
 * describes the cuts, so charging it per-part would be circular; reserving a flat allowance and
 * pinning (in `test/unit/diffBudget.test.ts`) that the longest note this module can produce fits
 * inside it gives the same guarantee without the circularity.
 */
export const DIFF_NOTE_RESERVE = 1600;

/** The `"` pair `JSON.stringify` wraps around `structuredContent.diff`. */
export const DIFF_JSON_QUOTES_OVERHEAD = 2;

/**
 * The JSON punctuation and key names `structuredContent` wraps around a `diff` result — every key
 * except the two payload fields' contents (`diff`'s string body and `files`' elements, both
 * charged exactly), plus room for the counters' digits. Pinned by a test that stringifies a real
 * result and checks this still accounts for it, the same technique `conflictBudget.ts` uses for
 * the templates it cannot call.
 */
export const DIFF_STRUCTURED_SCAFFOLD_OVERHEAD = 200;

/** The `\n\n` the text channel puts between the summary, the patch and the note. */
export const DIFF_TEXT_SEPARATOR_OVERHEAD = 2;

/** `[` and `]` around the JSON `files` array. */
const FILES_ARRAY_JSON_OVERHEAD = 2;

/** The comma between two JSON array elements, charged per element. */
const FILES_ELEMENT_SEPARATOR_OVERHEAD = 1;

/**
 * What one string costs once this server has rendered it: verbatim in the result's text content
 * AND JSON-encoded into `structuredContent`. `JSON.stringify(s).length` already includes the two
 * quotes (charged once per field by {@link DIFF_JSON_QUOTES_OVERHEAD}, so they are removed here)
 * and, crucially, the real cost of escaping every `\`, `"`, newline and control character — the
 * term a raw-length charge misses.
 */
export function renderCost(s: string): number {
  return s.length + JSON.stringify(s).length - DIFF_JSON_QUOTES_OVERHEAD;
}

/**
 * What one string costs when this server renders it in exactly ONE channel — JSON-encoded into
 * `structuredContent` and nowhere else. The `JSON.stringify` term is kept for the same reason
 * {@link renderCost} keeps it: it is the real escaping cost, and LaTeX is backslash-dense, so a
 * raw-length charge under-counts. The two quotes are charged once per field by
 * {@link DIFF_JSON_QUOTES_OVERHEAD} and so are removed here.
 *
 * `push`'s branch-mode review diff (issue #160) is the caller for this: its result text is the
 * one-line `prepareBranch` summary, and the patch itself travels only in `structuredContent.diff`.
 */
export function structuredOnlyCost(s: string): number {
  return JSON.stringify(s).length - DIFF_JSON_QUOTES_OVERHEAD;
}

/** A single file's section of a unified diff. */
export interface PatchSection {
  /**
   * Best-effort path, read from the section's `+++ b/…` line (or `--- a/…` for a deletion), which
   * is the side a caller would go on to read. `''` when neither is present (a mode-only change, or
   * text before the first `diff --git`). Used only in an omission marker, never to open anything.
   */
  path: string;
  /**
   * Everything before the first `@@` — `diff --git`, `index`, `old mode`/`new mode`,
   * `--- a/…`, `+++ b/…`, `Binary files … differ`. Kept whenever the section is kept at all, so a
   * file whose hunks were cut is still named and still says what kind of change it was.
   */
  header: string;
  /** Each `@@ …` block with its body, in order. Empty for a binary or mode-only change. */
  hunks: string[];
}

/**
 * Split a unified diff into per-file sections, headers apart from hunks.
 *
 * A new section starts at a line-initial `diff --git `; inside one, a line-initial `@@ -` starts a
 * hunk. Neither can be confused with content: every line of a hunk body starts with ' ', '+', '-'
 * or '\' (the no-newline marker). Any text before the first `diff --git ` (which `git diff` does
 * not produce, but a caller of this planner could hand over) becomes one path-less section whose
 * whole body is a single elidable chunk rather than an uncuttable mandatory header.
 */
export function splitPatch(patch: string): PatchSection[] {
  if (patch === '') return [];
  // Lookbehind split keeps each line's own '\n', so joining sections back together is exact —
  // including a final line with no trailing newline.
  const lines = patch.split(/(?<=\n)/);
  const sections: PatchSection[] = [];
  const preamble: string[] = [];
  let header: string[] | null = null;
  let hunks: string[][] = [];

  const flush = (): void => {
    if (header === null) return;
    sections.push({
      path: sectionPath(header),
      header: header.join(''),
      hunks: hunks.map((h) => h.join('')),
    });
    header = null;
    hunks = [];
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flush();
      header = [line];
      continue;
    }
    if (header === null) {
      preamble.push(line);
      continue;
    }
    if (line.startsWith('@@ -')) {
      hunks.push([line]);
      continue;
    }
    const open = hunks[hunks.length - 1];
    if (open) open.push(line);
    else header.push(line);
  }
  flush();

  if (preamble.length > 0) {
    sections.unshift({ path: '', header: '', hunks: [preamble.join('')] });
  }
  return sections;
}

/** The path a section is about, from its `+++ b/…` (or `--- a/…`) line. */
function sectionPath(headerLines: string[]): string {
  const plus = headerLines.find((l) => l.startsWith('+++ '));
  const minus = headerLines.find((l) => l.startsWith('--- '));
  for (const line of [plus, minus]) {
    if (line === undefined) continue;
    const value = line
      .slice(4)
      .replace(/\r?\n$/, '')
      .trim();
    if (value === '/dev/null') continue;
    return value.replace(/^[ab]\//, '');
  }
  return '';
}

/**
 * The marker left in the patch where a file's hunks were cut. Rendered here, beside the cost
 * function that charges it, so the charge and the text are the same call and cannot drift.
 *
 * It starts with `... ` rather than a space, `+`, `-`, `@` or `\`, so it is not a line any patch
 * reader will mistake for diff content — a truncated patch is not a patch, and this says so in
 * place instead of leaving a caller to notice the line counts do not add up.
 */
export function renderHunkOmissionMarker(
  section: { path: string },
  omitted: number,
  total: number,
  chars: number,
  hint: string,
): string {
  const where = section.path ? ` of ${section.path}` : '';
  return `... ${omitted} of ${total} hunk(s)${where} omitted (${chars} chars)${hint ? ` — ${hint}` : ''}\n`;
}

/** The marker left at the end of the patch when whole file sections were dropped. */
export function renderFileOmissionMarker(count: number, hint: string): string {
  return `... ${count} more changed file(s) omitted from this patch${hint ? ` — ${hint}` : ''}\n`;
}

/** What the planner decided about one patch, independent of which tool asked. */
interface PatchPlan {
  patch: string;
  /** Hunks cut from a file that DID get a section. */
  hunksOmitted: number;
  /** Files with at least one cut hunk. */
  filesWithCutHunks: number;
  /** Whole sections dropped — header, hunks and all. */
  sectionsOmitted: number;
  /** True when the mandatory summary/header charges alone left nothing for content. */
  starved: boolean;
}

interface PatchBudgetOptions {
  budget: number;
  maxFiles: number;
  /** Route-to-the-rest text appended to each omission marker; `''` when a `note` carries it. */
  hint: string;
  /**
   * What one rendered string costs. Defaults to {@link renderCost} — BOTH channels — because that
   * is what `diff` and `changeDiff` do; a caller whose payload ships in only ONE channel passes
   * {@link structuredOnlyCost} instead. The charge is a parameter rather than a constant precisely
   * so the two cannot be confused: a single-channel payload charged twice silently halves what the
   * caller gets, and a two-channel payload charged once overruns by 2x, which is the #68 defect.
   */
  cost?: (s: string) => number;
}

/**
 * Fill a patch against a budget, whole hunks only.
 *
 * Sections are taken in order, capped at `maxFiles`, and each one's header block is a mandatory
 * charge: a file that appears at all must say which file it is and what kind of change it was.
 * A section whose header does not fit is dropped entirely — with every section after it, so the
 * kept set stays a prefix — and counted.
 *
 * Hunks are then taken in order, and **the tail of each FILE is cut**: within a file, once one
 * hunk does not fit, no later hunk of that file is kept either, so a file's hunks are always a
 * prefix of its real ones and never carry an unmarked hole in the middle. The cut does NOT carry
 * over to the next file, and that boundary is the whole decision: a regenerated `.bbl` or a
 * re-exported `.svg` is exactly the kind of first file that blows a budget, and letting it blank
 * every later file's hunks would lose the part of the patch a reviewer actually came for. Nothing
 * is reordered or cherry-picked by size either way — files and hunks stay in git's order, each
 * file that lost hunks says so in place, and the counts are reported.
 *
 * There is deliberately **no keep-at-least-one rule** here, unlike `searchBudget.ts`. One search
 * row over budget is still an answer; one hunk can be an entire regenerated `.bbl`, and keeping it
 * would reproduce the exact defect this module exists to fix. The header still names the file and
 * the marker still names the size, so the caller is told what is there and how to get it.
 */
function planPatch(sections: PatchSection[], opts: PatchBudgetOptions): PatchPlan {
  const renderCharge = opts.cost ?? renderCost;
  const kept = sections.slice(0, opts.maxFiles);
  let sectionsOmitted = sections.length - kept.length;

  // Reserve the worst case for the "N more file(s) omitted" marker up front: its real length for
  // the largest count it could ever carry. Cheaper to over-charge by a few digits than to discover
  // the boilerplate explaining an overrun caused one.
  let remaining = opts.budget;
  if (sections.length > 0) {
    remaining -= renderCharge(renderFileOmissionMarker(sections.length, opts.hint));
  }

  const included: PatchSection[] = [];
  for (const [i, section] of kept.entries()) {
    // Charge the header AND, up front, the exact marker this file would need if it lost every one
    // of its hunks. The allowance can only be an over-charge (the file may keep everything), never
    // an under-charge, which is what makes the rendered total a real bound.
    const mandatory =
      renderCharge(section.header) +
      (section.hunks.length > 0
        ? renderCharge(
            renderHunkOmissionMarker(
              section,
              section.hunks.length,
              section.hunks.length,
              section.hunks.reduce((n, h) => n + h.length, 0),
              opts.hint,
            ),
          )
        : 0);
    if (mandatory > remaining) {
      sectionsOmitted += kept.length - i;
      break;
    }
    remaining -= mandatory;
    included.push(section);
  }
  // A distinct cause, worth naming apart from "hunks were cut" exactly as `conflictBudget.ts`
  // names `headersExhaustedBudget` apart from its aggregate budget: the mandatory charges — the
  // caller's summary and the kept files' headers — left nothing at all for content, so this is a
  // report about path lengths and file counts, not about how big the change is.
  const starved = remaining <= 0 && sections.some((s) => s.hunks.length > 0);

  let hunksOmitted = 0;
  let filesWithCutHunks = 0;
  const parts: string[] = [];
  for (const section of included) {
    parts.push(section.header);
    // Per FILE, not per patch — see the note above on why the cut stops at the file boundary.
    let stopped = false;
    let cut = 0;
    let cutChars = 0;
    for (const hunk of section.hunks) {
      if (!stopped) {
        const cost = renderCharge(hunk);
        if (cost <= remaining) {
          remaining -= cost;
          parts.push(hunk);
          continue;
        }
        stopped = true;
      }
      cut += 1;
      cutChars += hunk.length;
    }
    if (cut > 0) {
      hunksOmitted += cut;
      filesWithCutHunks += 1;
      parts.push(renderHunkOmissionMarker(section, cut, section.hunks.length, cutChars, opts.hint));
    }
  }
  if (sectionsOmitted > 0) {
    parts.push(renderFileOmissionMarker(sectionsOmitted, opts.hint));
  }
  return {
    patch: parts.join(''),
    hunksOmitted,
    filesWithCutHunks,
    sectionsOmitted,
    starved,
  };
}

/** The budgeted `diff` payload, driving BOTH channels — `src/tools/diff.ts` renders from this and
 * from nothing else, so the text and `structuredContent` can never disagree about what was cut. */
export interface DiffPlan {
  /** The patch as it will be sent. Cut at hunk boundaries, with a marker where anything went. */
  diff: string;
  /** Characters in the FULL patch, before any cut — so a caller always knows the real size. */
  diffChars: number;
  /** Per-file added/removed counts, capped at {@link DIFF_MAX_FILES}. */
  files: DiffFile[];
  /** Entries cut from {@link DiffPlan.files} by that cap. */
  filesOmitted: number;
  /** Hunks cut from a file the patch still details. */
  hunksOmitted: number;
  /** Files the patch drops entirely — no header, no hunks. Distinct from `filesOmitted`: this one
   * is about the patch, that one about the summary list, and the caps can fire independently. */
  patchFilesOmitted: number;
  /** True iff anything at all was cut. Never inferred from an empty `diff`: an empty patch means
   * "nothing changed", and the two must never be confusable. */
  truncated: boolean;
  /** What was cut and how to get it — present only when something actually was. */
  note?: string;
  /** Echoed back so the renderer and the structured payload name the same ref. */
  ref?: string;
}

export interface DiffPlanOptions {
  /** `'full'` is the escape hatch: nothing cut, nothing capped, as `conflictDetail: 'full'` is. */
  detail?: 'auto' | 'full';
  ref?: string;
  budget?: number;
  maxFiles?: number;
}

/** The text-channel summary: one `path +N -M` line per file, then what the cap left out. */
export function renderDiffSummary(plan: Pick<DiffPlan, 'files' | 'filesOmitted' | 'ref'>): string {
  if (plan.files.length === 0) {
    return `No changes${plan.ref ? ` vs ${plan.ref}` : ''}.`;
  }
  const lines = plan.files.map((f) => `${f.path} +${f.added} -${f.removed}`);
  if (plan.filesOmitted > 0) {
    lines.push(
      `... ${plan.filesOmitted} more changed file(s) not listed ` +
        `(${plan.files.length + plan.filesOmitted} changed in all)`,
    );
  }
  return lines.join('\n');
}

/** The whole text channel, built from the plan and nothing else. */
export function renderDiffText(plan: DiffPlan): string {
  const parts = [renderDiffSummary(plan)];
  if (plan.diff) parts.push(plan.diff);
  if (plan.note) parts.push(plan.note);
  return parts.join('\n\n');
}

/** Exact rendered cost of the summary: its text-channel lines plus the JSON `files` array. */
function summaryCost(files: DiffFile[], filesOmitted: number, ref: string | undefined): number {
  const text = renderDiffSummary({ files, filesOmitted, ref });
  const json =
    FILES_ARRAY_JSON_OVERHEAD +
    files.reduce((n, f) => n + JSON.stringify(f).length + FILES_ELEMENT_SEPARATOR_OVERHEAD, 0);
  return text.length + json;
}

/**
 * Plan a `diff` result: which files the summary lists, and which hunks the patch carries.
 *
 * `detail: 'full'` returns everything, uncut and uncapped — the escape hatch for a caller that
 * wants the complete patch and can take the size.
 */
export function planDiffPayload(
  patch: string,
  files: DiffFile[],
  opts: DiffPlanOptions = {},
): DiffPlan {
  const ref = opts.ref;
  if (opts.detail === 'full') {
    return {
      diff: patch,
      diffChars: patch.length,
      files,
      filesOmitted: 0,
      hunksOmitted: 0,
      patchFilesOmitted: 0,
      truncated: false,
      ...(ref ? { ref } : {}),
    };
  }
  const budget = opts.budget ?? DIFF_CONTENT_BUDGET;
  const maxFiles = opts.maxFiles ?? DIFF_MAX_FILES;

  const keptFiles = files.slice(0, maxFiles);
  const filesOmitted = files.length - keptFiles.length;

  const fixed =
    DIFF_STRUCTURED_SCAFFOLD_OVERHEAD +
    DIFF_JSON_QUOTES_OVERHEAD +
    2 * DIFF_TEXT_SEPARATOR_OVERHEAD +
    (ref ? ref.length : 0) +
    DIFF_NOTE_RESERVE +
    summaryCost(keptFiles, filesOmitted, ref);

  const sections = splitPatch(patch);
  // The aggregate note carries the route out of a cut, so the per-file markers stay terse.
  const plan = planPatch(sections, { budget: budget - fixed, maxFiles, hint: '' });

  const truncated =
    filesOmitted > 0 || plan.hunksOmitted > 0 || plan.sectionsOmitted > 0 || plan.starved;
  const result: DiffPlan = {
    diff: plan.patch,
    diffChars: patch.length,
    files: keptFiles,
    filesOmitted,
    hunksOmitted: plan.hunksOmitted,
    patchFilesOmitted: plan.sectionsOmitted,
    truncated,
    ...(ref ? { ref } : {}),
  };
  if (!truncated) return result;
  result.note = describeDiffCuts(plan, { filesOmitted, total: files.length, budget, maxFiles });
  return result;
}

/**
 * The `note`, naming ONLY the bound that actually fired — reporting a cap that did not fire sends
 * the reader looking for a cause that is not there (`conflictBudget.ts`'s rule, and
 * `searchBudget.ts`'s after it).
 */
function describeDiffCuts(
  plan: PatchPlan,
  ctx: { filesOmitted: number; total: number; budget: number; maxFiles: number },
): string {
  const reasons: string[] = [];
  if (ctx.filesOmitted > 0) {
    reasons.push(
      `only the first ${ctx.maxFiles} of ${ctx.total} changed files are listed in files[]`,
    );
  }
  if (plan.sectionsOmitted > 0) {
    reasons.push(`${plan.sectionsOmitted} file(s) got no section in the patch at all`);
  }
  if (plan.hunksOmitted > 0) {
    reasons.push(
      `${plan.hunksOmitted} hunk(s) across ${plan.filesWithCutHunks} file(s) were cut from the ` +
        'patch (whole hunks only — a part-hunk is not a diff)',
    );
  }
  if (plan.starved) {
    reasons.push('the per-file summary and headers alone consumed the budget, so no hunk fits');
  }
  return (
    `${reasons.join('; ')}. The ${ctx.budget}-char budget is charged across both channels ` +
    '(the patch is returned as text AND as structuredContent.diff). Re-run diff with a narrower ' +
    '`path`, read a whole file with read_file (with `ref` for a committed side), or pass ' +
    'detail: "full" for the complete patch.'
  );
}

/** What {@link planChangeDiff} hands a write tool. */
export interface ChangeDiffPlan {
  /** The confirmation patch, cut at hunk boundaries. `''` means there is no diff at all (a local
   * project, or nothing changed) — never "it was cut", which always leaves the file headers. */
  diff: string;
  /** True iff the patch was cut. Declared in each write tool's outputSchema as `diffTruncated`. */
  truncated: boolean;
}

/**
 * Plan a write/edit confirmation diff against {@link CHANGE_DIFF_BUDGET}.
 *
 * No summary and no aggregate note: the tool's own headline already says what was written, and the
 * whole budget here is small on purpose, so a 500-character note would be a quarter of it. The
 * route out therefore rides on the per-file markers instead.
 */
export function planChangeDiff(patch: string, budget = CHANGE_DIFF_BUDGET): ChangeDiffPlan {
  if (patch === '') return { diff: '', truncated: false };
  const plan = planPatch(splitPatch(patch), {
    budget,
    maxFiles: DIFF_MAX_FILES,
    hint: 'call diff for the full patch',
  });
  return {
    diff: plan.patch,
    truncated: plan.hunksOmitted > 0 || plan.sectionsOmitted > 0,
  };
}

// ---------------------------------------------------------------------------
// `push`, branch mode: the review diff (issue #160)
// ---------------------------------------------------------------------------

/**
 * The JSON punctuation and key names `push`'s awaiting-approval `structuredContent` wraps around
 * the review payload — `status`, `pushed`, `remote`, `branch`, `base`, `committedSha`, the
 * `diff`/`diffFiles` keys themselves and the counters' digits — everything except the two payload
 * bodies and `summary`, which are charged exactly. Larger than
 * {@link DIFF_STRUCTURED_SCAFFOLD_OVERHEAD} because this result carries more small fields than a
 * `diff` result does. It covers the fixed key names, the counters' digits and the redacted
 * `remote` URL; `branch` and `base` are caller-supplied and unbounded, so they are charged
 * EXACTLY instead (as `planDiffPayload` charges `ref`) rather than swallowed by a constant a long
 * enough branch name would break. A test that stringifies a real result pins that this still
 * accounts for the rest, from both sides — the same technique `conflictBudget.ts` uses for the
 * templates it cannot call.
 */
export const PUSH_REVIEW_SCAFFOLD_OVERHEAD = 400;

/** What {@link planPushReviewDiff} hands `src/tools/push.ts` for an `awaiting-approval` result. */
export interface PushReviewDiffPlan {
  /** The patch as it will be sent, cut at hunk boundaries with a marker where anything went. */
  diff: string;
  /** Characters in the FULL patch, before any cut — so the real size is always known. */
  diffChars: number;
  /** Per-file added/removed counts, capped at {@link DIFF_MAX_FILES}. */
  diffFiles: DiffFile[];
  /** Entries cut from {@link PushReviewDiffPlan.diffFiles} by that cap. */
  diffFilesOmitted: number;
  /** Hunks cut from a file the patch still details. */
  diffHunksOmitted: number;
  /** Files the patch drops entirely — no header, no hunks. Independent of `diffFilesOmitted`:
   * that one is the summary list's cap, this one the patch's, and either can fire alone. */
  diffPatchFilesOmitted: number;
  /** True iff anything at all was cut. Never inferred from an empty `diff`: an empty patch means
   * the branch commit changed nothing, and the two must never be confusable. */
  diffTruncated: boolean;
  /** What was cut and how to get it — present only when something actually was. */
  diffNote?: string;
}

export interface PushReviewDiffOptions {
  /** `prepareBranch`'s one-line summary. Charged exactly: it ships in BOTH channels. */
  summary: string;
  /** The base branch, for the `diff` call the note routes a caller to. */
  base: string;
  /** The review branch, likewise. */
  branch: string;
  budget?: number;
  maxFiles?: number;
}

/** The JSON cost of the `diffFiles` array. It ships only in `structuredContent` — `push`'s text
 * channel has no per-file summary, unlike `diff`'s — so there is no text term here. */
function filesJsonCost(files: DiffFile[]): number {
  return (
    FILES_ARRAY_JSON_OVERHEAD +
    files.reduce((n, f) => n + JSON.stringify(f).length + FILES_ELEMENT_SEPARATOR_OVERHEAD, 0)
  );
}

/**
 * Plan the review payload of a branch-mode `push` (`status: "awaiting-approval"`).
 *
 * Two decisions carry this, and the issue (#160) left both open on purpose.
 *
 *  1. **The share is the full house figure, {@link DIFF_CONTENT_BUDGET}, reused rather than
 *     restated.** #153 gave `diff` that figure because the caller asked for the patch, and
 *     `changeDiff` the 2000-character diagnostic share because nobody did. Branch mode is squarely
 *     the first case: its whole purpose is to commit somewhere safe so the patch can be reviewed
 *     before it lands, and `prepareBranch`'s own summary says "Review the diff vs <base>, then
 *     approve to land it." A caller who is told to review and then handed a silently gutted patch
 *     has been given the worst of both. The rest of an awaiting-approval result is small and
 *     fixed-shape (`status`/`pushed`/`remote`/`branch`/`base`/`committedSha`/`summary`), and is
 *     charged exactly below rather than paid for out of the patch's share — so "it ships alongside
 *     other fields" is answered by charging them, not by shrinking the budget. Note that
 *     `rebasedOver` is NOT one of those fields: it exists only on `safePushToolResult`'s branches,
 *     which this planner never touches.
 *  2. **Charged ONCE, with {@link structuredOnlyCost}.** `push`'s awaiting-approval result puts
 *     only `prep.summary` in the text channel; the patch travels in `structuredContent.diff`
 *     alone. So the same 20000 bounds the same thing it bounds for `diff` — the total size of the
 *     result a client receives — while the charge matches how many times the patch is actually
 *     rendered. Charging it twice here would halve what a reviewer gets for no reason a reader
 *     could find in the code. **If anyone later renders the patch into the text channel too** (a
 *     defensible change — the conflict branch above deliberately does exactly that, so an MCP-only
 *     client that drops `structuredContent` can still act), this must become
 *     {@link renderCost} in the same commit, or the result overruns by 2x. That is the whole
 *     reason the charge is a named parameter and not a default.
 *
 * The `note` IS rendered into both channels (it is small, bounded by {@link DIFF_NOTE_RESERVE},
 * and a cut nobody is told about is the one thing worse than a cut), so the reserve pays for two
 * copies of it — pinned by a test.
 */
export function planPushReviewDiff(
  patch: string,
  files: DiffFile[],
  opts: PushReviewDiffOptions,
): PushReviewDiffPlan {
  const budget = opts.budget ?? DIFF_CONTENT_BUDGET;
  const maxFiles = opts.maxFiles ?? DIFF_MAX_FILES;

  const keptFiles = files.slice(0, maxFiles);
  const diffFilesOmitted = files.length - keptFiles.length;

  const fixed =
    PUSH_REVIEW_SCAFFOLD_OVERHEAD +
    DIFF_JSON_QUOTES_OVERHEAD +
    renderCost(opts.summary) +
    opts.base.length +
    opts.branch.length +
    DIFF_TEXT_SEPARATOR_OVERHEAD +
    DIFF_NOTE_RESERVE +
    filesJsonCost(keptFiles);

  // The aggregate note carries the route out, so the per-file markers stay terse — as in
  // `planDiffPayload`, and unlike `planChangeDiff`, whose budget is too small to afford a note.
  const plan = planPatch(splitPatch(patch), {
    budget: budget - fixed,
    maxFiles,
    hint: '',
    cost: structuredOnlyCost,
  });

  const diffTruncated =
    diffFilesOmitted > 0 || plan.hunksOmitted > 0 || plan.sectionsOmitted > 0 || plan.starved;
  const result: PushReviewDiffPlan = {
    diff: plan.patch,
    diffChars: patch.length,
    diffFiles: keptFiles,
    diffFilesOmitted,
    diffHunksOmitted: plan.hunksOmitted,
    diffPatchFilesOmitted: plan.sectionsOmitted,
    diffTruncated,
  };
  if (!diffTruncated) return result;
  result.diffNote = describePushReviewCuts(plan, {
    diffFilesOmitted,
    total: files.length,
    budget,
    maxFiles,
    base: opts.base,
    branch: opts.branch,
  });
  return result;
}

/**
 * The `note`, naming ONLY the bound that actually fired — `conflictBudget.ts`'s rule, and
 * `describeDiffCuts`'s after it. The route out is `diff` with the branch's own three-dot range
 * (`resolveDiffRef` accepts one), which already has `detail: "full"` for a caller that wants
 * every line; that is why `push` grows no escape-hatch argument of its own here.
 */
function describePushReviewCuts(
  plan: PatchPlan,
  ctx: {
    diffFilesOmitted: number;
    total: number;
    budget: number;
    maxFiles: number;
    base: string;
    branch: string;
  },
): string {
  const reasons: string[] = [];
  if (ctx.diffFilesOmitted > 0) {
    reasons.push(
      `only the first ${ctx.maxFiles} of ${ctx.total} changed files are listed in diffFiles[]`,
    );
  }
  if (plan.sectionsOmitted > 0) {
    reasons.push(`${plan.sectionsOmitted} file(s) got no section in the patch at all`);
  }
  if (plan.hunksOmitted > 0) {
    reasons.push(
      `${plan.hunksOmitted} hunk(s) across ${plan.filesWithCutHunks} file(s) were cut from the ` +
        'patch (whole hunks only — a part-hunk is not a diff)',
    );
  }
  if (plan.starved) {
    reasons.push('the per-file headers alone consumed the budget, so no hunk fits');
  }
  return (
    `${reasons.join('; ')}. The review patch is budgeted to ${ctx.budget} characters. The branch ` +
    `is committed and nothing was lost: read the whole change with diff, ref: ` +
    `"${ctx.base}...${ctx.branch}" (add detail: "full" for every line), or read a file with ` +
    'read_file. Approve only once you have reviewed it.'
  );
}

/**
 * `push`'s awaiting-approval text channel, built from the already-cut plan and nothing else.
 *
 * The patch is deliberately NOT rendered here — see {@link planPushReviewDiff}, decision 2. Only
 * the note joins the summary, so a client that drops `structuredContent` is still told that the
 * patch it cannot see was cut, and how to fetch it.
 */
export function renderPushReviewText(summary: string, plan: PushReviewDiffPlan): string {
  return plan.diffNote ? `${summary}\n\n${plan.diffNote}` : summary;
}
