import { z } from 'zod';
import type { EditOp } from '../services/fileService.js';

/**
 * Rewrite preservation mode: when the model replaces text in a `.tex`-like file, should the
 * original be kept, commented out above the replacement — the habit Overleaf users already have
 * by hand — instead of silently vanishing from the diff?
 *
 * This is deliberately server-side rather than a prompt instruction telling the model to type
 * `% ...` lines itself: a hand-typed comment is not provably the original text (the model can
 * paraphrase while "preserving"), and it burns the model's attention on formatting instead of
 * content. Deriving the preserved block from the caller's own `oldString` makes it byte-exact by
 * construction.
 */
export type RewriteMode = 'off' | 'prose' | 'always';

/** The complete mode vocabulary, in one place — `src/config.ts` and the tools import this rather
 * than keeping private copies (the same reason `COMPILER_KINDS` is shared with the resolver). */
export const REWRITE_MODES: readonly RewriteMode[] = ['off', 'prose', 'always'];

/**
 * The mode when nothing else says otherwise: `'off'`. Preservation changes the bytes of the
 * user's document beyond what they asked for, so it is opt-in, not a silent default — a user who
 * wants the Overleaf habit of commenting the original above a rewrite turns it on per project with
 * `set_rewrite_mode`, or server-wide with `WEB_LATEX_MCP_REWRITE_MODE`.
 */
export const DEFAULT_REWRITE_MODE: RewriteMode = 'off';

/** Where a resolved mode came from, so it is never a hidden setting. */
export type RewriteModeSource = 'call' | 'project' | 'default';

/**
 * `RewriteModeSource` as a zod enum, shared by `set_rewrite_mode` and `list_projects` rather than
 * each tool keeping a private copy (the same reason `REWRITE_MODES` itself is shared). `'call'` is
 * unreachable from either tool's own source enum: neither takes a per-call
 * `preserveOriginal`-equivalent, so a mode reported by these two tools can only be `'project'` or
 * `'default'`. It stays in the vocabulary because it names a real value `resolveRewriteMode` can
 * return (and `edit_file` does report it) — narrowing it away here would make this a different
 * type from the one `resolveRewriteMode` actually produces.
 */
export const rewriteModeSourceEnum = z.enum([
  'call',
  'project',
  'default',
] as const satisfies readonly RewriteModeSource[]);

/**
 * Fail the build if `RewriteModeSource` ever gains a member this enum does not list. `satisfies`
 * above catches a value that stops being a source; this catches a source that stops being a
 * value. Without both directions the schema drifts silently from the type it claims to mirror,
 * and a tool would report a source no client's schema admits.
 */
type UnlistedSource = Exclude<RewriteModeSource, (typeof rewriteModeSourceEnum.options)[number]>;
const _sourcesAreExhaustive: UnlistedSource extends never ? true : never = true;
void _sourcesAreExhaustive;

export interface ResolveRewriteModeInput {
  /**
   * Per-call assertion (`edit_file`'s `preserveOriginal`). `true` behaves as `'always'`, `false`
   * as `'off'`. Always wins over the stored/default mode when present.
   */
  perCall?: boolean;
  /** The project's sticky stored mode, or `null` when nothing is stored. */
  stored: RewriteMode | null;
  /** The env-configured default (`ServerConfig.rewriteMode`). */
  envDefault: RewriteMode;
}

export interface ResolvedRewriteMode {
  mode: RewriteMode;
  source: RewriteModeSource;
}

/**
 * Resolve the effective rewrite mode from exactly one place, so no two call sites can derive a
 * disagreeing answer (the `parseCompilerChoice` lesson). Precedence, highest first:
 * per-call `preserveOriginal` > stored per-project mode > env default.
 */
export function resolveRewriteMode(input: ResolveRewriteModeInput): ResolvedRewriteMode {
  if (input.perCall !== undefined) {
    return { mode: input.perCall ? 'always' : 'off', source: 'call' };
  }
  if (input.stored !== null) {
    return { mode: input.stored, source: 'project' };
  }
  return { mode: input.envDefault, source: 'default' };
}

/**
 * Prefix every line of `text` with `% `.
 *
 * A line that already starts with `%` is prefixed anyway, producing `%% ...`. This is
 * intentional, not an oversight: the preserved block must be a faithful copy of the bytes that
 * were there, not a "smart" re-comment. A `text` that starts with `%` is exactly the kind of
 * content that must survive round-trip unaltered, and a special case for it would make the
 * preserved text diverge from the original whenever it fires.
 *
 * An empty line becomes a bare `%` (no trailing space) — trailing whitespace is noise in a diff
 * and some linters/editors strip it on save, which would otherwise make a byte-for-byte preserved
 * block drift the moment someone saves the file. This holds for an empty CRLF line too: splitting
 * on bare `\n` leaves a segment that is just `"\r"` (see below), and that becomes a bare `"%\r"`,
 * not `"% \r"` — the `\r` is part of the line ending, not content, so it earns no space before it
 * either.
 *
 * The trailing-newline shape of `text` is preserved. Splitting `"a\nb\n"` on `\n` yields
 * `["a", "b", ""]` — the final empty string is an artifact of the trailing newline, not a real
 * line, so it must NOT be turned into a stray `%` line; it is instead re-emitted as the trailing
 * newline on the joined result. `text` with no trailing newline gets none back either.
 *
 * `\r\n` line endings are handled by splitting on bare `\n` and treating the segment as ending in
 * `\r`: the `\r` stays inside the segment content, appearing before the `\n` join, not before the
 * `% ` prefix. That way `"a\r\nb"` becomes `"% a\r\n% b"` — CRLF survives round-trip, which
 * matters since the repo forces `core.autocrlf=false` so CRLF bytes can genuinely be on disk.
 */
export function commentOut(text: string): string {
  const hadTrailingNewline = text.endsWith('\n');
  const body = hadTrailingNewline ? text.slice(0, -1) : text;
  const lines = body.split('\n');
  // A segment that is empty, or is just the "\r" half of a CRLF empty line, becomes a bare "%"
  // (or "%\r") — no trailing space. Without the "\r" case, an empty CRLF line ("\r\n" splits on
  // "\n" to a "\r" segment) got "% \r" instead, leaving a trailing space the docstring promises
  // never to leave.
  const commented = lines.map((line) => (line === '' || line === '\r' ? `%${line}` : `% ${line}`));
  return commented.join('\n') + (hadTrailingNewline ? '\n' : '');
}

/**
 * Overlap threshold for "near-identical" in `classifyEdit`, below the docstring there.
 *
 * Measured as the fraction of `oldString`'s **adjacent-token bigrams** (by exact string match,
 * counting duplicates) that also appear in `newString`'s bigram multiset — see
 * `nearIdenticalOverlap`. Unlike a bag-of-tokens (unigram) measure, this is order-sensitive: a
 * one-token typo fix, a changed number, a swapped `\cite{...}` key, or a renamed `\label{...}`
 * still shares nearly every adjacent pair with the original (only the two bigrams touching the
 * changed token are lost), so the surviving fraction stays high (0.77-0.86 for the one-token
 * changes this heuristic exists to catch — a typo fix, a changed number, a swapped `\cite` key, a
 * renamed `\label`, a one-word swap). A genuine rewrite drops it well below that: a full paragraph
 * rewrite scores near 0, and even a **pure reordering that keeps whole clauses intact** — which a
 * unigram (bag-of-tokens) count cannot distinguish from a typo fix at all, since nothing is added
 * or removed — only breaks the bigrams at the seam(s) where a clause boundary moved, landing
 * around 0.53-0.67 for the reordering/passive-voice/clause-swap cases this heuristic must call
 * `prose`. 0.7 sits in the gap between those two regimes, and the two ends of that gap are worth
 * stating exactly, because the margin is thin. A single interior token change in an `n`-token
 * string loses exactly 2 of its `n - 1` bigrams, so its overlap is `(n - 3) / (n - 1)`: the floor
 * is not the 0.77 the observed samples suggest but **5/7 ≈ 0.714 at the 8-token gate**, clearing
 * 0.7 by 0.014. A clause reorder's measured ceiling is around 0.667. Anything that narrows that
 * gap — a lower token gate, a different measure — has to revisit this number rather than assume
 * it still separates the regimes.
 *
 * The known cost of 0.7 over the 0.6 it replaced: **two** small changes in a short string (two
 * typos in one 10-token sentence, say) score around 0.667 and now come out `prose`, so the
 * original is preserved where it arguably need not be. That is the acceptable direction — a stray
 * commented line the author deletes, rather than a rewrite silently lost — and a proofreading
 * pass issues one edit per typo anyway. It is a judgment call, not a derived constant, and is
 * named here so it can be tuned in one place if a real edit ever falls on the wrong side of it.
 *
 * A second, worse-in-the-safe-direction cost worth naming explicitly rather than leaving implicit:
 * a single conceptual fix that changes token *count* — de/hyphenating a compound
 * ("state of the art" -> "state-of-the-art"), or splitting/joining one — breaks every bigram at
 * the seam on both sides, not just the two the threshold's arithmetic above assumes for a
 * single-token change. `"The state of the art detector reaches ninety percent accuracy on this
 * benchmark."` -> `"The state-of-the-art detector reaches ninety percent accuracy on this
 * benchmark."` scores 0.583 — well below 0.7 — and comes out `prose`, preserving the original
 * above a one-word hyphenation fix. `proofread-document` lists hyphenation consistency as one of
 * its own checks, so this is not a hypothetical: the server sees exactly this edit shape. It is
 * wrong in the same safe direction as the two-typo cost above (an extra stray comment, never a
 * lost rewrite) so it is not a reason to change this threshold or `classifyEdit`'s absolute-loss
 * floor (`MIN_UNMATCHED_BIGRAMS_FOR_PROSE`, below) — it is recorded here so the next person tuning
 * either number has the actual worst case in front of them instead of rediscovering it.
 */
export const NEAR_IDENTICAL_OVERLAP_THRESHOLD = 0.7;

/**
 * Absolute floor, in *unmatched* bigrams (not a fraction), below which `classifyEdit` calls an
 * edit `'prose'` regardless of how high `nearIdenticalOverlap`'s fraction comes out — see
 * `classifyEdit` for how this combines with `NEAR_IDENTICAL_OVERLAP_THRESHOLD`.
 *
 * The fraction test alone is one-sided: it is the share of `oldString`'s bigrams that survive,
 * with no penalty for *where* the loss falls. Deleting a contiguous run of `k` tokens from the
 * **end** (or start) of an `n`-token paragraph creates exactly one rejoin seam and loses only `k`
 * of the paragraph's `n - 1` bigrams — no seam in the middle costs more. A 10-token trailing
 * sentence cut from a 100-token paragraph scores 89/99 ≈ 0.899, clearing 0.7 by a wide margin and
 * landing `'minor'` — silently not preserved — while the identical 10-token deletion from the
 * *middle* of the same paragraph breaks two seams and scores ≈0.64, landing `'prose'`. The
 * fraction test is therefore least reliable exactly where paragraphs are longest, and gives an
 * inconsistent answer for the same deletion depending only on where in the paragraph it happens
 * to sit. An absolute floor on the unmatched count catches the case the fraction dilutes away in a
 * long paragraph, without touching the fraction test's behaviour on short-to-medium strings where
 * the two floors below already draw the line correctly.
 *
 * 6 is chosen from the same per-edit arithmetic the threshold's own docstring uses — a single
 * interior token change in an `n`-token string loses exactly 2 of its `n - 1` bigrams (the one
 * ending at the changed token and the one starting there):
 *
 *  - **One** interior change loses 2 bigrams; **two** scattered interior changes lose 4. Both stay
 *    under the floor and are decided by the fraction test alone, which is the whole point of the
 *    near-identical measure — a typo fix, a changed number, a swapped `\cite` key, or a renamed
 *    `\label` must stay `'minor'` regardless of paragraph length.
 *  - **Three** scattered changes lose 6 bigrams and now come out `'prose'` even in a long
 *    paragraph where the fraction alone would still read `'minor'`. That is the accepted cost of
 *    the floor, in the same safe direction as the fraction threshold's own known cost: an extra
 *    stray comment the author deletes, not a paragraph silently lost — and a proofreading pass
 *    issues one edit per typo anyway, so three scattered "typo" edits in one call is already an
 *    unusual shape for that use case.
 *  - A deleted or replaced **clause** of roughly 6 or more tokens loses roughly 6 or more bigrams
 *    and is caught by the floor — and therefore preserved — no matter how long the surrounding
 *    paragraph is, which is the case this constant exists to fix (the trailing/leading-sentence
 *    deletion above).
 *  - A **pure in-place expansion** (`newString` is `oldString` with text appended and nothing
 *    removed or reordered) loses **0** bigrams — every one of `oldString`'s adjacent pairs still
 *    appears in `newString` unbroken — so it stays under the floor and `'minor'`, unchanged from
 *    before this constant existed. See `classifyEdit`'s docstring for why that case must stay
 *    `'minor'`.
 */
export const MIN_UNMATCHED_BIGRAMS_FOR_PROSE = 6;

/** Split on whitespace, dropping empty segments (leading/trailing/repeated whitespace). */
function tokenize(text: string): string[] {
  return text.split(/\s+/).filter((t) => t.length > 0);
}

/** Raw survivor/total counts behind a multiset overlap fraction — shared by
 * `tokenMultisetOverlap` and `nearIdenticalOverlap` so neither has to build the multiset twice,
 * and so `classifyEdit` can get at the unmatched count (`total - survivors`) that the fraction
 * alone throws away. Not exported: callers get either the fraction (`tokenMultisetOverlap`,
 * `nearIdenticalOverlap`) or the full detail (`nearIdenticalOverlapDetail`). */
interface OverlapCounts {
  survivors: number;
  total: number;
}

/** How many of `oldItems` (as a multiset, by exact string match) survive in `newItems`, plus
 * the total (`oldItems.length`) the fraction is taken over. */
function multisetOverlapCounts(
  oldItems: readonly string[],
  newItems: readonly string[],
): OverlapCounts {
  if (oldItems.length === 0) return { survivors: 0, total: 0 };
  const counts = new Map<string, number>();
  for (const item of newItems) {
    counts.set(item, (counts.get(item) ?? 0) + 1);
  }
  let survivors = 0;
  for (const item of oldItems) {
    const remaining = counts.get(item) ?? 0;
    if (remaining > 0) {
      survivors++;
      counts.set(item, remaining - 1);
    }
  }
  return { survivors, total: oldItems.length };
}

/**
 * Fraction of `oldTokens` (as a multiset, by exact string match) that survive in `newTokens`.
 * The base measure `nearIdenticalOverlap` applies to bigrams; this is also the unigram fallback
 * for a too-short token list, and is exported so it can be exercised directly in tests without
 * relying on `classifyEdit`'s own 8-token gate to reach it.
 */
export function tokenMultisetOverlap(
  oldTokens: readonly string[],
  newTokens: readonly string[],
): number {
  const { survivors, total } = multisetOverlapCounts(oldTokens, newTokens);
  return total === 0 ? 0 : survivors / total;
}

/** Adjacent-token bigrams of `tokens`, joined with a single space. Since `tokenize` splits on
 * whitespace, no token can itself contain a space, so the join is unambiguous as a bigram key:
 * `["a", "b", "c"]` -> `["a b", "b c"]`. */
function bigramsOf(tokens: readonly string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i + 1 < tokens.length; i++) {
    result.push(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return result;
}

/**
 * The order-sensitive "near-identical" measure used by `classifyEdit`: the fraction of
 * `oldTokens`'s adjacent-token bigrams that survive (as a multiset) in `newTokens`'s bigrams —
 * see `NEAR_IDENTICAL_OVERLAP_THRESHOLD` for why bigrams rather than a bag of unigram tokens.
 *
 * Degenerate case: fewer than 2 tokens produce no bigrams at all (an empty bigram list would
 * divide by zero and, worse, vacuously "overlap" 0/0 either way). Below that length there is no
 * adjacency to measure, so this falls back to the plain unigram overlap (`tokenMultisetOverlap`)
 * instead. In practice `classifyEdit` never reaches this function with fewer than 8 `oldTokens`
 * (its own length gate returns `'minor'` first), so the fallback is exercised directly in tests
 * rather than through `classifyEdit`.
 */
export function nearIdenticalOverlap(
  oldTokens: readonly string[],
  newTokens: readonly string[],
): number {
  return nearIdenticalOverlapDetail(oldTokens, newTokens).overlap;
}

/** Everything `nearIdenticalOverlap` computes, plus the raw counts behind the fraction —
 * `classifyEdit`'s absolute-loss floor (`MIN_UNMATCHED_BIGRAMS_FOR_PROSE`, below) needs the
 * unmatched count, not just the ratio, and this is the one place that count is available without
 * building the bigram multiset a second time. `unmatched` and `total` are bigram counts (`n - 1`
 * bigrams for `n` tokens) whenever `oldTokens.length >= 2` — the branch `classifyEdit` always
 * takes, since its own 8-token gate runs first. Below that length they fall back to unigram
 * counts, same as `overlap` does; `classifyEdit` never reaches this function in that regime, so
 * the fallback's `unmatched` is not meaningful for the bigram floor and is exercised only via
 * `nearIdenticalOverlap`'s own degenerate-case tests, never through `classifyEdit`.
 */
export function nearIdenticalOverlapDetail(
  oldTokens: readonly string[],
  newTokens: readonly string[],
): { overlap: number; survivors: number; total: number; unmatched: number } {
  const { survivors, total } =
    oldTokens.length < 2
      ? multisetOverlapCounts(oldTokens, newTokens)
      : multisetOverlapCounts(bigramsOf(oldTokens), bigramsOf(newTokens));
  return {
    overlap: total === 0 ? 0 : survivors / total,
    survivors,
    total,
    unmatched: total - survivors,
  };
}

/**
 * True when `token`, taken entirely on its own, is a complete inline/display math span: it both
 * starts and ends with `$` (or both starts and ends with `$$`), with at least the two delimiter
 * characters plus something between them. `"$x$"` and `"$$x$$"` qualify; a bare `"$"` or `"$$"`
 * does not (those are handled as standalone delimiter tokens below), and `"$x"` (an opening
 * delimiter with no matching close in the same token) does not either — that half-open case is
 * markup too, but it is caught by `markupMask`'s toggle state, not here.
 */
function isCompleteMathToken(token: string): boolean {
  if (token.startsWith('$$')) {
    return token.length > 4 && token.endsWith('$$');
  }
  if (token.startsWith('$')) {
    return token.length > 2 && token.endsWith('$');
  }
  return false;
}

/**
 * True when `token` is LaTeX markup rather than prose content: a control sequence (`\cite`,
 * `\label{foo}`, ...), a bare math/grouping delimiter token (`{`, `}`, `&`, `$`, `$$`) that
 * appears on its own rather than attached to a word, or a token that is entirely a complete
 * math span (`"$x$"`, `"$$x$$"` — see `isCompleteMathToken`). Used only to decide whether a
 * majority of `oldString`'s tokens are prose — a permissive, not exhaustive, notion of "markup"
 * is fine here since the classifier only needs to separate "mostly sentences" from "mostly a
 * table row or equation", not to fully parse LaTeX.
 */
function isMarkupToken(token: string): boolean {
  if (token.startsWith('\\')) return true;
  if (token === '{' || token === '}' || token === '&' || token === '$' || token === '$$') {
    return true;
  }
  if (isCompleteMathToken(token)) return true;
  return false;
}

/**
 * Mark every token that falls inside (or delimits) a `$...$` or `$$...$$` math span as markup.
 * `isMarkupToken` already catches a standalone delimiter (`$`, `$$`) and a token that is a
 * *complete* span by itself (`"$x$"`); this function additionally tracks the case a per-token
 * check cannot see — a span opened in one token and closed in a later one (`"$x" "=" "1$"`) — by
 * scanning tokens left to right and toggling in/out of math state on a token with an odd count of
 * `$` characters (a standalone `"$$"` toggles once, as one display-math delimiter).
 *
 * The token that *opens* such a span is itself masked, not just the tokens strictly inside it:
 * the toggle is evaluated before deciding `mask[i]`, so the opening delimiter — which is markup,
 * not a prose word — is folded into the `inMath` state for this same token rather than only
 * affecting the ones after it. Without that, `"$x" "=" "1$"` would count `"$x"` as a prose word.
 *
 * This is intentionally crude (it does not track nesting) — good enough to keep an inline
 * formula's variable names from being counted as prose words, which is all `classifyEdit` needs.
 *
 * An escaped `\$` (currency, not a math delimiter) is stripped before counting toggles: a token
 * like `"\$100"` contains a literal dollar sign that is not opening or closing a math span, so
 * counting it would flip `inMath` and misclassify every token for the rest of the string as
 * markup. `\$100` is already markup on its own via `isMarkupToken`'s leading-backslash rule, so
 * stripping it here loses nothing and only removes the toggle's false signal.
 */
export function markupMask(tokens: string[]): boolean[] {
  const mask = tokens.map(isMarkupToken);
  let inMath = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? '';
    const unescaped = token.replace(/\\\$/g, '');
    // A standalone "$$" token is one display-math delimiter, toggling once; any other
    // occurrence of "$" toggles once per (odd count of) dollar sign in the token.
    const toggles = token === '$$' ? 1 : (unescaped.match(/\$/g) ?? []).length % 2;
    if (inMath || toggles === 1) mask[i] = true;
    if (toggles === 1) inMath = !inMath;
  }
  return mask;
}

/**
 * Classify an `edit_file` edit as `'prose'` (worth preserving under the `prose` mode) or
 * `'minor'` (not worth preserving). `'prose'` requires condition 1 and 2 below, AND (3a OR 3b):
 *
 *  1. `oldString` has at least 8 whitespace-separated tokens — short strings are usually a
 *     label, a key, a single clause, not a paragraph worth keeping around.
 *  2. A strict majority of those tokens are non-markup (see `isMarkupToken`/`markupMask`) — a
 *     table row or a display equation can easily have 8+ tokens, none of them prose.
 *  3. `newString` is not near-identical to `oldString`, tested two ways — either is sufficient:
 *     a. the **fraction** of `oldString`'s bigrams that survive in `newString` falls below
 *        `NEAR_IDENTICAL_OVERLAP_THRESHOLD` (see `nearIdenticalOverlap`), or
 *     b. the **absolute count** of `oldString`'s bigrams that do *not* survive reaches
 *        `MIN_UNMATCHED_BIGRAMS_FOR_PROSE` (see that constant's docstring for why the fraction
 *        alone is not enough: it dilutes a fixed-size loss away in a long paragraph, so a
 *        trailing or leading sentence deleted from a long paragraph would otherwise silently
 *        score `'minor'` while the identical deletion from the middle scores `'prose'`).
 *
 * Condition 3 carries the real weight, and both of its tests are deliberately **order-sensitive**
 * (bigram, not bag-of-tokens): without that, a typo fix in a long sentence ("nvoel" -> "novel")
 * would count as a "rewrite" and get preserved, leaving `% we propose a nvoel method` sitting
 * above the corrected line forever — noise nobody wants. The same reasoning rules out preserving
 * a changed number, a swapped `\cite` key, or a renamed `\label`: each changes one token in an
 * otherwise-identical sentence, so the overlap stays high *and* the unmatched count stays low (2
 * bigrams for one change), so the edit is `minor` under both tests. And because the measure is
 * order-sensitive, a pure **reordering** of the same words (e.g. swapping the order of two
 * clauses, or an active/passive rewrite that keeps most of the same vocabulary) is correctly
 * `prose`: a bag-of-tokens count cannot tell that apart from a typo fix at all, but reordering
 * breaks almost every adjacent pair at the seam where words moved, so the bigram overlap drops.
 *
 * Edit shapes worth calling out explicitly, since they are easy to get backwards:
 *  - A **deletion** (`newString === ''`) has zero overlap with any non-empty `oldString` by
 *    construction (there is nothing for `oldString`'s bigrams to survive in), so a qualifying
 *    deleted paragraph always comes out `prose` — exactly the case this feature exists for: the
 *    user's whole paragraph is what must be preserved, not lost.
 *  - An **expanding** rewrite where `newString` is `oldString` plus more text appended in place
 *    (nothing removed or reordered) scores overlap 1.0 **and** 0 unmatched bigrams, so it stays
 *    `minor` under both tests. This is a deliberate decision, not an oversight: nothing is lost
 *    when the old text is wholly retained, so there is nothing for the preserved-original comment
 *    to protect the user from — commenting out a paragraph that still appears verbatim in the new
 *    text would be pure noise. If a future case combines expansion with a genuine reorder or
 *    deletion of part of the original, the bigram measure already scores that correctly as
 *    `prose` (a broken adjacency drops the overlap and raises the unmatched count): this call
 *    only concerns pure, in-place expansion.
 *  - A run of tokens deleted or replaced from the **end or start** of a long paragraph — the case
 *    that motivated 3b — has only one rejoin seam, so the fraction test alone (3a) can miss it in
 *    a long enough paragraph; the absolute floor (3b) catches it regardless of paragraph length.
 */
export function classifyEdit(oldString: string, newString: string): 'prose' | 'minor' {
  const oldTokens = tokenize(oldString);
  if (oldTokens.length < 8) return 'minor';

  const mask = markupMask(oldTokens);
  const proseCount = mask.filter((isMarkup) => !isMarkup).length;
  if (proseCount * 2 <= oldTokens.length) return 'minor';

  const newTokens = tokenize(newString);
  const { overlap, unmatched } = nearIdenticalOverlapDetail(oldTokens, newTokens);
  if (overlap >= NEAR_IDENTICAL_OVERLAP_THRESHOLD && unmatched < MIN_UNMATCHED_BIGRAMS_FOR_PROSE) {
    return 'minor';
  }

  return 'prose';
}

/** Join a commented block with what follows it, using exactly one line terminator between them
 * and never doubling one `commentOut` already produced. `lineEnding` is `'\r\n'` or `'\n'` — the
 * separator must mirror the line ending the original match actually sat on, or a CRLF file comes
 * back with one stray LF-only line in an otherwise all-CRLF file (the repo forces
 * `core.autocrlf=false`, so a mixed-ending file is a real, persisted defect, not cosmetic). */
function joinCommentedBlock(commented: string, rest: string, lineEnding: '\n' | '\r\n'): string {
  const separator = commented.endsWith('\n') ? '' : lineEnding;
  return commented + separator + rest;
}

/**
 * Extensions whose line-comment syntax is `%` — the only files where preserving a rewrite as a
 * commented block above the replacement is meaningful text, not noise. Anywhere else (`.md`,
 * `.txt`, ...) the mode must be inert: the edit applies unchanged. Kept here, exported, and unit
 * tested rather than duplicated inline in `edit_file` — a second copy of this list is exactly how
 * the tool and the transform eventually disagree about what counts as "commentable".
 */
const LINE_COMMENT_EXTENSIONS: readonly string[] = ['.tex', '.sty', '.cls', '.bbl'];

/** Whether `relPath`'s extension uses `%` for line comments (case-insensitive). */
export function supportsLineComments(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  return LINE_COMMENT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** A `FileService.applyEdits` `transformNewString` hook, plus a way to read how many edits it
 * actually preserved once `applyEdits` has called it for every eligible edit — surfaced by
 * `edit_file` so preservation is never silent. */
export interface PreserveTransform {
  /** Pass as `opts.transformNewString` to `FileService.applyEdits`. */
  transform: (edit: EditOp, matchIndex: number, content: string) => string;
  /** How many edits were actually preserved — call only after `applyEdits` has run. */
  preservedEdits: () => number;
}

/**
 * Build a `FileService.applyEdits` hook that comments the original text out above its
 * replacement, for a `RewriteMode` — the only place that decision is made, so `FileService`
 * itself stays ignorant of `%`-comment syntax (it just calls the hook with the match it found).
 *
 * `'off'` preserves nothing; `'always'` preserves every *eligible* edit; `'prose'` preserves
 * exactly the edits `classifyEdit` calls `'prose'`. An edit is eligible only when ALL of:
 *
 *  - `oldString !== newString` — a no-op edit is passed through untransformed in every mode.
 *    `FileService.applyEdits` rejects such an edit ("oldString and newString are identical")
 *    *before* ever calling this hook (see its per-edit loop), so this case in practice never
 *    reaches `transform` — but the check stays here too, defensively, so this function can never
 *    be the reason that guard goes quiet if the call order ever changes.
 *  - the match found by `applyEdits` (`content.indexOf(edit.oldString)`, always the first
 *    occurrence — the same occurrence `applyEdits` itself replaces when the match is unique)
 *    is **line-aligned**: `oldString` starts at the beginning of a line, and ends at the end of
 *    a line — either because the character right after the match is a line terminator (`\n`, or
 *    `\r` immediately before `\n`) or end-of-file, OR because `oldString`'s own bytes already end
 *    with a line terminator (a caller can include the trailing newline in what it wants replaced
 *    or deleted; the match then consumes it, so there is nothing of that newline left in
 *    `content` right after `end` to check — the alignment is in `oldString` itself). A mid-line
 *    match has no reliable place to put a `%`-comment: a mid-line deletion would silently swallow
 *    the rest of that line into the last preserved `%` line (never in `oldString`, and gone from
 *    the file), and a mid-line replacement would reflow the trailing text onto the replacement's
 *    line, breaking the one-sentence-per-line convention. Neither check can be made inside
 *    `applyRewriteMode`'s old signature, which never saw the file's content or where the match
 *    landed — hence this hook shape, computed lazily by `FileService.applyEdits` itself, after
 *    its own not-found/non-unique guards already ran.
 *  - `edit.replaceAll` is not set. With `replaceAll` there is no single match position (and no
 *    single place to put one preserved block) — `FileService.applyEdits` does not call this hook
 *    for a `replaceAll` edit at all, so this in practice never reaches `transform` with
 *    `replaceAll` set. `transform` checks it again anyway (belt-and-braces, the same reasoning as
 *    the `oldString !== newString` check above): this function must never be the reason that
 *    guard goes quiet if the call order or a future caller ever changes.
 *
 * A deletion (`newString === ''`) is preserved as just the commented block, with no trailing
 * blank line after it — appending an empty `newString` behind the separator would otherwise leave
 * one. When `oldString` consumed its own trailing newline, a non-empty `newString` gets that
 * newline put back after it (so the line that used to follow does not merge onto the
 * replacement's line) — see the comment inline below.
 */
export function createPreserveTransform(mode: RewriteMode): PreserveTransform {
  let preservedEdits = 0;

  function transform(edit: EditOp, matchIndex: number, content: string): string {
    if (mode === 'off') return edit.newString;
    if (edit.oldString === edit.newString) return edit.newString;
    // Belt-and-braces: FileService.applyEdits already never calls this hook for a replaceAll
    // edit (there is no single match position to comment above), but checking it again here too
    // means this function can never be the reason that guard goes quiet if the call order or a
    // future caller ever changes.
    if (edit.replaceAll) return edit.newString;

    const shouldPreserve =
      mode === 'always' || classifyEdit(edit.oldString, edit.newString) === 'prose';
    if (!shouldPreserve) return edit.newString;

    const atLineStart = matchIndex === 0 || content[matchIndex - 1] === '\n';
    const end = matchIndex + edit.oldString.length;
    // `oldString` can end with its own trailing line terminator (a caller including the
    // newline in what it wants replaced/deleted) — that terminator is then already consumed by
    // the match, so `content[end]` is the *next* line's first character, not a newline. That is
    // still a line-aligned match: the check must not rely solely on what follows in `content`.
    const oldEndsWithNewline = edit.oldString.endsWith('\n');
    const matchEndsWithCrlf = content[end] === '\r' && content[end + 1] === '\n';
    const atLineEnd =
      oldEndsWithNewline || end === content.length || content[end] === '\n' || matchEndsWithCrlf;
    if (!atLineStart || !atLineEnd) return edit.newString;

    preservedEdits++;
    const commented = commentOut(edit.oldString);
    if (edit.newString === '') return commented;

    // Mirror the line ending the match sat on (falls back to '\n' at EOF, where there is no
    // terminator to mirror and a bare '\n' is as good a default as any).
    const separatorLineEnding: '\n' | '\r\n' = matchEndsWithCrlf ? '\r\n' : '\n';
    const joined = joinCommentedBlock(commented, edit.newString, separatorLineEnding);

    // When oldString's own bytes already included its trailing terminator, the match consumed
    // it directly out of `content` — so if real content still follows, that terminator has to be
    // put back after `newString`, or the next line would merge onto newString's line. Nothing to
    // restore at EOF: there is no following line to separate from, so a bare comment+replacement
    // with no added trailing newline is already correct there.
    //
    // Restore it only when `newString` does not already carry one. A caller replacing a whole
    // line naturally mirrors its oldString and ends `newString` with a newline too; adding a
    // second one there yields a blank line, which LaTeX reads as a paragraph break the edit
    // never asked for. Testing `'\n'` covers `'\r\n'` as well, since CRLF ends in `\n`.
    if (oldEndsWithNewline && end !== content.length && !edit.newString.endsWith('\n')) {
      const restoredLineEnding: '\n' | '\r\n' = edit.oldString.endsWith('\r\n') ? '\r\n' : '\n';
      return joined + restoredLineEnding;
    }
    return joined;
  }

  return { transform, preservedEdits: () => preservedEdits };
}
