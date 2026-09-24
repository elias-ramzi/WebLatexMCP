import path from 'node:path';
import { mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { merge3 } from '../lib/merge3.js';
import { sessionDir, sessionStateDir } from '../lib/sessionPaths.js';
import { toPosix } from '../lib/paths.js';
import { coversPath } from '../lib/commitPaths.js';
import { foldCase } from '../lib/caseFold.js';
import { writeAtomic } from './sessionRegistry.js';

/**
 * Reads a path out of the clone's HEAD commit, as raw bytes. Injected so the store never depends
 * on GitService (which depends on nothing here), and so tests can drive it without a repository.
 * Returning bytes (rather than a decoded string) is what lets the store hold a binary shadow
 * (e.g. a PNG) byte-identically instead of mangling it through a UTF-8 round trip.
 */
export type HeadReader = (projectDir: string, relPath: string) => Promise<Buffer | null>;

/**
 * The blob id `bytes` would get if committed at `relPath` in `projectDir` — clean filter applied,
 * nothing written. Injected (rather than importing `GitService` directly) for the same reason
 * `HeadReader` is: this store stays independent of git, and tests can drive it without a
 * repository. See `GitService.cleanBlobId`, and the class doc comment below, for why the store
 * needs this at all.
 */
export type CleanHasher = (projectDir: string, relPath: string, bytes: Buffer) => Promise<string>;

/**
 * The commit sha HEAD currently points at, or the literal `'unborn'` when the project has no
 * commit yet — never throws. Injected for the same reason `HeadReader`/`CleanHasher` are: the
 * store stays independent of `GitService`, and tests can drive it without a repository. This is
 * what lets `refresh` memoise a conflicted verdict: see the class doc comment and `refresh`.
 */
export type HeadShaReader = (projectDir: string) => Promise<string>;

/** One file this session has changed, as tracked on disk. */
interface ShadowIndexEntry {
  /** True when this session's change to the file is its deletion. */
  deleted: boolean;
  /** True when the file existed in the HEAD the shadow is based on. */
  baseExists: boolean;
  /**
   * Set when moving the shadow onto a new HEAD hit a genuine conflict — this session and a
   * commit both changed the same lines. The shadow is left as it was, and the file is excluded
   * from commits until the conflict is dealt with.
   */
  conflicted?: boolean;
  /**
   * The commit sha HEAD had when `refresh` last judged this entry conflicted. While HEAD is still
   * that commit, the verdict cannot have changed — `record` early-returns on `conflicted`
   * (leaving the shadow and base exactly as they were) and `refresh` writes nothing on either
   * conflicting branch — so `refresh` skips recomputing it: no HEAD blob read, no shadow read, no
   * merge, no `sameAsGitSees` spawn. Absent on entries written before this field existed (simply
   * re-evaluated once, which then sets it) and on a `record`-time collision: set only by a
   * persisting `refresh`, and only on its three conflicting branches. A `record`-time collision
   * never gets one at all — it is `incomplete`, which `refresh` skips before the memo check, as it
   * does an `unrecorded` entry — and neither does an entry that becomes `incomplete` later: once
   * set, `refresh` never re-judges it, so the stale memo is inert. Cleared wherever `conflicted`
   * is cleared.
   */
  conflictHead?: string;
  /**
   * When this session last wrote the file, ISO 8601. Set on every `record` call — including the
   * conflicted early return, since the session did write the file even though the shadow could
   * not fold it in. Never touched by `refresh`: that rewrites shadow files and the index on every
   * HEAD move regardless of whether this session wrote anything, which is exactly why on-disk
   * mtimes are not a usable write signal either. Absent on indexes written before this field
   * existed; such entries parse as `touchedAt: null` via `peerEntries`.
   */
  touchedAt?: string;
  /**
   * True once this session has written non-text bytes to the file. A binary shadow is never
   * three-way merged — there is no such thing as a merged PNG — so a collision is reported
   * rather than resolved. Absent on indexes written before this field existed, which parse as
   * text, matching how those entries were actually stored.
   */
  binary?: boolean;
  /**
   * Set when a write reached the working tree but its shadow record failed (`touch`/`record`
   * threw — an unreadable HEAD, an unwritable `.sessions/` dir, …), so the shadow does not hold
   * this session's latest change to the file. Always paired with `conflicted`, which is what
   * actually keeps the entry sticky and excluded from commits — this flag only distinguishes the
   * two causes ("a peer's commit landed on the same lines" vs. "this session's own record
   * failed") in messages shown to the caller.
   */
  unrecorded?: boolean;
  /**
   * Set when `record` could not fold one of this session's writes into the shadow even though the
   * record itself succeeded: a record-time collision (the write rewrote lines a peer had already
   * changed in the working tree, so there is no honest merge) or a write that landed while the
   * entry was already `conflicted` (its base is stale, so nothing can be folded in). Either way the
   * shadow no longer holds this session's latest change to the file — the same known-incomplete
   * state `unrecorded` describes, reached by a different cause — so `refresh` treats it exactly as
   * it treats `unrecorded`: it never advances, settles or re-judges the entry, because "the stale
   * shadow merges cleanly onto the new HEAD" and "HEAD equals the shadow" are both statements
   * about a shadow that lacks the write. Clearing the flag there made the missing write owned by
   * nobody, so a live peer's `commit scope: "paths"` took it. Always paired with `conflicted`.
   *
   * A separate flag rather than `unrecorded`, because `commit` reports `unrecorded` entries as
   * "this session's own record failed" (and lists them under `unrecorded`), which is not what
   * happened here: the record succeeded and found a collision — `commit`'s "collided" wording is
   * the true one. Only a deliberate take (`settle`/`clear`: commit scope "all"/"paths") or a
   * discard (`settleAll`/`clearAll`) ends this state, by dropping the entry.
   *
   * A `conflicted` entry WITHOUT this flag was flagged by `refresh` alone and received no write
   * since, so its shadow still holds every write this session made (only its base is stale):
   * `refresh` may still advance or settle it once HEAD moves so that the merge is clean or lands
   * on the shadow — that is a verdict about a complete shadow, and it is the right one.
   */
  incomplete?: boolean;
}

interface ShadowIndex {
  /**
   * Keyed by project-relative path — a name the project's author chose — so this map is ALWAYS a
   * null-prototype object (`entryMap`), never a `{}` literal: on an ordinary object a file named
   * `constructor`/`toString` read back an inherited function as its "existing entry" (then dropped
   * by `JSON.stringify`), and one named `__proto__` read back `Object.prototype` itself, which
   * `record` then stamped `touchedAt`/`binary`/... onto — polluting every object in the process —
   * while the entry was lost. On disk it stays a plain JSON object; only the in-memory copy changes.
   */
  entries: Record<string, ShadowIndexEntry>;
}

/**
 * A null-prototype copy of `from`'s own enumerable entries (or an empty one) — the only way a
 * `ShadowIndex.entries` map is ever built. `JSON.parse` keeps a `"__proto__"` key as an own
 * property but returns an ordinary object, so a loaded index is copied key by key; assignment into
 * a null-prototype target defines `__proto__` as a plain data property rather than reaching a setter.
 */
function entryMap(from?: object): Record<string, ShadowIndexEntry> {
  const out = Object.create(null) as Record<string, ShadowIndexEntry>;
  if (from) {
    for (const [key, value] of Object.entries(from)) out[key] = value as ShadowIndexEntry;
  }
  return out;
}

/** One entry of a session's shadow index, as read by a peer — no lock, no content resolved. */
export interface PeerShadowEntry {
  path: string;
  deleted: boolean;
  conflicted: boolean;
  touchedAt: string | null;
}

/** A file this session has changed, with content resolved. */
export interface ShadowChange {
  path: string;
  /**
   * The file as it would be with only this session's edits — null when this session deleted it.
   * A binary entry (`binary: true`) yields a `Buffer`; a text entry yields a `string`, exactly as
   * before this type widened.
   */
  content: string | Buffer | null;
  /** The HEAD content the change is expressed against — null when the file is new. */
  base: string | Buffer | null;
  conflicted: boolean;
  /** True when this file's shadow holds raw bytes rather than text — see `ShadowIndexEntry.binary`. */
  binary: boolean;
  /** True when this session's latest change to the file could not be recorded — see `markUnrecorded`. */
  unrecorded: boolean;
}

export interface RefreshResult {
  /** Files whose shadow was successfully carried onto the new HEAD. */
  advanced: string[];
  /**
   * Files left flagged: where this session's edits and a commit touched the same lines, plus every
   * `unrecorded` or `incomplete` entry, which `refresh` skips without reading HEAD (see
   * `judgeEntry`).
   */
  conflicted: string[];
  /** Files dropped because the session's change is now part of HEAD (typically its own commit). */
  settled: string[];
}

/**
 * What a refresh decides for one entry (`ShadowStore.judge`). `conflicted` with `flag: false`
 * reports an entry that is already flagged and must be left exactly as it is (unrecorded,
 * incomplete, or a memo hit); `flag: true` is a fresh verdict to write, stamping `conflictHead`
 * when HEAD's sha is known.
 */
type Verdict =
  | { kind: 'keep' }
  | { kind: 'settled' }
  | { kind: 'conflicted'; flag: false }
  | { kind: 'conflicted'; flag: true; headSha: string | undefined }
  | { kind: 'advanced'; shadow: Buffer; base: Buffer };

/**
 * Serialises every read-modify-write of one shadow index within this process, keyed by the
 * session directory that holds it. Module-level, not per instance: two `ShadowStore`s in one
 * process (two sessions' contexts, as the integration tests build them) write each other's indexes
 * through `settleAll`, so a per-instance mutex would not see the other's writes. Across processes
 * the project's `runExclusive` lock is what serialises writers — every index writer runs under it,
 * and the one lock-free reader (`status`) goes through `refreshedChanges`, which writes nothing.
 */
const indexLocks = new Map<string, Promise<unknown>>();

async function withIndexLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(dir);
  const prior = indexLocks.get(key) ?? Promise.resolve();
  const run = prior.then(fn, fn);
  // The chain continues whether `fn` resolves or rejects; the caller still sees its own outcome.
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  indexLocks.set(key, tail);
  try {
    return await run;
  } finally {
    // Drop the key once nothing is queued behind this call, so the map does not grow forever.
    if (indexLocks.get(key) === tail) indexLocks.delete(key);
  }
}

/**
 * Tracks, per session, *which changes in the shared clone are that session's own*.
 *
 * Several agent sessions edit one working tree, so `git diff` conflates everybody's in-flight
 * work and `git add` would sweep up a peer's half-written paragraph. This store keeps a parallel
 * copy of each touched file holding `HEAD + only this session's edits` — its shadow — which
 * `commit` stages directly. That is what makes a commit contain one session's lines and leave
 * everyone else's uncommitted.
 *
 * The invariant, per tracked file, is:
 *
 *     shadow == the file at `base`, plus only this session's edits
 *     base   == the file's content at the HEAD the shadow was last carried onto
 *
 * `record` maintains it as edits land, `refresh` restores it after HEAD moves (a peer's commit, a
 * pull, a rebase). Both do so by three-way merge, never by guessing which hunk belongs to whom.
 *
 * Equality between HEAD/shadow/working-tree bytes is judged *through the path's clean filter*,
 * not just raw byte comparison, because `commit`'s session scope stages via
 * `GitService.commitContents`, which writes each blob with `git hash-object --path` — so a clone
 * whose `.gitattributes` normalises a path (e.g. `* text=auto` turning a CRLF `.svg` into LF)
 * ends up with a HEAD blob that differs, byte-for-byte, from what this session's shadow holds,
 * even though nobody else touched the file. Raw comparison then read that as a peer's change and
 * flagged the entry `conflicted` — sticky, so it never cleared (#63). `sameAsGitSees` (below) asks
 * git what blob id the bytes would get at that path; two byte strings with the same id are the
 * same content *as git will store it*. This is consulted only as a fallback after raw equality
 * already failed, and only when a `CleanHasher` is wired — see `sameAsGitSees`. The invariant
 * itself is unchanged, and nothing here weakens it: a genuine collision (different content even
 * after normalisation) still conflicts, a binary shadow is still never three-way merged, and
 * `conflicted` still stays sticky once set.
 *
 * The fallback trusts whatever clean filter the path actually has, not only a `text`/`eol`
 * normaliser: a lossy custom `filter=` driver (e.g. one that strips a generated section before
 * hashing) makes two contents equal here exactly when it would make them equal in the commit —
 * which is the honest answer, since nothing else could ever be committed for that path either.
 */
export class ShadowStore {
  constructor(
    private readonly workspaceRoot: string,
    readonly sessionId: string,
    private readonly readHead: HeadReader,
    private readonly now: () => number = Date.now,
    private readonly cleanHash?: CleanHasher,
    private readonly resolveHeadSha?: HeadShaReader,
    /**
     * Whether the clone at `projectDir` has `core.ignorecase` set (see
     * `GitService.isCaseInsensitive`). On such a clone two spellings of one name are one file —
     * and one shadow: `shadow/<rel>` and `base/<rel>` live on the same filesystem, where
     * `shadow/notes.txt` IS `shadow/Notes.txt`, so a second entry keyed by the other spelling
     * silently overwrote the first's shadow with HEAD's bytes (macOS CI). `record` therefore
     * folds a new key onto an existing entry that differs only in ASCII case, so two such keys
     * never coexist. Optional and injected like the other git-facing hooks; absent means
     * byte-exact keys.
     */
    private readonly isCaseInsensitive?: (projectDir: string) => Promise<boolean>,
  ) {}

  /** `isCaseInsensitive`'s last answer per project, so `markUnrecorded` (no dir) can reuse it. */
  private readonly insensitiveByProject = new Map<string, boolean>();

  private async caseInsensitive(projectId: string, projectDir: string): Promise<boolean> {
    if (!this.isCaseInsensitive) return false;
    try {
      const answer = await this.isCaseInsensitive(projectDir);
      this.insensitiveByProject.set(projectId, answer);
      return answer;
    } catch {
      // Unanswerable — keys stay byte-exact for this call, which only ever creates a separate
      // entry, never loses one.
      return this.insensitiveByProject.get(projectId) ?? false;
    }
  }

  /**
   * The index key `rel` belongs to: `rel` itself when the index holds it or the clone is
   * case-sensitive; otherwise an existing key equal to it under git's ASCII fold, if any.
   */
  private entryKey(index: ShadowIndex, rel: string, insensitive: boolean): string {
    if (!insensitive || index.entries[rel]) return rel;
    const folded = foldCase(rel);
    return Object.keys(index.entries).find((k) => foldCase(k) === folded) ?? rel;
  }

  /**
   * Whether `a` and `b` are the same content *as git would store it* at `rel` — i.e. they clean-
   * filter to the same blob id — used only as a fallback once a raw byte/string comparison has
   * already failed. Returns `false` outright when no `CleanHasher` was wired (byte-exact behaviour
   * is preserved for every caller that does not supply one, including every existing test). Spawns
   * git twice, so callers must only reach this after the cheap raw comparison has already missed.
   */
  private async sameAsGitSees(
    projectDir: string,
    rel: string,
    a: Buffer,
    b: Buffer,
  ): Promise<boolean> {
    if (!this.cleanHash) return false;
    try {
      const [idA, idB] = await Promise.all([
        this.cleanHash(projectDir, rel, a),
        this.cleanHash(projectDir, rel, b),
      ]);
      return idA === idB;
    } catch (err) {
      // A git hiccup here (e.g. a `.gitattributes` naming an uninstalled `filter=` driver) must
      // not turn into a sticky conflict, nor fail whatever caller asked (`refresh`/`record`, and
      // transitively `status`/`commit`) — it means only "we cannot vouch these are the same", the
      // same byte-exact answer as when no hasher is wired at all.
      console.error(
        `[web-latex-mcp] could not clean-filter "${rel}" to compare shadow content — treating ` +
          `as changed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Fold a mutation this session just made into its shadow.
   *
   * `before`/`after` are the working-tree content either side of the change (null meaning the
   * file was absent). The shadow gets the *change*, not the result: `after` includes whatever
   * peers had already written into the working tree, so applying it wholesale would silently
   * adopt their lines. Merging `before -> after` onto the shadow applies only what we did.
   */
  async record(
    projectId: string,
    projectDir: string,
    relPath: string,
    before: string | Buffer | null,
    after: string | Buffer | null,
  ): Promise<void> {
    await withIndexLock(this.dir(projectId), () =>
      this.recordLocked(projectId, projectDir, relPath, before, after),
    );
  }

  private async recordLocked(
    projectId: string,
    projectDir: string,
    relPath: string,
    before: string | Buffer | null,
    after: string | Buffer | null,
  ): Promise<void> {
    const index = await this.readIndex(projectId);
    const rel = this.entryKey(
      index,
      toPosix(relPath),
      await this.caseInsensitive(projectId, projectDir),
    );
    let entry = index.entries[rel];
    const isBinaryChange = Buffer.isBuffer(before) || Buffer.isBuffer(after);

    if (!entry) {
      // First touch: anchor to HEAD, and start the shadow at the same content.
      const head = await this.readHead(projectDir, rel);
      entry = { deleted: false, baseExists: head !== null, binary: isBinaryChange };
      await this.writeBase(projectId, rel, head);
      await this.writeShadow(projectId, rel, head);
    }

    // The session did write the file on every call that reaches here, including the conflicted
    // branch below where the shadow itself cannot be updated — so this is set unconditionally,
    // before that branch's early return.
    entry.touchedAt = new Date(this.now()).toISOString();

    // Sticky: once a path has carried binary bytes it stays binary for the life of the entry —
    // a later text write to the same path (unlikely, but not impossible) must not fall back to
    // three-way text merging, which would treat the bytes as UTF-8 and corrupt them.
    entry.binary = entry.binary === true || isBinaryChange;

    if (entry.conflicted) {
      // Once a file is conflicted its shadow is anchored to a base that HEAD has moved past, so
      // no further edit can be folded in safely: committing it would revert whatever landed in
      // between. It stays flagged until the session resolves it deliberately (commit scope
      // "all", or discard) — see `commit`'s error message. The write itself is left out of the
      // shadow, so the shadow is now incomplete (unless the write changed nothing at all) —
      // which is what stops a later `refresh` from clearing the flag (see `incomplete`).
      if (!sameContent(before, after)) entry.incomplete = true;
      index.entries[rel] = entry;
      await this.writeIndex(projectId, index);
      return;
    }

    if (after === null) {
      // A deletion is not mergeable — record it as this session's change outright.
      entry.deleted = true;
      entry.conflicted = false;
      delete entry.conflictHead;
      await this.removeShadow(projectId, rel);
    } else if (entry.binary) {
      // Binary content has no honest merge — there is no such thing as a merged PNG. A peer
      // changing the bytes under us (the working-tree bytes we started from no longer match what
      // we last wrote as the shadow) is reported as a collision, exactly like the text path
      // reports an unmergeable one, rather than silently adopting either side.
      const shadow = entry.deleted ? null : await this.readShadow(projectId, rel);
      const shadowBuf = shadow === null ? null : toBuffer(shadow);
      const beforeBuf = before === null ? null : toBuffer(before);
      // A text-tool write (write_file/edit_file) reads the working tree as a *string*, even on a
      // path whose shadow is sticky-binary — so `before` arrives here as the UTF-8 decoding of
      // whatever bytes are on disk, which is LOSSY when those bytes are not valid UTF-8 (every
      // invalid byte becomes U+FFFD). Comparing that string, re-encoded, against the true shadow
      // bytes can then never match even though nothing actually conflicts — the bytes we started
      // from are exactly the shadow's. So when `before` arrived as a string, also accept a match
      // by decoding the *shadow* the same lossy way and comparing strings: that is honest, because
      // `after` is a string too, and `toBuffer(after)` below re-encodes exactly what the text tool
      // wrote — only the comparison was lossy, never the write. A Buffer `before` never takes this
      // branch, so a genuine byte-level collision between two binary writers still conflicts.
      let beforeMatchesShadow =
        shadowBuf === null ||
        beforeBuf === null ||
        shadowBuf.equals(beforeBuf) ||
        (typeof before === 'string' && shadowBuf.toString('utf8') === before);
      // Raw comparison failed: as a fallback, ask git whether the two sides would clean-filter to
      // the same blob (e.g. a clone-wide `* text=auto` normalising CRLF to LF) — see the class doc
      // comment and `sameAsGitSees`. Only reached with both sides present, so this never fires on
      // the common (equal, or plainly new-file) path.
      if (!beforeMatchesShadow && shadowBuf !== null && beforeBuf !== null) {
        beforeMatchesShadow = await this.sameAsGitSees(projectDir, rel, shadowBuf, beforeBuf);
      }
      if (beforeMatchesShadow) {
        entry.deleted = false;
        entry.conflicted = false;
        delete entry.conflictHead;
        await this.writeShadow(projectId, rel, toBuffer(after));
      } else {
        // The write is left out of the shadow — see `incomplete`.
        entry.conflicted = true;
        entry.incomplete = true;
      }
    } else {
      const shadow = entry.deleted ? null : await this.readShadow(projectId, rel);
      const shadowStr = shadow === null ? null : shadow.toString('utf8');
      const beforeStr = before === null ? null : before.toString('utf8');
      const afterStr = after.toString('utf8');
      let directApply = shadowStr === null || beforeStr === null || shadowStr === beforeStr;
      // Raw string comparison failed: fall back to clean-filtered equality, exactly as the binary
      // branch does — a CRLF `.tex` on a clone with `* text=auto` normalises to the same LF blob,
      // which means the working tree held no peer lines, so applying `after` directly is honest.
      if (!directApply && shadow !== null && before !== null) {
        directApply = await this.sameAsGitSees(projectDir, rel, shadow, toBuffer(before));
      }
      if (directApply) {
        // Nothing to reconcile: a new file, one we are re-creating, a working tree that has not
        // diverged from our shadow, or one that has diverged only in a way git's clean filter
        // erases — the edit applies to the shadow directly.
        entry.deleted = false;
        entry.conflicted = false;
        delete entry.conflictHead;
        await this.writeShadow(projectId, rel, Buffer.from(afterStr, 'utf8'));
      } else if (shadowStr !== null && beforeStr !== null) {
        // Re-checked (rather than asserted) so the compiler can narrow these to `string`:
        // `directApply` is false here only when both were already non-null and unequal.
        const { merged, conflicted } = await merge3(shadowStr, beforeStr, afterStr);
        if (conflicted) {
          // This session just edited lines a peer had already changed in the working tree. There
          // is no honest way to say which of the two the shadow should hold, so we keep it as it
          // was and flag the file — writing markers into the shadow would commit them. The write
          // is therefore missing from the shadow: `incomplete`, so no `refresh` clears the flag.
          entry.conflicted = true;
          entry.incomplete = true;
        } else {
          entry.deleted = false;
          entry.conflicted = false;
          delete entry.conflictHead;
          await this.writeShadow(projectId, rel, Buffer.from(merged, 'utf8'));
        }
      }
    }

    index.entries[rel] = entry;
    await this.writeIndex(projectId, index);
  }

  /**
   * Flag a path as having a write that reached the working tree but could not be folded into the
   * shadow (`touch` or `record` threw). Called by the mutation recorder's own failure path
   * (`src/lib/mutationRecorder.ts`), never by `record` itself.
   *
   * Takes whatever entry already exists — preserving its `binary`/`deleted`/`baseExists` — or
   * creates a bare one (`baseExists: false`) for a path this session had not touched before, since
   * a write can fail to record on its very first touch. Either way the entry ends up `conflicted`
   * (the flag that actually excludes it from commits and keeps it sticky — see the class doc
   * comment) and `unrecorded` (which only distinguishes *why*, in messages). `touchedAt` is
   * stamped too, since the session did write the file.
   */
  async markUnrecorded(projectId: string, relPath: string): Promise<void> {
    await withIndexLock(this.dir(projectId), async () => {
      const index = await this.readIndex(projectId);
      const rel = this.entryKey(
        index,
        toPosix(relPath),
        this.insensitiveByProject.get(projectId) ?? false,
      );
      const entry: ShadowIndexEntry = index.entries[rel] ?? { deleted: false, baseExists: false };
      entry.conflicted = true;
      entry.unrecorded = true;
      entry.touchedAt = new Date(this.now()).toISOString();
      index.entries[rel] = entry;
      await this.writeIndex(projectId, index);
    });
  }

  /** Every change this session currently owns, resolved to content. */
  async changes(projectId: string): Promise<ShadowChange[]> {
    const index = await this.readIndex(projectId);
    const out: ShadowChange[] = [];
    for (const [rel, entry] of Object.entries(index.entries)) {
      const shadow = entry.deleted ? null : await this.readShadow(projectId, rel);
      const base = entry.baseExists ? await this.readBase(projectId, rel) : null;
      out.push(this.toChange(rel, entry, shadow, base));
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** One entry resolved to a `ShadowChange` — shared by `changes` and `refreshedChanges`. */
  private toChange(
    rel: string,
    entry: ShadowIndexEntry,
    shadow: Buffer | null,
    base: Buffer | null,
  ): ShadowChange {
    const binary = entry.binary === true;
    return {
      path: rel,
      content: binary ? shadow : (shadow?.toString('utf8') ?? null),
      base: binary ? base : (base?.toString('utf8') ?? null),
      // Belt and braces: an unrecorded or incomplete entry is reported conflicted regardless of
      // the raw flag, so no future code path that clears `conflicted` can make it look committable.
      conflicted: isFlagged(entry),
      binary,
      unrecorded: entry.unrecorded === true,
    };
  }

  /** Whether this session is tracking any change at all (drives `commit`'s default scope). */
  async hasChanges(projectId: string): Promise<boolean> {
    return Object.keys((await this.readIndex(projectId)).entries).length > 0;
  }

  /**
   * Reads another session's shadow index directly — no lock, no file content resolved — for a
   * peer that needs to know *what* a live session owns without touching it (the push ownership
   * guard, `status`). Works for the caller's own session id too.
   *
   * A session directory that does not exist yet (no edits recorded) is not an error: it returns
   * `[]`. Anything else that stops the index from being read as intended — a read error other
   * than "not found", invalid JSON, or a parsed value with no `entries` object — returns `null`.
   *
   * **`null` means unreadable, not "owns nothing".** Callers must fail closed: treat a `null`
   * result the same as if the session owned every file in question, exactly as an unrecoverable
   * shadow already refuses to let `commit` proceed. Never coerce `null` to `[]`.
   *
   * **And `[]` means "nothing is recorded here", which is weaker than "this session changed
   * nothing".** ENOENT and a successfully-read empty index deliberately collapse to the same
   * value, so `[]` also covers the session whose write reached the working tree while the index
   * write itself failed (a full or unwritable `.sessions/`) before it could be marked
   * `unrecorded` — its dirty lines are in the tree with no entry naming them. That is safe for
   * every ownership guard, which only ever asks whether a peer owns a path and must not treat an
   * absent claim as permission for anything it would refuse otherwise; it is *not* safe for a
   * caller that wants to report "this session holds no changes" as a fact. The one such caller is
   * `status`'s stale-peer collapse, which is why `isStalePeer` (`src/lib/peerSummary.ts`) also
   * requires the peer to have been quiet past `RECENT_HEARTBEAT_GRACE_MS` before it believes an
   * empty index. A new caller that wants to distinguish the two must teach this method to say so
   * — never infer it from `[]`.
   */
  async peerEntries(projectId: string, sessionId: string): Promise<PeerShadowEntry[] | null> {
    const file = path.join(sessionDir(this.workspaceRoot, projectId, sessionId), 'shadow.json');
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!isShadowIndexShape(parsed)) return null;

    return Object.entries(parsed.entries)
      .map(([p, entry]) => ({
        path: p,
        deleted: entry.deleted === true,
        // Belt and braces, matching `changes()`: an unrecorded or incomplete entry is reported
        // conflicted regardless of the raw flag, so no future code path that clears `conflicted`
        // can make a peer treat it as safe to route around.
        conflicted: isFlagged(entry),
        touchedAt: entry.touchedAt ?? null,
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * Carry every tracked shadow onto the current HEAD, and write the result back.
   *
   * Call after anything that moves HEAD or rewrites the tree — this session committing, a peer
   * committing, a pull, a rebase — and **only while holding the project's `runExclusive` lock**:
   * this is a read-modify-write of the shadow index, and the lock is what keeps a peer process's
   * `record`/`settleAll` from landing between the read and the write (the in-process index mutex
   * below covers this process only). A lock-free caller wants `refreshedChanges`, which computes
   * the same picture and writes nothing.
   *
   * Files whose change is now in HEAD stop being tracked; files where HEAD and this session
   * changed the same lines are marked conflicted and left alone, so nothing is resolved on the
   * session's behalf. An `unrecorded` or `incomplete` entry is skipped entirely — its shadow is
   * known not to hold every write this session made, so neither a clean merge nor "HEAD equals
   * the shadow" says anything about it — and reported under `conflicted` as it was. An entry that
   * is neither, and not conflicted, is also settled while HEAD has not moved when its shadow
   * already equals HEAD (an edit reverted to the original text, or a file created and deleted
   * again): there is nothing of it left to commit, and keeping it would claim the path forever.
   *
   * A conflicted entry whose `conflictHead` still matches the current HEAD is reported without
   * re-reading HEAD's blob, re-reading the shadow, re-running `merge3`, or spawning
   * `sameAsGitSees` — that verdict cannot have changed since HEAD has not moved and neither
   * `record` nor `refresh` touch a conflicted entry's shadow/base (see `ShadowIndexEntry.conflictHead`).
   * HEAD's sha is resolved at most once per call, before the loop, when a `HeadShaReader` is
   * wired.
   */
  async refresh(projectId: string, projectDir: string): Promise<RefreshResult> {
    return withIndexLock(this.dir(projectId), async () => {
      const index = await this.readIndex(projectId);
      const verdicts = await this.judge(projectId, projectDir, index);
      const result: RefreshResult = { advanced: [], conflicted: [], settled: [] };
      let changed = false;

      for (const [rel, verdict] of verdicts) {
        const entry = index.entries[rel] as ShadowIndexEntry;
        switch (verdict.kind) {
          case 'keep':
            break;
          case 'conflicted':
            result.conflicted.push(rel);
            if (verdict.flag) {
              entry.conflicted = true;
              if (verdict.headSha !== undefined) entry.conflictHead = verdict.headSha;
              changed = true;
            }
            break;
          case 'settled':
            // Our change is what landed — there is nothing left of it to commit.
            await this.forget(projectId, rel);
            delete index.entries[rel];
            result.settled.push(rel);
            changed = true;
            break;
          case 'advanced':
            await this.writeShadow(projectId, rel, verdict.shadow);
            await this.writeBase(projectId, rel, verdict.base);
            entry.baseExists = true;
            entry.conflicted = false;
            delete entry.conflictHead;
            result.advanced.push(rel);
            changed = true;
            break;
        }
      }

      if (changed) await this.writeIndex(projectId, index);
      return result;
    });
  }

  /**
   * What `changes()` would return right after a `refresh()` — computed from the same verdicts,
   * but **writing nothing**: no index, no shadow, no base, no `conflictHead` memo.
   *
   * For `status`, which is read-only and takes no project lock. A persisting refresh there was a
   * read-modify-write of the index with git spawns in the middle and no lock around it: it wrote
   * back the index it had read, so a `record` from this session's own concurrent write was lost
   * (the file then showed as nobody's), and — across processes — an entry a peer's path-limited
   * `discard` had just settled under its lock was resurrected. Only callers holding
   * `runExclusive` may write the index; the picture here is carried forward for real by the next
   * `commit`/`push`/`project_sync`, which refresh under the lock before acting.
   */
  async refreshedChanges(projectId: string, projectDir: string): Promise<ShadowChange[]> {
    // The in-process mutex, not the project lock: it only keeps this read from interleaving with
    // this process's own shadow/base writes, so the view never pairs a new index with a
    // half-written shadow file.
    return withIndexLock(this.dir(projectId), async () => {
      const index = await this.readIndex(projectId);
      const verdicts = await this.judge(projectId, projectDir, index);
      const out: ShadowChange[] = [];
      for (const [rel, verdict] of verdicts) {
        const entry = index.entries[rel] as ShadowIndexEntry;
        if (verdict.kind === 'settled') continue;
        if (verdict.kind === 'advanced') {
          out.push(
            this.toChange(rel, { ...entry, conflicted: false }, verdict.shadow, verdict.base),
          );
          continue;
        }
        const flagged = verdict.kind === 'conflicted' ? { ...entry, conflicted: true } : entry;
        out.push(
          this.toChange(
            rel,
            flagged,
            entry.deleted ? null : await this.readShadow(projectId, rel),
            entry.baseExists ? await this.readBase(projectId, rel) : null,
          ),
        );
      }
      return out.sort((a, b) => a.path.localeCompare(b.path));
    });
  }

  /**
   * The per-entry verdicts a refresh reaches, computed without writing anything — shared by
   * `refresh` (which applies them) and `refreshedChanges` (which only reports them), so the two
   * can never disagree about what a refresh would do.
   */
  private async judge(
    projectId: string,
    projectDir: string,
    index: ShadowIndex,
  ): Promise<Array<[string, Verdict]>> {
    const headSha = this.resolveHeadSha ? await this.resolveHeadSha(projectDir) : undefined;
    const out: Array<[string, Verdict]> = [];

    for (const [rel, entry] of Object.entries(index.entries)) {
      out.push([rel, await this.judgeEntry(projectId, projectDir, rel, entry, headSha)]);
    }
    return out;
  }

  private async judgeEntry(
    projectId: string,
    projectDir: string,
    rel: string,
    entry: ShadowIndexEntry,
    headSha: string | undefined,
  ): Promise<Verdict> {
    if (entry.unrecorded === true || entry.incomplete === true) {
      // This session's latest write to the file never made it into the shadow — its record
      // failed (`markUnrecorded`), or `record` could not fold it in (`incomplete`: a record-time
      // collision, or a write while already conflicted). A three-way merge onto a new HEAD only
      // tells us the *shadow* reconciles cleanly — it says nothing about the write that is
      // missing from it — and "HEAD equals the shadow" would be true only by ignoring that same
      // gap. Either way, resolving anything here risks either reverting the session's own edit
      // (advanced) or silently dropping its claim on an uncommitted change (settled/forgotten),
      // after which a live peer's `commit scope: "paths"` takes it. So: touch nothing, leave the
      // entry exactly as it is, and keep it flagged. Only a deliberate take (`settle`/`clear`,
      // i.e. commit scope "all"/"paths") or a discard ends this state.
      return { kind: 'conflicted', flag: false };
    }

    if (entry.conflicted === true && headSha !== undefined && entry.conflictHead === headSha) {
      // HEAD has not moved since this entry was last judged conflicted, and a conflicted
      // entry's shadow/base are frozen (`record` early-returns on it; `refresh` writes nothing
      // on either conflicting branch below) — so the verdict is unchanged. Skip the HEAD read,
      // the shadow read, the merge, and the `sameAsGitSees` spawns entirely.
      return { kind: 'conflicted', flag: false };
    }

    const head = await this.readHead(projectDir, rel);
    const base = entry.baseExists ? await this.readBase(projectId, rel) : null;
    if (bytesEqual(head, base)) {
      // HEAD has not moved under this file. An ordinary entry whose shadow already equals HEAD
      // has nothing left to commit — the session reverted its own edit, or created and deleted a
      // file HEAD never had — so it settles here, or it would stay tracked forever (HEAD never
      // moves under a change nobody commits) and every `commit` in the session would find
      // nothing to stage while a peer's `scope: "paths"` refused the path as this session's.
      // Raw comparison only: this runs for every in-flight entry on every refresh, and the
      // clean-filter fallback costs two git spawns each — an edit reverted to text that differs
      // from HEAD only by what the clean filter normalises stays tracked until HEAD moves, which
      // is the pre-existing behaviour for it. Never for a conflicted entry: a refresh-time
      // conflict's base is stale by definition, and an incomplete one was skipped above.
      if (entry.conflicted !== true) {
        const shadow = entry.deleted ? null : await this.readShadow(projectId, rel);
        const reverted = entry.deleted
          ? head === null
          : head !== null && shadow !== null && head.equals(shadow);
        if (reverted) return { kind: 'settled' };
      }
      return { kind: 'keep' };
    }

    const shadow = entry.deleted ? null : await this.readShadow(projectId, rel);
    const settled =
      bytesEqual(head, shadow) ||
      (head === null && entry.deleted) ||
      // Raw bytes differ but both sides are present: ask git whether they'd clean-filter to the
      // same blob (see the class doc comment) before concluding a peer changed this file.
      (head !== null &&
        shadow !== null &&
        (await this.sameAsGitSees(projectDir, rel, head, shadow)));
    if (settled) return { kind: 'settled' };

    if (head === null || shadow === null) {
      // One side is a delete: no text to merge, and picking a winner would be a guess.
      return { kind: 'conflicted', flag: true, headSha };
    }

    if (entry.binary) {
      // A binary shadow whose HEAD moved to different bytes has no honest merge — there is no
      // such thing as a merged PNG — so it is reported as a conflict, never merged.
      return { kind: 'conflicted', flag: true, headSha };
    }

    const { merged, conflicted } = await merge3(
      head.toString('utf8'),
      base?.toString('utf8') ?? '',
      shadow.toString('utf8'),
    );
    if (conflicted) return { kind: 'conflicted', flag: true, headSha };
    return { kind: 'advanced', shadow: Buffer.from(merged, 'utf8'), base: head };
  }

  /**
   * Drop every entry this session tracks whose path is covered by one of `paths` (`coversPath` —
   * a directory covers everything under it), regardless of `conflicted`/`unrecorded`. Returns the
   * dropped paths, in this session's own shadow spelling.
   *
   * Called by `commit` after a `scope: "all"`/`"paths"` commit, and only after that commit has
   * actually landed. It drops every entry *under the paths the commit was given* (`coversPath` —
   * a directory covers everything under it), whether or not git actually staged that particular
   * entry — those scopes stage the working tree as it stands (via `git add`), and git stages
   * nothing for a path whose working-tree content already equals HEAD, so checking "did git stage
   * this" would leave exactly the already-reconciled entries wedged. Dropping by coverage instead
   * is deliberate: whatever this session's shadow said about a covered path — including a sticky
   * `conflicted`/`unrecorded` flag — is now either exactly what is in HEAD, or was deliberately
   * overridden by the caller's choice of scope. This is not a weakening of "conflicted stays
   * flagged": nothing here clears the flag on an *edit* (`record` never calls this), and `refresh`
   * still refuses to resolve one on its own. The entry disappears because the session took the
   * tree deliberately — the exact remedy every conflicted/unrecorded message names.
   *
   * `fold` is git's own ASCII case fold (`foldCase`, `src/lib/caseFold.ts`), passed by the caller
   * only when the repository is case-insensitive (`GitService.isCaseInsensitive`) — see
   * `coversPath`. On an ignorecase clone this session's entry can be keyed under a different
   * spelling than the path `commit` was asked to take (`git add`/`commitContents` staged it under
   * whichever spelling won), and without the fold that entry never matches, so it stays wedged
   * forever even though the commit that was meant to resolve it landed.
   */
  async settle(
    projectId: string,
    paths: string[],
    fold?: (p: string) => string,
  ): Promise<string[]> {
    // Same normal form as the tool layer's `settlePaths`: POSIX, leading `./` stripped.
    const wanted = paths.map((p) => toPosix(p).replace(/^(\.\/)+/, ''));
    return withIndexLock(this.dir(projectId), async () => {
      const index = await this.readIndex(projectId);
      const dropped: string[] = [];
      for (const rel of Object.keys(index.entries)) {
        if (wanted.some((p) => coversPath(p, rel, fold))) {
          await this.forget(projectId, rel);
          delete index.entries[rel];
          dropped.push(rel);
        }
      }
      await this.writeIndex(projectId, index);
      return dropped;
    });
  }

  /**
   * Drop *every* session's entries covered by `paths` (`coversPath`, as `settle` above) — for a
   * path-limited `discard`, which rewrites only the named paths on disk and so must settle only
   * the records that describe them, leaving every other session's unrelated in-flight work
   * (`session.json` heartbeat included) intact. `clearAll` remains the whole-tree tool: it drops
   * every session's *entire* shadow state because a whole-tree discard leaves nothing on disk any
   * shadow could still describe.
   *
   * Iterates every session directory the same way `clearAll` does (a listing failure — no
   * `.sessions/<projectId>` yet — is "nothing to settle", not an error) and applies the same
   * per-entry removal `settle` uses, just against each session's own directory rather than only
   * this store's `sessionId`. Returns every dropped path, in each owning session's own spelling
   * (a path can appear more than once if, oddly, two sessions both tracked it).
   */
  async settleAll(
    projectId: string,
    paths: string[],
    fold?: (p: string) => string,
  ): Promise<string[]> {
    // Same normal form as the tool layer's `settlePaths`: POSIX, leading `./` stripped.
    const wanted = paths.map((p) => toPosix(p).replace(/^(\.\/)+/, ''));
    const root = sessionStateDir(this.workspaceRoot, projectId);
    let sessionIds: string[];
    try {
      sessionIds = (await readdir(root, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return [];
    }

    const dropped: string[] = [];
    for (const sessionId of sessionIds) {
      const dir = path.join(root, sessionId);
      await withIndexLock(dir, async () => {
        const index = await this.readIndexAt(dir);
        let changed = false;
        for (const rel of Object.keys(index.entries)) {
          if (wanted.some((p) => coversPath(p, rel, fold))) {
            await this.forgetAt(dir, rel);
            delete index.entries[rel];
            dropped.push(rel);
            changed = true;
          }
        }
        if (changed) await this.writeIndexAt(dir, index);
      });
    }
    return dropped;
  }

  /**
   * Drop this session's tracked changes for a project (after its work is committed or discarded).
   * Removes only the shadow state — `shadow/`, `base/`, `shadow.json` — never the session
   * directory itself: `session.json` (the heartbeat record `SessionRegistry` writes there) must
   * survive, or a `commit scope: "all"` would make this session look dead to its peers until the
   * next throttled heartbeat.
   */
  async clear(projectId: string): Promise<void> {
    const dir = this.dir(projectId);
    await withIndexLock(dir, () => this.clearShadowState(dir));
  }

  /**
   * Drop *every* session's tracked changes for a project. For the tools that rewrite the whole
   * working tree (`discard`, `reset_to_remote`, a pull): the uncommitted work those shadows
   * described no longer exists on disk, so keeping them would misattribute future edits.
   */
  async clearAll(projectId: string): Promise<void> {
    const root = sessionStateDir(this.workspaceRoot, projectId);
    let sessions: string[];
    try {
      sessions = (await readdir(root, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return;
    }
    await Promise.all(
      sessions.map((id) => {
        const dir = path.join(root, id);
        return withIndexLock(dir, () => this.clearShadowState(dir));
      }),
    );
  }

  /** The shadow files under one session directory, leaving everything else there alone. */
  private async clearShadowState(dir: string): Promise<void> {
    await rm(path.join(dir, 'shadow'), { recursive: true, force: true });
    await Promise.all([
      rm(path.join(dir, 'base'), { recursive: true, force: true }),
      rm(path.join(dir, 'shadow.json'), { force: true }),
    ]);
  }

  private dir(projectId: string): string {
    return sessionDir(this.workspaceRoot, projectId, this.sessionId);
  }

  private shadowPath(projectId: string, rel: string): string {
    return path.join(this.dir(projectId), 'shadow', rel);
  }

  private basePath(projectId: string, rel: string): string {
    return path.join(this.dir(projectId), 'base', rel);
  }

  private readIndex(projectId: string): Promise<ShadowIndex> {
    return this.readIndexAt(this.dir(projectId));
  }

  private writeIndex(projectId: string, index: ShadowIndex): Promise<void> {
    return this.writeIndexAt(this.dir(projectId), index);
  }

  /** Reads the shadow index at an arbitrary session directory — `readIndex` for this session,
   * `settleAll` for every session's. Shared so both stay in exact agreement on the on-disk shape. */
  private async readIndexAt(dir: string): Promise<ShadowIndex> {
    try {
      const raw = await readFile(path.join(dir, 'shadow.json'), 'utf8');
      const parsed = JSON.parse(raw) as Partial<ShadowIndex> | null;
      if (typeof parsed !== 'object' || parsed === null || !parsed.entries) {
        return { entries: entryMap() };
      }
      // Any other top-level key rides along unchanged, as it did before the copy.
      return { ...parsed, entries: entryMap(parsed.entries) };
    } catch {
      return { entries: entryMap() };
    }
  }

  /** Writes the shadow index at an arbitrary session directory — see `readIndexAt`. */
  private async writeIndexAt(dir: string, index: ShadowIndex): Promise<void> {
    await mkdir(dir, { recursive: true });
    await writeAtomic(path.join(dir, 'shadow.json'), JSON.stringify(index, null, 2));
  }

  private readShadow(projectId: string, rel: string): Promise<Buffer | null> {
    return readOrNull(this.shadowPath(projectId, rel));
  }

  private readBase(projectId: string, rel: string): Promise<Buffer | null> {
    return readOrNull(this.basePath(projectId, rel));
  }

  private async writeShadow(projectId: string, rel: string, content: Buffer | null): Promise<void> {
    await writeOrRemove(this.shadowPath(projectId, rel), content);
  }

  private async writeBase(projectId: string, rel: string, content: Buffer | null): Promise<void> {
    await writeOrRemove(this.basePath(projectId, rel), content);
  }

  private async removeShadow(projectId: string, rel: string): Promise<void> {
    await rm(this.shadowPath(projectId, rel), { force: true });
  }

  private forget(projectId: string, rel: string): Promise<void> {
    return this.forgetAt(this.dir(projectId), rel);
  }

  /**
   * Removes the shadow and base files for `rel` under an arbitrary session directory — the
   * per-entry removal `settle` (this session, via `forget`) and `settleAll` (every session) share,
   * so dropping an index entry always sheds the same on-disk files whichever one drops it.
   */
  private async forgetAt(dir: string, rel: string): Promise<void> {
    await Promise.all([
      rm(path.join(dir, 'shadow', rel), { force: true }),
      rm(path.join(dir, 'base', rel), { force: true }),
    ]);
  }
}

/**
 * Whether an entry must be reported conflicted: flagged outright, or known-incomplete (its shadow
 * lacks a write this session made — `unrecorded` or `incomplete`), whatever the raw flag says.
 */
function isFlagged(entry: ShadowIndexEntry): boolean {
  return entry.conflicted === true || entry.unrecorded === true || entry.incomplete === true;
}

/** Whether a mutation's two sides carry the same bytes (both absent counts as the same). */
function sameContent(a: string | Buffer | null, b: string | Buffer | null): boolean {
  if (a === null || b === null) return a === b;
  return toBuffer(a).equals(toBuffer(b));
}

/** Narrows an arbitrary parsed JSON value to something `peerEntries` can safely read entries off. */
function isShadowIndexShape(value: unknown): value is ShadowIndex {
  if (typeof value !== 'object' || value === null) return false;
  const entries = (value as { entries?: unknown }).entries;
  return typeof entries === 'object' && entries !== null;
}

/**
 * The most recent `touchedAt` among a set of peer entries, or `null` when none of them parse as a
 * date (including an empty list). Compares by `Date.parse`, not string order — ISO timestamps from
 * different code paths are not guaranteed to share the same fractional-second precision, and
 * lexicographic comparison only agrees with chronological order when the format matches exactly.
 */
export function latestTouch(entries: PeerShadowEntry[]): string | null {
  let best: { iso: string; ms: number } | null = null;
  for (const entry of entries) {
    if (entry.touchedAt === null) continue;
    const ms = Date.parse(entry.touchedAt);
    if (Number.isNaN(ms)) continue;
    if (best === null || ms > best.ms) best = { iso: entry.touchedAt, ms };
  }
  return best?.iso ?? null;
}

async function readOrNull(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch {
    return null;
  }
}

async function writeOrRemove(file: string, content: Buffer | null): Promise<void> {
  if (content === null) {
    await rm(file, { force: true });
    return;
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

/** Normalize a mutation's `before`/`after` (or the shadow's own content) to raw bytes. */
function toBuffer(v: string | Buffer): Buffer {
  return Buffer.isBuffer(v) ? v : Buffer.from(v, 'utf8');
}

/** Byte-aware equality for two possibly-absent buffers — `===` is never true for two distinct
 * Buffer instances even when their bytes match, which is why every HEAD/base/shadow comparison
 * in this file goes through this helper instead. */
function bytesEqual(a: Buffer | null, b: Buffer | null): boolean {
  if (a === null || b === null) return a === b;
  return a.equals(b);
}
