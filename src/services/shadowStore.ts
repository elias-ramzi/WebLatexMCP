import path from 'node:path';
import { mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { merge3 } from '../lib/merge3.js';
import { sessionDir, sessionStateDir } from '../lib/sessionPaths.js';
import { toPosix } from '../lib/paths.js';
import { writeAtomic } from './sessionRegistry.js';

/**
 * Reads a path out of the clone's HEAD commit. Injected so the store never depends on GitService
 * (which depends on nothing here), and so tests can drive it without a repository.
 */
export type HeadReader = (projectDir: string, relPath: string) => Promise<string | null>;

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
}

interface ShadowIndex {
  entries: Record<string, ShadowIndexEntry>;
}

/** A file this session has changed, with content resolved. */
export interface ShadowChange {
  path: string;
  /** The file as it would be with only this session's edits — null when this session deleted it. */
  content: string | null;
  /** The HEAD content the change is expressed against — null when the file is new. */
  base: string | null;
  conflicted: boolean;
}

export interface RefreshResult {
  /** Files whose shadow was successfully carried onto the new HEAD. */
  advanced: string[];
  /** Files where this session's edits and a commit touched the same lines. */
  conflicted: string[];
  /** Files dropped because the session's change is now part of HEAD (typically its own commit). */
  settled: string[];
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
 */
export class ShadowStore {
  constructor(
    private readonly workspaceRoot: string,
    readonly sessionId: string,
    private readonly readHead: HeadReader,
  ) {}

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
    before: string | null,
    after: string | null,
  ): Promise<void> {
    const rel = toPosix(relPath);
    const index = await this.readIndex(projectId);
    let entry = index.entries[rel];

    if (!entry) {
      // First touch: anchor to HEAD, and start the shadow at the same content.
      const head = await this.readHead(projectDir, rel);
      entry = { deleted: false, baseExists: head !== null };
      await this.writeBase(projectId, rel, head);
      await this.writeShadow(projectId, rel, head);
    }

    if (entry.conflicted) {
      // Once a file is conflicted its shadow is anchored to a base that HEAD has moved past, so
      // no further edit can be folded in safely: committing it would revert whatever landed in
      // between. It stays flagged until the session resolves it deliberately (commit scope
      // "all", or discard) — see `commit`'s error message.
      index.entries[rel] = entry;
      await this.writeIndex(projectId, index);
      return;
    }

    if (after === null) {
      // A deletion is not mergeable — record it as this session's change outright.
      entry.deleted = true;
      entry.conflicted = false;
      await this.removeShadow(projectId, rel);
    } else {
      const shadow = entry.deleted ? null : await this.readShadow(projectId, rel);
      if (shadow === null || before === null || shadow === before) {
        // Nothing to reconcile: a new file, one we are re-creating, or a working tree that has
        // not diverged from our shadow — the edit applies to the shadow directly.
        entry.deleted = false;
        entry.conflicted = false;
        await this.writeShadow(projectId, rel, after);
      } else {
        const { merged, conflicted } = await merge3(shadow, before, after);
        if (conflicted) {
          // This session just edited lines a peer had already changed in the working tree. There
          // is no honest way to say which of the two the shadow should hold, so we keep it as it
          // was and flag the file — writing markers into the shadow would commit them.
          entry.conflicted = true;
        } else {
          entry.deleted = false;
          entry.conflicted = false;
          await this.writeShadow(projectId, rel, merged);
        }
      }
    }

    index.entries[rel] = entry;
    await this.writeIndex(projectId, index);
  }

  /** Every change this session currently owns, resolved to content. */
  async changes(projectId: string): Promise<ShadowChange[]> {
    const index = await this.readIndex(projectId);
    const out: ShadowChange[] = [];
    for (const [rel, entry] of Object.entries(index.entries)) {
      out.push({
        path: rel,
        content: entry.deleted ? null : await this.readShadow(projectId, rel),
        base: entry.baseExists ? await this.readBase(projectId, rel) : null,
        conflicted: entry.conflicted === true,
      });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Whether this session is tracking any change at all (drives `commit`'s default scope). */
  async hasChanges(projectId: string): Promise<boolean> {
    return Object.keys((await this.readIndex(projectId)).entries).length > 0;
  }

  /**
   * Carry every tracked shadow onto the current HEAD.
   *
   * Call after anything that moves HEAD or rewrites the tree — this session committing, a peer
   * committing, a pull, a rebase. Files whose change is now in HEAD stop being tracked; files
   * where HEAD and this session changed the same lines are marked conflicted and left alone,
   * so nothing is resolved on the session's behalf.
   */
  async refresh(projectId: string, projectDir: string): Promise<RefreshResult> {
    const index = await this.readIndex(projectId);
    const result: RefreshResult = { advanced: [], conflicted: [], settled: [] };

    for (const [rel, entry] of Object.entries(index.entries)) {
      const head = await this.readHead(projectDir, rel);
      const base = entry.baseExists ? await this.readBase(projectId, rel) : null;
      if (head === base) continue; // HEAD has not moved under this file

      const shadow = entry.deleted ? null : await this.readShadow(projectId, rel);
      if (head === shadow || (head === null && entry.deleted)) {
        // Our change is what landed — there is nothing left of it to commit.
        await this.forget(projectId, rel);
        delete index.entries[rel];
        result.settled.push(rel);
        continue;
      }

      if (head === null || shadow === null) {
        // One side is a delete: no text to merge, and picking a winner would be a guess.
        entry.conflicted = true;
        result.conflicted.push(rel);
        continue;
      }

      const { merged, conflicted } = await merge3(head, base ?? '', shadow);
      if (conflicted) {
        entry.conflicted = true;
        result.conflicted.push(rel);
        continue;
      }
      await this.writeShadow(projectId, rel, merged);
      await this.writeBase(projectId, rel, head);
      entry.baseExists = true;
      entry.conflicted = false;
      result.advanced.push(rel);
    }

    await this.writeIndex(projectId, index);
    return result;
  }

  /** Drop this session's tracked changes for a project (after its work is committed or discarded). */
  async clear(projectId: string): Promise<void> {
    await rm(this.dir(projectId), { recursive: true, force: true });
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
      sessions.map((id) =>
        rm(path.join(root, id, 'shadow'), { recursive: true, force: true }).then(() =>
          Promise.all([
            rm(path.join(root, id, 'base'), { recursive: true, force: true }),
            rm(path.join(root, id, 'shadow.json'), { force: true }),
          ]),
        ),
      ),
    );
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

  private async readIndex(projectId: string): Promise<ShadowIndex> {
    try {
      const raw = await readFile(path.join(this.dir(projectId), 'shadow.json'), 'utf8');
      const parsed = JSON.parse(raw) as ShadowIndex;
      return parsed.entries ? parsed : { entries: {} };
    } catch {
      return { entries: {} };
    }
  }

  private async writeIndex(projectId: string, index: ShadowIndex): Promise<void> {
    const dir = this.dir(projectId);
    await mkdir(dir, { recursive: true });
    await writeAtomic(path.join(dir, 'shadow.json'), JSON.stringify(index, null, 2));
  }

  private readShadow(projectId: string, rel: string): Promise<string | null> {
    return readOrNull(this.shadowPath(projectId, rel));
  }

  private readBase(projectId: string, rel: string): Promise<string | null> {
    return readOrNull(this.basePath(projectId, rel));
  }

  private async writeShadow(projectId: string, rel: string, content: string | null): Promise<void> {
    await writeOrRemove(this.shadowPath(projectId, rel), content);
  }

  private async writeBase(projectId: string, rel: string, content: string | null): Promise<void> {
    await writeOrRemove(this.basePath(projectId, rel), content);
  }

  private async removeShadow(projectId: string, rel: string): Promise<void> {
    await rm(this.shadowPath(projectId, rel), { force: true });
  }

  private async forget(projectId: string, rel: string): Promise<void> {
    await Promise.all([
      rm(this.shadowPath(projectId, rel), { force: true }),
      rm(this.basePath(projectId, rel), { force: true }),
    ]);
  }
}

async function readOrNull(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

async function writeOrRemove(file: string, content: string | null): Promise<void> {
  if (content === null) {
    await rm(file, { force: true });
    return;
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
}
