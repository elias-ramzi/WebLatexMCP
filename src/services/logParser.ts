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

/** Return the last `n` lines of a log verbatim, for the raw escape hatch. */
export function logTail(log: string, n = 60): string {
  const lines = log.split('\n');
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

/** `-file-line-error` form: "./main.tex:12: Undefined control sequence." */
const FILE_LINE_ERROR = /^(?:\.\/)?([^:\s][^:]*\.\w+):(\d+): (.+)$/;

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
    if (j > i + 1 && (line.startsWith('! ') || FILE_LINE_ERROR.test(line))) return undefined;
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
    const warn = /(?:LaTeX|Package (\w+)|Class (\w+)) Warning: (.+)/.exec(line);
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
    const box = /^(Overfull|Underfull) \\([hv])box/.exec(line);
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
  /^(Overfull|Underfull) \\[hv]box/,
  /(may have changed|Rerun to get|Please rerun)/, // cross-reference rerun hints
  /^Output written on /, // the "(N pages, … bytes)" summary
];

/**
 * Distil a raw compile log down to only diagnostically useful lines (see {@link KEEP_PATTERNS}),
 * scanning the whole log (not just its tail, so an error early in a long log is not lost) after
 * un-wrapping TeX's 79-column hard-wrapping. Bounds the result to `maxLines` (keeping the most
 * recent, where a fatal error and the output summary sit) and notes any omission. Falls back to a
 * short raw tail if nothing matched, so the caller always sees something. The full log stays on disk
 * at `logPath`; `compile`'s `rawLog: true` returns the unfiltered tail.
 */
export function filterLog(log: string, opts: { maxLines?: number } = {}): string {
  const maxLines = opts.maxLines ?? 80;
  const kept = unwrapLines(log)
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => KEEP_PATTERNS.some((re) => re.test(l)));
  if (kept.length === 0) return logTail(log, 15);
  if (kept.length > maxLines) {
    const omitted = kept.length - maxLines;
    return [
      `… (${omitted} earlier diagnostic line(s) omitted — see logPath for the full log)`,
      ...kept.slice(-maxLines),
    ].join('\n');
  }
  return kept.join('\n');
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
