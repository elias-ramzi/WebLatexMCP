/**
 * Deciding how much of a `commit` result's two working-tree path lists may be returned, against a
 * character budget charged on the RENDERED payload in BOTH channels. A pure planner over plain
 * data, the same family as `statusBudget.ts`, `fileListBudget.ts` and `diffBudget.ts`: a budget, a
 * plan, and a tool layer that only maps the plan onto response shapes. It imports nothing from the
 * tool layer and touches no fs/process/clock.
 *
 * Why it exists. `commit` returns `files` (what the commit took, with line counts) and
 * `leftUncommitted` (what is still dirty and deliberately not taken), and both ship twice — as a
 * `structuredContent` array and again in the result text. Both are filled from the working tree,
 * which the server does not control: a scope "all" commit of a regenerated `figures/` tree, or a
 * session commit beside a few thousand untracked build products, reaches thousands of paths — the
 * #68 shape, a result the client rejects **undelivered**. Here that is worse than anywhere else,
 * because the commit has already landed: the caller loses the sha, the counts and the fact that
 * anything happened at all.
 *
 * The three decisions:
 *
 *  1. **A character budget, not `capList`'s 20.** A count cap would cut an ordinary 30-file scope
 *     "all" commit that has always been reported whole, and it bounds nothing about size (a path's
 *     length is the document's choice). {@link COMMIT_CONTENT_BUDGET} is the house 20000, charged
 *     across both channels ({@link committedFileCost}, {@link leftUncommittedCost} call the render
 *     templates, so the charge and the text cannot drift apart). It buys a few hundred paths at
 *     ordinary lengths.
 *  2. **Strict priority, `files` then `leftUncommitted`** — not `statusBudget.ts`'s guaranteed
 *     shares, because the two lanes are disjoint by cause: one is what this commit took, the other
 *     what it left, and no single cause fills both (the one overlap, a file a session commit took
 *     part of, is one path in each, not a tree). They also never compete where it matters: scope
 *     "all" always leaves `leftUncommitted` empty, and under "session"/"paths" `files` is bounded by
 *     what this session wrote or the caller named. `files` ranks first because it is the record of
 *     what this mutating call just did; `leftUncommitted` is exactly what `status` reports as
 *     unstaged/untracked, one call away.
 *  3. **A cut stays distinguishable from "nothing".** `leftUncommitted: []` means the tree is clean
 *     apart from what was taken, so a non-empty lane always keeps its first path (the running total
 *     absorbs its cost), and every cut is counted in `filesOmitted`/`leftUncommittedOmitted`, which
 *     the tool declares in its `outputSchema`. `filesChanged` is never touched — it stays git's
 *     true count.
 *
 * What is NOT budgeted here, and why: `ignored`, `settled`, `conflicted`, `unrecorded` are bounded
 * by what this session itself recorded or the caller named, not by the working tree.
 */

/**
 * Total character budget for `files` + `leftUncommitted` across BOTH channels combined — the house
 * figure for a rendered content budget (`STATUS_CONTENT_BUDGET`, `CONFLICT_CONTENT_BUDGET`, …),
 * sized so the worst case lands well under the ~67k a client actually rejected (#68).
 */
export const COMMIT_CONTENT_BUDGET = 20000;

/**
 * Withheld from the budget for the text-only "… N more" lines a cut adds (at most one per lane) and
 * the JSON scaffolding of the two arrays and their counters. Pinned by a unit test that renders the
 * longest pair of those lines — seven-digit counts, a 40-hex sha — and checks it still fits.
 */
export const COMMIT_BUDGET_RESERVE = 700;

/** The comma between two JSON array elements. */
const ELEMENT_SEPARATOR_OVERHEAD = 1;
/** The `\n` after a committed-file text line. */
const TEXT_LINE_SEPARATOR_OVERHEAD = 1;
/** The `, ` between two paths in the one `left uncommitted` text line. */
const TEXT_LIST_SEPARATOR_OVERHEAD = 2;

export interface CommittedFile {
  path: string;
  added: number;
  removed: number;
}

/** One committed file as the text channel renders it. */
export function renderCommittedFileLine(f: CommittedFile): string {
  return `  ${f.path} +${f.added} -${f.removed}`;
}

/** The one text line that lists what was left uncommitted, rendered from the ALREADY-CUT list. */
export function renderLeftUncommittedLine(paths: readonly string[]): string {
  return `left uncommitted (not this session's): ${paths.join(', ')}`;
}

/**
 * The trailing line when `files` was cut. `sha` is the commit just made (or the sentinel "unborn",
 * never reached with a non-empty `files`), so the remedy names a real range — except for a clone's
 * first commit, which has no parent: `<sha>~1` does not resolve there, and `diff`'s single-ref form
 * compares the WORKING TREE against a commit, so it cannot show a root commit's contents either.
 * The line says so conditionally rather than costing every commit a parent lookup. And `diff` is
 * budgeted itself, so the line points at it without promising it lists every file.
 */
export function renderFilesOmittedLine(omitted: number, sha: string): string {
  return (
    `  … ${omitted} more committed file(s) not listed (${COMMIT_CONTENT_BUDGET}-char payload ` +
    `budget); filesChanged is the full count. diff with ref "${sha}~1..${sha}" shows the ` +
    "commit's changes (itself budgeted) — unless this is the clone's first commit, which has no " +
    'parent: then every file tracked at that commit is one it took'
  );
}

/** The trailing line when `leftUncommitted` was cut. */
export function renderLeftUncommittedOmittedLine(omitted: number): string {
  return (
    `  … and ${omitted} more left uncommitted, not listed (${COMMIT_CONTENT_BUDGET}-char payload ` +
    'budget); status lists every change in the working tree'
  );
}

/** What one committed file costs: its JSON element in `structuredContent.files` plus its text line. */
export function committedFileCost(f: CommittedFile): number {
  return (
    JSON.stringify(f).length +
    ELEMENT_SEPARATOR_OVERHEAD +
    renderCommittedFileLine(f).length +
    TEXT_LINE_SEPARATOR_OVERHEAD
  );
}

/** What one left-uncommitted path costs: its JSON string element plus its share of the text line. */
export function leftUncommittedCost(p: string): number {
  return (
    JSON.stringify(p).length + ELEMENT_SEPARATOR_OVERHEAD + p.length + TEXT_LIST_SEPARATOR_OVERHEAD
  );
}

export interface CommitListsPlan {
  files: CommittedFile[];
  filesOmitted: number;
  leftUncommitted: string[];
  leftUncommittedOmitted: number;
}

/**
 * Keep a prefix of `files`, then a prefix of `leftUncommitted`, while the running total stays in
 * budget; everything after the first entry that does not fit in a lane is cut and counted (a cheap
 * later path never slips in behind a cut one, so the kept list is always a prefix). Keep-at-least-
 * one applies per non-empty lane, and its cost is absorbed, so it can never be used to forge an
 * empty list.
 */
export function planCommitLists(
  input: { files: readonly CommittedFile[]; leftUncommitted: readonly string[] },
  opts: { budget?: number } = {},
): CommitListsPlan {
  const budget = opts.budget ?? COMMIT_CONTENT_BUDGET;
  let remaining = Math.max(budget - COMMIT_BUDGET_RESERVE, 0);

  const take = <T>(items: readonly T[], cost: (item: T) => number): T[] => {
    const kept: T[] = [];
    for (const item of items) {
      const c = cost(item);
      if (c > remaining && kept.length > 0) break;
      // Keep-at-least-one: the first entry of a non-empty lane is kept even when it does not fit.
      remaining -= c;
      kept.push(item);
      if (remaining < 0) break;
    }
    return kept;
  };

  const files = take(input.files, committedFileCost);
  const leftUncommitted = take(input.leftUncommitted, leftUncommittedCost);
  return {
    files,
    filesOmitted: input.files.length - files.length,
    leftUncommitted,
    leftUncommittedOmitted: input.leftUncommitted.length - leftUncommitted.length,
  };
}
