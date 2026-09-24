import { randomUUID } from 'node:crypto';
import { asShadowContent } from './shadowContent.js';
import type { Merge3Result } from './merge3.js';

/**
 * The pure core of `shelve` / `unshelve` / `list_shelves`: the shelf id, the on-disk manifest
 * shape and its tolerant parser, plus the two small helpers the tools need (line counting and
 * the conflict-payload cap).
 *
 * Pure by design — no fs, no git, no process/env access — so every rule below is unit-testable
 * without a workspace. The one step that needs git, the three-way merge `unshelve` runs when HEAD
 * moved under a text entry, is injected ({@link UnshelveMerge}) rather than imported. `ShelfStore` (`src/services/shelfStore.ts`) is the only thing that turns
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

type ConflictSide = keyof UnshelveSideElision;

/**
 * The order sides are charged against the aggregate budget — ACROSS every detailed file, one side
 * at a time, not file by file — so the side that is cut first is the one the caller can best get
 * back:
 *
 * 1. `theirs` — the shelved content. The shelf lives under `<workspace>/.sessions/`, outside every
 *    project sandbox, so no tool can read it: this payload is the ONLY copy a caller can reach.
 *    Charged first, and exempt from the per-side cap (bounded by the aggregate alone), because a
 *    cut `theirs` is the one side nothing else recovers.
 * 2. `ours` — what is in the working tree now; one `read_file` away.
 * 3. `base` — HEAD's content when the shelf was taken; `read_file` with `ref` = the shelf's
 *    `headSha` reads it, so it is the cheapest to lose.
 *
 * An earlier version charged base, ours, theirs — declaration order — and so cut `theirs` first:
 * two 9000-character sides filled a 20000 budget and the only unrecoverable one was dropped.
 */
export const UNSHELVE_ALLOCATION_ORDER: readonly ConflictSide[] = ['theirs', 'ours', 'base'];

/**
 * Literal characters of ONE `structuredContent.conflicts[]` entry's JSON scaffold —
 * `{"path":,"reason":,"base":,"ours":,"theirs":}` plus the comma that separates it from the next
 * array element — EXCLUDING the path's and reason's own JSON strings and the three side values
 * (charged with each side). Pinned against `JSON.stringify` of a real planned entry in
 * `test/unit/unshelveConflictBudget.test.ts`, so a new key cannot land uncharged.
 */
export const UNSHELVE_FILE_JSON_OVERHEAD =
  '{"path":,"reason":,"base":,"ours":,"theirs":}'.length + 1;

/**
 * Literal characters of the `,"elided":{}` wrapper an entry grows once a side is cut, LESS ONE:
 * each elided side is charged its key, its value and one separating comma, and `k` parts need
 * only `k - 1` commas. Same accounting as `ELIDED_JSON_WRAPPER_OVERHEAD` in `conflictBudget.ts`.
 */
export const UNSHELVE_ELIDED_WRAPPER_OVERHEAD = ',"elided":{}'.length - 1;

/** What `null` costs in JSON — an absent or cut side's value. */
const JSON_NULL = 'null'.length;

/** `"<side>":<count>,` — what one entry under `elided` costs. */
function elisionCost(side: ConflictSide, count: number): number {
  return JSON.stringify(side).length + 1 + String(count).length + 1;
}

/**
 * Cap a conflict payload so it fits in one tool result.
 *
 * Three bounds, each reported only when it actually fired: how many files get a detailed block,
 * how long any ONE recoverable side may be, and how much every side of every file may come to in
 * TOTAL. A per-side cap without an aggregate is not a bound on the result: 20 files x 3 sides x
 * 12000 characters clears every individual cap and still renders 720000 characters with
 * `truncated: false`.
 *
 * **Both caps are charged against the RENDERED size**, the JSON string the side ships as, not the
 * characters held. The sides reach the caller only in `structuredContent` (the text channel names
 * paths and reasons, never content), and JSON escapes every control character as `\u00XX` — six
 * characters for one. Charged on held length, 9000 control characters cleared a 20000 budget and
 * rendered 54002; a binary side, lossily decoded, did the same at scale (~120k, `truncated:
 * false`). The entry scaffold, the `null` an absent or cut side still costs and the `elided`
 * entries are charged too ({@link UNSHELVE_FILE_JSON_OVERHEAD}), so whenever the mandatory
 * scaffolding fits, `JSON.stringify(plan.files).length <= totalBudget`. The one approximation is
 * on the safe side: an entry's `elided` wrapper stays reserved until its last contested side is
 * decided, so a payload within that wrapper's few characters of the budget can be cut where an
 * oracle would not. A side too small to be worth cutting (reporting it cut would cost more than
 * its JSON) is always shown.
 *
 * Sides are charged in {@link UNSHELVE_ALLOCATION_ORDER} — `theirs`, `ours`, `base` — across every
 * detailed file; see that constant for why.
 *
 * The first `maxFiles` files get a detailed block; the rest are named in `paths` only, which is
 * never capped and never elided — the path list is the one thing a caller needs in order to act.
 * A cut side comes back `null` with its **true** character count under `elided.<side>`.
 *
 * `null` with **no** matching `elided` entry keeps meaning what it always meant — the side is
 * absent (the file was added, so there is no base; or deleted, so there are no shelved bytes).
 * That distinction must never blur: one says "there was nothing here", the other says "there
 * were N characters here".
 *
 * A conflicting `unshelve` writes nothing and **leaves the shelf intact**, so a cut `theirs` is
 * still held by the shelf — but no tool reads a shelf, which is exactly why it is charged first.
 * `baseRef` (the shelf's `headSha`) lets the note say where a cut `base` can be read.
 */
export function capUnshelveConflict(
  files: UnshelveConflictFile[],
  opts: { maxFiles: number; sideCap: number; totalBudget: number; baseRef?: string },
): UnshelveConflictPlan {
  const maxFiles = Math.max(0, opts.maxFiles);
  const sideCap = Math.max(0, opts.sideCap);
  const totalBudget = Math.max(0, opts.totalBudget);
  const paths = files.map((f) => f.path);
  const kept = files.slice(0, maxFiles);
  const droppedFiles = files.length - kept.length;
  let sideCapFired = false;
  let budgetFired = false;
  let theirsCut = false;

  // `[` + `]`, less the comma the last entry charged but does not render.
  let used = kept.length > 0 ? 1 : 0;
  const planned = kept.map((file) => {
    const entry: UnshelveConflictFile & { elided?: UnshelveSideElision } = {
      path: file.path,
      reason: file.reason,
      base: null,
      ours: null,
      theirs: null,
    };
    const elided: UnshelveSideElision = {};
    // Sides the budget still has to decide, as [side, rendered cost if kept, cost if cut].
    const contested: Array<[ConflictSide, number, number]> = [];
    used +=
      UNSHELVE_FILE_JSON_OVERHEAD +
      JSON.stringify(file.path).length +
      JSON.stringify(file.reason).length;
    for (const side of UNSHELVE_ALLOCATION_ORDER) {
      const value = file[side];
      // A genuinely absent side stays absent: `null` in, `null` out, and no `elided` entry.
      if (value === null) {
        used += JSON_NULL;
        continue;
      }
      const keptCost = JSON.stringify(value).length;
      const cutCost = JSON_NULL + elisionCost(side, value.length);
      if (side !== 'theirs' && keptCost > sideCap) {
        // The per-side cap bounds only the sides another tool can fetch; `theirs` has no such
        // route, so it answers to the aggregate alone.
        elided[side] = value.length;
        sideCapFired = true;
        used += cutCost;
      } else if (keptCost <= cutCost) {
        // Reporting it cut would cost more than showing it: never a saving, so never cut.
        entry[side] = value;
        used += keptCost;
      } else {
        // Reserve what a cut would cost; keeping it later charges only the difference, so the
        // running total only ever rises toward what renders and a cut can never overshoot.
        contested.push([side, keptCost, cutCost]);
        used += cutCost;
      }
    }
    // The `elided` wrapper: certain once a side is cut, reserved while one might be, and given
    // back when the entry's last contested side is kept with nothing of it cut.
    if (Object.keys(elided).length > 0 || contested.length > 0) {
      used += UNSHELVE_ELIDED_WRAPPER_OVERHEAD;
    }
    return { file, entry, elided, contested };
  });

  for (const side of UNSHELVE_ALLOCATION_ORDER) {
    for (const p of planned) {
      const at = p.contested.findIndex(([s]) => s === side);
      if (at < 0) continue;
      const [, keptCost, cutCost] = p.contested[at]!;
      p.contested.splice(at, 1);
      const wrapperBack =
        p.contested.length === 0 && Object.keys(p.elided).length === 0
          ? UNSHELVE_ELIDED_WRAPPER_OVERHEAD
          : 0;
      const keepCost = keptCost - cutCost - wrapperBack;
      if (used + keepCost > totalBudget) {
        p.elided[side] = p.file[side]!.length;
        budgetFired = true;
        if (side === 'theirs') theirsCut = true;
        continue;
      }
      used += keepCost;
      p.entry[side] = p.file[side];
    }
  }

  const out = planned.map(({ entry, elided }) => {
    if (Object.keys(elided).length === 0) return entry;
    // Keys in a fixed order, whatever order the passes cut them in.
    const ordered: UnshelveSideElision = {};
    for (const side of ['base', 'ours', 'theirs'] as const) {
      if (elided[side] !== undefined) ordered[side] = elided[side];
    }
    return { ...entry, elided: ordered };
  });

  const baseHint =
    opts.baseRef && opts.baseRef !== 'unborn'
      ? `read_file with ref "${opts.baseRef}"`
      : 'read_file with a ref';
  const notes: string[] = [];
  if (droppedFiles > 0) {
    notes.push(
      `only the first ${maxFiles} of ${files.length} conflicting paths are detailed; every ` +
        `one of them is listed under "paths"`,
    );
  }
  if (sideCapFired) {
    notes.push(
      `a base or ours rendering to over ${sideCap} characters was elided — ours is the ` +
        `working tree (read_file), base is HEAD when the shelf was taken (${baseHint})`,
    );
  }
  // Named apart from the per-side cap, and only when it actually fired: reporting "a side was
  // too long" for a payload cut by the aggregate sends the reader looking for one big file that
  // is not there. Same rule conflictBudget.ts follows.
  if (budgetFired) {
    notes.push(
      `the ${totalBudget}-character total budget across every side of every file was reached, ` +
        `and sides are charged theirs first, then ours, then base, so what did not fit was ` +
        `elided — ours is the working tree ` +
        `(read_file), base is HEAD when the shelf was taken (${baseHint})` +
        (theirsCut
          ? '; a cut theirs is the shelved content itself, which no other tool can read — the ' +
            'shelf is intact and still holds it, and a later unshelve that applies writes it out'
          : ''),
    );
  }

  return {
    files: out,
    paths,
    truncated: droppedFiles > 0 || sideCapFired || budgetFired,
    note: notes.join('; '),
  };
}

/** What one shelved file's restore would do to the tree, decided from bytes alone. */
export type UnshelveVerdict =
  | { kind: 'apply' }
  | { kind: 'noop' }
  /** HEAD moved under a TEXT entry and the tree is clean: three-way merge the shelved change on. */
  | { kind: 'merge'; ours: string; base: string; theirs: string }
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
 *
 * **HEAD moved under the file: merge a text entry, refuse the rest.** Refusing every such file
 * wedged the shelf for good — the ordinary "shelve section B, pull a co-author's commit touching
 * it" case — because the only exit left was making the tree byte-equal to the shelved bytes,
 * which throws away every line HEAD gained, and no tool can read a shelf to do even that. So a
 * file whose base, shelved and current bytes are all TEXT (`asShadowContent`: no NUL, lossless
 * UTF-8 — the same test the shadow store's three-way merge rests on) and whose tree is clean is
 * returned as `merge`: the caller three-way merges base -> shelved onto the tree
 * ({@link resolveUnshelveFile}). The merge's `ours` is the TREE's bytes, not HEAD's blob: they
 * are what the write replaces, and `dirty === false` is git's own word — filters included — that
 * they are HEAD. Everything else stays `head-moved`: bytes that are not text are never merged
 * (there is no such thing as a merged PNG — the ShadowStore rule), and a side that is absent
 * (added or deleted on either end) has no text to merge, so picking a winner would be a guess.
 * A mergeable file over a DIRTY tree is `dirty`, not `head-moved`: the collision the caller has
 * to clear is the live edit, and once it is cleared the merge runs.
 */
export function planUnshelveFile(state: UnshelveFileState): UnshelveVerdict {
  const { base, shelved, current, headNow, dirty } = state;

  // Already what the shelf would write — including "already absent" for a shelved deletion.
  if (bytesEqual(current, shelved)) return { kind: 'noop' };

  // HEAD moved UNDER THIS FILE, so the shelved edit no longer applies to what it was made
  // against. Both sides are blob bytes here, so this comparison is filter-free and exact; a HEAD
  // that advanced without touching this path compares equal and is correctly not a conflict.
  if (!bytesEqual(headNow, base)) {
    const b = asShadowContent(base);
    const t = asShadowContent(shelved);
    const o = asShadowContent(current);
    const mergeable =
      headNow !== null && typeof b === 'string' && typeof t === 'string' && typeof o === 'string';
    if (!mergeable) return { kind: 'conflict', reason: 'head-moved' };
    if (dirty) return { kind: 'conflict', reason: 'dirty' };
    return { kind: 'merge', ours: o, base: b, theirs: t };
  }

  // Untracked when shelved: the shelve removed the path, so anything present now is live work
  // that `git status` may or may not be willing to mention. See the doc comment.
  if (base === null && current !== null) return { kind: 'conflict', reason: 'dirty' };

  if (dirty) return { kind: 'conflict', reason: 'dirty' };
  return { kind: 'apply' };
}

/** The three-way merge `unshelve` runs — `merge3` (`src/lib/merge3.ts`, `git merge-file`), the
 *  primitive ShadowStore's `refresh`/`record` use, injected so this module stays pure. */
export type UnshelveMerge = (ours: string, base: string, theirs: string) => Promise<Merge3Result>;

/** What `unshelve` does with one file, once any merge has run. */
export type UnshelveResolution =
  | {
      kind: 'restore';
      /** The bytes to leave at the path; `null` = remove it (a shelved deletion). */
      bytes: Buffer | null;
      /**
       * The `before` to hand `ShadowStore.record` (with `after` = `bytes`), so the change this
       * session is recorded as owning is exactly the shelved edit — nothing of HEAD's, nothing
       * of a peer's. See {@link resolveUnshelveFile}.
       */
      recordBefore: Buffer | null;
      /** True when the bytes are a three-way merge rather than the shelf's own. */
      merged: boolean;
    }
  | { kind: 'conflict'; reason: UnshelveConflictReason };

/**
 * {@link planUnshelveFile}, with the merge it asks for actually run.
 *
 * **What the session is recorded as owning.** For an ordinary restore and a no-op, `recordBefore`
 * is the shelf's BASE, so the recorded change is base -> shelved, exactly the shelved edit (on an
 * applied restore the base IS what the tree held; on a no-op the tree already holds the shelved
 * bytes, and recording tree -> tree would record nothing and leave the lines out of a session
 * commit). For a MERGE it is the TREE's bytes as they stood — which the clean dirty check proved
 * are HEAD — and NOT the base: the settled shadow starts at the new HEAD, so recording
 * HEAD -> merged hands it the shelved lines and nothing else, while recording base -> merged
 * would make the shadow re-merge a change that already contains HEAD's new lines against a base
 * HEAD has moved past, which can collide on the very lines the merge just placed side by side.
 *
 * A collision (`git merge-file` reports conflicts) is `head-moved`, and no markers are ever
 * written: the caller gets base/ours/theirs, and the shelf stays intact.
 */
export async function resolveUnshelveFile(
  state: UnshelveFileState,
  merge: UnshelveMerge,
): Promise<UnshelveResolution> {
  const verdict = planUnshelveFile(state);
  switch (verdict.kind) {
    case 'conflict':
      return verdict;
    case 'apply':
    case 'noop':
      return { kind: 'restore', bytes: state.shelved, recordBefore: state.base, merged: false };
    case 'merge': {
      const { merged, conflicted } = await merge(verdict.ours, verdict.base, verdict.theirs);
      if (conflicted) return { kind: 'conflict', reason: 'head-moved' };
      return {
        kind: 'restore',
        bytes: Buffer.from(merged, 'utf8'),
        recordBefore: state.current,
        merged: true,
      };
    }
  }
}

/** Byte equality where `null` (absent) is a value distinct from empty. */
export function bytesEqual(a: Buffer | null, b: Buffer | null): boolean {
  if (a === null || b === null) return a === b;
  return a.equals(b);
}
