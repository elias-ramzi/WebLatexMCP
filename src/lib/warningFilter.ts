import { withoutUnopenableLocation } from './sourceSnippet.js';

/**
 * `compile`'s `warningsFilter` — trims `warnings[]` (and, in lockstep, `logTail`; see
 * `filterLog`'s `keepWarning` option in `src/services/logParser.ts`) down to the warnings a caller
 * actually wants, on a large document where every `Overfull \hbox`/`Underfull \vbox` line
 * otherwise ships twice: once structured, once as raw text.
 *
 * Matching is **exact and literal** — no globs, no prefixes, no case folding. This mirrors the
 * house rule that a caller-named path handed downstream is literal, never a glob (CLAUDE.md, "A
 * pathspec handed to git is literal"): a filter is a caller assertion about an exact spelling, and
 * silently treating it as a prefix or a glob would make a typo match nothing conspicuously wrong
 * instead of everything wrong.
 */
export interface WarningFilter {
  /**
   * Keep only warnings whose `file` is exactly one of these (project-relative POSIX, as
   * `warnings[].file` reports it). A warning the log named no file for is dropped when this is
   * given — there is nothing to compare, and a caller filtering to one file does not want the
   * fileless ones mixed in.
   */
  file?: string[];
  /** Keep only warnings whose `rule` is exactly one of these. */
  rule?: string[];
  /** Drop warnings whose `rule` is exactly one of these; a rule-less warning is never excluded. */
  excludeRule?: string[];
}

/** The subset of a diagnostic the filter judges — deliberately narrower than `StructuredError`. */
export interface FilterableWarning {
  file?: string;
  rule?: string;
}

/**
 * True iff `w` survives `f`. Every clause present in `f` must pass; an absent or empty clause
 * imposes no constraint. `warningMatches(w, undefined)` is always `true`.
 */
export function warningMatches(w: FilterableWarning, f: WarningFilter | undefined): boolean {
  if (!f) return true;
  if (f.file && f.file.length > 0) {
    if (w.file === undefined || !f.file.includes(w.file)) return false;
  }
  if (f.rule && f.rule.length > 0) {
    if (w.rule === undefined || !f.rule.includes(w.rule)) return false;
  }
  if (f.excludeRule && f.excludeRule.length > 0) {
    if (w.rule !== undefined && f.excludeRule.includes(w.rule)) return false;
  }
  return true;
}

/**
 * True when `f` constrains nothing — undefined, or every one of its three arrays absent/empty —
 * so the filtering machinery can be skipped entirely (and, for `filterLog`, the paren-stack
 * bookkeeping `keepWarning` needs) rather than running a predicate that always says yes.
 *
 * {@link makeWarningJudge} is the route a caller takes to that answer: it calls this once and
 * returns `undefined`, so nobody downstream re-derives emptiness on their own and drifts from the
 * predicate. A new caller asking this directly, beside a judge, is re-opening that gap.
 */
export function isEmptyFilter(f: WarningFilter | undefined): boolean {
  if (!f) return true;
  return (
    !(f.file && f.file.length > 0) &&
    !(f.rule && f.rule.length > 0) &&
    !(f.excludeRule && f.excludeRule.length > 0)
  );
}

/** The one predicate `compile` judges a warning by, on both channels. */
export type WarningJudge = (w: FilterableWarning) => boolean;

/**
 * The predicate `compile`'s `warningsFilter` judges a warning by — built once and handed to both
 * channels (`warnings[]` and, as `filterLog`'s `keepWarning`, `logTail`).
 *
 * **`undefined` when the filter constrains nothing**, deliberately — not an always-true predicate.
 * A caller then has exactly ONE value to branch on for both channels, so "no filter ⇒ output
 * byte-identical and `filterLog` skips its paren-stack bookkeeping entirely" is decided once
 * instead of re-derived per channel. Be precise about what that buys and what it does not: it
 * removes the drift between the *emptiness decision* and the predicate (a second `isEmptyFilter`
 * call beside the judge is exactly the shape that lets one channel keep filtering after the other
 * stopped). It does not make a one-sided edit impossible — the caller still branches on this value
 * twice, once per channel, and nothing here can stop a future edit from filtering `warnings[]`
 * while handing `logTail` something else. That much is still convention, and still worth reviewing
 * for.
 *
 * **Filter AFTER `withoutUnopenableLocation`, never before:** a warning whose path was withheld (a
 * symlink escape, or past the path-check cap) must be judged on the `file` the caller actually
 * sees — `undefined` for a withheld one — not the log's original, possibly unopenable path.
 *
 * **ONE predicate for both channels, and it applies the withholding itself.** `logTail`'s side
 * derives `file` from the log's own paren stack, which knows nothing about what was withheld;
 * judging it directly had the two channels disagree about exactly the paths the server
 * deliberately refuses to hand back — a `file` filter naming a withheld path emptied `warnings[]`
 * while leaving that very warning in the tail. Running each candidate through
 * `withoutUnopenableLocation` first makes the question identical on both sides; it is idempotent
 * on a candidate whose file is already gone, so the structured side pays nothing for it.
 *
 * One residual, accepted — a property of how `compile` builds the set it passes, not of this
 * function: `withheld` holds only paths the *parsed* diagnostics named, so a tail-only warning
 * line (a `LaTeX Font Warning:`, a bare `pdfTeX warning`) under an escaping
 * paren-stack path is still judged on its real path. That leaks nothing — filtering only ever
 * removes lines, and never emits a path — it just leaves a weak confirmation oracle for a caller
 * who already knows the escaping path and watches whether such a line survives naming it. They
 * supply the path, learn no content, and get nothing openable back.
 *
 * The predicate closes over the `withheld` *reference*, not a copy — mutating that set after
 * building the judge changes the answers it gives mid-filter. `compile` never does (the set comes
 * back finished from `unopenablePaths`), and a caller that would should pass a snapshot.
 */
export function makeWarningJudge(
  withheld: Set<string>,
  filter: WarningFilter | undefined,
): WarningJudge | undefined {
  if (isEmptyFilter(filter)) return undefined;
  return (w) => warningMatches(withoutUnopenableLocation(w, withheld), filter);
}
