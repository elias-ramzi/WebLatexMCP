import path from 'node:path';
import type { StructuredError } from '../types.js';

/**
 * A diagnostic plus how the parser came by its location. Both extra fields are parser provenance
 * for the snippet layer, which consumes and strips them: they exist so that "never show source for
 * a location we cannot vouch for" is decidable at all, and they are deliberately not on
 * {@link StructuredError}, which is what tools return.
 */
export interface ParsedDiagnostic extends StructuredError {
  /**
   * `file` and `line` were read off one diagnostic line, so they describe one place in one file.
   * Absent when they came from independent sources — the balanced-paren file stack for the file, a
   * nearby `l.<n>` for the line — which a stray `)` in log text can pull apart.
   */
  locatedPair?: boolean;
  /** The source text TeX echoed for `line` (its `l.<n> …` context line), when it printed one. */
  echo?: string;
}

export interface ParsedLog {
  errors: ParsedDiagnostic[];
  warnings: ParsedDiagnostic[];
}

/** pdfTeX/latexmk hard-wrap column (`max_print_line` default). */
const WRAP_WIDTH = 79;

/**
 * The last `n` lines of a log, for the raw escape hatch (`compile`'s `rawLog: true`, and
 * `filterLog`'s fallback when nothing matched). Splits on every line ending, not just `\n`: pdfTeX
 * writes its .log in text mode, so on Windows each line would otherwise come back with a trailing
 * `\r` — the matched path is clean because it goes through {@link unwrapLines}, and this was the
 * last one that was not.
 */
export function logTail(log: string, n = 60): string {
  const lines = log.split(/\r\n|\n|\r/);
  return lines.slice(Math.max(0, lines.length - n)).join('\n');
}

/**
 * TeX hard-wraps its log at `max_print_line` columns (79 by default), splitting long file paths and
 * messages across physical lines with no continuation marker. Rejoin them so a path or message that
 * spans several physical lines is parsed as one logical line: a physical line of exactly the wrap
 * width is treated as a wrap and glued to the next. Best-effort — a natural line that happens to be
 * exactly 79 chars is (rarely) joined too, the accepted cost of every LaTeX-log parser.
 */
export function unwrapLines(log: string, width = WRAP_WIDTH): string[] {
  // Split on every line ending, not just \n. pdfTeX writes its .log through C stdio in text mode,
  // so on Windows every line arrives with a trailing \r — which `.`/`$` do not cross, which
  // `extname` keeps ('.tex\r'), and which pushes a wrapped line to 80 chars so the un-wrap below
  // never fires. Left in, it silently emptied every diagnostic this parser produces on Windows.
  const physical = log.split(/\r\n|\n|\r/);
  const logical: string[] = [];
  let buf = '';
  let wrapped = false;
  for (const line of physical) {
    buf += line;
    if (line.length === width) {
      wrapped = true;
      continue;
    }
    logical.push(buf);
    buf = '';
    wrapped = false;
  }
  if (wrapped || buf) logical.push(buf);
  return logical;
}

function normalizeFile(file: string): string {
  return file.replace(/^\.\//, '');
}

/**
 * Put a path the log printed back onto the project root.
 *
 * The log's paths are relative to the directory the engine ran in, which is **not** the project
 * root: latexmk is passed `-cd`, so it chdirs into the root file's directory first, and a document
 * at `paper/main.tex` reports its own errors as `./main.tex`. Left unjoined, a snippet either
 * misses — or, when a same-named file happens to sit at the project root, silently shows five lines
 * of the wrong file under a `>` marker. Absolute paths (a `.sty` from the TeX tree) are left alone,
 * as is anything that would climb out of the project.
 */
function rebase(file: string, baseDir: string): string {
  if (!baseDir || path.posix.isAbsolute(file) || path.win32.isAbsolute(file)) return file;
  const joined = path.posix.normalize(path.posix.join(baseDir, file));
  return joined.startsWith('..') ? file : joined;
}

/**
 * pgf/TikZ prints this when a `\write18` system call was blocked because `-shell-escape` was not
 * enabled. Externalization fires one such error per figure (18 on a figure-heavy paper), all with
 * the same root cause. The "did NOT result in a usable output file" phrase prints on a single
 * physical line, so it survives without un-wrapping.
 */
const SHELL_ESCAPE_FAILURE = /did NOT result in a usable output file/;

/**
 * True when the log shows a system call was blocked for lack of `-shell-escape` — the signature of
 * a TikZ-externalizing document compiled without shell escape. Un-wraps first, since TeX splits the
 * "…enabled system calls" advice across physical lines.
 */
export function needsShellEscape(log: string): boolean {
  const text = unwrapLines(log).join('\n');
  return SHELL_ESCAPE_FAILURE.test(text) && /enabled system calls/.test(text);
}

/**
 * TeX's "the file I was told to read does not exist" signatures, in the `-file-line-error` form
 * (`./main.tex:3: LaTeX Error: File \`fontawesome.sty' not found.`), the bare form
 * (`! LaTeX Error: File \`IEEEtran.cls' not found.`) and TeX's own lower-level phrasing
 * (`! I can't find file \`foo.sty'.`). The name is always quoted backtick-apostrophe.
 */
const MISSING_FILE = /(?:File\s+`([^'\n]+)'\s+not found|can't find file\s+`([^'\n]+)')/g;

/**
 * Only these are a *package* the user can install: a missing `.png` or `.bbl` is a problem with the
 * document (or with an earlier build step), and telling the caller to install a package for it
 * would send them down the wrong path entirely.
 */
const INSTALLABLE_EXTENSION = /\.(sty|cls)$/i;

/**
 * Package/class names a compile could not find, e.g. `["fontawesome"]` — extracted so the caller
 * gets a machine-actionable fact instead of having to regex the log itself. Un-wraps first, since a
 * long path in the message is hard-wrapped like any other line. Names are de-duplicated (TeX
 * reports the same missing file once per pass) and returned in the order they first appear.
 */
export function findMissingPackages(log: string): string[] {
  const text = unwrapLines(log).join('\n');
  const names = new Set<string>();
  for (const match of text.matchAll(MISSING_FILE)) {
    const file = match[1] ?? match[2];
    if (!file || !INSTALLABLE_EXTENSION.test(file)) continue;
    // `\usepackage{sub/foo}` reports `sub/foo.sty`; the installable unit is the base name.
    const base = file.slice(file.lastIndexOf('/') + 1);
    names.add(base.replace(INSTALLABLE_EXTENSION, ''));
  }
  return [...names];
}

/**
 * TikZ externalization emits one identical "system call did NOT result in a usable output file"
 * error per figure — they share a single cause (shell escape disabled), so collapse them into one
 * diagnostic instead of flooding the caller with N opaque `Package tikz Error` entries.
 */
function collapseShellEscapeErrors(errors: ParsedDiagnostic[]): ParsedDiagnostic[] {
  const matched = errors.filter((e) => SHELL_ESCAPE_FAILURE.test(e.message));
  if (matched.length <= 1) return errors;
  const collapsed: ParsedDiagnostic = {
    severity: 'error',
    // Deliberately unattributed. This entry stands for N figures, so the first one's file and line
    // are not its location — inheriting them pointed the caller (and the snippet layer) at one
    // arbitrary figure's source, where nothing is wrong, as though it were the error site.
    message:
      `TikZ externalization failed for ${matched.length} figures: the system call did NOT ` +
      'result in a usable output file because shell escape is disabled. Retry compile with ' +
      'restrictedShellEscape: true (or shellEscape: true) to enable system calls.',
    rule: 'shell escape disabled',
  };
  return [collapsed, ...errors.filter((e) => !SHELL_ESCAPE_FAILURE.test(e.message))];
}

function deriveRule(message: string): string {
  // First clause of the message, e.g. "Undefined control sequence." -> "Undefined control sequence".
  return message.split(/[.:]/)[0]?.trim() ?? message;
}

/**
 * Does a token that followed a `(` look like a filename TeX opened? A real file always prints with a
 * path separator or a dotted extension (`./main.tex`, `/usr/share/.../pgf.sty`, `main.aux`), whereas
 * incidental parens in prose/math (`(\end occurred`, `(3.14)`) do not. Requiring a slash or an
 * alphabetic extension keeps those from corrupting the file stack.
 */
function looksLikeFile(token: string): boolean {
  return token.includes('/') || /\.[A-Za-z]/.test(token);
}

/**
 * TeX prints the offending source line under an error as `l.<n> <text>`, splitting it at the error
 * position (the remainder goes on the next line). `<text>` is therefore a *prefix* of the real
 * source line — enough to check a location against the file on disk, which is all it is used for.
 * The lookahead spans the message, its "See the … documentation" advice and the blank line between.
 */
const CONTEXT_LOOKAHEAD = 8;

/**
 * `-file-line-error` form: "./main.tex:12: Undefined control sequence."
 *
 * Shared, via `.exec()` in `parseLog` and `.test()` in `nextContext` and both of `filterLog`'s
 * pattern loops — {@link KEEP_PATTERNS} (it is the line naming what failed) and
 * {@link ALWAYS_KEEP_PATTERNS} (so no warning filter can take it away). Flags must stay empty — no
 * `g`/`y` — or `lastIndex` persists across those call sites and produces alternating misses that
 * look like a parser flake, not a regex bug.
 */
const FILE_LINE_ERROR = /^(?:\.\/)?([^:\s][^:]*\.\w+):(\d+): (.+)$/;

/**
 * A warning from LaTeX itself, a package, or a class — e.g. "LaTeX Warning: ...", "Package
 * hyperref Warning: ...". Shared by `parseLog` and `filterLog`'s `keepWarning` so the two never
 * derive a different `rule` for the same line. Deliberately narrow: "LaTeX Font Warning: ..." does
 * NOT match (there is no bare "Warning:" right after "LaTeX"), so a font warning falls through to
 * `warningRuleOf`'s unmatched case rather than being misclassified as rule "LaTeX".
 *
 * The name class is `[\w.-]+`, not `\w+`: real package names carry `.` and `-` (`pdftex.def`,
 * `tikz-cd`, `biblatex-ext`), and `\w+` matched neither — so `Package pdftex.def Warning: ...`
 * matched nothing at all. Not misclassified: *invisible*, dropped from `warnings[]` by `parseLog`
 * and from `warningsOmitted` by `warningRuleOf` (it never reached the filter to be counted), while
 * `KEEP_PATTERNS`' literal `/Warning:/` still kept the raw line in `logTail` — the one asymmetry
 * `warningsFilter` exists to remove. The space before `Warning:` is deliberately outside the
 * class, so a name can never swallow into it.
 */
const PACKAGE_WARNING = /(?:LaTeX|Package ([\w.-]+)|Class ([\w.-]+)) Warning: (.+)/;

/** An `Overfull \hbox`/`Underfull \vbox` line. Shared the same way as {@link PACKAGE_WARNING}. */
const BOX_WARNING = /^(Overfull|Underfull) \\([hv])box/;

/**
 * The `{ file, rule }` shape `keepWarning` judges, derived from one log line the same way
 * `parseLog` derives a *warning's* `rule` — kept as one function so the two stay in step.
 *
 * It speaks only for lines that reach the filter at all. An *error* line never does: a `! ` line
 * and — because `parseLog` tests {@link FILE_LINE_ERROR} first and `continue`s, so a
 * `-file-line-error` line is an error whatever its message says — a `-file-line-error` line are
 * both excluded by {@link ALWAYS_KEEP_PATTERNS} before `warningRuleOf` is ever consulted (as is a
 * bare error-shaped line `parseLog` does not call a warning — see {@link BARE_ERROR_LINE}). That
 * exclusion is what keeps the two partitions aligned; this function makes no claim about a line
 * `parseLog` would call an error, and would derive the wrong `rule` for one
 * (`./main.tex:12: Package foo Warning: …` → `"foo"`, where `parseLog` derives
 * `"Package foo Warning"` from the whole message).
 *
 * `matched: false` means the line carries no rule this feature understands (a font warning, a bare
 * `pdfTeX warning`, or any other line kept only because it contains the word "Warning:") — it is
 * still a warning line, just one with `rule: undefined`.
 */
function warningRuleOf(line: string): { matched: boolean; rule?: string } {
  const warn = PACKAGE_WARNING.exec(line);
  if (warn && warn[3]) return { matched: true, rule: warn[1] ?? warn[2] ?? 'LaTeX' };
  const box = BOX_WARNING.exec(line);
  if (box) return { matched: true, rule: `${box[1]} \\${box[2]}box` };
  return { matched: false };
}

/**
 * Whether a kept log line is a *warning* line at all, as opposed to an error/context/summary line
 * that `filterLog` always keeps regardless of `keepWarning`. Deliberately broader than
 * {@link warningRuleOf}'s "matched" case — a bare `pdfTeX warning` or an unrecognised
 * `... Warning: ...` is still a warning, with no rule this feature understands.
 */
function isWarningLine(line: string): boolean {
  return /Warning:/.test(line) || /pdfTeX warning/.test(line) || BOX_WARNING.test(line);
}

/**
 * An error-shaped line with no `! ` in front — `LaTeX Error:`, `Package foo Error:`,
 * `Class foo Error:` at the START of the line — that `parseLog` does not structure as a warning.
 *
 * This replaces an unanchored `/Error:/` in {@link ALWAYS_KEEP_PATTERNS}, which pinned any line
 * whose text merely CONTAINED "Error:" — so `Package foo Warning: Error: …`, a warning to
 * `parseLog` with rule `foo`, was dropped from `warnings[]` by `excludeRule: ["foo"]` and kept in
 * `logTail`: the two partitions disagreeing about one line, the asymmetry `warningsFilter` exists to
 * remove. The log is document-controlled, so that is reachable from any `\PackageWarning`.
 *
 * Two things keep this entry aligned with `parseLog` rather than merely narrower:
 *  - `parseLog`'s error branches are `! …` and {@link FILE_LINE_ERROR}, both already in
 *    {@link ALWAYS_KEEP_PATTERNS} on their own, so no line `parseLog` calls an error depends on
 *    this entry. (A real TeX error always prints behind `! ` or `file:line:` — `\errmessage` starts
 *    a fresh line with one or the other — so a bare error shape is not something `parseLog` has a
 *    branch for at all.)
 *  - The lookahead refuses any line {@link PACKAGE_WARNING} matches ANYWHERE, built from that very
 *    regex's source so the two cannot drift: `PACKAGE_WARNING` is unanchored, so
 *    `Package foo Error: see LaTeX Warning: …` is a `LaTeX`-rule warning to `parseLog`, and an
 *    anchor on the prefix alone would pin it straight back onto the wrong side.
 *
 * What it still pins is a bare error shape `parseLog` reports as neither — which only ever matters
 * when such a line also carries a warning marker `isWarningLine` sees (a `LaTeX Font Warning:`, a
 * `pdfTeX warning`), since a line with none is never filtered anyway.
 */
const BARE_ERROR_LINE = new RegExp(
  `^(?!.*${PACKAGE_WARNING.source})(?:LaTeX|Package [\\w.-]+|Class [\\w.-]+) Error:`,
);

/**
 * Longest `logTail` line kept, in characters, before an elision marker.
 *
 * `filterLog` bounds the tail in LINES (80), but each is a *logical* line — {@link unwrapLines}
 * rejoins TeX's 79-column wrap — so a single `\PackageWarning` with a long message was one kept line
 * of any length, and 80 of them put ~400k characters into `structuredContent`. 500 is ~6 physical
 * lines of a wrapped log: past the head of any real message (which package, what went wrong, the
 * `on input line N`), which is the part a reader acts on, while the rest stays in `logPath`. It is
 * a per-line bound, not the total's: `compile` charges the rendered tail against its diagnostics
 * budget and trims whole lines to fit (`fitFilteredLog`). What this cap guarantees is that no one
 * line can spend that whole share — the tail keeps at least its last line — and that a line under
 * it comes back byte-identical, since only a longer line is ever touched.
 */
export const LOG_TAIL_LINE_CAP = 500;

/**
 * `text` cut to its first `keep` characters plus a marker saying how many went and where they are
 * — or `text` itself, untouched, when it is no longer than that. The cut is on a character
 * boundary: one landing between the halves of an astral character would leave a lone surrogate,
 * which is not text (the same care `sourceSnippet.ts` takes over its snippet lines), so it backs
 * off by one. Shared by the `logTail` line cap and `compile`'s diagnostics budget, which cuts a
 * kept-regardless error's message with it, so a cut reads the same wherever it was made.
 */
export function elideAt(text: string, keep: number): string {
  if (text.length <= keep) return text;
  const last = text.charCodeAt(keep - 1);
  const cut = keep - (last >= 0xd800 && last <= 0xdbff ? 1 : 0);
  return `${text.slice(0, cut)} … [${text.length - cut} more characters — see logPath]`;
}

/** One `logTail` line cut to {@link LOG_TAIL_LINE_CAP}; see {@link elideAt}. */
function capLogLine(line: string): string {
  return elideAt(line, LOG_TAIL_LINE_CAP);
}

/**
 * What a string costs once it is a JSON string value, without the two enclosing quotes. JSON
 * escapes character by character, so the cost of a `\n`-joined text is the sum of its pieces' plus
 * 2 per separator — which is what lets {@link fitLines} price a candidate without rendering it.
 */
function jsonCost(s: string): number {
  return JSON.stringify(s).length - 2;
}

/**
 * The fewest characters of the last line {@link fitLines} will cut it to, when even that one line
 * does not fit its budget on its own. 80 is one terminal line — about one TeX wrap — which is the
 * head a reader acts on (which package, what went wrong); a line no longer than this is never
 * cut further. A floor rather than zero because the last line is kept regardless, so it is the one
 * place the lane can overshoot: this bounds by how much (worst case ~80 control characters at six
 * rendered characters each, plus the marker), where the 500-character cap alone let it reach ~3.3k.
 */
export const LOG_TAIL_LAST_LINE_FLOOR = 80;

/**
 * The earliest lines of `lines` dropped until the JSON rendering of what is left — `header(n)` for
 * the `n` lines gone, then the survivors, `\n`-joined — fits `maxChars`, always keeping the last
 * line. `alreadyOmitted` is what an earlier bound (`maxLines`) cut before this one saw the list, so
 * the header counts both. `Infinity` fits everything and returns exactly the legacy rendering.
 *
 * `lines` arrive UNCAPPED and are cut to {@link LOG_TAIL_LINE_CAP} here, so that when the last line
 * alone still does not fit — the cap bounds characters, but a control character renders as a
 * six-character `\u00XX` escape, so a capped line can cost ~3.3k — it can be cut further from the
 * original, with a marker that counts against the original rather than against the capped copy.
 * That further cut never goes below {@link LOG_TAIL_LAST_LINE_FLOOR} and never splits a surrogate
 * pair ({@link elideAt}). It only ever fires on the kept-regardless last line, and only when that
 * line does not fit, so every other result — `Infinity` above all — is byte-identical to before.
 */
function fitLines(
  originals: readonly string[],
  alreadyOmitted: number,
  maxChars: number,
  header: (omitted: number) => string,
): { text: string; trimmed: number } {
  const lines = originals.map(capLogLine);
  const render = (start: number): string => {
    const omitted = alreadyOmitted + start;
    const body = lines.slice(start);
    return (omitted > 0 ? [header(omitted), ...body] : body).join('\n');
  };
  if (maxChars === Infinity) return { text: render(0), trimmed: 0 };
  // Suffix sums of each line's cost plus its `\n` separator, so each candidate is priced in O(1).
  const suffix = new Array<number>(lines.length + 1).fill(0);
  for (let i = lines.length - 1; i >= 0; i--) {
    suffix[i] = (suffix[i + 1] as number) + jsonCost(lines[i] as string) + 2;
  }
  const cost = (start: number): number => {
    const omitted = alreadyOmitted + start;
    // Every kept line carries a separator except the last; a header adds itself plus one.
    const body = (suffix[start] as number) - 2;
    return 2 + body + (omitted > 0 ? jsonCost(header(omitted)) + 2 : 0);
  };
  let start = 0;
  while (start < lines.length - 1 && cost(start) > maxChars) start++;
  const last = lines.length - 1;
  if (last >= 0 && start === last && cost(start) > maxChars) {
    lines[last] = fitLastLine(
      originals[last] as string,
      lines[last] as string,
      // Everything but the line's own content: quotes, the header and its separator.
      maxChars - (cost(start) - jsonCost(lines[last] as string)),
    );
  }
  return { text: render(start), trimmed: start };
}

/**
 * `original` cut (by {@link elideAt}) to the longest keep whose JSON cost fits `room`, searched
 * between {@link LOG_TAIL_LAST_LINE_FLOOR} and the capped line's own keep. The floor is kept whatever
 * it costs; and if cutting to the floor would cost more than `capped` already does (a short line,
 * where the marker outweighs what it saves), `capped` is returned unchanged.
 */
function fitLastLine(original: string, capped: string, room: number): string {
  const lo0 = Math.min(LOG_TAIL_LAST_LINE_FLOOR, original.length);
  const floorCut = elideAt(original, lo0);
  if (jsonCost(floorCut) >= jsonCost(capped)) return capped;
  let lo = lo0;
  // `hi` is the capped line's keep, known not to fit (that is why we are here).
  let hi = Math.min(original.length, LOG_TAIL_LINE_CAP);
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (jsonCost(elideAt(original, mid)) <= room) lo = mid;
    else hi = mid;
  }
  return elideAt(original, lo);
}

const keptLinesHeader = (omitted: number): string =>
  `… (${omitted} earlier diagnostic line(s) omitted — see logPath for the full log)`;

const rawLinesHeader = (omitted: number): string =>
  `… (${omitted} earlier raw log line(s) omitted — see logPath for the full log)`;

/**
 * What `filterLog` returns when every diagnostic line it found was rejected by `keepWarning`. A
 * sentence rather than an empty string, so a caller reading only `logTail` can tell "your filter
 * matched nothing" apart from "this compile said nothing" — which an empty tail would not.
 */
const NOTHING_MATCHED_FILTER =
  '(every diagnostic line in the log was excluded by warningsFilter — some may have been log-only ' +
  'lines that were never structured warnings, so warningsOmitted can read 0 while this line shows; ' +
  'drop the filter, or see logPath, for the rest)';

/**
 * Lines `filterLog` always keeps, never subject to `keepWarning` — checked *before* the warning
 * test below, because a line can be both (a `LaTeX Warning: Label(s) may have changed. Rerun to
 * get cross-references right.` line matches `Warning:` as well as the rerun-hint pattern), and a
 * rerun hint must survive a filter that would otherwise drop its "LaTeX"-rule warning.
 *
 * Accepted cost: a kept line here can outlive the filtered warning it belonged to. A
 * `Package rerunfilecheck Warning: File 'main.out' has changed.` is filterable, but its
 * continuation `(rerunfilecheck)   Rerun to get outlines right.` matches the rerun-hint pattern
 * and stays — a dangling indented fragment with no header. Deliberately not fixed: suppressing it
 * would mean tracking which header each continuation belongs to, and the half that survives is the
 * actionable half. Never drop a line from this list to tidy that up.
 */
const ALWAYS_KEEP_PATTERNS: RegExp[] = [
  /^! /,
  // A `-file-line-error` line, mirroring `parseLog`'s branch order: it tests this first and
  // `continue`s, so such a line is an ERROR there whatever its message says. Without it here, a
  // `./main.tex:12: Package foo Warning: …` (no inline `Error:`) was an error to `parseLog` and a
  // filterable warning to `filterLog` — the one line reporting the failure, dropped from the tail.
  // The anchoring (`^…$`) does NOT keep this from matching a prose line that merely contains
  // `path:12:` — `[^:]*` admits spaces, so `see ./main.tex:12: for details` matches too, with
  // group 1 = "see ./main.tex". That is harmless here, not absent: `parseLog` classifies that same
  // line as an error via this identical regex, so both partitions still agree on it — which is the
  // real invariant this list preserves, not the anchoring.
  FILE_LINE_ERROR,
  /^l\.\d+/,
  /^Runaway /,
  /^(Emergency stop|Fatal error|No pages of output)/,
  BARE_ERROR_LINE,
  /(may have changed|Rerun to get|Please rerun)/,
  // biblatex phrases its rerun hint as `Please (re)run Biber on the file:` — literal parentheses,
  // so `Please rerun` above does not match it. On a biblatex paper it is the only line saying the
  // bibliography is stale. Deliberately `logTail`-only: the structured `warnings[]` entry (rule
  // `biblatex`) is still dropped by an include-filter, exactly as the `Label(s) may have changed`
  // hint's `LaTeX`-rule entry already is — protected in the tail, filterable in `warnings[]`. Do
  // not "fix" that asymmetry here; making `warnings[]` protect rerun hints is new behaviour and
  // would change `warningsOmitted`.
  //
  // Anchored to `Please `, not a bare `/\(re\)run/`: the log is document-controlled (a `.tex` can
  // emit anything via `\PackageWarning`/`\typeout`), so an unanchored substring match let any line
  // containing the literal text "(re)run" pin itself past a caller's filter — an
  // `Overfull \hbox (re)run (12.0pt too wide) in paragraph at lines 4--5` survived every
  // `warningsFilter`, indistinguishable from a real rerun hint. Do not widen this back to a bare
  // `/\(re\)run/` to "simplify" it; match biblatex's actual phrasing instead.
  /Please \(re\)run/,
  /^Output written on /,
];

/**
 * The `l.<n>` context TeX printed for the diagnostic at index `i`, if any.
 *
 * The scan stops at the next diagnostic, because a context line below *that* one belongs to it: a
 * `! Package hyperref Error` printed with no source position would otherwise adopt the `l.3` of the
 * `! Undefined control sequence` beneath it, and be reported — and, once it drove the excerpt,
 * illustrated — at a line that has nothing to do with it.
 */
function nextContext(lines: string[], i: number): { line: number; echo?: string } | undefined {
  for (let j = i + 1; j < Math.min(i + CONTEXT_LOOKAHEAD, lines.length); j++) {
    const line = lines[j] ?? '';
    if (line.startsWith('! ') || FILE_LINE_ERROR.test(line)) return undefined;
    const lm = /^l\.(\d+)(.*)$/.exec(line);
    if (lm && lm[1]) {
      const echo = (lm[2] ?? '').trim();
      return { line: Number(lm[1]), echo: echo || undefined };
    }
  }
  return undefined;
}

/** The echoed source text for a known line number, ignoring a context line for a different line. */
function echoFor(lines: string[], i: number, lineNo: number): string | undefined {
  const context = nextContext(lines, i);
  return context?.line === lineNo ? context.echo : undefined;
}

/** Topmost real (non-`null`) file on the stack — the file currently being read. */
function currentFile(stack: Array<string | null>): string | undefined {
  for (let i = stack.length - 1; i >= 0; i--) {
    const f = stack[i];
    if (f) return f;
  }
  return undefined;
}

/**
 * Update the balanced-paren file stack for one logical line. TeX brackets every file it reads in
 * `(path … )`, nesting them, so the top of the stack is the file currently open. A `(` followed by a
 * filename pushes it; any other `(` pushes a `null` placeholder so its matching `)` pops the
 * placeholder instead of a real file; a `)` pops. Underflow (unbalanced `)`) is ignored.
 */
function scanParens(line: string, stack: Array<string | null>): void {
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '(') {
      let j = i + 1;
      while (j < line.length && !'(){}[]<> '.includes(line[j] as string)) j++;
      const token = line.slice(i + 1, j);
      stack.push(looksLikeFile(token) ? normalizeFile(token) : null);
      i = j - 1;
    } else if (ch === ')') {
      if (stack.length > 0) stack.pop();
    }
  }
}

/**
 * Parse a LaTeX/latexmk log into structured errors and warnings. LaTeX logs are messy, so this is
 * best-effort and deliberately conservative; callers should also surface the filtered log tail.
 * Works best with `-file-line-error`. Each diagnostic is attributed to the source file open when it
 * was emitted, tracked via the log's balanced `(path … )` nesting (`file`), so a warning in an
 * `\input`-ed section maps back to that section rather than the main file. Attribution is omitted
 * when it cannot be determined.
 *
 * `baseDir` is the directory the engine ran in, relative to the project root — `dirname(rootFile)`
 * under latexmk's `-cd`, empty for tectonic. Paths are rebased onto the project root with it, so a
 * `file` this returns is one the caller can open (see {@link rebase}).
 */
export function parseLog(log: string, opts: { baseDir?: string } = {}): ParsedLog {
  const baseDir = opts.baseDir ? normalizeFile(opts.baseDir).replace(/\/+$/, '') : '';
  const lines = unwrapLines(log);
  const errors: ParsedDiagnostic[] = [];
  const warnings: ParsedDiagnostic[] = [];
  const stack: Array<string | null> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    // The file established by prior lines — diagnostics print inside the file already open, before
    // any `(open` on their own line. Capture it, then fold this line's parens into the stack.
    const openFile = currentFile(stack);
    scanParens(line, stack);

    // file-line-error format: "./main.tex:12: Undefined control sequence."
    const fle = FILE_LINE_ERROR.exec(line);
    if (fle && fle[1] && fle[2] && fle[3]) {
      const lineNo = Number(fle[2]);
      errors.push({
        severity: 'error',
        file: rebase(normalizeFile(fle[1]), baseDir),
        line: lineNo,
        message: fle[3].trim(),
        rule: deriveRule(fle[3]),
        // File and line come off this one line, so they describe one place.
        locatedPair: true,
        echo: echoFor(lines, i, lineNo),
      });
      continue;
    }

    // TeX error line: "! Undefined control sequence." possibly followed by "l.12 ..."
    if (line.startsWith('! ')) {
      const message = line.slice(2).trim();
      const context = nextContext(lines, i);
      errors.push({
        severity: 'error',
        file: openFile ? rebase(openFile, baseDir) : undefined,
        message,
        line: context?.line,
        rule: deriveRule(message),
        // The file comes from the paren stack and the line from the `l.<n>` below: two independent
        // sources a stray `)` in log text can pull apart. `echo` is the only evidence they agree,
        // so the snippet layer requires it here. Tectonic takes this branch for every diagnostic,
        // since it has no -file-line-error.
        echo: context?.echo,
      });
      continue;
    }

    // Warnings from LaTeX, a package, or a class.
    const warn = PACKAGE_WARNING.exec(line);
    if (warn && warn[3]) {
      const message = warn[3].trim();
      const onLine =
        /on input line (\d+)/.exec(message) ?? /on input line (\d+)/.exec(lines[i + 1] ?? '');
      warnings.push({
        severity: 'warning',
        file: openFile ? rebase(openFile, baseDir) : undefined,
        message,
        line: onLine && onLine[1] ? Number(onLine[1]) : undefined,
        rule: warn[1] ?? warn[2] ?? 'LaTeX',
      });
      continue;
    }

    // Overfull/Underfull boxes.
    const box = BOX_WARNING.exec(line);
    if (box) {
      const lm = /at lines? (\d+)/.exec(line);
      warnings.push({
        severity: 'warning',
        file: openFile ? rebase(openFile, baseDir) : undefined,
        message: line.trim(),
        line: lm && lm[1] ? Number(lm[1]) : undefined,
        rule: `${box[1]} \\${box[2]}box`,
      });
    }
  }

  return { errors: collapseShellEscapeErrors(dedupe(errors)), warnings: dedupe(warnings) };
}

/**
 * Lines worth keeping from a compile log: real errors and their `l.<n>` position context, warnings
 * (boxes, undefined refs/citations, font substitutions, "rerun" hints), and the final "Output
 * written on …" summary. Everything else — the memory-usage block, the trailing font `.pfb`/`.enc`
 * path dump, PDF-object statistics, and the reams of `LaTeX Font Info` chatter — is dropped.
 */
const KEEP_PATTERNS: RegExp[] = [
  /^! /, // TeX error
  /^l\.\d+/, // error position/context ("l.12 …")
  /^Runaway /, // runaway-argument error context
  /^(Emergency stop|Fatal error|No pages of output)/,
  /Warning:/, // LaTeX / package / class / font warnings, incl. "Label(s) may have changed"
  /pdfTeX warning/,
  /Error:/, // LaTeX / package errors printed inline (no leading "! ")
  // The `-file-line-error` form latexmk asks for: `./main.tex:5: Undefined control sequence.` — no
  // leading `! `, no inline `Error:`, so nothing above matched it and the de-noiser kept only the
  // `l.<n>` echo below it. The tail said *where* the compile failed and never *what* failed, which
  // is the whole message. (`parseLog` was always right about these — it tests this same regex first
  // — so the gap hit only a client reading `logTail`.) Filter-exempt for free: the same regex sits
  // in {@link ALWAYS_KEEP_PATTERNS}, mirroring `parseLog`'s branch order, so the two partitions
  // stay aligned rather than this becoming a kept line a warning filter could take away.
  FILE_LINE_ERROR,
  /^(Overfull|Underfull) \\[hv]box/,
  /(may have changed|Rerun to get|Please rerun)/, // cross-reference rerun hints
  /^Output written on /, // the "(N pages, … bytes)" summary
];

/**
 * Distil a raw compile log down to only diagnostically useful lines (see {@link KEEP_PATTERNS}),
 * scanning the whole log (not just its tail, so an error early in a long log is not lost) after
 * un-wrapping TeX's 79-column hard-wrapping. Bounds the result to `maxLines` (keeping the most
 * recent, where a fatal error and the output summary sit) and notes any omission, and cuts every
 * line — kept or fallback — to {@link LOG_TAIL_LINE_CAP} characters, since an un-wrapped line has no
 * length limit of its own. Falls back to a short raw tail if nothing matched, so the caller always
 * sees something. The full log stays on disk at `logPath`; `compile`'s `rawLog: true` returns the
 * unfiltered tail. A character bound on the whole result is {@link fitFilteredLog}'s `maxChars`.
 *
 * `keepWarning`, when given, additionally drops a *warning* line (an `Overfull \hbox`/
 * `Underfull \vbox`, or anything else kept only via a `Warning:`/`pdfTeX warning` match — see
 * {@link isWarningLine}) the predicate rejects, so `compile`'s `warningsFilter` trims `logTail` in
 * lockstep with `warnings[]` instead of the same lines shipping twice. Applied *before* the
 * `maxLines` cap, so filtering frees room in the tail rather than being crowded out by lines the
 * cap would have kept anyway. Every other kept line — errors, their `l.<n>` context, rerun hints,
 * the `Output written on ` summary — is never filtered (see {@link ALWAYS_KEEP_PATTERNS}).
 *
 * **Critical: with `keepWarning` absent, the output is byte-identical to calling this with no
 * options at all** — pinned by a test — and the paren-stack bookkeeping `keepWarning` needs is
 * skipped entirely. Only the first half is observable, so only the first half is tested; keep the
 * bookkeeping behind its `if` anyway, since this runs on every compile of every session. `baseDir` rebases a filtered warning's `file` onto the project root exactly as
 * `parseLog` does (see {@link rebase}); it is ignored when `keepWarning` is absent.
 */
export function filterLog(log: string, opts: FilterLogOptions = {}): string {
  return fitFilteredLog(log, { ...opts, maxChars: Infinity }).text;
}

export interface FilterLogOptions {
  maxLines?: number;
  baseDir?: string;
  keepWarning?: (w: { file?: string; rule?: string }) => boolean;
}

/** {@link fitFilteredLog}'s result: the tail, and how many lines `maxChars` alone cut from it. */
export interface FittedLogTail {
  text: string;
  /**
   * Lines dropped from the front to fit `maxChars` — on top of, and counted apart from, what
   * `maxLines` dropped. The tail's own header line counts both; this is how a caller can say which
   * bound fired.
   */
  trimmed: number;
}

/**
 * {@link filterLog}, additionally fitted to `maxChars` measured on the JSON-rendered result — the
 * form it ships in inside `structuredContent` — by dropping the EARLIEST lines (the tail keeps the
 * most recent, where a fatal error and the output summary sit, exactly as `maxLines` does) and
 * folding the count into the same "earlier diagnostic line(s) omitted" header. At least the last
 * line is always kept, and that line is bounded by {@link LOG_TAIL_LINE_CAP}; the one-sentence
 * "filter matched nothing" result is short and fixed, and is returned as is.
 *
 * `maxChars: Infinity` is `filterLog` exactly — which is how `filterLog` is implemented, so the two
 * cannot drift and the byte-identity guarantee above holds for both.
 */
export function fitFilteredLog(
  log: string,
  opts: FilterLogOptions & { maxChars: number },
): FittedLogTail {
  const maxChars = opts.maxChars;
  const maxLines = opts.maxLines ?? 80;
  const keepWarning = opts.keepWarning;
  const baseDir =
    keepWarning && opts.baseDir ? normalizeFile(opts.baseDir).replace(/\/+$/, '') : '';
  const stack: Array<string | null> = [];
  const kept: string[] = [];
  // Counted separately from `kept` so the "nothing matched" fallback below can tell apart a log
  // with no diagnostics in it from one whose diagnostics the *filter* removed. They need opposite
  // answers, and conflating them inverts the feature: see the fallback's own comment.
  let matchedBeforeFilter = 0;
  for (const raw of unwrapLines(log)) {
    const line = raw.replace(/\s+$/, '');
    // Only maintained when needed: a caller with no `keepWarning` must see byte-identical output,
    // which this bookkeeping (allocations, `scanParens`' inner loop) must not perturb by running
    // at all — not merely by not changing the result.
    const openFile = keepWarning ? currentFile(stack) : undefined;
    if (keepWarning) scanParens(line, stack);

    if (!KEEP_PATTERNS.some((re) => re.test(line))) continue;
    matchedBeforeFilter++;

    if (keepWarning && !ALWAYS_KEEP_PATTERNS.some((re) => re.test(line)) && isWarningLine(line)) {
      const { rule } = warningRuleOf(line);
      const file = openFile ? rebase(openFile, baseDir) : undefined;
      if (!keepWarning({ file, rule })) continue;
    }
    // Kept whole and capped only later, by `fitLines`: every pattern above judged the whole line,
    // so a cut can never change which side of the error/warning partition a line lands on — and
    // `fitLines` needs the original to cut the last line further than the cap when it must.
    kept.push(line);
  }
  if (kept.length === 0) {
    // The raw-tail fallback exists for a log with nothing diagnostic in it, so the caller is never
    // handed an empty string. It must NOT fire when a filter is what emptied the list: the raw
    // tail is the unfiltered, un-de-noised log, so a filter that rejected every warning would hand
    // back the very lines it was asked to drop — plus the font/`.pfb`/PDF-statistics noise
    // `filterLog` exists to strip. That is the feature inverted, and silently, which is why the
    // two cases are told apart by `matchedBeforeFilter` rather than by `kept` alone.
    if (matchedBeforeFilter > 0) return { text: NOTHING_MATCHED_FILTER, trimmed: 0 };
    // Physical lines, but not therefore short: a log written with a large `max_print_line` has no
    // wrap at all. `logTail` joins with `\n`, so this split recovers its lines exactly.
    const raw = logTail(log, 15).split('\n');
    return fitLines(raw, 0, maxChars, rawLinesHeader);
  }
  // Written as the legacy `maxLines` branch was, `slice(-maxLines)` quirks included.
  const overCap = kept.length > maxLines;
  const shown = overCap ? kept.slice(-maxLines) : kept;
  return fitLines(shown, overCap ? kept.length - maxLines : 0, maxChars, keptLinesHeader);
}

function dedupe(items: ParsedDiagnostic[]): ParsedDiagnostic[] {
  const seen = new Set<string>();
  const out: ParsedDiagnostic[] = [];
  for (const item of items) {
    const key = `${item.severity}|${item.file ?? ''}|${item.line ?? ''}|${item.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}
