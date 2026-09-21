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
 * Three bounds, each reported only when it actually fired: how many files get a detailed block,
 * how long any ONE side may be, and — the one an earlier version of this omitted — how much
 * every side of every file may come to in TOTAL. A per-side cap without an aggregate is not a
 * bound on the result: 20 files x 3 sides x 12000 characters clears every individual cap and
 * still renders 720000 characters with `truncated: false`.
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
  opts: { maxFiles: number; sideCap: number; totalBudget: number },
): UnshelveConflictPlan {
  const maxFiles = Math.max(0, opts.maxFiles);
  const sideCap = Math.max(0, opts.sideCap);
  const totalBudget = Math.max(0, opts.totalBudget);
  const paths = files.map((f) => f.path);
  const kept = files.slice(0, maxFiles);
  const droppedFiles = files.length - kept.length;
  let anySideElided = false;
  let budgetFired = false;
  // Charged across every side of every file, not per side. The per-side cap alone is only half
  // of the mechanism #68 built, and the missing half is the one that matters: 20 files x 3 sides
  // x 12000 characters is 720000 characters with nothing individually over its cap, so nothing
  // is elided, `truncated` is false and the note is empty — a payload an order of magnitude past
  // the ~67k that was rejected undelivered in the first place. Five shelved 8 kB sections
  // rebased over reach ~120k without an adversary anywhere.
  let used = 0;

  const out = kept.map((file) => {
    const elided: UnshelveSideElision = {};
    const cut = (value: string | null, side: keyof UnshelveSideElision): string | null => {
      // A genuinely absent side stays absent: `null` in, `null` out, and no `elided` entry.
      if (value === null) return null;
      if (value.length > sideCap) {
        elided[side] = value.length;
        anySideElided = true;
        return null;
      }
      // The aggregate. Charged in the order sides are visited, so the cut is a tail rather than
      // a hole: a caller reading the first files in full is better off than one reading every
      // file half. An over-budget side is elided with its true length, exactly as an
      // over-the-side-cap one is, and stays recoverable because the shelf is left intact.
      if (used + value.length > totalBudget) {
        elided[side] = value.length;
        budgetFired = true;
        return null;
      }
      used += value.length;
      return value;
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
  // Named apart from the per-side cap, and only when it actually fired: reporting "a side was
  // too long" for a payload cut by the aggregate sends the reader looking for one big file that
  // is not there. Same rule conflictBudget.ts follows.
  if (budgetFired) {
    notes.push(
      `the ${totalBudget}-character total budget across every side of every file was reached, ` +
        `so later sides were elided; the shelf is left intact, so resolving the collision and ` +
        `unshelving again recovers every byte`,
    );
  }

  return {
    files: out,
    paths,
    truncated: droppedFiles > 0 || anySideElided || budgetFired,
    note: notes.join('; '),
  };
}

/** What one shelved file's restore would do to the tree, decided from bytes alone. */
export type UnshelveVerdict =
  | { kind: 'apply' }
  | { kind: 'noop' }
  | { kind: 'conflict'; reason: UnshelveConflictReason };

/** One file's inputs to {@link planUnshelveFile}, all as raw bytes (or absent). */
export interface UnshelveFileState {
  /** HEAD's bytes when the shelf was taken. `null` iff the file was untracked then. */
  base: Buffer | null;
  /** The bytes the shelf holds. `null` iff the shelf recorded a deletion. */
  shelved: Buffer | null;
  /** What is in the working tree now. `null` iff the path is absent. */
  current: Buffer | null;
  /** HEAD's bytes now. `null` iff the path is not tracked at HEAD now. */
  headNow: Buffer | null;
  /** Whether `git status` reports this path as changed — already folded by the caller. */
  dirty: boolean;
}

/**
 * Decide, for ONE shelved file, whether `unshelve` may write it.
 *
 * Pure and byte-level so it can be unit-tested exhaustively, which is the whole reason it is not
 * inline in the tool: the first version of this logic lived in the handler, had no seam, and
 * silently destroyed a user's work (see the `git status` note below).
 *
 * **Why `dirty` is passed in rather than derived here.** Asking whether the working tree differs
 * from HEAD is not a byte comparison: under a gitattributes clean filter (`* text=auto`) a CRLF
 * working-tree file never equals its own blob, and comparing the two directly reports a file
 * nobody touched as conflicted forever — the #63 defect. `git status` answers that question
 * correctly, filters included, so the caller asks git and hands the answer down.
 *
 * **And why `git status` alone is NOT enough — the bug this function exists to fix.** git declines
 * to report a path it has been told to ignore, so an UNTRACKED shelved path that is later covered
 * by a `.gitignore` is invisible to `status`: the user's new file at that path was overwritten,
 * the call reported `restored: true` with zero conflicts, and the shelf was then deleted, making
 * the loss unrecoverable. For an entry the shelf took while untracked (`base === null`) the tree
 * must therefore be checked for PRESENCE, which needs no filter reasoning at all: the shelve
 * removed that path, so anything there now is someone's work. A TRACKED entry needs no such
 * check — `.gitignore` never applies to a tracked file, so `status` does report it.
 *
 * A restore whose bytes are already on disk is a **no-op**, not a conflict. That matters for a
 * real case rather than a tidy one: a crash between writing the shelf and clearing the tree
 * leaves exactly that state, and calling it a conflict makes the shelf permanently unreclaimable
 * with `ours` and `theirs` byte-identical.
 */
export function planUnshelveFile(state: UnshelveFileState): UnshelveVerdict {
  const { base, shelved, current, headNow, dirty } = state;

  // Already what the shelf would write — including "already absent" for a shelved deletion.
  if (bytesEqual(current, shelved)) return { kind: 'noop' };

  // HEAD moved UNDER THIS FILE, so the shelved edit no longer applies to what it was made
  // against. Both sides are blob bytes here, so this comparison is filter-free and exact; a HEAD
  // that advanced without touching this path compares equal and is correctly not a conflict.
  if (!bytesEqual(headNow, base)) return { kind: 'conflict', reason: 'head-moved' };

  // Untracked when shelved: the shelve removed the path, so anything present now is live work
  // that `git status` may or may not be willing to mention. See the doc comment.
  if (base === null && current !== null) return { kind: 'conflict', reason: 'dirty' };

  if (dirty) return { kind: 'conflict', reason: 'dirty' };
  return { kind: 'apply' };
}

/** Byte equality where `null` (absent) is a value distinct from empty. */
export function bytesEqual(a: Buffer | null, b: Buffer | null): boolean {
  if (a === null || b === null) return a === b;
  return a.equals(b);
}
