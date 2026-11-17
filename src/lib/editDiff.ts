import {
  CHANGE_DIFF_BUDGET,
  CHANGE_DIFF_HINT,
  DIFF_CONTENT_BUDGET,
  planChangeDiff,
  renderCost,
  renderFileOmissionMarker,
  renderHunkOmissionMarker,
  splitPatch,
} from './diffBudget.js';
import type { ChangeDiffPlan } from './diffBudget.js';

/**
 * The confirmation diff `edit_file` shows: what THIS call changed, not the file against HEAD.
 *
 * Diffing against HEAD (as `write_file` still does, through `changeDiff`) re-reported every earlier
 * uncommitted edit to the same file, and LaTeX written a paragraph per source line made a single
 * hunk longer than the whole {@link CHANGE_DIFF_BUDGET} — so a one-word edit came back as
 * "1 of 1 hunk(s) omitted" every time, and the caller needed a separate `diff` or `read_file` just
 * to see what it wrote. `applyEdits` already holds both sides, so this costs no git call either,
 * and it works for a local project, which has no HEAD of ours to diff against.
 *
 * Two things keep it small:
 * - **Line hunks** come from an LCS over the lines between the common prefix and suffix, with
 *   {@link CONTEXT_LINES} of context; past {@link MAX_LCS_CELLS} the middle is one replace block.
 * - **Long lines are condensed** around what changed ({@link condenseLongLines}): a `-`/`+` pair
 *   longer than {@link LONG_LINE_CHARS} keeps only the span that differs plus
 *   {@link INTRALINE_CONTEXT} characters either side, with `…[N chars]…` standing for the rest; an
 *   unpaired long line (context, or an added/removed one) keeps its head. The result is a
 *   confirmation, not a patch to apply — the `diff` tool gives the exact one — and `condensed` says
 *   when this happened.
 *
 * The output keeps the `diff --git`/`@@` shape so `planChangeDiff` budgets it exactly like the HEAD
 * diff it replaces (whole hunks, an omission marker, `truncated`).
 */
export const CONTEXT_LINES = 2;
export const LONG_LINE_CHARS = 240;
export const INTRALINE_CONTEXT = 60;
const MAX_LCS_CELLS = 4_000_000;

export interface EditDiffPlan extends ChangeDiffPlan {
  /** True when a long line was cut around its change (the text is then not an applicable patch). */
  condensed: boolean;
}

type Op = { kind: ' ' | '-' | '+'; text: string; a: number; b: number };

/** Split keeping each line's terminator, so a terminator-only change is still a change. */
function splitLines(s: string): string[] {
  if (s === '') return [];
  return s.split(/(?<=\r\n|\n|\r(?!\n))/);
}

/** Line-level edit script between `a` and `b` (prefix/suffix trimmed, LCS in the middle). */
function lineOps(a: string[], b: string[]): Op[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  ) {
    suf++;
  }
  const ops: Op[] = [];
  for (let i = 0; i < pre; i++) ops.push({ kind: ' ', text: a[i] ?? '', a: i, b: i });
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  if (am.length * bm.length > MAX_LCS_CELLS) {
    am.forEach((t, i) => ops.push({ kind: '-', text: t, a: pre + i, b: pre }));
    bm.forEach((t, j) => ops.push({ kind: '+', text: t, a: pre + am.length, b: pre + j }));
  } else {
    // dp[i][j] = LCS length of am[i..] and bm[j..], flattened.
    const w = bm.length + 1;
    const dp = new Uint32Array((am.length + 1) * w);
    for (let i = am.length - 1; i >= 0; i--) {
      for (let j = bm.length - 1; j >= 0; j--) {
        dp[i * w + j] =
          am[i] === bm[j]
            ? (dp[(i + 1) * w + j + 1] ?? 0) + 1
            : Math.max(dp[(i + 1) * w + j] ?? 0, dp[i * w + j + 1] ?? 0);
      }
    }
    let i = 0;
    let j = 0;
    while (i < am.length || j < bm.length) {
      if (i < am.length && j < bm.length && am[i] === bm[j]) {
        ops.push({ kind: ' ', text: am[i] ?? '', a: pre + i, b: pre + j });
        i++;
        j++;
      } else if (
        i < am.length &&
        (j >= bm.length || (dp[(i + 1) * w + j] ?? 0) >= (dp[i * w + j + 1] ?? 0))
      ) {
        // Removals before additions on a tie, as `git diff` prints a replaced block.
        ops.push({ kind: '-', text: am[i] ?? '', a: pre + i, b: pre + j });
        i++;
      } else {
        ops.push({ kind: '+', text: bm[j] ?? '', a: pre + i, b: pre + j });
        j++;
      }
    }
  }
  for (let k = 0; k < suf; k++) {
    const ai = a.length - suf + k;
    const bi = b.length - suf + k;
    ops.push({ kind: ' ', text: a[ai] ?? '', a: ai, b: bi });
  }
  return ops;
}

/** Shown for a line; a missing final terminator gets git's marker. */
function render(kind: string, text: string): string {
  const body = text.replace(/\r?\n$|\r$/, '');
  const ended = body.length !== text.length;
  return `${kind}${body}\n${ended ? '' : '\\ No newline at end of file\n'}`;
}

function elide(n: number): string {
  return `…[${n} chars]…`;
}

/** Keep the changed span of `x` (relative to its partner) plus context; elide the rest. */
function condensePair(x: string, y: string): [string, string] {
  let p = 0;
  while (p < x.length && p < y.length && x[p] === y[p]) p++;
  let s = 0;
  while (s < x.length - p && s < y.length - p && x[x.length - 1 - s] === y[y.length - 1 - s]) s++;
  const cut = (t: string): string => {
    const from = Math.max(0, p - INTRALINE_CONTEXT);
    const to = Math.min(t.length, t.length - s + INTRALINE_CONTEXT);
    return (
      (from > 0 ? elide(from) : '') +
      t.slice(from, to) +
      (to < t.length ? elide(t.length - to) : '')
    );
  };
  return [cut(x), cut(y)];
}

function condenseHead(t: string): string {
  return t.length > LONG_LINE_CHARS
    ? t.slice(0, LONG_LINE_CHARS) + elide(t.length - LONG_LINE_CHARS)
    : t;
}

/**
 * Condense the long lines of one hunk's body ops. A run of `-` lines followed by a run of `+`
 * lines is paired index by index; each long member of a pair is cut around the change.
 */
function condenseLongLines(ops: Op[]): { ops: Op[]; condensed: boolean } {
  const out = ops.map((o) => ({ ...o }));
  let condensed = false;
  const paired = new Set<number>();
  const term = (t: string): [string, string] => {
    const m = /(\r\n|\n|\r)$/.exec(t);
    return m ? [t.slice(0, -m[0].length), m[0]] : [t, ''];
  };
  let k = 0;
  while (k < out.length) {
    if (out[k]?.kind !== '-') {
      k++;
      continue;
    }
    let r = k;
    while (out[r]?.kind === '-') r++;
    let e = r;
    while (out[e]?.kind === '+') e++;
    const pairs = Math.min(r - k, e - r);
    for (let q = 0; q < pairs; q++) {
      const del = out[k + q];
      const add = out[r + q];
      if (!del || !add) continue;
      const [dt, dn] = term(del.text);
      const [at, an] = term(add.text);
      if (dt.length > LONG_LINE_CHARS || at.length > LONG_LINE_CHARS) {
        const [cd, ca] = condensePair(dt, at);
        if (cd !== dt || ca !== at) condensed = true;
        paired.add(k + q);
        paired.add(r + q);
        del.text = cd + dn;
        add.text = ca + an;
      }
    }
    k = e;
  }
  for (const [idx, o] of out.entries()) {
    if (paired.has(idx)) continue;
    const [t, n] = term(o.text);
    if (t.length > LONG_LINE_CHARS) {
      o.text = condenseHead(t) + n;
      condensed = true;
    }
  }
  return { ops: out, condensed };
}

/**
 * Plan `edit_file`'s confirmation diff of `before` → `after` for `relPath` (POSIX, project-relative),
 * budgeted like every confirmation diff.
 */
export function planEditDiff(before: string, after: string, relPath: string): EditDiffPlan {
  const { patch, condensed } = buildEditPatch(before, after, relPath);
  if (patch === '') return { diff: '', truncated: false, condensed: false };
  return { ...planChangeDiff(patch), condensed };
}

/** The unbudgeted confirmation patch of `before` → `after`, and whether a long line was cut. */
function buildEditPatch(
  before: string,
  after: string,
  relPath: string,
): { patch: string; condensed: boolean } {
  if (before === after) return { patch: '', condensed: false };
  const a = splitLines(before);
  const b = splitLines(after);
  const ops = lineOps(a, b);

  // Group changed ops into hunks with CONTEXT_LINES of context, merging hunks that touch.
  const changed = ops.map((o, i) => (o.kind === ' ' ? -1 : i)).filter((i) => i >= 0);
  const ranges: Array<[number, number]> = [];
  for (const i of changed) {
    const lo = Math.max(0, i - CONTEXT_LINES);
    const hi = Math.min(ops.length - 1, i + CONTEXT_LINES);
    const last = ranges[ranges.length - 1];
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else ranges.push([lo, hi]);
  }

  let condensed = false;
  let patch = `diff --git a/${relPath} b/${relPath}\n--- a/${relPath}\n+++ b/${relPath}\n`;
  for (const [lo, hi] of ranges) {
    const slice = ops.slice(lo, hi + 1);
    const first = slice[0];
    if (!first) continue;
    const aCount = slice.filter((o) => o.kind !== '+').length;
    const bCount = slice.filter((o) => o.kind !== '-').length;
    const aStart = aCount === 0 ? first.a : first.a + 1;
    const bStart = bCount === 0 ? first.b : first.b + 1;
    const c = condenseLongLines(slice);
    condensed ||= c.condensed;
    patch += `@@ -${aStart},${aCount} +${bStart},${bCount} @@\n`;
    for (const o of c.ops) patch += render(o.kind, o.text);
  }
  return { patch, condensed };
}

/** One file of a multi-file `edit_file` call, as {@link planEditDiffs} takes it. */
export interface EditDiffInput {
  before: string;
  after: string;
  relPath: string;
}

/**
 * The confirmation diffs of a multi-file `edit_file` call, from ONE pool: `files` exists so a
 * caller can batch many small edits, and N per-file budgets would grow the echo with N while a
 * pool keeps it bounded. The pool is {@link CHANGE_DIFF_BUDGET} per file — what N single-file
 * calls would each have had — capped at the house content budget {@link DIFF_CONTENT_BUDGET},
 * so 20 files can no more return 40000 characters than one `diff` call can.
 *
 * Every file first gets its mandatory charge — what `planChangeDiff` would itself reserve for it:
 * its header, the marker for losing every hunk, and the file-omission marker — so a later file is
 * never starved to an empty diff by an earlier big one (an empty `diff` must keep meaning "nothing
 * changed"). The rest of the pool is then spent in file order, each file getting its mandatory
 * charge plus whatever is left, and returning what it did not use. Charges are `renderCost`, both
 * channels, as for every confirmation diff. Only when the mandatory charges alone exceed the pool
 * (twenty very long paths) does the total pass it — by headers, never by content.
 */
export function planEditDiffs(inputs: EditDiffInput[]): EditDiffPlan[] {
  const built = inputs.map((i) => buildEditPatch(i.before, i.after, i.relPath));
  const hint = CHANGE_DIFF_HINT;
  const mandatory = built.map(({ patch }) => {
    if (patch === '') return 0;
    const [section] = splitPatch(patch);
    if (!section) return 0;
    return (
      renderCost(renderFileOmissionMarker(1, hint)) +
      renderCost(section.header) +
      (section.hunks.length > 0
        ? renderCost(
            renderHunkOmissionMarker(
              section,
              section.hunks.length,
              section.hunks.length,
              section.hunks.reduce((n, h) => n + h.length, 0),
              hint,
            ),
          )
        : 0)
    );
  });
  const pool = Math.min(inputs.length * CHANGE_DIFF_BUDGET, DIFF_CONTENT_BUDGET);
  let spare = Math.max(0, pool - mandatory.reduce((a, b) => a + b, 0));
  return built.map(({ patch, condensed }, i) => {
    if (patch === '') return { diff: '', truncated: false, condensed: false };
    const budget = (mandatory[i] ?? 0) + spare;
    const plan = planChangeDiff(patch, budget);
    spare = Math.max(0, budget - renderCost(plan.diff));
    return { ...plan, condensed };
  });
}
