import { mkdir, readFile } from 'node:fs/promises';
import { rewriteModePath, sessionStateDir } from '../lib/sessionPaths.js';
import { REWRITE_MODES } from '../lib/rewriteMode.js';
import type { RewriteMode } from '../lib/rewriteMode.js';
import { writeAtomic } from './sessionRegistry.js';

/** On-disk shape of the stored mode — an object, not a bare string, so it has room to grow. */
interface RewriteModeRecord {
  mode: string;
}

function isRewriteMode(value: string): value is RewriteMode {
  return (REWRITE_MODES as readonly string[]).includes(value);
}

/**
 * Persists the sticky per-project rewrite-preservation mode set by `set_rewrite_mode`, so it
 * survives restarts and is shared by every session working on the project. State lives under
 * `<workspaceRoot>/.sessions/<projectId>/rewrite-mode.json` (see `src/lib/sessionPaths.ts`) —
 * beside the clone, never inside it.
 *
 * Fail-soft like `SessionRegistry.readRecord`: a missing, malformed, or unreadable file, or one
 * holding a string that is no longer a valid mode, resolves to `null` rather than throwing, so
 * the caller can fall through to the env default. `null` is deliberately distinct from `'off'` —
 * conflating "nothing stored" with "off" would silently change behaviour for every project that
 * predates this store. A read that fails for a reason other than "nothing stored yet" (EACCES,
 * EISDIR, EMFILE, …) is logged to stderr before returning `null`, so a project whose stored mode
 * became unreadable doesn't silently revert to the default with nothing telling the user.
 */
export class RewriteModeStore {
  constructor(private readonly workspaceRoot: string) {}

  async get(projectId: string): Promise<RewriteMode | null> {
    const file = rewriteModePath(this.workspaceRoot, projectId);
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return null; // nothing stored yet
      }
      console.error(
        `rewriteModeStore: could not read ${file} (${code ?? (err as Error).message}); ` +
          `treating as nothing stored.`,
      );
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.error(
        `rewriteModeStore: malformed JSON in ${file}, ignoring: ${(err as Error).message}`,
      );
      return null;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      console.error(
        `rewriteModeStore: ${file} holds ${JSON.stringify(parsed)}, expected an object with a ` +
          `mode field. Ignoring.`,
      );
      return null;
    }
    const record = parsed as Partial<RewriteModeRecord>;
    if (typeof record.mode !== 'string' || !isRewriteMode(record.mode)) {
      console.error(
        `rewriteModeStore: ${file} holds an unrecognised mode ${JSON.stringify(
          record.mode,
        )}; expected one of ${REWRITE_MODES.join(', ')}. Ignoring.`,
      );
      return null;
    }
    return record.mode;
  }

  async set(projectId: string, mode: RewriteMode): Promise<void> {
    const dir = sessionStateDir(this.workspaceRoot, projectId);
    await mkdir(dir, { recursive: true });
    const record: RewriteModeRecord = { mode };
    await writeAtomic(
      rewriteModePath(this.workspaceRoot, projectId),
      JSON.stringify(record, null, 2),
    );
  }
}
