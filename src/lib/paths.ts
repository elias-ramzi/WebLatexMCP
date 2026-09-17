import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Convert a native path to POSIX (`/`) separators, so tool output is identical on Windows. */
export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/**
 * Convert an absolute native path to a clickable `file://` URL. Uses `pathToFileURL` so
 * Windows drive letters and special characters (spaces, `#`) are encoded correctly — a
 * hand-built `file://` string is invalid on Windows and breaks on spaces.
 */
export function toFileUrl(absPath: string): string {
  return pathToFileURL(absPath).href;
}

/**
 * Whether two paths name the same location, after `path.resolve`. Exact (case-sensitive) on
 * Linux; case-insensitive on `win32` and `darwin`, whose default filesystems (NTFS, APFS/HFS+ in
 * their default configuration) treat differently-cased paths as the same file — so a caller
 * spelling `Figures/x.png` for an on-disk `figures/x.png` names the same entry there, and a
 * case-sensitive string compare would wrongly call that a different target (e.g.
 * `FileService.linkTarget` mistaking a mere case mismatch for a symlink pointing elsewhere).
 */
export function samePath(a: string, b: string): boolean {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  if (process.platform === 'win32' || process.platform === 'darwin') {
    return ra.toLowerCase() === rb.toLowerCase();
  }
  return ra === rb;
}

/**
 * Resolve a user-supplied relative path against a project root, rejecting anything
 * that escapes the root (`..`, absolute paths, symlink-style traversal in the string).
 * Returns the absolute resolved path. Allows the root itself (empty/`.` relative path).
 */
export function resolveInside(root: string, relPath: string): string {
  if (path.isAbsolute(relPath)) {
    throw new Error(`Path must be relative to the project root, got absolute: "${relPath}"`);
  }
  const normalizedRoot = path.resolve(root);
  const resolved = path.resolve(normalizedRoot, relPath);
  const rel = path.relative(normalizedRoot, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes the project root: "${relPath}"`);
  }
  return resolved;
}

/**
 * Convert every path in one response object to POSIX separators, in a single call at the
 * response boundary.
 *
 * Why one call rather than a `toPosix` at each emission site: a tool's result **text** and its
 * `structuredContent` are then rendered from the same converted value, so the two channels
 * cannot disagree about a separator. That disagreement is the actual bug shape — a `toPosix`'d
 * `note` sitting beside a backslashed `pdfPath` inside one result object, on a server that
 * documents "file paths are always POSIX, on every OS".
 *
 * The values this returns are for **display** only. Convert here and nowhere earlier: a path
 * still headed for a filesystem call must stay native, and so must one headed for `toFileUrl`,
 * which takes a filesystem path and owns its own encoding rather than a spelling chosen for a
 * reader. `pathToFileURL` does in fact accept either — it resolves through `path.win32.resolve`
 * first, so `C:\a\b` and `C:/a/b` produce the same URL — so that half is a discipline about what
 * a value is FOR, not a bug being dodged. Do not relax it on the strength of that: the page count
 * just above the boundary in `compile` really does open the file, and the moment a converted
 * value reaches something that opens one, the distinction stops being cosmetic. Converting
 * upstream and passing the result on is the trap this helper sits next to.
 *
 * `sep` is a test seam, not a knob: `toPosix` splits on `path.sep`, which is `/` on a POSIX
 * host, where the conversion is the identity and every assertion about it is vacuous. Passing
 * `'\\'` lets a test drive the conversion wherever it runs. Production code always omits it.
 *
 * Keys and their order are preserved, an `undefined` value stays `undefined` (an absent PDF
 * must stay absent in `structuredContent`, never present as the string `"undefined"`), the
 * argument is never mutated, and nothing else is normalised — no `path.resolve`, no
 * trailing-slash trimming, no case folding.
 */
export function toPosixOut<T extends Record<string, string | undefined>>(
  paths: T,
  sep: string = path.sep,
): T {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(paths)) {
    out[key] = value === undefined ? undefined : value.split(sep).join('/');
  }
  return out as T;
}
