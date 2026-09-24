import path from 'node:path';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { sessionStateDir } from '../lib/sessionPaths.js';
import { resolveInside, toPosix } from '../lib/paths.js';
import { assertShelfId, newShelfId, parseManifest } from '../lib/shelf.js';
import type { ShelfFileRecord, ShelfFileStatus, ShelfManifest } from '../lib/shelf.js';
import { writeAtomic } from './sessionRegistry.js';

/** Name of the shelves directory under a project's session-state directory. */
const SHELVES_DIRNAME = 'shelves';
/** Name of a shelf's manifest — written LAST, see `create`. */
const MANIFEST_NAME = 'shelf.json';
/** How many fresh ids `create` will try before giving up on a colliding directory. */
const ID_ATTEMPTS = 5;

/** One file as handed to `create`. */
export interface ShelfFileInput {
  /** Project-relative path, as git reported it. */
  path: string;
  status: ShelfFileStatus;
  added: number;
  removed: number;
  /** The working-tree bytes taken; `null` iff `status === 'deleted'`. */
  content: Buffer | null;
  /** HEAD's bytes at shelve time; `null` iff `status === 'added'`. */
  base: Buffer | null;
}

/** Both stored sides of one shelved file, as {@link ShelfEntry.sides} reads them. */
export interface ShelfSides {
  /** The working-tree bytes taken; `null` iff the manifest says `'deleted'`. */
  content: Buffer | null;
  /** HEAD's bytes at shelve time; `null` iff the manifest says `'added'`. */
  base: Buffer | null;
}

/**
 * A shelf whose stored bytes contradict its own manifest, or cannot be read at all. Thrown
 * rather than returned, because every consumer's fallback for a missing side is an ACTION — a
 * missing content side is restored by deleting the file — and a corrupt shelf must never be
 * acted on.
 */
export class ShelfCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShelfCorruptError';
  }
}

/** A shelf read back off disk: its manifest, plus lazy access to the bytes it holds. */
export interface ShelfEntry {
  manifest: ShelfManifest;
  /**
   * The stored working-tree bytes for a path, or `null` when the shelf holds none (a
   * `'deleted'` file). `null` means ENOENT and only ENOENT: any other read failure throws.
   */
  content(relPath: string): Promise<Buffer | null>;
  /**
   * The stored HEAD bytes for a path, or `null` when the shelf holds none (an `'added'` file).
   * `null` means ENOENT and only ENOENT: any other read failure throws.
   */
  base(relPath: string): Promise<Buffer | null>;
  /**
   * Both sides of one manifest record, read once and checked against the record's `status`:
   * `'modified'` must hold both, `'added'` content and no base, `'deleted'` base and no content.
   * A side that is missing where the manifest says it exists (or present where it says it does
   * not) throws {@link ShelfCorruptError}. This is the read `unshelve` uses, because a bare
   * `null` cannot tell "recorded as absent" from "lost".
   */
  sides(file: ShelfFileRecord): Promise<ShelfSides>;
}

/**
 * Persists the shelves taken by `shelve`, under
 * `<workspaceRoot>/.sessions/<projectId>/shelves/<shelfId>/` (see `src/lib/sessionPaths.ts`) —
 * beside the clone, never inside it, so nothing here can be committed or mistaken for project
 * content.
 *
 * ```
 * shelves/<shelfId>/
 *   shelf.json        manifest — written LAST
 *   content/<rel>     the working-tree bytes taken (absent when the file was deleted)
 *   base/<rel>        HEAD's bytes at shelve time (absent when the file was untracked)
 * ```
 *
 * Shelves are **project-scoped, not session-scoped**: any session on the project can list and
 * unshelve one. An invisible per-session shelf would reproduce the unreclaimed `stash@{0}` this
 * feature exists to replace. `sessionId` is recorded in the manifest for information only.
 *
 * Two rules carry the safety of the whole store, and both are stated on the methods below: the
 * manifest is written last, and every id and every relative path is re-validated before it is
 * joined onto a path.
 */
export class ShelfStore {
  constructor(
    private readonly workspaceRoot: string,
    private readonly sessionId: string,
    private readonly newId: () => string = newShelfId,
  ) {}

  /** `<workspaceRoot>/.sessions/<projectId>/shelves` — via `sessionStateDir`, never hand-built. */
  shelvesDir(projectId: string): string {
    return path.join(sessionStateDir(this.workspaceRoot, projectId), SHELVES_DIRNAME);
  }

  /**
   * Write a shelf.
   *
   * **The manifest is written LAST.** Every `content/<rel>` and `base/<rel>` file lands first,
   * and only then `shelf.json`. A shelf directory without a readable, valid manifest is not a
   * shelf — `list` skips it and `read` returns `null` — which is what makes a half-written shelf
   * invisible rather than corrupt.
   *
   * **The directory unwinds on ANY failure**: a throw from anywhere between `mkdir` and the
   * manifest removes the whole shelf directory before propagating, so a failed shelve never
   * leaves a partial shelf behind. (The unwind is belt-and-braces over the manifest-last rule:
   * the rule already makes the leftovers invisible, this stops them taking up space.)
   *
   * Every `path` in `files` is re-checked to resolve inside this shelf's `content`/`base`
   * subdirectory before anything is written under it, and stored POSIX so a shelf taken on one
   * OS reads back on another.
   */
  async create(
    projectId: string,
    opts: { label: string | null; headSha: string; files: ShelfFileInput[] },
  ): Promise<ShelfManifest> {
    const root = this.shelvesDir(projectId);
    await mkdir(root, { recursive: true });

    const { id, dir } = await this.reserveDir(root);
    try {
      const records: ShelfFileRecord[] = [];
      for (const file of opts.files) {
        const rel = toPosix(file.path);
        // A caller-named path, re-checked at the point of use: `resolveInside` throws for an
        // absolute path or one that climbs out of the shelf.
        if (file.content !== null) {
          await writeUnder(path.join(dir, 'content'), rel, file.content);
        }
        if (file.base !== null) {
          await writeUnder(path.join(dir, 'base'), rel, file.base);
        }
        records.push({
          path: rel,
          status: file.status,
          added: file.added,
          removed: file.removed,
        });
      }
      const manifest: ShelfManifest = {
        version: 1,
        id,
        label: opts.label,
        createdAt: new Date().toISOString(),
        sessionId: this.sessionId,
        headSha: opts.headSha,
        files: records,
      };
      // LAST — see the doc comment above.
      await writeAtomic(path.join(dir, MANIFEST_NAME), JSON.stringify(manifest, null, 2));
      return manifest;
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      throw err;
    }
  }

  /**
   * Every readable shelf on the project, newest first.
   *
   * A directory with no readable or no valid `shelf.json` is **skipped** — logged to stderr,
   * never thrown for and never repaired: "unreadable" must not quietly become "empty". No
   * `shelves/` directory at all means nothing has been shelved, which is `[]`, not an error.
   */
  async list(projectId: string): Promise<ShelfManifest[]> {
    const root = this.shelvesDir(projectId);
    let names: string[];
    try {
      names = (await readdir(root, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return []; // nothing shelved on this project
    }
    const out: ShelfManifest[] = [];
    for (const name of names) {
      const manifest = await this.readManifest(path.join(root, name), name);
      if (manifest) out.push(manifest);
    }
    out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return out;
  }

  /**
   * The shelf `shelfId` names, or `null` when it names none (including a directory whose
   * manifest is missing, unreadable or invalid — see `create`).
   *
   * `shelfId` goes through `assertShelfId` **before any `path.join`**: the id is interpolated
   * into a filesystem path, so an invalid one throws here rather than reaching the filesystem at
   * all. Each `relPath` handed to the returned `content`/`base` is likewise re-checked to
   * resolve inside the shelf directory — a manifest is data even though this server wrote it.
   */
  async read(projectId: string, shelfId: string): Promise<ShelfEntry | null> {
    assertShelfId(shelfId);
    const dir = path.join(this.shelvesDir(projectId), shelfId);
    const manifest = await this.readManifest(dir, shelfId);
    if (!manifest) return null;
    const content = (relPath: string): Promise<Buffer | null> =>
      readUnder(path.join(dir, 'content'), relPath);
    const base = (relPath: string): Promise<Buffer | null> =>
      readUnder(path.join(dir, 'base'), relPath);
    return {
      manifest,
      content,
      base,
      sides: async (file: ShelfFileRecord): Promise<ShelfSides> => {
        const sides = { content: await content(file.path), base: await base(file.path) };
        const problem = sidesContradiction(file.status, sides);
        if (problem) {
          throw new ShelfCorruptError(
            `Shelf ${manifest.id} is corrupt at ${file.path}: the manifest records it as ` +
              `"${file.status}", but ${problem}. Nothing was written and the shelf was left ` +
              `exactly as it is, so whatever it still holds can be recovered by hand from ` +
              `${toPosix(dir)}.`,
          );
        }
        return sides;
      },
    };
  }

  /**
   * Remove a shelf, directory and all. Idempotent: removing an id that names no shelf is a
   * no-op, not an error. `shelfId` is validated before any `path.join`, as in `read`.
   */
  async remove(projectId: string, shelfId: string): Promise<void> {
    assertShelfId(shelfId);
    await rm(path.join(this.shelvesDir(projectId), shelfId), { recursive: true, force: true });
  }

  /**
   * Claim a fresh, not-yet-existing shelf directory. `mkdir` without `recursive` is the claim:
   * it fails with EEXIST rather than silently adopting a directory that is already a shelf.
   */
  private async reserveDir(root: string): Promise<{ id: string; dir: string }> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < ID_ATTEMPTS; attempt += 1) {
      const id = assertShelfId(this.newId());
      const dir = path.join(root, id);
      try {
        await mkdir(dir);
        return { id, dir };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        lastErr = err;
      }
    }
    throw new Error(
      `Could not allocate a shelf id after ${ID_ATTEMPTS} attempts (last: ` +
        `${(lastErr as Error | undefined)?.message ?? 'unknown'}).`,
    );
  }

  /** Read and validate one shelf's manifest, or `null` — logging why it was skipped to stderr. */
  private async readManifest(dir: string, name: string): Promise<ShelfManifest | null> {
    const file = path.join(dir, MANIFEST_NAME);
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        console.error(`shelfStore: could not read ${file} (${code ?? (err as Error).message}).`);
      } else {
        console.error(`shelfStore: ${dir} holds no ${MANIFEST_NAME}; not a shelf, skipping.`);
      }
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.error(`shelfStore: malformed JSON in ${file}, skipping: ${(err as Error).message}`);
      return null;
    }
    const manifest = parseManifest(parsed);
    if (!manifest) {
      console.error(`shelfStore: ${file} is not a valid shelf manifest, skipping.`);
      return null;
    }
    if (manifest.id !== name) {
      console.error(
        `shelfStore: ${file} names shelf "${manifest.id}" but sits in "${name}", skipping.`,
      );
      return null;
    }
    return manifest;
  }
}

/**
 * Reject a relative path that is not safe to join under `root`, then join it.
 *
 * `resolveInside` refuses an absolute path and one that climbs out; the backslash and NUL
 * checks cover what it cannot — a backslash is a separator on Windows and merely a filename
 * character on POSIX, and a NUL truncates a path at the syscall boundary. Every read and write
 * of shelf content goes through here.
 */
function resolveShelfPath(root: string, relPath: string): string {
  if (relPath.includes('\0') || relPath.includes('\\')) {
    throw new Error(`Shelf path is not usable: ${JSON.stringify(relPath)}`);
  }
  return resolveInside(root, relPath);
}

async function writeUnder(root: string, relPath: string, bytes: Buffer): Promise<void> {
  const target = resolveShelfPath(root, relPath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
}

/**
 * Where a side's presence contradicts the manifest `status` that `create` stored it under, the
 * reason as a phrase; otherwise `null`. `create` writes exactly the sides its input has, and
 * `shelve` derives `status` from those very sides, so any mismatch here is damage after the fact.
 */
export function sidesContradiction(status: ShelfFileStatus, sides: ShelfSides): string | null {
  const wantContent = status !== 'deleted';
  const wantBase = status !== 'added';
  if (wantContent && sides.content === null) return 'its stored content is missing';
  if (wantBase && sides.base === null) return "its stored copy of HEAD's version is missing";
  if (!wantContent && sides.content !== null) return 'it holds content for a deleted file';
  if (!wantBase && sides.base !== null) return 'it holds a HEAD version for an untracked file';
  return null;
}

/**
 * Read one stored side. **`null` means ENOENT and nothing else.** `null` is a value here —
 * "the shelf holds no such side" — and `unshelve` acts on it (a null content side is restored by
 * DELETING the file), so reading EACCES, EIO, EMFILE or a Windows sharing violation as `null`
 * turned an intact-but-unreadable shelf into the deletion of the user's file, reported as a
 * successful restore, followed by the removal of the shelf itself. Every other failure throws.
 */
async function readUnder(root: string, relPath: string): Promise<Buffer | null> {
  const target = resolveShelfPath(root, relPath);
  try {
    return await readFile(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}
