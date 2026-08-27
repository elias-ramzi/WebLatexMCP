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

/** The mode when nothing else says otherwise. */
export const DEFAULT_REWRITE_MODE: RewriteMode = 'prose';

/** Where a resolved mode came from, so it is never a hidden setting. */
export type RewriteModeSource = 'call' | 'project' | 'default';

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
 * block drift the moment someone saves the file.
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
  const commented = lines.map((line) => (line === '' ? '%' : `% ${line}`));
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
 */
export const NEAR_IDENTICAL_OVERLAP_THRESHOLD = 0.7;

/** Split on whitespace, dropping empty segments (leading/trailing/repeated whitespace). */
function tokenize(text: string): string[] {
  return text.split(/\s+/).filter((t) => t.length > 0);
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
  if (oldTokens.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const token of newTokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  let survivors = 0;
  for (const token of oldTokens) {
    const remaining = counts.get(token) ?? 0;
    if (remaining > 0) {
      survivors++;
      counts.set(token, remaining - 1);
    }
  }
  return survivors / oldTokens.length;
}

/** Adjacent-token bigrams of `tokens`, joined with a single space. Since `tokenize` splits on
 * whitespace, no token can itself contain a space, so the join is unambiguous as a bigram key:
 * `["a", "b", "c"]` -> `["a b", "b c"]`. */
function bigramsOf(tokens: readonly string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i + 1 < tokens.length; i++) {
    result.push(`${tokens[i]} ${tokens[i + 1]}`);
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
  if (oldTokens.length < 2) {
    return tokenMultisetOverlap(oldTokens, newTokens);
  }
  return tokenMultisetOverlap(bigramsOf(oldTokens), bigramsOf(newTokens));
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
 * This is intentionally crude (it does not track nesting or escaped `\$`) — good enough to keep
 * an inline formula's variable names from being counted as prose words, which is all
 * `classifyEdit` needs.
 */
export function markupMask(tokens: string[]): boolean[] {
  const mask = tokens.map(isMarkupToken);
  let inMath = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? '';
    // A standalone "$$" token is one display-math delimiter, toggling once; any other
    // occurrence of "$" toggles once per (odd count of) dollar sign in the token.
    const toggles = token === '$$' ? 1 : (token.match(/\$/g) ?? []).length % 2;
    if (inMath || toggles === 1) mask[i] = true;
    if (toggles === 1) inMath = !inMath;
  }
  return mask;
}

/**
 * Classify an `edit_file` edit as `'prose'` (worth preserving under the `prose` mode) or
 * `'minor'` (not worth preserving). `'prose'` requires ALL of:
 *
 *  1. `oldString` has at least 8 whitespace-separated tokens — short strings are usually a
 *     label, a key, a single clause, not a paragraph worth keeping around.
 *  2. A strict majority of those tokens are non-markup (see `isMarkupToken`/`markupMask`) — a
 *     table row or a display equation can easily have 8+ tokens, none of them prose.
 *  3. `newString` is not near-identical to `oldString` (see `nearIdenticalOverlap` /
 *     `NEAR_IDENTICAL_OVERLAP_THRESHOLD`).
 *
 * The third condition carries the real weight, and it is deliberately **order-sensitive**
 * (bigram, not bag-of-tokens): without that, a typo fix in a long sentence ("nvoel" -> "novel")
 * would count as a "rewrite" and get preserved, leaving `% we propose a nvoel method` sitting
 * above the corrected line forever — noise nobody wants. The same reasoning rules out preserving
 * a changed number, a swapped `\cite` key, or a renamed `\label`: each changes one token in an
 * otherwise-identical sentence, so the overlap stays high and the edit is `minor`. And because the
 * measure is order-sensitive, a pure **reordering** of the same words (e.g. swapping the order of
 * two clauses, or an active/passive rewrite that keeps most of the same vocabulary) is correctly
 * `prose`: a bag-of-tokens count cannot tell that apart from a typo fix at all, but reordering
 * breaks almost every adjacent pair at the seam where words moved, so the bigram overlap drops.
 *
 * Two edit shapes worth calling out explicitly, since they are easy to get backwards:
 *  - A **deletion** (`newString === ''`) has zero overlap with any non-empty `oldString` by
 *    construction (there is nothing for `oldString`'s bigrams to survive in), so a qualifying
 *    deleted paragraph always comes out `prose` — exactly the case this feature exists for: the
 *    user's whole paragraph is what must be preserved, not lost.
 *  - An **expanding** rewrite where `newString` is `oldString` plus more text appended in place
 *    (nothing removed or reordered) scores overlap 1.0 and is `minor`. This is a deliberate
 *    decision, not an oversight: nothing is lost when the old text is wholly retained, so there is
 *    nothing for the preserved-original comment to protect the user from — commenting out a
 *    paragraph that still appears verbatim in the new text would be pure noise. If a future case
 *    combines expansion with a genuine reorder or deletion of part of the original, the bigram
 *    measure already scores that correctly as `prose` (a broken adjacency drops the overlap): this
 *    call only concerns pure, in-place expansion.
 */
export function classifyEdit(oldString: string, newString: string): 'prose' | 'minor' {
  const oldTokens = tokenize(oldString);
  if (oldTokens.length < 8) return 'minor';

  const mask = markupMask(oldTokens);
  const proseCount = mask.filter((isMarkup) => !isMarkup).length;
  if (proseCount * 2 <= oldTokens.length) return 'minor';

  const newTokens = tokenize(newString);
  const overlap = nearIdenticalOverlap(oldTokens, newTokens);
  if (overlap >= NEAR_IDENTICAL_OVERLAP_THRESHOLD) return 'minor';

  return 'prose';
}

/** Join a commented block with what follows it, using exactly one newline between them and
 * never doubling one `commentOut` already produced. */
function joinCommentedBlock(commented: string, rest: string): string {
  const separator = commented.endsWith('\n') ? '' : '\n';
  return commented + separator + rest;
}

/** The result of `applyRewriteMode`: the (possibly rewritten) edit list, and how many edits had
 * their original text preserved — surfaced by the tool so preservation is never silent. */
export interface RewriteModeResult {
  edits: EditOp[];
  preservedEdits: number;
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

/**
 * Apply a `RewriteMode` to a list of `edit_file` edits, producing a new edit list where preserved
 * edits get `commentOut(oldString)` spliced in front of `newString`.
 *
 * `'off'` preserves nothing; `'always'` preserves everything; `'prose'` preserves exactly the
 * edits `classifyEdit` calls `'prose'`. In every mode, an edit whose `oldString === newString` is
 * passed through completely untransformed — `FileService.applyEdits` rejects such a no-op edit
 * ("oldString and newString are identical"), and if this function transformed it first, the two
 * strings would no longer match and that guard would silently stop firing. Preservation must
 * never be the reason an existing guard goes quiet.
 *
 * A deletion (`newString === ''`) is preserved as just the commented block, with no trailing
 * blank line after it — appending an empty `newString` behind the separator would otherwise leave
 * one.
 */
export function applyRewriteMode(edits: readonly EditOp[], mode: RewriteMode): RewriteModeResult {
  if (mode === 'off') {
    return { edits: edits.map((edit) => ({ ...edit })), preservedEdits: 0 };
  }

  let preservedEdits = 0;
  const result = edits.map((edit): EditOp => {
    if (edit.oldString === edit.newString) {
      return { ...edit };
    }

    const shouldPreserve =
      mode === 'always' || classifyEdit(edit.oldString, edit.newString) === 'prose';
    if (!shouldPreserve) {
      return { ...edit };
    }

    preservedEdits++;
    const commented = commentOut(edit.oldString);
    const newString =
      edit.newString === '' ? commented : joinCommentedBlock(commented, edit.newString);
    return { ...edit, newString };
  });

  return { edits: result, preservedEdits };
}
