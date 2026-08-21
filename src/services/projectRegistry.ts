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
 */

/** Name of the persisted registry file under the workspace root. */
export const REGISTRY_FILENAME = 'registry.json';

/** Path to the persisted registry file for a workspace. */
export function registryPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, REGISTRY_FILENAME);
}

/**
 * The persisted shape: the same map as `WEB_LATEX_MCP_PROJECTS`. Either a git remote or a local
 * directory; an entry without `mode` is a git project, which is what every entry written before
 * local mode existed looks like.
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
    }),
    z.object({
      mode: z.literal('local'),
      path: z.string().min(1),
      rootFile: z.string().min(1).optional(),
      followSymlinks: z.boolean().optional(),
    }),
  ]),
);

type RegistryFile = z.infer<typeof registrySchema>;

/** Parse registry file text into projects, tolerating a missing/invalid file (returns []). */
function parse(text: string, filePath: string): ProjectConfig[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    console.error(`[web-latex-mcp] ignoring invalid ${filePath}: ${(err as Error).message}`);
    return [];
  }
  const result = registrySchema.safeParse(json);
  if (!result.success) {
    console.error(`[web-latex-mcp] ignoring invalid ${filePath}: ${result.error.message}`);
    return [];
  }
  return Object.entries(result.data).map(([id, cfg]) => ({ id, ...cfg }));
}

/**
 * Read the persisted registry synchronously. Returns `[]` when the file is absent (the common
 * case — nothing registered yet) or unparseable, so a bad file never blocks startup. Used both at
 * startup (via `loadConfig`) and on an unknown-project miss (to pick up a peer's registration).
 */
export function readProjectRegistry(workspaceRoot: string): ProjectConfig[] {
  const filePath = registryPath(workspaceRoot);
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return []; // no registry yet
  }
  return parse(text, filePath);
}

/** A configured registry the server can read from and persist to. */
export class ProjectRegistry {
  private readonly filePath: string;
  private readonly lockPath: string;

  constructor(private readonly workspaceRoot: string) {
    this.filePath = registryPath(workspaceRoot);
    this.lockPath = `${this.filePath}.lock`;
  }

  /** Current persisted projects (synchronous; `[]` when none). */
  read(): ProjectConfig[] {
    return readProjectRegistry(this.workspaceRoot);
  }

  /**
   * Persist (add or update) a project. Read-modify-write under a cross-process lock so two
   * sessions registering different projects at once can't clobber each other, and the write is
   * atomic (temp file + rename) so a reader never sees a half-written file.
   */
  async upsert(cfg: ProjectConfig): Promise<void> {
    await withFileLock(
      this.lockPath,
      async () => {
        const current = this.read();
        const map: RegistryFile = {};
        for (const p of current) map[p.id] = toEntry(p);
        map[cfg.id] = toEntry(cfg);
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

/** Drop the synthetic `id` field — the file keys projects by id. */
function toEntry(cfg: ProjectConfig): RegistryFile[string] {
  if (isLocalProject(cfg)) {
    const { mode, path: dir, rootFile, followSymlinks } = cfg;
    return { mode, path: dir, rootFile, followSymlinks };
  }
  const { gitUrl, rootFile, branch, username, tokenEnv } = cfg;
  return { gitUrl, rootFile, branch, username, tokenEnv };
}
