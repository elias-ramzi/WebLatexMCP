import { randomUUID } from 'node:crypto';

/**
 * The pure core of `shelve` / `unshelve` / `list_shelves`: the shelf id, the on-disk manifest
 * shape and its tolerant parser, plus the two small helpers the tools need (line counting and
 * the conflict-payload cap).
 *
 * Pure by design — no fs, no git, no process/env access — so every rule below is unit-testable
 * without a workspace. `ShelfStore` (`src/services/shelfStore.ts`) is the only thing that turns
 * these values into paths.
 */

/** `sh-` + 8 lowercase hex, e.g. `sh-1a2b3c4d`. */
export const SHELF_ID_RE = /^sh-[0-9a-f]{8}$/;

/** Number of hex digits in a shelf id, after the `sh-` prefix. */
const SHELF_ID_HEX_LEN = 8;

/** True when `value` is exactly a well-formed shelf id. Never partially accepts. */
export function isShelfId(value: string): boolean {
  return typeof value === 'string' && SHELF_ID_RE.test(value);
}

/**
 * Validate a shelf id, returning it unchanged.
 *
 * This is a **security boundary, not a convenience** — the same reasoning as
 * `src/lib/referenceKey.ts`: the id is interpolated into a filesystem path under
 * `<workspace>/.sessions/<projectId>/shelves/`, so it must never reach a `path.join`
 * partially validated. There is no normalisation step and no "close enough" branch: a value
 * that is not exactly `sh-` + 8 lowercase hex is refused, and nothing else is ever returned.
 * `..`, a separator, a NUL, an absolute path and an uppercase spelling all fail the same way.
 *
 * The message names `list_shelves`, because that is the one call that tells a caller which ids
 * actually exist.
 */
export function assertShelfId(value: string): string {
  if (!isShelfId(value)) {
    throw new Error(
      `"${value}" is not a shelf id. A shelf id is "sh-" followed by 8 lowercase hex digits ` +
        `(e.g. "sh-1a2b3c4d"). Call list_shelves to see the shelves this project holds.`,
    );
  }
  return value;
}

/**
 * A fresh shelf id.
 *
 * `rand` is injectable so a test can pin the id; it returns any string, from which the leading
 * 8 hex digits (lowercased, other characters dropped) become the id. The default is
 * `randomUUID`, whose 32 hex digits are always enough. A `rand` that yields fewer than 8 hex
 * digits is a programming error and throws rather than producing a short — and therefore
 * invalid — id.
 */
export function newShelfId(rand: () => string = randomUUID): string {
  const hex = rand()
    .toLowerCase()
    .replace(/[^0-9a-f]/g, '');
  if (hex.length < SHELF_ID_HEX_LEN) {
    throw new Error(
      `newShelfId: the random source yielded ${hex.length} hex digits, need ${SHELF_ID_HEX_LEN}.`,
    );
  }
  return `sh-${hex.slice(0, SHELF_ID_HEX_LEN)}`;
}

/** How a shelved path stood at shelve time. */
export type ShelfFileStatus = 'modified' | 'added' | 'deleted';

const SHELF_FILE_STATUSES: readonly ShelfFileStatus[] = ['modified', 'added', 'deleted'];

export interface ShelfFileRecord {
  /** POSIX, project-relative, exactly as git reported it. */
  path: string;
  /**
   * `'added'` = untracked at shelve time, so the shelf holds no HEAD side;
   * `'deleted'` = tracked but absent from the tree at shelve time, so it holds no content side.
   */
  status: ShelfFileStatus;
  added: number;
  removed: number;
}

export interface ShelfManifest {
  version: 1;
  id: string;
  label: string | null;
  /** ISO instant the shelf was taken. */
  createdAt: string;
  /** The session that took the shelf — informational; shelves are project-scoped. */
  sessionId: string;
  /** HEAD at shelve time, or `'unborn'` when the repository had no commit yet. */
  headSha: string;
  files: ShelfFileRecord[];
}

/**
 * True when `p` is safe to join under a shelf's `content/` or `base/` directory.
 *
 * A manifest is **data**, even though this server wrote it: it sits in a user-writable
 * directory and every `path` in it is later joined under the shelf directory and read or
 * written. So the shape is checked here rather than trusted — absolute (in any platform's
 * spelling), a `..` segment, a backslash (a separator on Windows, and invisible to a POSIX
 * `..` check) and a NUL (which truncates a path at the syscall boundary) are all refused.
 * `ShelfStore` re-checks with `resolveInside` at the point of use; this is the first of the
 * two layers, not the only one.
 */
function isSafeShelfPath(p: unknown): p is string {
  if (typeof p !== 'string' || p.length === 0) return false;
  if (p.includes('\\') || p.includes('\0')) return false;
  if (p.startsWith('/')) return false;
  if (/^[A-Za-z]:/.test(p)) return false; // a Windows drive-qualified path
  return !p.split('/').some((segment) => segment === '..');
}

function parseFileRecord(raw: unknown): ShelfFileRecord | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (!isSafeShelfPath(rec.path)) return null;
  if (typeof rec.status !== 'string') return null;
  if (!SHELF_FILE_STATUSES.includes(rec.status as ShelfFileStatus)) return null;
  if (typeof rec.added !== 'number' || !Number.isFinite(rec.added)) return null;
  if (typeof rec.removed !== 'number' || !Number.isFinite(rec.removed)) return null;
  return {
    path: rec.path,
    status: rec.status as ShelfFileStatus,
    added: rec.added,
    removed: rec.removed,
  };
}

/**
 * Tolerant parse of a `shelf.json` body. Returns `null` for anything that is not a well-formed
 * manifest and **never throws**: a shelf directory whose manifest does not parse is not a shelf,
 * which is precisely what makes a half-written or hand-mangled shelf invisible rather than
 * corrupt.
 */
export function parseManifest(raw: unknown): ShelfManifest | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  if (m.version !== 1) return null;
  if (typeof m.id !== 'string' || !isShelfId(m.id)) return null;
  const label = m.label === undefined || m.label === null ? null : m.label;
  if (label !== null && typeof label !== 'string') return null;
  if (typeof m.createdAt !== 'string') return null;
  if (typeof m.sessionId !== 'string') return null;
  if (typeof m.headSha !== 'string') return null;
  if (!Array.isArray(m.files)) return null;
  const files: ShelfFileRecord[] = [];
  for (const entry of m.files) {
    const parsed = parseFileRecord(entry);
    if (!parsed) return null;
    files.push(parsed);
  }
  return {
    version: 1,
    id: m.id,
    label,
    createdAt: m.createdAt,
    sessionId: m.sessionId,
    headSha: m.headSha,
    files,
  };
}

/** LF, as a byte — what `countLines` counts. */
const LF = 0x0a;

/**
 * Number of lines in `bytes`: a trailing newline does not add an empty last line, and an empty
 * buffer has 0 lines. Counted over the **bytes**, so nothing is decoded and a file that is not
 * valid UTF-8 still gets an honest count.
 */
export function countLines(bytes: Buffer): number {
  if (bytes.length === 0) return 0;
  let count = 0;
  for (const byte of bytes) {
    if (byte === LF) count += 1;
  }
  return bytes[bytes.length - 1] === LF ? count : count + 1;
}

/** Why a shelved path could not be restored. */
export type UnshelveConflictReason = 'dirty' | 'head-moved';

export interface UnshelveConflictFile {
  path: string;
  reason: UnshelveConflictReason;
  /** The HEAD content the shelved edit was made against (the shelf's stored base). */
  base: string | null;
  /** What is in the working tree now. */
  ours: string | null;
  /** The shelved content the restore would have written. */
  theirs: string | null;
}

/** True character counts of the sides that were cut, for the sides that were cut. */
export interface UnshelveSideElision {
  base?: number;
  ours?: number;
  theirs?: number;
}

export interface UnshelveConflictPlan {
  files: Array<UnshelveConflictFile & { elided?: UnshelveSideElision }>;
  /** Every conflicting path, never capped, never elided. */
  paths: string[];
  truncated: boolean;
  /** Names only whichever cap actually fired, never a reason that did not. `''` when nothing was cut. */
  note: string;
}

/**
 * Cap a conflict payload so it fits in one tool result.
 *
 * The first `maxFiles` files get a detailed block; the rest are named in `paths` only, which is
 * never capped and never elided — the path list is the one thing a caller needs in order to act.
 * Each side is capped at `sideCap` characters; a cut side comes back `null` with its **true**
 * character count under `elided.<side>`.
 *
 * `null` with **no** matching `elided` entry keeps meaning what it always meant — the side is
 * absent (the file was added, so there is no base; or deleted, so there are no shelved bytes).
 * That distinction must never blur: one says "there was nothing here", the other says "there
 * were N characters here and you can still get them".
 *
 * Eliding is safe here in a way it is not for a push conflict: a conflicting `unshelve` writes
 * nothing and **leaves the shelf intact**, so every elided byte stays recoverable by resolving
 * the collision and calling `unshelve` again.
 */
export function capUnshelveConflict(
  files: UnshelveConflictFile[],
  opts: { maxFiles: number; sideCap: number },
): UnshelveConflictPlan {
  const maxFiles = Math.max(0, opts.maxFiles);
  const sideCap = Math.max(0, opts.sideCap);
  const paths = files.map((f) => f.path);
  const kept = files.slice(0, maxFiles);
  const droppedFiles = files.length - kept.length;
  let anySideElided = false;

  const out = kept.map((file) => {
    const elided: UnshelveSideElision = {};
    const cut = (value: string | null, side: keyof UnshelveSideElision): string | null => {
      // A genuinely absent side stays absent: `null` in, `null` out, and no `elided` entry.
      if (value === null) return null;
      if (value.length <= sideCap) return value;
      elided[side] = value.length;
      anySideElided = true;
      return null;
    };
    const entry: UnshelveConflictFile & { elided?: UnshelveSideElision } = {
      path: file.path,
      reason: file.reason,
      base: cut(file.base, 'base'),
      ours: cut(file.ours, 'ours'),
      theirs: cut(file.theirs, 'theirs'),
    };
    if (Object.keys(elided).length > 0) entry.elided = elided;
    return entry;
  });

  const notes: string[] = [];
  if (droppedFiles > 0) {
    notes.push(
      `only the first ${maxFiles} of ${files.length} conflicting paths are detailed; every ` +
        `one of them is listed under "paths"`,
    );
  }
  if (anySideElided) {
    notes.push(
      `a base, ours or theirs over ${sideCap} characters was elided; the shelf is left intact, ` +
        `so resolving the collision and unshelving again recovers every byte`,
    );
  }

  return {
    files: out,
    paths,
    truncated: droppedFiles > 0 || anySideElided,
    note: notes.join('; '),
  };
}
