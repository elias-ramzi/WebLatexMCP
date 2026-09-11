/**
 * Resolves the bytes `add_asset` will write, from either a filesystem path on the machine
 * running this server or an inline base64 payload — and every check that must clear before
 * those bytes are read at all.
 *
 * Kept out of the tool layer (`src/tools/addAsset.ts`) so it is unit-testable without an MCP
 * client, matching every other `src/lib/*` helper in this repo.
 */

import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import {
  isImportableAsset,
  assetTypeBlockedMessage,
  assetSourceBlockedMessage,
  assetTooLargeMessage,
} from './assets.js';
import { MAX_ASSET_BYTES, MAX_INLINE_ASSET_BYTES } from './assets.js';

export interface ResolvedAsset {
  bytes: Buffer;
  /** Where the bytes came from, for the result text: a resolved absolute path, or 'inline base64'. */
  origin: string;
  /** Hex sha256 of `bytes`, so the caller can verify the copy is byte-identical. */
  sha256: string;
}

const DATA_URL_PREFIX = /^data:[^;,]*;base64,/;
const BASE64_CHARS = /^[A-Za-z0-9+/]*={0,2}$/;

function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Expand a leading `~` (or bare `~`) to the user's home directory. MCP arguments are not
 * shell-expanded, so a caller typing `~/Desktop/plot.png` would otherwise get a literal
 * `~` directory entry that never exists.
 */
function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

async function resolveFromSourcePath(destPath: string, sourcePath: string): Promise<ResolvedAsset> {
  const expanded = expandHome(sourcePath);

  // A relative path is ambiguous: relative to the server process's cwd, which the caller
  // (running in a different process, possibly on a different machine's mental model of the
  // project) cannot know. Refuse rather than guess.
  if (!path.isAbsolute(expanded)) {
    throw new Error(
      `sourcePath "${sourcePath}" is not absolute (resolved to "${expanded}"). ` +
        'add_asset needs an absolute path on the machine running this server, e.g. ' +
        '"/home/you/Desktop/plot.png" or "~/Desktop/plot.png".',
    );
  }

  // Cheap, pre-I/O filter: reject a non-asset extension BEFORE any filesystem access at all.
  // This is pure string work (isImportableAsset only looks at the path's extension), so it
  // cannot be used to probe the filesystem — a caller pointing sourcePath at /etc/shadow,
  // ~/.ssh/id_rsa, or any other non-asset path gets refused without a single syscall, so no
  // realpath/stat outcome (found vs. not-found vs. permission-denied) ever reaches them. This
  // is NOT the authoritative check: a symlink named `photo.png` that actually resolves to
  // `id_rsa` passes this filter (its own name looks like an asset) and must still be caught —
  // that is what the identical check after realpath below is for, on the resolved target. Do
  // not remove either one: this one closes the oracle for non-asset paths; that one closes the
  // laundering hole for asset-named symlinks. A sourcePath that is itself named like an asset
  // (e.g. some-other-real-file.png) can still be probed for existence/type by a caller who
  // already knows to name it that way — that is the accepted cost of resolving a caller-named
  // path at all, not something this filter claims to prevent.
  if (!isImportableAsset(expanded)) {
    throw new Error(assetSourceBlockedMessage(expanded));
  }

  // realpath follows symlinks so the reported origin names where the bytes actually came from.
  // This path is intentionally outside every project sandbox — the user named a file on their
  // own machine, not inside a registered project — so resolveInside/project-escape checks do
  // NOT apply here. What makes this read accountable is: the destination allowlist (checked
  // before this function is ever called), the cheap source-extension filter above, the SOURCE
  // allowlist below (checked on the realpath'd target, same reasoning as `resolveThroughLinks`
  // in fileService.ts — a symlink named `photo.png` that actually points at `id_rsa` is judged
  // on where it lands, not on its own name), and reporting this real, resolved path back to the
  // caller.
  let real: string;
  try {
    real = await realpath(expanded);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      // Report only the already-expanded absolute path, not the original tilde form: the
      // caller needs to see exactly what was checked against the filesystem.
      throw new Error(`sourcePath "${expanded}" was not found.`, { cause: err });
    }
    if (code === 'EACCES' || code === 'EPERM') {
      // Don't let the raw errno text (which includes the syscall name and path) escape to the
      // caller — wrap it in a message with the same shape as the other refusals here.
      throw new Error(`sourcePath "${expanded}" could not be resolved (permission denied).`, {
        cause: err,
      });
    }
    throw err;
  }

  let st;
  try {
    st = await stat(real);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`sourcePath "${real}" was not found.`, { cause: err });
    }
    throw err;
  }
  if (!st.isFile()) {
    throw new Error(`sourcePath "${real}" is not a regular file.`);
  }

  // The source itself must be a recognized asset type too — checked on the REALPATH'D path, so a
  // symlink named e.g. `photo.png` that actually resolves to `~/.ssh/id_rsa` is judged on where
  // it lands, not on the name the caller gave it (same reasoning as `resolveThroughLinks` in
  // fileService.ts). This is the fix for the exfiltration hole: the destination allowlist alone
  // constrained nothing about sourcePath, so any file on the machine — a credential, an SSH key,
  // /etc/passwd — could be read and (via a text-ish asset extension like .svg/.eps, or via
  // commit+push) exfiltrated. Note this deliberately does NOT require the source and destination
  // extensions to match: importing plot.jpeg as plot.jpg is a legitimate rename.
  if (!isImportableAsset(real)) {
    throw new Error(assetSourceBlockedMessage(real));
  }

  // Check the size BEFORE reading: reading first would slurp a multi-gigabyte file into memory
  // just to then reject it.
  if (st.size > MAX_ASSET_BYTES) {
    throw new Error(assetTooLargeMessage(destPath, st.size, MAX_ASSET_BYTES));
  }

  const bytes = await readFile(real);
  return { bytes, origin: real, sha256: sha256Of(bytes) };
}

function resolveFromBase64(destPath: string, contentBase64: string): ResolvedAsset {
  const stripped = contentBase64.replace(DATA_URL_PREFIX, '').replace(/\s+/g, '');

  // Buffer.from(s, 'base64') silently ignores invalid characters rather than throwing, so a
  // typo'd or truncated payload would decode to plausible-looking garbage and get written as a
  // corrupt image. Validate strictly first.
  if (!BASE64_CHARS.test(stripped) || stripped.length % 4 !== 0) {
    throw new Error(
      'contentBase64 is not valid base64 (after stripping any data: prefix and whitespace). ' +
        'A payload containing characters outside the base64 alphabet, or one whose length is ' +
        'not a multiple of 4, is rejected rather than decoded.',
    );
  }

  const bytes = Buffer.from(stripped, 'base64');
  if (bytes.length === 0) {
    throw new Error('contentBase64 decoded to 0 bytes; an empty asset is never what was meant.');
  }
  if (bytes.length > MAX_INLINE_ASSET_BYTES) {
    throw new Error(
      assetTooLargeMessage(destPath, bytes.length, MAX_INLINE_ASSET_BYTES) +
        " The inline base64 cap is lower than the cap for sourcePath (a path on the server's " +
        'own filesystem); for a larger file, save it to disk and pass sourcePath instead.',
    );
  }

  return { bytes, origin: 'inline base64', sha256: sha256Of(bytes) };
}

export async function resolveAssetSource(opts: {
  destPath: string;
  sourcePath?: string;
  contentBase64?: string;
}): Promise<ResolvedAsset> {
  // 1. Destination allowlist FIRST, before anything is read off disk. This ordering is
  // security-relevant: a refused destination type must never cause the server to read a file
  // from outside every project sandbox. That read is the whole reason the allowlist exists —
  // checking it after the read would defeat the point of checking it at all.
  if (!isImportableAsset(opts.destPath)) {
    throw new Error(assetTypeBlockedMessage(opts.destPath));
  }

  // 2. Exactly one source. Use `!== undefined`, not truthiness: an empty-string contentBase64
  // is still "given" (and rejected downstream as an empty payload), not "omitted".
  const hasSourcePath = opts.sourcePath !== undefined;
  const hasBase64 = opts.contentBase64 !== undefined;
  if (!hasSourcePath && !hasBase64) {
    throw new Error(
      'add_asset needs exactly one source: sourcePath (an absolute path on the machine ' +
        'running this server) or contentBase64 (the file bytes, base64-encoded, for a client ' +
        'with no filesystem access). Neither was given.',
    );
  }
  if (hasSourcePath && hasBase64) {
    throw new Error(
      'add_asset needs exactly one source: pass either sourcePath or contentBase64, not both.',
    );
  }

  // 3. Resolve the chosen source.
  if (hasSourcePath) {
    return resolveFromSourcePath(opts.destPath, opts.sourcePath as string);
  }
  return resolveFromBase64(opts.destPath, opts.contentBase64 as string);
}
