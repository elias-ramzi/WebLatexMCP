import path from 'node:path';

/**
 * Whether a path points at a BibTeX bibliography file.
 *
 * Judged twice, and a match on either counts, so this can only ever widen what is guarded:
 *
 *  - on the literal name, as before — on POSIX `refs.tex:x.bib` is a real file with a `.bib`
 *    extension;
 *  - on the name **Windows** would open. Win32 path normalisation strips trailing dots and spaces
 *    from the final component, and `name:stream[:$DATA]` addresses an alternate data stream of
 *    `name`, so `refs.bib.`, `refs.bib ` and `refs.bib::$DATA` all write `refs.bib` there — while
 *    `extname` reads `.bib.`, `.bib ` and `.bib::$DATA`, and `write_file` skipped `confirmBibEdit`.
 *    The final component is cut at its first `:` and then stripped of trailing dots and spaces.
 *    Only the final component: a drive letter (`C:/…`) or a colon in a directory name is not a
 *    stream suffix of the file.
 *
 * This runs on every platform. On POSIX the second reading calls a file literally named
 * `refs.bib.` a bibliography, which costs one confirmation — the fail-safe direction.
 */
export function isBibFile(relPath: string): boolean {
  if (path.extname(relPath).toLowerCase() === '.bib') return true;
  const base = relPath.slice(Math.max(relPath.lastIndexOf('/'), relPath.lastIndexOf('\\')) + 1);
  const colon = base.indexOf(':');
  const windowsName = (colon === -1 ? base : base.slice(0, colon)).replace(/[. ]+$/, '');
  return path.extname(windowsName).toLowerCase() === '.bib';
}

// BibTeX entry header, e.g. `@inproceedings{he2016deep,`. Non-citation directives
// (@string / @comment / @preamble) carry no cite key and are excluded below.
const ENTRY_RE = /@(\w+)\s*\{\s*([^,\s}]+)\s*,/g;
const NON_ENTRY_TYPES = new Set(['string', 'comment', 'preamble']);

/** Citation keys declared by the entries in a BibTeX string, in document order. */
export function extractEntryKeys(bibtex: string): string[] {
  const keys: string[] = [];
  for (const m of bibtex.matchAll(ENTRY_RE)) {
    const type = m[1]?.toLowerCase();
    const key = m[2];
    if (!type || !key || NON_ENTRY_TYPES.has(type)) continue;
    keys.push(key);
  }
  return keys;
}

export interface BibMergeResult {
  /** Full bibliography content after the merge. */
  content: string;
  /** Primary cite key of the merged entry. */
  key: string;
  /** True when the entry's key already existed and nothing was appended. */
  alreadyPresent: boolean;
}

/**
 * Append a fetched BibTeX entry to an existing bibliography, skipping it when its
 * primary cite key is already present. Pure: callers read/write the file. The entry
 * is appended verbatim (separated by a blank line) so its provenance is preserved.
 */
export function mergeBibEntry(existing: string, entry: string): BibMergeResult {
  const entryKeys = extractEntryKeys(entry);
  const key = entryKeys[0];
  if (!key) {
    throw new Error('The fetched BibTeX contains no entry with a citation key.');
  }
  const present = new Set(extractEntryKeys(existing));
  if (present.has(key)) {
    return { content: existing, key, alreadyPresent: true };
  }
  const trimmedEntry = entry.trim();
  const base = existing.trim().length === 0 ? '' : `${existing.replace(/\s*$/, '')}\n\n`;
  return { content: `${base}${trimmedEntry}\n`, key, alreadyPresent: false };
}

/**
 * Why direct .bib mutation is refused, and the two sanctioned ways forward. Returned
 * from write/edit/delete when the target is a .bib file and `confirmBibEdit` is unset.
 *
 * `target`, when given, means `relPath` is not itself named `.bib` — it is a symlink (possibly
 * through a linked directory) that lands on one, per `FileService.linkTarget`. The opening
 * sentence then names both: the path the caller gave, and the .bib it actually resolves to,
 * so the refusal is not mistaken for a false positive on a `.png`-named path.
 */
export function bibEditBlockedMessage(relPath: string, target?: string): string {
  const subject =
    target === undefined
      ? `"${relPath}" is a .bib bibliography file and is protected from direct changes.`
      : `"${relPath}" is a link to "${target}", a .bib bibliography file, and is protected from direct changes.`;
  return (
    `${subject} ` +
    'To add a reference, use search_references then add_citation, which fetch verified ' +
    'BibTeX from DBLP, Crossref or OpenAlex. To change the .bib another way (e.g. remove or fix ' +
    'an entry), ' +
    'first ask the user to approve the change, then retry with confirmBibEdit: true.'
  );
}
