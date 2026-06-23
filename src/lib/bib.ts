import path from 'node:path';

/** Whether a path points at a BibTeX bibliography file. */
export function isBibFile(relPath: string): boolean {
  return path.extname(relPath).toLowerCase() === '.bib';
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
 */
export function bibEditBlockedMessage(relPath: string): string {
  return (
    `"${relPath}" is a .bib bibliography file and is protected from direct changes. ` +
    'To add a reference, use search_references then add_citation, which fetch verified ' +
    'BibTeX from DBLP. To change the .bib another way (e.g. remove or fix an entry), ' +
    'first ask the user to approve the change, then retry with confirmBibEdit: true.'
  );
}
