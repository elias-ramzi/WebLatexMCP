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
 * so callers can skip the filtering machinery entirely (and, for `filterLog`, skip the paren-stack
 * bookkeeping `keepWarning` needs) rather than run a predicate that always says yes.
 */
export function isEmptyFilter(f: WarningFilter | undefined): boolean {
  if (!f) return true;
  return (
    !(f.file && f.file.length > 0) &&
    !(f.rule && f.rule.length > 0) &&
    !(f.excludeRule && f.excludeRule.length > 0)
  );
}
