/**
 * Deciding how much of `locate_text`'s payload may be returned, charged against the RENDERED
 * result in BOTH channels it ships in — the `searchBudget.ts` pattern. Every byte of a snippet is
 * document text and every path comes from walking the project, so a count cap alone bounds
 * nothing: 20 candidates on a generated `.tex` with 2000-character lines would be ~80KB.
 *
 * Each entry is charged `JSON.stringify(entry).length` plus its text-channel lines, rendered by
 * {@link renderLocatedEntry} — the same function the tool renders with, so the charge and the text
 * cannot drift. Two lanes, disjoint, in strict priority:
 *
 *  1. **Locations first.** A `file:line–endLine` is what the caller acts on, and the one thing no
 *     follow-up call recovers; entries are admitted (snippet-less) in order while they fit, the
 *     first always. What does not fit is counted in `resultsOmitted`.
 *  2. **Snippets next**, in entry order, each only if its whole cost fits; otherwise `snippet` is
 *     `null` and counted in `snippetsOmitted` — one `read_file` of the range recovers it.
 *
 * A snippet is already shaped before it is charged: at most {@link SNIPPET_MAX_LINES} lines, each
 * cut at {@link SNIPPET_LINE_CHARS} characters, both cuts marked inline with `…`.
 *
 * The `skipped` list (files not searched) has its own diagnostic budget, as in `search_files`, so
 * a long list of candidates can never crowd out "this file was not searched".
 */
import { CONFLICT_CONTENT_BUDGET, CONFLICT_MAX_FILES } from './conflictBudget.js';
import type { LocatedCandidate } from './locateText.js';
import type { QuoteMatchedBy } from './quoteLocate.js';

/** The house figure for one document-controlled field's share of a result, reused. */
export const LOCATE_TEXT_CONTENT_BUDGET = CONFLICT_CONTENT_BUDGET;
/** The house figure for a merely diagnostic share. */
export const LOCATE_TEXT_SKIPPED_BUDGET = 2000;
/** The house cap for a list. */
export const LOCATE_TEXT_MAX_SKIPPED = CONFLICT_MAX_FILES;
export const SNIPPET_MAX_LINES = 6;
export const SNIPPET_LINE_CHARS = 240;

export interface LocatedEntry {
  file: string;
  line: number;
  endLine: number;
  matchedBy: QuoteMatchedBy;
  /** The live source lines, shaped; `null` when the payload budget cut it. */
  snippet: string | null;
}

/** A candidate's live lines, cut to the snippet shape (cuts marked with `…`). */
export function shapeSnippet(lines: readonly string[]): string {
  const kept = lines
    .slice(0, SNIPPET_MAX_LINES)
    .map((l) => (l.length > SNIPPET_LINE_CHARS ? `${l.slice(0, SNIPPET_LINE_CHARS)}…` : l));
  if (lines.length > SNIPPET_MAX_LINES) {
    kept.push(`… (${lines.length - SNIPPET_MAX_LINES} more line(s))`);
  }
  return kept.join('\n');
}

/** One entry as the text channel shows it. */
export function renderLocatedEntry(e: LocatedEntry): string[] {
  const range = e.endLine > e.line ? `${e.line}–${e.endLine}` : `${e.line}`;
  const out = [`${e.file}:${range} (${e.matchedBy})`];
  if (e.snippet !== null) {
    for (const l of e.snippet.split('\n')) out.push(`  ${l}`);
  } else {
    out.push('  (snippet omitted by the payload budget — read_file this range)');
  }
  return out;
}

/** What one entry costs across both channels (plus its separators). */
export function entryCost(e: LocatedEntry): number {
  return JSON.stringify(e).length + 1 + renderLocatedEntry(e).join('\n').length + 1;
}

export interface LocatedPlan {
  entries: LocatedEntry[];
  /** Candidates admitted by count but cut by the budget. */
  omittedBySize: number;
  snippetsOmitted: number;
}

/** Fit `candidates` (already cut to `maxResults`) into `budget`. */
export function planLocatedPayload(
  candidates: readonly LocatedCandidate[],
  budget: number = LOCATE_TEXT_CONTENT_BUDGET,
): LocatedPlan {
  const bare: LocatedEntry[] = candidates.map((c) => ({
    file: c.file,
    line: c.line,
    endLine: c.endLine,
    matchedBy: c.matchedBy,
    snippet: null,
  }));
  let used = 0;
  const kept: LocatedEntry[] = [];
  for (const e of bare) {
    const cost = entryCost(e);
    if (kept.length > 0 && used + cost > budget) break;
    kept.push(e);
    used += cost;
  }
  let snippetsOmitted = 0;
  const entries = kept.map((e, i) => {
    const withSnippet = { ...e, snippet: shapeSnippet(candidates[i]?.snippetLines ?? []) };
    const delta = entryCost(withSnippet) - entryCost(e);
    if (used + delta <= budget) {
      used += delta;
      return withSnippet;
    }
    snippetsOmitted++;
    return e;
  });
  return { entries, omittedBySize: candidates.length - kept.length, snippetsOmitted };
}

export interface SkippedFile {
  path: string;
  reason: 'too-large' | 'unreadable';
}

/** One skipped file as the text channel shows it. */
export function renderSkipped(s: SkippedFile): string {
  return `  not searched (${s.reason}): ${s.path}`;
}

/** The skipped files that fit their own budget and count cap, in order. */
export function planSkipped(
  skipped: readonly SkippedFile[],
  budget: number = LOCATE_TEXT_SKIPPED_BUDGET,
): SkippedFile[] {
  let used = 0;
  const out: SkippedFile[] = [];
  for (const s of skipped.slice(0, LOCATE_TEXT_MAX_SKIPPED)) {
    const cost = JSON.stringify(s).length + 1 + renderSkipped(s).length + 1;
    if (used + cost > budget) break;
    out.push(s);
    used += cost;
  }
  return out;
}

/** `locate_text`'s `structuredContent`: every key here is declared in the tool's outputSchema. */
export interface LocateTextResult {
  results: LocatedEntry[];
  matchCount: number;
  unique: boolean;
  resultsOmitted: number;
  snippetsOmitted: number;
  variant: 'as-pasted' | 'margin-numbers-removed' | 'none';
  marginNumbersRemoved: number;
  instructionDropped: boolean;
  wordsSearched: number;
  filesSearched: number;
  skipped: SkippedFile[];
  skippedCount: number;
  note?: string;
}

/**
 * The tool's result in both channels, built from ONE cut plan: the text is rendered from the
 * entries the budget kept, never from the full candidate list.
 */
export function buildLocateTextResult(
  outcome: {
    candidates: readonly LocatedCandidate[];
    variant: 'as-pasted' | 'margin-numbers-removed' | null;
    marginNumbersRemoved: number;
    instructionDropped: boolean;
    wordsSearched: number;
    filesSearched: number;
    skipped: readonly SkippedFile[];
  },
  maxResults: number,
): { result: LocateTextResult; text: string } {
  const matchCount = outcome.candidates.length;
  const byCount = outcome.candidates.slice(0, maxResults);
  const plan = planLocatedPayload(byCount);
  const skipped = planSkipped(outcome.skipped);
  const unique = matchCount === 1 && outcome.skipped.length === 0;

  const notes: string[] = [];
  if (matchCount > byCount.length) {
    notes.push(`${matchCount - byCount.length} candidate(s) beyond maxResults (${maxResults}).`);
  }
  if (plan.omittedBySize > 0) {
    notes.push(`${plan.omittedBySize} candidate(s) cut by the payload budget.`);
  }
  if (plan.snippetsOmitted > 0) {
    notes.push(
      `${plan.snippetsOmitted} snippet(s) cut by the payload budget; read_file the range instead.`,
    );
  }
  if (outcome.skipped.length > 0) {
    notes.push(
      `${outcome.skipped.length} .tex file(s) were not searched (too large or unreadable), so a ` +
        'single candidate is not known to be unique.',
    );
  }
  if (outcome.skipped.length > skipped.length) {
    notes.push(`${outcome.skipped.length - skipped.length} unsearched file(s) not listed.`);
  }
  if (outcome.variant === 'margin-numbers-removed') {
    notes.push(
      `Located only after removing ${outcome.marginNumbersRemoved} margin line number(s) the ` +
        'PDF copy carried; the match does not rely on them.',
    );
  }
  if (outcome.instructionDropped) {
    notes.push('Everything from the first "-->" on was treated as an instruction, not searched.');
  }

  const result: LocateTextResult = {
    results: plan.entries,
    matchCount,
    unique,
    resultsOmitted: matchCount - plan.entries.length,
    snippetsOmitted: plan.snippetsOmitted,
    variant: outcome.variant ?? 'none',
    marginNumbersRemoved: outcome.marginNumbersRemoved,
    instructionDropped: outcome.instructionDropped,
    wordsSearched: outcome.wordsSearched,
    filesSearched: outcome.filesSearched,
    skipped,
    skippedCount: outcome.skipped.length,
    ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
  };

  const lines: string[] = [];
  if (matchCount === 0) {
    lines.push(
      `Not found in ${outcome.filesSearched} .tex file(s) (${outcome.wordsSearched} words ` +
        'searched, % comments excluded).',
    );
  } else {
    const how =
      outcome.variant === 'margin-numbers-removed' ? 'margin numbers removed' : 'as pasted';
    const showing = plan.entries.length < matchCount ? `, showing ${plan.entries.length}` : '';
    const tag = unique ? ' (unique)' : '';
    lines.push(
      `${matchCount} candidate location(s)${tag} for ${outcome.wordsSearched} words, ${how}` +
        `${showing}:`,
    );
    for (const e of plan.entries) lines.push(...renderLocatedEntry(e));
  }
  for (const s of skipped) lines.push(renderSkipped(s));
  if (result.note) lines.push(result.note);
  return { result, text: lines.join('\n') };
}
