/**
 * What counts as an importable asset — the single source of truth shared by the tool layer and
 * `FileService`, so the two cannot disagree about which paths `add_asset` may read from and
 * write to.
 *
 * This allowlist is a **security gate**, not a convenience. `add_asset` is the one path that reads
 * a file from outside every project sandbox (the user's own filesystem) and writes it into a
 * project. Restricting BOTH the destination and the sourcePath to known asset extensions is what
 * stops a credential file (`~/.ssh/id_rsa`, `.env` — both extensionless or non-asset) from being
 * read off disk and written into a project — and from there committed and pushed to a remote. The
 * destination check alone is not enough: nothing constrained sourcePath, so `resolveAssetSource`
 * also checks `isImportableAsset` on sourcePath itself (cheaply, before any filesystem access) and
 * again on the realpath'd source (authoritatively, so a symlink is judged on where it lands).
 * Widen this set only for a genuine figure format, never to be permissive.
 */

import path from 'node:path';

/** Binary figure/asset extensions `add_asset` (and `FileService`'s binary read note) recognize. */
export const ASSET_EXT: ReadonlySet<string> = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.pdf',
  '.eps',
  '.gif',
  '.svg',
  '.tiff',
  '.tif',
  '.bmp',
  '.webp',
  '.ico',
]);

/**
 * Cap for an asset read off the local filesystem (the source side of `add_asset`). Generous enough
 * for any real figure, small enough that a mistake cannot blow up the repo.
 */
export const MAX_ASSET_BYTES = 25 * 1024 * 1024;

/**
 * Cap for base64-supplied bytes, measured as the DECODED size. Lower than {@link MAX_ASSET_BYTES}
 * because inline bytes cross the model's context window — the cost is paid per token, not per byte
 * on disk, so the limit has to be much tighter than what the filesystem could otherwise hold.
 */
export const MAX_INLINE_ASSET_BYTES = 5 * 1024 * 1024;

/** Whether a project-relative path names a recognized asset type. */
export function isImportableAsset(relPath: string): boolean {
  return ASSET_EXT.has(path.extname(relPath).toLowerCase());
}

/**
 * Why a destination was refused, and the two ways forward: `write_file` for text/`.tex`, and
 * `add_citation` for a `.bib`. Every refusal in this repo names the way forward — modeled on
 * `bibEditBlockedMessage`.
 */
export function assetTypeBlockedMessage(relPath: string): string {
  const ext = path.extname(relPath).toLowerCase() || '(none)';
  const allowed = [...ASSET_EXT].sort().join(', ');
  return (
    `"${relPath}" has extension "${ext}", which is not a recognized asset type. ` +
    `add_asset only writes binary figures with one of these extensions: ${allowed}. ` +
    'For a text or .tex file, use write_file. For a .bib bibliography entry, use add_citation.'
  );
}

/**
 * Why a `sourcePath` was refused, and the way forward: `contentBase64` for bytes that are not
 * themselves a recognized asset file on the server's filesystem. Only asset files may be READ off
 * the machine running this server at all — `sourcePath` is the one primitive in this tool that
 * reaches outside every project sandbox, so this message has to make the "only assets" rule as
 * plain as `assetTypeBlockedMessage` makes it for the destination. Modeled on
 * `bibEditBlockedMessage`.
 */
export function assetSourceBlockedMessage(sourcePath: string): string {
  const ext = path.extname(sourcePath).toLowerCase();
  const extDescription = ext ? `extension "${ext}"` : 'no extension';
  const allowed = [...ASSET_EXT].sort().join(', ');
  return (
    `"${sourcePath}" has ${extDescription}, which is not a recognized asset type. ` +
    'add_asset only reads files off this machine that are themselves a recognized asset type ' +
    `(one of: ${allowed}) — this is what stops a credential file (e.g. ~/.ssh/id_rsa, .env, ` +
    '/etc/passwd) from being read and copied into a project. If the bytes are not on this ' +
    "machine's filesystem (e.g. the client has its own copy), pass them as contentBase64 instead."
  );
}

/**
 * Why a destination was refused because it is a symlink landing somewhere add_asset must not
 * write: `relPath` names an asset-typed path — it cleared `assetTypeBlockedMessage`'s check on
 * its own name — but it is a link (possibly through a linked directory) to `target`, which is not
 * itself a recognized asset type. This message fires from the link check, which the tool layer
 * runs *before* `resolveAssetSource` (so `sourcePath`/`contentBase64` are never even looked at
 * for a destination that resolves to something add_asset must not overwrite); it is not, and does
 * not depend on, `assetSourceBlockedMessage`'s check on the source side. Mirrors
 * `assetTypeBlockedMessage`'s wording (same allowlist, same "use write_file / add_citation
 * instead" guidance) so a `.tex` or `.bib` at the far end is refused with the same actionable
 * message whether the caller named it directly or through a link. Modeled on
 * `bibEditBlockedMessage`'s target-naming form.
 */
export function assetLinkBlockedMessage(relPath: string, target: string): string {
  const allowed = [...ASSET_EXT].sort().join(', ');
  return (
    `"${relPath}" is a link to "${target}", which is not a recognized asset type. ` +
    `add_asset only writes binary figures with one of these extensions: ${allowed}. ` +
    'For a text or .tex file at the far end, use write_file. For a .bib bibliography entry, ' +
    'use add_citation.'
  );
}

/** Why an asset was refused for being too large, naming both the actual size and the cap. */
export function assetTooLargeMessage(relPath: string, bytes: number, cap: number): string {
  const mib = (n: number) => (n / (1024 * 1024)).toFixed(1);
  return (
    `"${relPath}" is ${mib(bytes)} MiB (${bytes} bytes), which exceeds the ${mib(cap)} MiB ` +
    `(${cap} bytes) limit for add_asset.`
  );
}
