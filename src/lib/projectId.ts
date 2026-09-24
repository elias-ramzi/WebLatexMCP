import path from 'node:path';
import type { SkippedProject } from '../types.js';

/**
 * What a project id may look like — the one rule, applied wherever an id enters the server:
 * `register_project`/`project_sync` input (via `ProjectManager.registerProject`), the persisted
 * registry (`readProjectRegistry`), and `WEB_LATEX_MCP_PROJECTS` (`loadConfig`).
 *
 * An id becomes a directory name twice over — the clone at `<workspace>/<id>` and the session
 * state at `<workspace>/.sessions/<id>/` — and `path.join` resolves `..` and separators rather than
 * refusing them. Before 0.7, `../../home/u/evil` cloned outside the workspace, and a local project
 * `../paper` put its lock and session dir inside git project `paper`'s clone, where a
 * `commit scope: "all"` would stage them.
 *
 * The rule refuses what is UNSAFE as one directory entry and nothing else, because every id it
 * refuses strands a user whose configuration already used it (the entry is skipped, and the
 * project disappears until renamed). So Unicode letters and digits, spaces and ordinary
 * punctuation are all fine — `thèse`, `My Thesis`, `paper+notes`, `論文` — and what is refused is:
 *
 * - a path separator (`/`, `\`) or any other character a Windows file name cannot hold
 *   (`: < > " | ? *`) — `:` is also a drive (`C:x`) or an NTFS stream, and `<`/`>` keep an id from
 *   ever closing the viewer page's `<script>` it is embedded in as a JSON string;
 * - a control character (C0, DEL, C1), a bidirectional-override character (an id displayed in
 *   an error must read as what it is), or a lone surrogate (which UTF-8 cannot encode, so the
 *   directory would be named something else);
 * - an invisible character: any format character (`\p{Cf}`: zero-width space, word joiner, soft
 *   hyphen, tag characters, …) or default-ignorable code point (Hangul filler, variation
 *   selectors, the combining grapheme joiner, …). Two ids differing only in one look identical
 *   in every listing and message, so one could stand in for the other. The one exception is a
 *   zero-width non-joiner or joiner (U+200C/U+200D) BETWEEN two letters or marks of a script
 *   whose spelling uses them (Arabic-script languages such as Persian, where ZWNJ is ordinary
 *   orthography, and the Brahmic scripts, where it selects a conjunct form) — there it changes
 *   what the word looks like, so it is not invisible, and refusing it would refuse the correct
 *   spelling of the word. Between Latin letters, at an edge, or inside an emoji sequence it is
 *   refused. The exception is deliberately narrow, and a few correct spellings fall outside it
 *   (see `JOINER_SCRIPT` for the list and why each stays refused);
 * - a space that is not U+0020 (`\p{Zs}`: no-break space, the en/em/thin/hair spaces, the
 *   ideographic space, …) — `My Thesis` and `My<NBSP>Thesis` look identical — and a line or
 *   paragraph separator (U+2028/U+2029), which breaks the line an id is shown on;
 * - a combining mark in first place, which draws itself onto whatever precedes the id in a
 *   message (a quote, a space);
 * - a backtick, which would break every Markdown code span the id is shown in (skill prompts);
 * - `__proto__`, `constructor` or `prototype` — an id keys plain objects on its way to and from
 *   `registry.json`, where `map["__proto__"] = entry` sets the prototype instead of adding an
 *   entry (the readers and writers use null-prototype objects too; this is the second fence);
 * - an id that is not NFC-normalised. It is refused, never silently normalised: macOS hands back
 *   NFD from some input paths and Linux keeps whatever bytes it is given, so normalising here
 *   would make one configured key name two different directories on two machines. Refusing names
 *   the NFC form to use, and the key stays exactly what the user wrote;
 * - `.`/`..` or any leading `.` (a hidden name, like `.sessions` itself), or a leading `-` that git
 *   or a shell could read as an option;
 * - leading or trailing whitespace, or a trailing `.` — Windows drops trailing dots and spaces, so
 *   `paper.` IS `paper` there, and edge whitespace is invisible in every message that quotes it;
 * - a Windows device name (`con`, `nul`, `com1`, `lpt¹`, `conin$`, … with or without an
 *   extension), refused on every platform so a configuration stays portable between them;
 * - a name the workspace root already holds beside the clones: `registry.json` and its lock/temp
 *   files (`registry.json.*`), `.sessions` (a leading dot), or any `<name>.pdf` — `compile`
 *   surfaces project `<name>`'s PDF at exactly that path (`src/lib/pdfSurface.ts`);
 * - a `~` followed by a digit — the shape of a Windows 8.3 short name (`PAPER-~1`, `SESSIO~1`,
 *   `REGIST~1.JSO`), which NTFS resolves to whatever long name it abbreviates: another project's
 *   clone, `.sessions`, or `registry.json`;
 * - more than `MAX_PROJECT_ID_LENGTH` characters or `MAX_PROJECT_ID_BYTES` UTF-8 bytes (below).
 *
 * Device and reserved names are judged on `projectIdFold(id)`, not on `toLowerCase()`: a
 * case-insensitive disk folds more than ASCII — `ſ` (long s) is `s` to APFS, NTFS upper-cases
 * `ı` (dotless i) to `I` — so `regiſtry.json` IS `registry.json` there.
 *
 * What is not judged here, because it depends on the OTHER ids: two ids whose folds are equal
 * name one directory on a case-insensitive disk (macOS, Windows) under two locks.
 * `ProjectManager.registerProject` refuses a new id whose fold equals a known id's, on every
 * platform, so a configuration stays portable.
 */

/**
 * Longest id accepted, in characters (Unicode code points) — the unit a person counts in, and the
 * bound the ASCII-only rule had, so every id valid before is valid still. It also bounds the id's
 * UTF-16 length (Windows' unit) at 128.
 */
export const MAX_PROJECT_ID_LENGTH = 64;

/**
 * Longest id accepted, in UTF-8 bytes. File-name limits are 255 bytes (ext4, APFS), and the
 * names the server builds from an id are `<id>` (the clone, and `.sessions/<id>/`), `<id>.pdf`
 * (`src/lib/pdfSurface.ts`, 4 bytes more) and the build dir `<id>-<8 hex>`
 * (`buildDir` in `src/services/compiler.ts`, 9 bytes more) — the longest — so 255 − 9 = 246.
 * Every other name (the lock, the session files) sits INSIDE `.sessions/<id>/`, where the id is
 * a directory, not part of the name. Sixty-four characters are at most 256 bytes, so this only
 * ever binds on 62+ four-byte characters (emoji, rare CJK); a code-point bound alone would let
 * those through to fail at compile time. A new name built from an id must fit under this too —
 * `test/unit/projectIdRound3.test.ts` builds each one from the longest accepted id.
 */
export const MAX_PROJECT_ID_BYTES = 246;

/** Characters no Windows file name may contain, plus both separators. */
const FORBIDDEN_CHARS = /[/\\:<>"|?*]/u;

/**
 * Format characters and default-ignorable code points — everything that renders as nothing.
 * Judged per character by `invisibleCharProblem`, which lets the joiners through in context.
 */
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/u;

/** Zero-width non-joiner and zero-width joiner. */
const JOINERS = new Set([0x200c, 0x200d]);

/**
 * The scripts whose spelling uses ZWNJ/ZWJ between letters: the cursive joining scripts
 * (Arabic, Syriac, N'Ko, Mongolian) and the Brahmic scripts of South Asia. Judged on the
 * neighbours' Script_Extensions, so a mark shared across several of them (a virama, a
 * nukta) counts for each.
 *
 * Known gaps — correct spellings this still refuses, each left refused because accepting it is
 * not trivially safe, and an id can always be spelled without it:
 *
 * - an old-style Malayalam chillu, `<consonant> U+0D4D U+200D` at the END of a word. The joiner
 *   has no letter after it, so the in-word test fails; accepting a trailing joiner would need a
 *   per-script rule for what follows. Since Unicode 5.1 the chillus are atomic letters
 *   (U+0D7A–U+0D7F), which are accepted.
 * - Myanmar and Khmer, which use ZWJ/ZWNJ occasionally (Myanmar kinzi and medial forms, Khmer
 *   coeng display) but not as ordinary orthography; not listed.
 * - the Mongolian free variation selectors (U+180B–U+180D, U+180F): variation selectors are
 *   default-ignorable, and whether one changes the glyph depends on the font.
 * - the Arabic prepended concatenation marks U+0600–U+0605 (number sign, year sign, …): format
 *   characters that render only with the digits after them, and only in fonts that support them.
 */
const JOINER_SCRIPT =
  /^[\p{scx=Arabic}\p{scx=Syriac}\p{scx=Nko}\p{scx=Mongolian}\p{scx=Devanagari}\p{scx=Bengali}\p{scx=Gurmukhi}\p{scx=Gujarati}\p{scx=Oriya}\p{scx=Tamil}\p{scx=Telugu}\p{scx=Kannada}\p{scx=Malayalam}\p{scx=Sinhala}]$/u;

/** A letter or a combining mark. */
const LETTER_OR_MARK = /^[\p{L}\p{M}]$/u;

/** Ids that are names of `Object.prototype` members or of its prototype setter. */
const OBJECT_PROTOTYPE_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

/** `~` then a digit: a Windows 8.3 short name's tail. */
const SHORT_NAME_TAIL = /~[0-9]/u;

/** Every space character except U+0020 — each one looks like an ordinary space, or like nothing. */
const NON_ASCII_SPACE = /[^\P{Zs} ]/u;

/** Line and paragraph separators (U+2028, U+2029). */
const LINE_OR_PARAGRAPH_SEPARATOR = /[\p{Zl}\p{Zp}]/u;

/** A combining mark (`\p{M}`) in first place. */
const LEADING_MARK = /^\p{M}/u;

/** C0, DEL and C1 controls (`\p{Cc}`), and lone surrogates (`\p{Cs}` matches only unpaired ones). */
const CONTROL_OR_LONE_SURROGATE = /[\p{Cc}\p{Cs}]/u;

/** Bidirectional embedding/override/isolate controls and the directional marks. */
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

/**
 * Windows device names, judged on the part before the first `.` with trailing spaces dropped
 * (Windows treats `NUL.txt`, `nul.tar.gz` and `CON .txt` as the device). The superscript digits
 * are devices too (`COM¹`), and `CONIN$`/`CONOUT$` are the console.
 */
const WINDOWS_DEVICE_NAMES =
  /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]|conin\$|conout\$)$/iu;

/**
 * The first invisible character in `id` that is not a joiner in its script's context (see
 * `INVISIBLE`, `JOINER_SCRIPT`), described, or `undefined` when there is none.
 */
function invisibleCharProblem(id: string): string | undefined {
  const chars = [...id];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if (!INVISIBLE.test(ch)) continue;
    const code = ch.codePointAt(0)!;
    if (isJoinerInWord(chars, i)) continue;
    return (
      `it contains an invisible character (${codePointName(code)}), so it would look ` +
      'identical to an id without it'
    );
  }
  return undefined;
}

/**
 * Whether `chars[i]` is a ZWNJ/ZWJ between two letters or marks of a script whose spelling uses
 * it — where it changes how the word is drawn, so it is not invisible. The id rule accepts
 * exactly these, and `escapeInvisibleChars` shows exactly these as themselves. Together with the
 * rule refusing everything else `escapeInvisibleChars` rewrites (controls, format characters,
 * default-ignorables, U+2028/U+2029, a leading combining mark, and — through the forbidden
 * characters — `\` and `"`), that makes an id the rule accepts displayed verbatim by `quoteId`,
 * so it can be copied back out of a message. `test/unit/projectIdRound4.test.ts` checks this for
 * every code point.
 */
function isJoinerInWord(chars: readonly string[], i: number): boolean {
  if (!JOINERS.has(chars[i]!.codePointAt(0)!)) return false;
  const inWord = (c: string | undefined): boolean =>
    c !== undefined && LETTER_OR_MARK.test(c) && JOINER_SCRIPT.test(c);
  return inWord(chars[i - 1]) && inWord(chars[i + 1]);
}

/** `U+200B`-style name of a code point. */
function codePointName(code: number): string {
  return `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * The key two ids share when a case-insensitive disk would give them one directory — a
 * deliberately generous fold (full upper-then-lower mapping in NFC), so it equates at least what
 * APFS and NTFS equate: `ſ` → `s`, `ı` → `i`, `K` (Kelvin) → `k`, `É` → `é`. It over-equates in
 * places (`ß` → `ss`), which only ever refuses a second id that a disk might have kept apart —
 * the safe direction for a refusal whose job is portability.
 */
export function projectIdFold(id: string): string {
  return id.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC');
}

/** Why `id` is not a usable project id, or `undefined` when it is. */
export function projectIdProblem(id: string): string | undefined {
  if (id.length === 0) return 'it is empty';
  if (CONTROL_OR_LONE_SURROGATE.test(id)) {
    return 'it contains a control character or an unpaired surrogate';
  }
  if (BIDI_CONTROLS.test(id)) return 'it contains a bidirectional-text control character';
  if (LINE_OR_PARAGRAPH_SEPARATOR.test(id)) {
    return 'it contains a line or paragraph separator (U+2028/U+2029)';
  }
  const invisible = invisibleCharProblem(id);
  if (invisible !== undefined) return invisible;
  const space = NON_ASCII_SPACE.exec(id);
  if (space !== null) {
    return (
      `it contains a space character other than an ordinary space ` +
      `(${codePointName(space[0].codePointAt(0)!)}), so it would look identical to an id with ` +
      'a plain space, or without one'
    );
  }
  if (LEADING_MARK.test(id)) {
    return 'it starts with a combining mark, which would draw itself onto what precedes the id';
  }
  if (FORBIDDEN_CHARS.test(id)) {
    return (
      'it contains a path separator or a character no Windows file name may hold ' +
      '(/ \\ : < > " | ? *)'
    );
  }
  if (id.includes('`')) return 'it contains a backtick, which breaks a code span showing it';
  if (OBJECT_PROTOTYPE_NAMES.has(id)) {
    return 'it is the name of a JavaScript object-prototype member, which cannot key a registry';
  }
  const nfc = id.normalize('NFC');
  if (nfc !== id) {
    return (
      `it is not NFC-normalised (the same text in NFC is ${quoteId(nfc)}); the id is not ` +
      'normalised for you, because the directory it names must be the same on every system'
    );
  }
  if (id.startsWith('.')) return 'it starts with "." (".", "..", or a hidden name)';
  if (id.startsWith('-')) return 'it starts with "-", which git or a shell could read as an option';
  if (/^\s|\s$/u.test(id)) {
    return 'it starts or ends with whitespace (Windows drops a trailing space, and it is invisible)';
  }
  if (id.endsWith('.')) return 'it ends in "." (Windows would drop the dot)';
  const chars = [...id].length;
  if (chars > MAX_PROJECT_ID_LENGTH) {
    return `it is longer than ${MAX_PROJECT_ID_LENGTH} characters`;
  }
  if (Buffer.byteLength(id, 'utf8') > MAX_PROJECT_ID_BYTES) {
    return `it is longer than ${MAX_PROJECT_ID_BYTES} bytes in UTF-8`;
  }
  if (SHORT_NAME_TAIL.test(id)) {
    return (
      'it contains "~" followed by a digit, the shape of a Windows 8.3 short name, which can ' +
      'name another project’s directory or the workspace’s own files there'
    );
  }
  // On the fold, not `toLowerCase()`: a case-insensitive disk equates more than ASCII case.
  const folded = projectIdFold(id);
  if (WINDOWS_DEVICE_NAMES.test(folded.split('.')[0]!.trimEnd())) {
    return 'it is a reserved device name on Windows';
  }
  if (folded === 'registry.json' || folded.startsWith('registry.json.')) {
    return 'it names the workspace registry file';
  }
  if (folded.endsWith('.pdf')) {
    return 'it ends in ".pdf", which is where compile surfaces another project’s PDF';
  }
  return undefined;
}

/**
 * Characters `escapeInvisibleChars` writes as `\u{…}`: controls, unpaired surrogates, format
 * characters (every bidirectional control is one), line/paragraph separators and
 * default-ignorables — what would otherwise forge a line, reorder the text around it, or vanish
 * from a message.
 */
const ESCAPE_IN_MESSAGE = /[\p{Cc}\p{Cs}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;

/**
 * `text` with every character in `ESCAPE_IN_MESSAGE` — except a joiner inside a word of a
 * script that uses it (`isJoinerInWord`), which is visible there and which a valid id may hold —
 * plus a combining mark in first place, which would otherwise draw itself onto whatever precedes
 * it, written as `\u{XXXX}`; and `\` doubled, so a literal `\u{A}` in the text stays
 * distinguishable from an escaped newline. For a name shown where quotes would be wrong (a
 * Markdown code span); everywhere else, `quoteId`.
 */
export function escapeInvisibleChars(text: string): string {
  const chars = [...text];
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if (ch === '\\') out += '\\\\';
    else if (
      (ESCAPE_IN_MESSAGE.test(ch) && !isJoinerInWord(chars, i)) ||
      (i === 0 && /^\p{M}$/u.test(ch))
    ) {
      out += `\\u{${ch.codePointAt(0)!.toString(16).toUpperCase()}}`;
    } else out += ch;
  }
  return out;
}

/**
 * An id (or any caller- or configuration-supplied name) as it is shown in a message: in double
 * quotes, `"` backslash-escaped, the rest as `escapeInvisibleChars` writes it. `JSON.stringify`
 * is not enough: it escapes C0 controls only, so a bidirectional override or a zero-width space
 * went through to the reader as itself, and a newline in a key forged a stderr line where the
 * id was interpolated bare. One function, so every message agrees on what an id looks like.
 */
export function quoteId(id: string): string {
  return `"${escapeInvisibleChars(id).replaceAll('"', '\\"')}"`;
}

/** Ids as a message lists them: each quoted (`quoteId`), comma-separated, or `(none)`. */
export function listIds(ids: readonly string[]): string {
  return ids.length === 0 ? '(none)' : ids.map(quoteId).join(', ');
}

/** Whether `id` is a usable project id. */
export function isValidProjectId(id: string): boolean {
  return projectIdProblem(id) === undefined;
}

/** Throw a readable error naming `id` and what is wrong with it, or return it unchanged. */
export function assertValidProjectId(id: string): string {
  const problem = projectIdProblem(id);
  if (problem !== undefined) {
    throw new Error(
      `Invalid project id ${quoteId(id)}: ${problem}. A project id names a directory, so ` +
        'use something like "paper" or "thesis-2026".',
    );
  }
  return id;
}

/**
 * The one sentence describing a skipped project — written to stderr when it is skipped and
 * repeated in the error a call naming it gets, so the fix reaches an MCP client that never sees
 * stderr. For an unusable id the fix is a rename, and a rename alone would orphan the project's
 * clone and session state, which live under directories named after the OLD id: say to move both.
 */
export function describeSkippedProject(skipped: SkippedProject, workspaceRoot: string): string {
  const id = quoteId(skipped.id);
  if (skipped.kind === 'entry') {
    return (
      `The entry ${id} in ${skipped.source} was skipped: it is not a valid project ` +
      `configuration (${skipped.problem}). Fix or remove that entry to use it.`
    );
  }
  return (
    `The entry ${id} in ${skipped.source} was skipped: invalid project id (${skipped.problem}). ` +
    'To use it, rename the key to a valid id — and, if the project was used before, move ' +
    `${id} (its clone, for a git project) and ${quoteId(`.sessions/${skipped.id}/`)} (its ` +
    'session state) ' +
    `under ${workspaceRoot} to the new name.`
  );
}

/**
 * The skipped entry a caller's `id` refers to, if any. Compared in NFC as well as exactly, so a
 * key refused for being decomposed (typed on macOS) is still found when the caller types it
 * composed — the case where the reason matters most, since the two look identical.
 */
export function findSkippedProject(
  skipped: readonly SkippedProject[],
  id: string,
): SkippedProject | undefined {
  const nfc = id.normalize('NFC');
  return skipped.find((s) => s.id === id) ?? skipped.find((s) => s.id.normalize('NFC') === nfc);
}

/**
 * `path.join(parent, name)`, refusing any `name` that does not land as a direct child of
 * `parent` — the defence in depth behind `assertValidProjectId` for every path built from an id
 * (`ProjectManager.projectPath`, `sessionPaths`). `what` names the component in the error.
 */
export function childPathInside(parent: string, name: string, what: string): string {
  const joined = path.join(parent, name);
  if (
    name.length === 0 ||
    path.dirname(path.resolve(joined)) !== path.resolve(parent) ||
    path.basename(joined) !== name
  ) {
    throw new Error(
      `Refusing ${what} ${quoteId(name)}: it does not name a single directory entry ` +
        `inside ${parent}.`,
    );
  }
  return joined;
}
