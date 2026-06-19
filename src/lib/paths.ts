import path from 'node:path';

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
