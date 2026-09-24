import path from 'node:path';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { z } from 'zod';
import { withFileLock } from '../lib/fileLock.js';
import { isLocalProject } from '../lib/projectMode.js';
import {
  assertValidProjectId,
  describeSkippedProject,
  projectIdProblem,
} from '../lib/projectId.js';
import type { ProjectConfig, SkippedProject } from '../types.js';

/**
 * Persistent store for projects registered at runtime (via the `register_project` tool), kept
 * beside the clones so a git URL added from the chat survives a restart and is picked up by every
 * other session that reads the same workspace.
 *
 * It holds only the runtime-registered projects — those configured through `WEB_LATEX_MCP_PROJECTS`
 * stay in the environment and always take precedence (see `loadConfig`). The file is the same
 * `id → { gitUrl, … }` shape as the env variable, so it is easy to inspect and hand-edit.
 *
 * One entry may also carry `default: true` — set via `register_project { default: true }` — naming
 * the project used when a tool call omits `project` and `WEB_LATEX_MCP_DEFAULT_PROJECT` is unset.
 * At most one entry has it at a time. It is registry metadata, not project config: `ProjectConfig`
 * (and everything `readProjectRegistry`/`ProjectRegistry.read()` hand back) never carries it — only
 * `readProjectRegistryDefault`/`ProjectRegistry.readDefault()` do.
 */

/** Name of the persisted registry file under the workspace root. */
export const REGISTRY_FILENAME = 'registry.json';

/** Path to the persisted registry file for a workspace. */
export function registryPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, REGISTRY_FILENAME);
}

/**
 * The persisted shape of ONE entry: the same as a `WEB_LATEX_MCP_PROJECTS` value, plus an optional
 * `default` flag. An entry without `mode` is a git project, which is what every entry written
 * before local mode existed looks like.
 *
 * Validated per entry, not as one schema over the whole file: a single hand-edited entry that
 * fails (a local entry with no `path`, an id `src/lib/projectId.ts` refuses) used to fail the
 * whole union, read back as `{}` — every registration gone — and the next `upsert` then wrote
 * that `{}` plus its own entry over the file, destroying the rest for good.
 */
const entrySchema = z.union([
  z.object({
    mode: z.literal('git').optional(),
    gitUrl: z.string().min(1),
    rootFile: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
    username: z.string().min(1).optional(),
    tokenEnv: z.string().min(1).optional(),
    default: z.boolean().optional(),
  }),
  z.object({
    mode: z.literal('local'),
    path: z.string().min(1),
    rootFile: z.string().min(1).optional(),
    followSymlinks: z.boolean().optional(),
    default: z.boolean().optional(),
  }),
]);

type RegistryEntry = z.infer<typeof entrySchema>;
type RegistryFile = Record<string, RegistryEntry>;

/**
 * The file as JSON, every entry kept whatever it holds — what `upsert` rewrites, so an entry this
 * version cannot use is carried through verbatim rather than dropped.
 */
type RawRegistry = Record<string, unknown>;

type RawRead = { ok: true; raw: RawRegistry } | { ok: false; reason: string };

/**
 * A fresh object with NO prototype, for every id-keyed record read from or written to the file.
 * On an ordinary `{}`, `map["__proto__"] = entry` calls the prototype setter instead of adding an
 * entry — a registration reported success, persisted nothing, and the loop clearing the other
 * entries' `default` had already run. `projectIdProblem` refuses the name too; this is the other
 * fence, so the next such name (or a hand-edited file) cannot reach the setter at all.
 */
function nullProtoRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/** Messages already written to stderr, so a bad entry is reported once, not on every tool call. */
const reported = new Set<string>();

function reportOnce(message: string): void {
  if (reported.has(message)) return;
  reported.add(message);
  console.error(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read the registry file as raw JSON. An absent file is an empty registry; text that is not JSON,
 * or JSON that is not an object, is `ok: false` — the one case where nothing in it can be trusted
 * to be carried forward, so `upsert` refuses rather than overwrite it.
 */
function readRawRegistry(filePath: string): RawRead {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (err) {
    // Only a missing file is an empty registry. One that exists but cannot be read (permissions,
    // a directory in its place) is not known to be empty, so `upsert` must not overwrite it.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      return { ok: true, raw: nullProtoRecord() };
    return { ok: false, reason: (err as Error).message };
  }
  // An empty (or whitespace-only) file holds no registration, so it IS an empty registry — a
  // truncated write or a `touch` leaves one. Refusing it would block every `register_project`
  // behind a parse error while protecting nothing: the refusal below exists so a rewrite never
  // drops registrations, and there are none here to drop.
  if (text.trim() === '') return { ok: true, raw: nullProtoRecord() };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
  if (!isPlainObject(json)) return { ok: false, reason: 'the top level is not a JSON object' };
  // `JSON.parse` makes a "__proto__" key an own property, but the object it returns still has
  // `Object.prototype`, so a later `raw[id] = …` would reach the setter. Copied key by key with
  // `defineProperty`, which never does.
  const raw = nullProtoRecord<unknown>();
  for (const [key, value] of Object.entries(json)) {
    Object.defineProperty(raw, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return { ok: true, raw };
}

/**
 * Read the persisted registry file synchronously as its map of USABLE entries (still carrying
 * `default` flags), plus the entries it skipped. An entry with an invalid id or shape is reported
 * on stderr and skipped — the others still load. An absent file is `{}`; an unparseable one is
 * reported and read as `{}`, so a bad file never blocks startup. Internal — every external reader
 * goes through `readProjectRegistry` (which strips `default`), `readProjectRegistryDefault` (which
 * reports only the flag) or `readProjectRegistrySkipped`.
 */
function readRegistryFile(workspaceRoot: string): {
  entries: RegistryFile;
  skipped: SkippedProject[];
} {
  const filePath = registryPath(workspaceRoot);
  const read = readRawRegistry(filePath);
  if (!read.ok) {
    reportOnce(`[web-latex-mcp] ignoring invalid ${filePath}: ${read.reason}`);
    return { entries: nullProtoRecord(), skipped: [] };
  }
  const entries: RegistryFile = nullProtoRecord();
  const skipped: SkippedProject[] = [];
  const skip = (entry: SkippedProject): void => {
    skipped.push(entry);
    reportOnce(`[web-latex-mcp] ${describeSkippedProject(entry, workspaceRoot)}`);
  };
  for (const [id, value] of Object.entries(read.raw)) {
    const idProblem = projectIdProblem(id);
    if (idProblem !== undefined) {
      skip({ id, source: filePath, kind: 'id', problem: idProblem });
      continue;
    }
    const parsed = entrySchema.safeParse(value);
    if (!parsed.success) {
      const problem = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'entry'}: ${issue.message}`)
        .join('; ');
      skip({ id, source: filePath, kind: 'entry', problem });
      continue;
    }
    entries[id] = parsed.data;
  }
  return { entries, skipped };
}

/**
 * The registry entries that were NOT loaded, with why (see `readRegistryFile`), so a call naming
 * one can be told the reason rather than "Unknown project". `[]` for an absent or unparseable file.
 */
export function readProjectRegistrySkipped(workspaceRoot: string): SkippedProject[] {
  return readRegistryFile(workspaceRoot).skipped;
}

/**
 * Read the persisted registry synchronously as `ProjectConfig`s. Returns `[]` when the file is
 * absent (the common case — nothing registered yet) or unparseable, so a bad file never blocks
 * startup. Used both at startup (via `loadConfig`) and on an unknown-project miss (to pick up a
 * peer's registration). Entries never carry `default` — that is registry metadata, not project
 * config; see `readProjectRegistryDefault` for it.
 */
export function readProjectRegistry(workspaceRoot: string): ProjectConfig[] {
  const map = readRegistryFile(workspaceRoot).entries;
  return Object.entries(map).map(([id, cfg]) => {
    const { default: _default, ...rest } = cfg;
    return { id, ...rest } as ProjectConfig;
  });
}

/**
 * Id of the persisted default project — the first entry with `default: true` — or `undefined`
 * when there is none (no file, an invalid file, or no entry flagged). At most one entry should
 * ever carry the flag (`ProjectRegistry.upsert` enforces that), but this reports the first found
 * defensively rather than throwing on a hand-edited file with two.
 */
export function readProjectRegistryDefault(workspaceRoot: string): string | undefined {
  const map = readRegistryFile(workspaceRoot).entries;
  for (const [id, cfg] of Object.entries(map)) {
    if (cfg.default === true) return id;
  }
  return undefined;
}

/** A configured registry the server can read from and persist to. */
export class ProjectRegistry {
  private readonly filePath: string;
  private readonly lockPath: string;

  constructor(private readonly workspaceRoot: string) {
    this.filePath = registryPath(workspaceRoot);
    this.lockPath = `${this.filePath}.lock`;
  }

  /** Current persisted projects (synchronous; `[]` when none). Never carries `default`. */
  read(): ProjectConfig[] {
    return readProjectRegistry(this.workspaceRoot);
  }

  /** Id of the persisted default project, or `undefined`. See `readProjectRegistryDefault`. */
  readDefault(): string | undefined {
    return readProjectRegistryDefault(this.workspaceRoot);
  }

  /** Entries skipped on read, with why. See `readProjectRegistrySkipped`. */
  skipped(): SkippedProject[] {
    return readProjectRegistrySkipped(this.workspaceRoot);
  }

  /**
   * Persist (add or update) a project. Read-modify-write under a cross-process lock so two
   * sessions registering different projects at once can't clobber each other, and the write is
   * atomic (temp file + rename) so a reader never sees a half-written file.
   *
   * `opts.makeDefault: true` flags this entry as the default and clears the flag from every other
   * entry — at most one project is ever the default. Omitted (or `false`), the entry keeps
   * whatever `default` it already had in the file: a plain re-register (e.g. updating `rootFile`)
   * must not silently drop a previously-set default.
   *
   * Every other entry is written back exactly as it was read — including one this version cannot
   * use (skipped on read, see `readRegistryFile`), so a hand-edit mistake stays in the file to be
   * fixed rather than being deleted by an unrelated registration. When the file is not a JSON
   * object at all there is nothing that can be carried forward safely, so this refuses and leaves
   * the file untouched rather than replace every registration in it with this one.
   */
  async upsert(cfg: ProjectConfig, opts?: { makeDefault?: boolean }): Promise<void> {
    // Never write an entry every reader would skip.
    assertValidProjectId(cfg.id);
    await withFileLock(
      this.lockPath,
      async () => {
        const read = readRawRegistry(this.filePath);
        if (!read.ok) {
          throw new Error(
            `Refusing to update the project registry ${this.filePath}: it is not valid (` +
              `${read.reason}), and rewriting it would drop every registration in it. Fix or ` +
              'move the file, then register again.',
          );
        }
        const map = read.raw; // null-prototype (see `readRawRegistry`)
        const existing = Object.hasOwn(map, cfg.id) ? map[cfg.id] : undefined;
        const entry: RegistryEntry = toEntry(cfg);
        if (opts?.makeDefault === true) {
          for (const [id, other] of Object.entries(map)) {
            if (id !== cfg.id && isPlainObject(other)) delete other.default;
          }
          entry.default = true;
        } else if (isPlainObject(existing) && existing.default === true) {
          entry.default = true;
        }
        map[cfg.id] = entry;
        this.writeAtomic(map);
      },
      { owner: 'registry' },
    );
  }

  private writeAtomic(map: RawRegistry): void {
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
    renameSync(tmp, this.filePath);
  }
}

/** Drop the synthetic `id` field — the file keys projects by id. Never sets `default`. */
function toEntry(cfg: ProjectConfig): RegistryEntry {
  if (isLocalProject(cfg)) {
    const { mode, path: dir, rootFile, followSymlinks } = cfg;
    return { mode, path: dir, rootFile, followSymlinks };
  }
  const { gitUrl, rootFile, branch, username, tokenEnv } = cfg;
  return { gitUrl, rootFile, branch, username, tokenEnv };
}
