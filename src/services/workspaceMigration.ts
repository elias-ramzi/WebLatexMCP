import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { SESSIONS_DIRNAME, projectLockPath } from '../lib/sessionPaths.js';
import { projectIdFold, projectIdProblem, quoteId, listIds } from '../lib/projectId.js';
import { toPosix } from '../lib/paths.js';
import { SessionRegistry } from './sessionRegistry.js';
import {
  REGISTRY_FILENAME,
  readRawRegistryFile,
  importRegistryEntries,
  registryPath,
} from './projectRegistry.js';

/**
 * `web-latex-mcp migrate-workspace <from> [--to <workspace>]`: move an older version's
 * workspace-local folder (`<repo>/.web_latex_mcp`) into the one shared workspace.
 *
 * What moves: every top-level entry of `from` (each clone, each surfaced `<id>.pdf`, the clone of
 * an env-configured project that no registry names), every `.sessions/<id>/` directory (the
 * per-project session state, shelves and rewrite mode), and every registry entry, merged into
 * `to`'s registry. Nothing is merged INTO an existing entry: two of anything with one name refuse.
 *
 * The rules, in the order they are applied:
 *
 * 1. **Every refusal runs before the first move.** A plan is built and checked whole — a name
 *    taken in `to`, a project id equal to one in `to` under `projectIdFold`, a live session or a
 *    held project lock in either workspace, a registry that cannot be read — and only a plan with
 *    no refusal is carried out. A refusal changes nothing.
 * 2. **A run that stopped part way can be run again.** An entry already moved is no longer in
 *    `from`, so it is not planned again; a registry entry `to` already holds byte-for-byte is
 *    counted as already migrated rather than as a collision. The registry is merged after the
 *    moves, and `from`'s registry is retired (renamed to `registry.json.migrated`) last.
 * 3. **A move is a rename, else copy-verify-delete.** Across filesystems (`EXDEV`) the entry is
 *    copied under a temporary name (links kept as links), compared with the source tree (names,
 *    kinds, link targets, and each file's permissions, size and SHA-256), renamed into place, and
 *    only then is the source set aside and removed (see `moveEntry`).
 *
 * What it does not do: hold the project locks across the moves (the lock files live in the very
 * `.sessions/` directories being moved), or touch the host repository's `.git/info/exclude` line,
 * which is the user's file and harmless once the folder is empty. The check for live sessions is
 * therefore a check at the start, and the command says to stop every session first.
 */

export interface MigrationOptions {
  from: string;
  to: string;
  /** The rename a move tries first; injectable so a test can force the `EXDEV` copy path. */
  rename?: (src: string, dst: string) => Promise<void>;
  /** The copy the `EXDEV` path makes; injectable so a test can make it fail or differ. */
  copy?: (src: string, dst: string) => Promise<void>;
}

export interface MigrationReport {
  from: string;
  to: string;
  /** Top-level entries and `.sessions/<id>` directories moved, as `from`-relative POSIX paths. */
  moved: string[];
  /** Registry entries added to `to`'s registry. */
  registered: string[];
  /** Registry entries `to` already held identically (a re-run after an interrupted one). */
  alreadyRegistered: string[];
  /** Whether `from`'s `default: true` flag was dropped because `to` already has a default. */
  defaultDropped?: string;
}

/** A refusal: nothing was changed. */
export class MigrationRefusedError extends Error {
  constructor(reasons: string[]) {
    super(
      `Nothing was moved:\n${reasons.map((r) => `- ${r}`).join('\n')}\n` +
        'Fix the above and run the command again.',
    );
    this.name = 'MigrationRefusedError';
  }
}

/** Entries of `from` that are not moved as they are: merged, retired, or never ours. */
function isSpecialTopLevel(name: string): boolean {
  return (
    name === REGISTRY_FILENAME ||
    name === SESSIONS_DIRNAME ||
    name === MIGRATED_NOTE ||
    name === PLAN_FILE ||
    name.startsWith(`${REGISTRY_FILENAME}.`) || // the registry's lock, temp files, a retired copy
    name.startsWith(ASIDE_PREFIX) || // a source set aside by an interrupted copy-delete
    OS_LITTER.has(name)
  );
}

/** Files an operating system drops into any folder it shows; left behind, never refused. */
const OS_LITTER = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

/**
 * `ASIDE_PREFIX` names a source set aside after its copy was verified and moved into place;
 * `PARTIAL_PREFIX` a copy still being made. A leading `.` keeps either from ever reading as a
 * project id (`projectIdProblem` refuses one). Both carry `<8 hex>-<name>` after the prefix.
 */
const ASIDE_PREFIX = '.migrated-';
const PARTIAL_PREFIX = '.migrating-';

/**
 * The plan of a run, written to `from` before the first move and removed after the last step: the
 * entries it set out to move, and where to. A re-run reads it to tell a clone it moved itself (now
 * in `to`, gone from `from`, its registry entry not merged yet) from someone else's directory that
 * merely has the same name.
 */
const PLAN_FILE = '.migration-plan.json';

/** An interrupted run's plan: where it was moving to, and what it set out to move. */
interface Plan {
  to: string;
  entries: Set<string>;
}

/** The plan an interrupted run left, or undefined (a first run, or a file this run cannot use). */
async function readPlan(from: string): Promise<Plan | undefined> {
  try {
    const plan = JSON.parse(await readFile(path.join(from, PLAN_FILE), 'utf8')) as unknown;
    if (typeof plan !== 'object' || plan === null) return undefined;
    const { to, entries } = plan as { to?: unknown; entries?: unknown };
    if (typeof to !== 'string' || !Array.isArray(entries)) return undefined;
    return {
      to,
      entries: new Set(entries.filter((e): e is string => typeof e === 'string')),
    };
  } catch {
    return undefined;
  }
}

/** Whether two paths name one folder: by identity when both exist, else by resolved spelling. */
async function sameFolder(a: string, b: string): Promise<boolean> {
  const [ia, ib] = await Promise.all([identities(a), identities(b)]);
  if ((await exists(a)) && (await exists(b))) return ia[0] === ib[0];
  return path.resolve(a) === path.resolve(b);
}

const MIGRATED_NOTE = 'MIGRATED.md';
const RETIRED_REGISTRY = `${REGISTRY_FILENAME}.migrated`;

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * The identities (`dev:ino`) of `p` and every existing ancestor, nearest first. Identity, not
 * spelling: `PROJECTS` and `projects` on a case-insensitive disk, or a path through a linked
 * parent, are one folder, and judging by `path.resolve` strings once retired the registry of the
 * workspace in use.
 */
async function identities(p: string): Promise<string[]> {
  const ids: string[] = [];
  let cur = path.resolve(p);
  for (;;) {
    try {
      // bigint: a 64-bit NTFS file id loses precision as a Number.
      const st = await stat(cur, { bigint: true });
      ids.push(`${st.dev}:${st.ino}`);
    } catch {
      // Not there (yet): only its existing ancestors can be another folder's identity.
    }
    const parent = path.dirname(cur);
    if (parent === cur) return ids;
    cur = parent;
  }
}

/** Whether `a` and `b` are one folder, or one holds the other, judged by identity. */
async function sameOrNested(a: string, b: string): Promise<boolean> {
  const [ia, ib] = await Promise.all([identities(a), identities(b)]);
  const selfA = ia[0];
  const selfB = ib[0];
  // `a` existing and found among `b`'s ancestors (itself included) means b is a, or lies in it.
  if (selfA !== undefined && (await exists(a)) && ib.includes(selfA)) return true;
  if (selfB !== undefined && (await exists(b)) && ia.includes(selfB)) return true;
  return false;
}

/**
 * Live sessions and held project locks in one workspace, as refusal reasons. `SessionRegistry`
 * is asked under a session id no process uses, so every recorded session counts as a peer; its
 * liveness rule fails closed (a recent heartbeat reads live even when the pid is gone).
 */
async function busyReasons(workspace: string, label: string): Promise<string[]> {
  const reasons: string[] = [];
  const probe = new SessionRegistry(workspace, `migrate-${randomBytes(6).toString('hex')}`);
  for (const id of await listDir(path.join(workspace, SESSIONS_DIRNAME))) {
    if (projectIdProblem(id) !== undefined) continue;
    const live = await probe.livePeers(id);
    if (live.length > 0) {
      reasons.push(
        `${label} project ${quoteId(id)} has live sessions (${listIds(live.map((p) => p.sessionId))}). ` +
          'Close them first.',
      );
    }
    const lock = projectLockPath(workspace, id);
    if (await exists(lock)) {
      reasons.push(
        `${label} project ${quoteId(id)} is locked by ${quoteId(toPosix(lock))}. If no server is ` +
          'running, a crash left it: delete that file.',
      );
    }
  }
  return reasons;
}

/**
 * A tree as a sorted list of `relpath kind mode size digest|target` lines, for verifying a copy.
 * File content is hashed: the source is deleted on this comparison's say-so, so names and sizes
 * alone would let a same-size corrupt copy replace the only good one.
 */
async function treeSignature(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    const abs = rel ? path.join(root, rel) : root;
    const st = await lstat(abs);
    if (st.isSymbolicLink()) {
      out.push(`${rel} link ${await readlink(abs)}`);
    } else if (st.isDirectory()) {
      out.push(`${rel} dir`);
      for (const name of (await readdir(abs)).sort()) {
        await walk(rel ? path.join(rel, name) : name);
      }
    } else {
      // Streamed: a pack file over 2 GiB is past what `readFile` can return.
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(abs)) hash.update(chunk as Buffer);
      const digest = hash.digest('hex');
      out.push(`${rel} file ${(st.mode & 0o777).toString(8)} ${st.size} ${digest}`);
    }
  };
  await walk('');
  return out;
}

/**
 * Remove what a killed earlier run left: a copy it was still making (`.migrating-…` in `to` or
 * `to/.sessions`), and a source it had set aside after its verified copy was renamed into place
 * (`.migrated-…` in `from` or `from/.sessions`) — the latter only while that copy is still there.
 * Both prefixes are this command's own; a project id can never start with `.`.
 */
async function clearLeftovers(from: string, to: string): Promise<void> {
  const tail = (name: string, prefix: string): string => name.slice(prefix.length + 9);
  for (const dir of [to, path.join(to, SESSIONS_DIRNAME)]) {
    for (const name of await listDir(dir)) {
      if (name.startsWith(PARTIAL_PREFIX))
        await rm(path.join(dir, name), { recursive: true, force: true });
    }
  }
  for (const [src, dst] of [
    [from, to],
    [path.join(from, SESSIONS_DIRNAME), path.join(to, SESSIONS_DIRNAME)],
  ] as const) {
    for (const name of await listDir(src)) {
      if (
        name.startsWith(ASIDE_PREFIX) &&
        (await exists(path.join(dst, tail(name, ASIDE_PREFIX))))
      ) {
        await rm(path.join(src, name), { recursive: true, force: true });
      }
    }
  }
}

async function copyTree(src: string, dst: string): Promise<void> {
  await cp(src, dst, {
    recursive: true,
    errorOnExist: true,
    force: false,
    verbatimSymlinks: true,
    preserveTimestamps: true,
  });
}

/**
 * Rename, or across filesystems copy, verify and delete. Never overwrites `dst`, and no
 * interruption leaves a half-made entry under either name a re-run would trip on:
 *
 * - the copy is made under a `.migrating-` name beside `dst` and renamed onto `dst` only once it
 *   matches the source; a failed copy is removed and the source left alone;
 * - the source is then renamed aside (`.migrated-…`, in its own folder, so a rename) before it is
 *   deleted, so a delete cut short leaves an aside, which a re-run skips, never a partial source
 *   under its own name.
 */
async function moveEntry(
  src: string,
  dst: string,
  renameFn: (src: string, dst: string) => Promise<void>,
  copyFn: (src: string, dst: string) => Promise<void>,
): Promise<void> {
  if (await exists(dst)) throw new Error(`${quoteId(toPosix(dst))} appeared during the migration`);
  try {
    await renameFn(src, dst);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
  }
  const token = randomBytes(4).toString('hex');
  const partial = path.join(path.dirname(dst), `${PARTIAL_PREFIX}${token}-${path.basename(dst)}`);
  try {
    await copyFn(src, partial);
    const [a, b] = await Promise.all([treeSignature(src), treeSignature(partial)]);
    if (a.length !== b.length || a.some((line, i) => line !== b[i])) {
      throw new Error(
        `the copy at ${quoteId(toPosix(partial))} did not match the source (a file's content, ` +
          'size or permissions differ; a disk that keeps no permissions, such as exFAT, cannot ' +
          'take a copy this command trusts)',
      );
    }
    await rename(partial, dst);
  } catch (err) {
    await rm(partial, { recursive: true, force: true });
    throw new Error(
      `copying ${quoteId(toPosix(src))} failed (${(err as Error).message}); the copy was ` +
        'removed and the source left in place',
      { cause: err },
    );
  }
  const aside = path.join(path.dirname(src), `${ASIDE_PREFIX}${token}-${path.basename(src)}`);
  await rename(src, aside);
  await rm(aside, { recursive: true, force: true });
}

/**
 * Whether two raw registry entries are one registration. `default` is left out: a run that
 * imported an entry without it (the new workspace already had a default) and stopped before
 * retiring the old registry must find that entry migrated, not "registered differently".
 */
function sameEntry(a: unknown, b: unknown): boolean {
  const strip = (e: unknown): unknown => {
    if (typeof e !== 'object' || e === null || Array.isArray(e)) return e;
    const { default: _default, ...rest } = e as Record<string, unknown>;
    return rest;
  };
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

/** Whether a raw registry entry carries `default: true`. */
function isDefault(entry: unknown): boolean {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    (entry as Record<string, unknown>).default === true
  );
}

/** A local project's directory, resolved, or undefined for a git (or unreadable) entry. */
function localPathOf(entry: unknown): string | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined;
  const e = entry as Record<string, unknown>;
  return e.mode === 'local' && typeof e.path === 'string' ? path.resolve(e.path) : undefined;
}

export async function migrateWorkspace(opts: MigrationOptions): Promise<MigrationReport> {
  const from = path.resolve(opts.from);
  const to = path.resolve(opts.to);
  const reasons: string[] = [];

  if (await sameOrNested(from, to)) {
    throw new MigrationRefusedError([
      `${quoteId(toPosix(from))} and ${quoteId(toPosix(to))} are the same folder or one holds ` +
        'the other.',
    ]);
  }
  let fromStat;
  try {
    fromStat = await lstat(from);
  } catch {
    throw new MigrationRefusedError([`${quoteId(toPosix(from))} does not exist.`]);
  }
  if (!fromStat.isDirectory()) {
    throw new MigrationRefusedError([`${quoteId(toPosix(from))} is not a directory.`]);
  }
  // Every entry of `from` is moved, so `from` must be a workspace — never a folder named by
  // mistake, whose contents this would otherwise carry off wholesale.
  if (
    !(await exists(registryPath(from))) &&
    !(await exists(path.join(from, SESSIONS_DIRNAME))) &&
    !(await exists(path.join(from, RETIRED_REGISTRY)))
  ) {
    throw new MigrationRefusedError([
      `${quoteId(toPosix(from))} is not a web-latex-mcp workspace: it holds neither ` +
        `${REGISTRY_FILENAME} nor ${SESSIONS_DIRNAME}/.`,
    ]);
  }

  // Registries: both must be readable, or the merge would drop what it cannot read.
  const fromRead = readRawRegistryFile(registryPath(from));
  const toRead = readRawRegistryFile(registryPath(to));
  if (!fromRead.ok) {
    reasons.push(`${quoteId(toPosix(registryPath(from)))} cannot be read: ${fromRead.reason}.`);
  }
  if (!toRead.ok) {
    reasons.push(`${quoteId(toPosix(registryPath(to)))} cannot be read: ${toRead.reason}.`);
  }

  reasons.push(...(await busyReasons(from, 'In the old workspace,')));
  reasons.push(...(await busyReasons(to, 'In the new workspace,')));

  // Registry entries: an id held by both registries is a collision unless the entries are
  // identical (an interrupted earlier run already merged it); an id equal to one in `to` only
  // under `projectIdFold` always is, since on a case-insensitive disk both name one directory.
  const toRaw = toRead.ok ? toRead.raw : Object.create(null);
  const fromRaw = fromRead.ok ? fromRead.raw : Object.create(null);
  const toIds = Object.keys(toRaw);
  const toLocalPaths = new Map<string, string>();
  for (const id of toIds) {
    const p = localPathOf(toRaw[id]);
    if (p !== undefined) toLocalPaths.set(p, id);
  }
  const imports: string[] = [];
  const alreadyRegistered: string[] = [];
  const plan = await readPlan(from);
  if (plan && !(await sameFolder(plan.to, to))) {
    // Finishing into another folder would leave what the first run moved where no registry
    // lists it, and retire the only registry that did.
    throw new MigrationRefusedError([
      `An earlier run of this migration stopped while moving into ${quoteId(toPosix(plan.to))}. ` +
        `Finish it first: run the command again with --to ${quoteId(toPosix(plan.to))}.`,
    ]);
  }
  const planned = plan?.entries ?? new Set<string>();
  for (const id of Object.keys(fromRaw)) {
    if (Object.hasOwn(toRaw, id)) {
      if (sameEntry(toRaw[id], fromRaw[id])) alreadyRegistered.push(id);
      else
        reasons.push(
          `Project ${quoteId(id)} is registered in both workspaces, differently. Rename or ` +
            'remove one of them.',
        );
      continue;
    }
    const alias = toIds.find((known) => projectIdFold(known) === projectIdFold(id));
    if (alias !== undefined) {
      reasons.push(
        `Project ${quoteId(id)} differs from ${quoteId(alias)} in the new workspace only in letter ` +
          'case; on a case-insensitive disk both name one directory. Rename one of them.',
      );
      continue;
    }
    const local = localPathOf(fromRaw[id]);
    const owner = local !== undefined ? toLocalPaths.get(local) : undefined;
    if (local !== undefined && owner !== undefined) {
      reasons.push(
        `Project ${quoteId(id)} uses ${quoteId(toPosix(local))}, which ${quoteId(owner)} in the ` +
          'new workspace already uses. One directory can belong to one project only.',
      );
      continue;
    }
    // A git entry names `<to>/<id>` as its clone: a directory already there that no registry
    // entry names (an env-configured project's clone) would be adopted as this project's.
    const isGit = typeof fromRaw[id] === 'object' && localPathOf(fromRaw[id]) === undefined;
    if (
      isGit &&
      !planned.has(id) &&
      !(await exists(path.join(from, id))) &&
      (await exists(path.join(to, id)))
    ) {
      reasons.push(
        `${quoteId(toPosix(path.join(to, id)))} already exists in the new workspace and no ` +
          `project there registers it, so project ${quoteId(id)} cannot take that name. Move or ` +
          'remove that directory.',
      );
      continue;
    }
    imports.push(id);
  }

  // Directory entries: every top-level entry and every `.sessions/<id>`, refused when `to` already
  // has that name (lstat, so a case-insensitive disk answers for case variants too).
  const moves: Array<{ rel: string; src: string; dst: string }> = [];
  for (const name of await listDir(from)) {
    if (isSpecialTopLevel(name)) continue;
    // A workspace holds clones (one directory per project id) and surfaced `<id>.pdf` copies.
    // Anything else is not the server's, so it is named rather than carried off.
    const st = await lstat(path.join(from, name));
    const isClone = st.isDirectory() && projectIdProblem(name) === undefined;
    const isPdf =
      st.isFile() && name.endsWith('.pdf') && projectIdProblem(name.slice(0, -4)) === undefined;
    // The arxiv-clean-project skill writes `<id>_arXiv.zip` beside the clones.
    const isExport =
      st.isFile() &&
      name.endsWith('_arXiv.zip') &&
      projectIdProblem(name.slice(0, -'_arXiv.zip'.length)) === undefined;
    if (!isClone && !isPdf && !isExport) {
      reasons.push(
        `${quoteId(toPosix(path.join(from, name)))} is neither a clone, a compiled PDF nor an arXiv export, so it ` +
          'is not moved. Move it out of the folder, then run the command again.',
      );
      continue;
    }
    moves.push({ rel: name, src: path.join(from, name), dst: path.join(to, name) });
  }
  for (const name of await listDir(path.join(from, SESSIONS_DIRNAME))) {
    if (name.startsWith(ASIDE_PREFIX) || OS_LITTER.has(name)) continue;
    moves.push({
      rel: `${SESSIONS_DIRNAME}/${name}`,
      src: path.join(from, SESSIONS_DIRNAME, name),
      dst: path.join(to, SESSIONS_DIRNAME, name),
    });
  }
  for (const m of moves) {
    if (await exists(m.dst)) {
      reasons.push(
        `${quoteId(toPosix(m.dst))} already exists in the new workspace, so ` +
          `${quoteId(m.rel)} cannot be moved there. Move or remove one of them.`,
      );
    }
  }

  if (reasons.length > 0) throw new MigrationRefusedError(reasons);
  if (moves.length === 0 && imports.length === 0 && !(await exists(registryPath(from)))) {
    // Already migrated (or nothing there): leave both folders exactly as they are.
    return { from: toPosix(from), to: toPosix(to), moved: [], registered: [], alreadyRegistered };
  }

  // Carried out: the plan written, the moves, the registry merge, `from`'s registry retired.
  await writeFile(
    path.join(from, PLAN_FILE),
    `${JSON.stringify({ to, entries: [...new Set([...planned, ...moves.map((m) => m.rel)])] })}\n`,
    'utf8',
  );
  await mkdir(path.join(to, SESSIONS_DIRNAME), { recursive: true });
  await clearLeftovers(from, to);
  const moved: string[] = [];
  for (const m of moves) {
    try {
      await moveEntry(m.src, m.dst, opts.rename ?? rename, opts.copy ?? copyTree);
    } catch (err) {
      throw new Error(
        `Stopped after moving ${moved.length} of ${moves.length} entries: moving ` +
          `${quoteId(m.rel)} failed (${(err as Error).message}). Run the command again, with ` +
          `--to ${quoteId(toPosix(to))}, to move the rest; what was moved stays moved.`,
        { cause: err },
      );
    }
    moved.push(m.rel);
  }

  let defaultDropped: string | undefined;
  if (imports.length > 0) {
    const toHasDefault = toIds.some((id) => isDefault(toRaw[id]));
    const entries: Record<string, unknown> = Object.create(null);
    for (const id of imports) {
      const entry = fromRaw[id];
      if (toHasDefault && isDefault(entry)) {
        const { default: _drop, ...rest } = entry as Record<string, unknown>;
        entries[id] = rest;
        defaultDropped = id;
      } else {
        entries[id] = entry;
      }
    }
    await importRegistryEntries(to, entries);
  }

  if (await exists(registryPath(from))) {
    // Never over an earlier migration's retired copy.
    let retired = path.join(from, RETIRED_REGISTRY);
    if (await exists(retired)) retired = `${retired}-${Date.now()}`;
    await rename(registryPath(from), retired);
  }
  await rm(path.join(from, PLAN_FILE), { force: true });
  await writeFile(
    path.join(from, MIGRATED_NOTE),
    '# Moved\n\n' +
      `The projects and clones that were here were moved to \`${toPosix(to)}\` by ` +
      '`web-latex-mcp migrate-workspace`. The old project list is kept as ' +
      `\`${RETIRED_REGISTRY}\`. This folder can be deleted.\n`,
    'utf8',
  );

  return {
    from: toPosix(from),
    to: toPosix(to),
    moved,
    registered: imports,
    alreadyRegistered,
    ...(defaultDropped !== undefined ? { defaultDropped } : {}),
  };
}
