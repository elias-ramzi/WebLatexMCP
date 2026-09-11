import path from 'node:path';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { z } from 'zod';
import { withFileLock } from '../lib/fileLock.js';
import { isLocalProject } from '../lib/projectMode.js';
import type { ProjectConfig } from '../types.js';

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
 * The persisted shape: the same map as `WEB_LATEX_MCP_PROJECTS`, plus an optional `default` flag.
 * An entry without `mode` is a git project, which is what every entry written before local mode
 * existed looks like.
 */
const registrySchema = z.record(
  z.string(),
  z.union([
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
  ]),
);

type RegistryFile = z.infer<typeof registrySchema>;
type RegistryEntry = RegistryFile[string];

/** Parse registry file text into the raw registry map, tolerating a missing/invalid file. */
function parseRegistryFile(text: string, filePath: string): RegistryFile {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    console.error(`[web-latex-mcp] ignoring invalid ${filePath}: ${(err as Error).message}`);
    return {};
  }
  const result = registrySchema.safeParse(json);
  if (!result.success) {
    console.error(`[web-latex-mcp] ignoring invalid ${filePath}: ${result.error.message}`);
    return {};
  }
  return result.data;
}

/**
 * Read the persisted registry file synchronously as its raw map (still carrying `default`
 * flags). Returns `{}` when the file is absent or unparseable, so a bad file never blocks
 * startup. Internal — every external reader goes through `readProjectRegistry` (which strips
 * `default`) or `readProjectRegistryDefault` (which reports only the flag).
 */
function readRegistryFile(workspaceRoot: string): RegistryFile {
  const filePath = registryPath(workspaceRoot);
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return {}; // no registry yet
  }
  return parseRegistryFile(text, filePath);
}

/**
 * Read the persisted registry synchronously as `ProjectConfig`s. Returns `[]` when the file is
 * absent (the common case — nothing registered yet) or unparseable, so a bad file never blocks
 * startup. Used both at startup (via `loadConfig`) and on an unknown-project miss (to pick up a
 * peer's registration). Entries never carry `default` — that is registry metadata, not project
 * config; see `readProjectRegistryDefault` for it.
 */
export function readProjectRegistry(workspaceRoot: string): ProjectConfig[] {
  const map = readRegistryFile(workspaceRoot);
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
  const map = readRegistryFile(workspaceRoot);
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

  /**
   * Persist (add or update) a project. Read-modify-write under a cross-process lock so two
   * sessions registering different projects at once can't clobber each other, and the write is
   * atomic (temp file + rename) so a reader never sees a half-written file.
   *
   * `opts.makeDefault: true` flags this entry as the default and clears the flag from every other
   * entry — at most one project is ever the default. Omitted (or `false`), the entry keeps
   * whatever `default` it already had in the file: a plain re-register (e.g. updating `rootFile`)
   * must not silently drop a previously-set default.
   */
  async upsert(cfg: ProjectConfig, opts?: { makeDefault?: boolean }): Promise<void> {
    await withFileLock(
      this.lockPath,
      async () => {
        const map = readRegistryFile(this.workspaceRoot);
        const existing = map[cfg.id];
        const entry: RegistryEntry = toEntry(cfg);
        if (opts?.makeDefault === true) {
          for (const id of Object.keys(map)) {
            if (id !== cfg.id) delete map[id]!.default;
          }
          entry.default = true;
        } else if (existing?.default === true) {
          entry.default = true;
        }
        map[cfg.id] = entry;
        this.writeAtomic(map);
      },
      { owner: 'registry' },
    );
  }

  private writeAtomic(map: RegistryFile): void {
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
