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
