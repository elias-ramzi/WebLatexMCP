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
import { constants as fsConstants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import {
  isImportableAsset,
  assetTypeBlockedMessage,
  assetSourceBlockedMessage,
  assetTooLargeMessage,
} from './assets.js';
import { MAX_ASSET_BYTES, MAX_INLINE_ASSET_BYTES } from './assets.js';
import { toPosix } from './paths.js';

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

/**
 * The two filesystem calls the sourcePath route makes, injectable so a test can perform an
 * attacker's move at the exact moment it matters (a name swapped for a link after `realpath`,
 * a file grown after `fstat`) against a real temp directory. Production passes nothing and gets
 * `node:fs/promises`.
 */
export interface AssetSourceFs {
  realpath(p: string): Promise<string>;
  open(p: string, flags: number): Promise<FileHandle>;
}
const NODE_FS: AssetSourceFs = { realpath: (p) => realpath(p), open: (p, f) => open(p, f) };

/**
 * Flags for the one `open` of the resolved source. `O_NOFOLLOW` makes the open fail rather than
 * follow a link at the final component — the realpath'd target contained none when it was
 * resolved, so one appearing there now is a swap. `O_NONBLOCK` keeps a FIFO swapped in at the name
 * from hanging the open itself (it is then refused by `fstat`); on a regular file it changes
 * nothing. Neither is defined on Windows, where they fall back to 0: there is no `O_NOFOLLOW`
 * equivalent reachable from Node, and creating a symlink there needs a privilege the ordinary
 * attacker lacks, so the handle-based read still closes the size-cap and file-type races.
 */
const OPEN_FLAGS =
  fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);

/** Chunk size for the bounded read through the handle. */
const READ_CHUNK = 1024 * 1024;

/**
 * A Windows network (UNC) or device path: `\\server\share\…`, `\\?\…`, `\\.\…`. On Windows `/`
 * and `\` are both separators, so any two leading separators name one; on POSIX only the
 * backslash spellings count, since a leading `//` there is an ordinary absolute path (and a
 * leading `\` is not absolute at all). Pure string work — the whole point is that it runs before
 * any syscall, because merely resolving `\\server\share\x.png` makes Windows connect to `server`
 * over SMB and offer it this machine's NTLM credentials.
 */
export function isUncOrDevicePath(
  p: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (p.startsWith('\\\\')) return true;
  return platform === 'win32' && /^[\\/]{2}/.test(p);
}

/**
 * Collapse a syscall failure on the source into found / not-found / unresolvable, never the raw
 * errno text: that text names the syscall and echoes the path, and is itself an oracle (ENOTDIR on
 * a path through a regular file proves the file exists; ELOOP proves a symlink cycle — or, from the
 * `O_NOFOLLOW` open, a link swapped in at the name). `EISDIR` is Windows refusing to open a
 * directory, which POSIX opens and `fstat` then refuses; both read "is not a regular file".
 */
function sourceSyscallError(shown: string, err: unknown): Error {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'EISDIR') {
    return new Error(`sourcePath "${shown}" is not a regular file.`, { cause: err });
  }
  if (
    code === 'ENOENT' ||
    code === 'ENOTDIR' ||
    code === 'ELOOP' ||
    code === 'EMLINK' ||
    code === 'ENAMETOOLONG'
  ) {
    return new Error(`sourcePath "${shown}" was not found.`, { cause: err });
  }
  return new Error(`sourcePath "${shown}" could not be resolved.`, { cause: err });
}

async function resolveFromSourcePath(
  destPath: string,
  sourcePath: string,
  fs: AssetSourceFs,
): Promise<ResolvedAsset> {
  const expanded = expandHome(sourcePath);

  // A network or device path is refused before anything else touches it — before `isAbsolute`
  // too, so the refusal reads the same on every platform (on POSIX `\\server\…` is merely
  // relative, and "not absolute" would hide why it can never work). `expanded`, not `sourcePath`:
  // a Windows home directory can itself live on a share, and `~/x.png` then expands to one.
  // Like the relative-path message below, this quotes the caller's own input verbatim.
  if (isUncOrDevicePath(expanded)) {
    const resolvedTo = expanded === sourcePath ? '' : ` (resolved to "${expanded}")`;
    throw new Error(
      `sourcePath "${sourcePath}"${resolvedTo} is a Windows network (UNC) or device path. ` +
        'add_asset reads only files on a local disk of the machine running this server: ' +
        'resolving a network path would make this machine connect to that server. Copy the ' +
        'file to a local disk first, or pass its bytes as contentBase64.',
    );
  }

  // A relative path is ambiguous: relative to the server process's cwd, which the caller
  // (running in a different process, possibly on a different machine's mental model of the
  // project) cannot know. Refuse rather than guess.
  // Deliberately, with the network-path refusal above, one of the TWO messages in this function
  // that keep native separators. Both halves of
  // it are quotations of what the caller typed: `sourcePath` verbatim, and `expanded` as the
  // tilde expansion of that same string. Re-spelling only the second would read as though the
  // server had rewritten the path — `"sub\dir\x.png" is not absolute (resolved to
  // "sub/dir/x.png")` — and the point of the sentence is to show the caller their own input.
  // Every message below names a path the SERVER resolved, and those are converted.
  if (!path.isAbsolute(expanded)) {
    throw new Error(
      `sourcePath "${sourcePath}" is not absolute (resolved to "${expanded}"). ` +
        'add_asset needs an absolute path on the machine running this server, e.g. ' +
        '"/home/you/Desktop/plot.png" or "~/Desktop/plot.png".',
    );
  }

  // Cheap, pre-I/O filter: reject a non-asset extension BEFORE any filesystem access at all.
  // This is pure string work (isImportableAsset only looks at the path's extension), so a
  // non-asset-NAMED path (/etc/shadow, ~/.ssh/id_rsa) is refused without a single syscall. This
  // is NOT the authoritative check: a symlink named `photo.png` that actually resolves to
  // `id_rsa` passes this filter (its own name looks like an asset) and must still be caught —
  // that is what the identical check after realpath below is for, on the resolved target. Do
  // not remove either one: this one closes the oracle for non-asset paths; that one closes the
  // laundering hole for asset-named symlinks. For a sourcePath that IS named like an asset
  // (e.g. some-other-real-file.png, or an attacker-chosen name ending in .png), this filter does
  // nothing — realpath/stat below are reached, and their outcome (found vs. not-found vs.
  // unresolvable) is what the error wrapping below collapses to exactly those three shapes, with
  // no errno text or syscall name in the message. That existence/type oracle for asset-NAMED
  // paths is the accepted cost of resolving a caller-named path at all, not something this
  // filter claims to prevent.
  //
  // `toPosix` on the interpolation only, never on the value: `expanded` goes on to `realpath`
  // and `readFile` below and must keep the host's own spelling, exactly as `toPosixOut`'s doc
  // comment requires. These messages reach a caller through `errorResult`, and the server
  // promises "file paths are always POSIX, on every OS" — `register_project` already converts
  // its equivalents (`No such file or directory: …`), so this is that same convention, not a
  // new one. The extension the allowlist judged is unaffected by a separator.
  if (!isImportableAsset(expanded)) {
    throw new Error(assetSourceBlockedMessage(toPosix(expanded)));
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
    real = await fs.realpath(expanded);
  } catch (err) {
    // Report only the already-expanded absolute path, not the original tilde form: the caller
    // needs to see exactly what was checked against the filesystem.
    throw sourceSyscallError(toPosix(expanded), err);
  }

  // The source itself must be a recognized asset type too — checked on the REALPATH'D path, so a
  // symlink named e.g. `photo.png` that actually resolves to `~/.ssh/id_rsa` is judged on where
  // it lands, not on the name the caller gave it (same reasoning as `resolveThroughLinks` in
  // fileService.ts). This is the fix for the exfiltration hole: the destination allowlist alone
  // constrained nothing about sourcePath, so any file on the machine — a credential, an SSH key,
  // /etc/passwd — could be read and (via a text-ish asset extension like .svg/.eps, or via
  // commit+push) exfiltrated. Note this deliberately does NOT require the source and destination
  // extensions to match: importing plot.jpeg as plot.jpg is a legitimate rename. It runs before
  // the open, so a non-asset target is never even opened.
  if (!isImportableAsset(real)) {
    throw new Error(assetSourceBlockedMessage(toPosix(real)));
  }

  // Everything from here on is judged on ONE handle, never on the path again. Checking the path
  // and then reading it by path is a check-then-use race: whoever owns the source name can swap
  // it, after the checks, for a link to `~/.ssh/id_rsa` (which the read would follow), for a file
  // over the size cap, or for a FIFO. `O_NOFOLLOW` refuses a link at the name (see OPEN_FLAGS);
  // `fstat` on the handle judges the file actually opened; the read goes through that handle.
  let fh: FileHandle;
  try {
    fh = await fs.open(real, OPEN_FLAGS);
  } catch (err) {
    throw sourceSyscallError(toPosix(real), err);
  }
  try {
    let st;
    try {
      st = await fh.stat();
    } catch (err) {
      throw sourceSyscallError(toPosix(real), err);
    }
    if (!st.isFile()) {
      throw new Error(`sourcePath "${toPosix(real)}" is not a regular file.`);
    }
    // Check the size BEFORE reading: reading first would slurp a multi-gigabyte file into memory
    // just to then reject it.
    if (st.size > MAX_ASSET_BYTES) {
      throw new Error(assetTooLargeMessage(destPath, st.size, MAX_ASSET_BYTES));
    }

    // ...and bound the read itself, since the file can still grow after that `fstat`: read at
    // most one byte past the cap, and refuse if that byte exists.
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const want = Math.min(READ_CHUNK, MAX_ASSET_BYTES + 1 - total);
      if (want <= 0) break;
      const chunk = Buffer.allocUnsafe(want);
      let bytesRead: number;
      try {
        ({ bytesRead } = await fh.read(chunk, 0, want, null));
      } catch (err) {
        throw sourceSyscallError(toPosix(real), err);
      }
      if (bytesRead === 0) break;
      chunks.push(bytesRead === want ? chunk : chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > MAX_ASSET_BYTES) {
      throw new Error(assetTooLargeMessage(destPath, total, MAX_ASSET_BYTES));
    }
    const bytes = Buffer.concat(chunks, total);
    return { bytes, origin: real, sha256: sha256Of(bytes) };
  } finally {
    await fh.close().catch(() => undefined);
  }
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

export async function resolveAssetSource(
  opts: {
    destPath: string;
    sourcePath?: string;
    contentBase64?: string;
  },
  fs: AssetSourceFs = NODE_FS,
): Promise<ResolvedAsset> {
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
    return resolveFromSourcePath(opts.destPath, opts.sourcePath as string, fs);
  }
  return resolveFromBase64(opts.destPath, opts.contentBase64 as string);
}
