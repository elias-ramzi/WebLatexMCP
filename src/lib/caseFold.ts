/**
 * Git's own ASCII-only case folding and an exact-first canonical-name lookup over a tree or index
 * listing. Applied only where `GitService.isCaseInsensitive(dir)` says the repository has
 * `core.ignorecase` set; on a case-sensitive repository every comparison stays byte-exact.
 */

/**
 * ASCII-only case fold — lowercases only `A-Z`, nothing else. This is what git's own
 * `core.ignorecase` folding does (and only that): a full-Unicode `toLowerCase()` would also fold
 * e.g. U+212A KELVIN SIGN to ASCII `k`, over-matching a pair git itself treats as different names.
 * Shared by every case-insensitive lookup in the server — `GitService` (HEAD/index lookups)
 * and the lib layer's by-name comparisons — so they all agree with git and never over-match.
 */
export function foldCase(name: string): string {
  return name.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/**
 * An exact-first, ASCII-fold-otherwise lookup over one tree/index listing (e.g.
 * `ls-tree -r -z --name-only <ref>` or `ls-files -z`). `resolve(rel)` returns the listing's own
 * spelling for `rel`:
 *
 * 1. `rel` itself, when the listing holds it verbatim — which is also the answer on a
 *    case-sensitive repository.
 * 2. Otherwise the first entry (in listing order) whose ASCII fold equals `rel`'s fold.
 * 3. Otherwise — `rel` **itself** names a directory the listing tracks (as a prefix of some full
 *    name) in another case — e.g. `sub` while the listing holds `Sub/a.tex` — the listing's own
 *    spelling of that whole directory, exact-first. Checked before the prefix loop below so a
 *    caller naming exactly a tracked directory (no tail of their own) lands on it directly, rather
 *    than that loop finding no shorter prefix to peel off and falling through to step 4.
 * 4. Otherwise — `rel` names a path the listing has no full entry for, e.g. a *new* file under a
 *    tracked directory — the longest directory prefix of `rel` that the listing tracks (as a
 *    prefix of some full name), folded the same exact-first way, with `rel`'s own remaining tail
 *    re-attached unchanged. A new `sub/new.tex` under a tracked `Sub/a.tex` resolves to
 *    `Sub/new.tex`, not a second, case-differing `sub/` tree entry beside `Sub/`.
 * 5. Otherwise `rel` unchanged.
 *
 * `has(rel)` is the tracked/not-tracked question alone (steps 1-2 only) — a directory-prefix
 * match is not "this exact path is tracked".
 *
 * Exact-first matters at every step when a tree legitimately holds both `Notes.txt` and
 * `notes.txt`, or both `Sub/` and `sub/` (e.g. a case-sensitive contributor added both): a caller
 * naming one of them exactly must land on that one, never on whichever entry happened to sort
 * last.
 */
export function canonicalNames(names: string[]): {
  resolve(rel: string): string;
  has(rel: string): boolean;
} {
  const exact = new Set(names);
  const folded = new Map<string, string>();
  // Every directory prefix of every listed name (excluding the name itself), e.g. `Sub` and
  // `Sub/deep` for a listed `Sub/deep/x.tex`. `exactDirs` mirrors `exact`'s role for full names —
  // checked first at each prefix length so an already-correctly-cased segment never gets rewritten
  // through a folded alias of some *other* listed entry. A name with no slash (`Sub` tracked as a
  // plain file) contributes no prefix: the inner loop only runs for i < segments.length.
  const exactDirs = new Set<string>();
  const foldedDirs = new Map<string, string>();
  for (const name of names) {
    const key = foldCase(name);
    if (!folded.has(key)) folded.set(key, name);
    const segments = name.split('/');
    for (let i = 1; i < segments.length; i++) {
      const prefix = segments.slice(0, i).join('/');
      exactDirs.add(prefix);
      const prefixKey = foldCase(prefix);
      if (!foldedDirs.has(prefixKey)) foldedDirs.set(prefixKey, prefix);
    }
  }
  return {
    resolve(rel: string): string {
      if (exact.has(rel)) return rel;
      const foldedMatch = folded.get(foldCase(rel));
      if (foldedMatch !== undefined) return foldedMatch;
      if (exactDirs.has(rel)) return rel;
      const foldedDir = foldedDirs.get(foldCase(rel));
      if (foldedDir !== undefined) return foldedDir;
      const segments = rel.split('/');
      for (let i = segments.length - 1; i >= 1; i--) {
        const prefix = segments.slice(0, i).join('/');
        const tail = segments.slice(i).join('/');
        if (exactDirs.has(prefix)) return `${prefix}/${tail}`;
        const canonicalPrefix = foldedDirs.get(foldCase(prefix));
        if (canonicalPrefix !== undefined) return `${canonicalPrefix}/${tail}`;
      }
      return rel;
    },
    has(rel: string): boolean {
      return exact.has(rel) || folded.has(foldCase(rel));
    },
  };
}
