import { mkdir, readFile, rm } from 'node:fs/promises';
import { compileDefaultsPath, sessionStateDir } from '../lib/sessionPaths.js';
import { compileDefaultsSchema } from '../lib/compileDefaults.js';
import type { CompileDefaults } from '../lib/compileDefaults.js';
import { writeAtomic } from './sessionRegistry.js';

/**
 * Persists a project's compile defaults set by `set_compile_defaults`, under
 * `<workspaceRoot>/.sessions/<projectId>/compile-defaults.json` — beside the clone, never inside
 * it, shared by every session on the project and outliving a restart.
 *
 * Fail-soft like `RewriteModeStore`: a missing file is `null` (nothing stored), and a malformed,
 * unreadable or invalid one is `null` too, logged to stderr, so a broken file can never stop a
 * compile — the call then runs on its own arguments and the server's defaults, as before the
 * defaults were set.
 */
export class CompileDefaultsStore {
  constructor(private readonly workspaceRoot: string) {}

  async get(projectId: string): Promise<CompileDefaults | null> {
    const file = compileDefaultsPath(this.workspaceRoot, projectId);
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      console.error(
        `compileDefaultsStore: could not read ${file} (${code ?? (err as Error).message}); ` +
          `treating as nothing stored.`,
      );
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.error(
        `compileDefaultsStore: malformed JSON in ${file}, ignoring: ${(err as Error).message}`,
      );
      return null;
    }
    const checked = compileDefaultsSchema.safeParse(parsed);
    if (!checked.success) {
      console.error(
        `compileDefaultsStore: ${file} is not a valid set of compile defaults, ignoring: ` +
          checked.error.message,
      );
      return null;
    }
    return Object.keys(checked.data).length > 0 ? checked.data : null;
  }

  async set(projectId: string, defaults: CompileDefaults): Promise<void> {
    await mkdir(sessionStateDir(this.workspaceRoot, projectId), { recursive: true });
    await writeAtomic(
      compileDefaultsPath(this.workspaceRoot, projectId),
      JSON.stringify(defaults, null, 2),
    );
  }

  async clear(projectId: string): Promise<void> {
    await rm(compileDefaultsPath(this.workspaceRoot, projectId), { force: true });
  }
}
