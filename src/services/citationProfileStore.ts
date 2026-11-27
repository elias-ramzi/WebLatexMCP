import { mkdir, readFile, rm } from 'node:fs/promises';
import { citationProfilePath, sessionStateDir } from '../lib/sessionPaths.js';
import { citationProfileSchema, isEmptyProfile } from '../lib/citationProfile.js';
import type { CitationProfile } from '../lib/citationProfile.js';
import { writeAtomic } from './sessionRegistry.js';

/**
 * Persists a project's citation field profile set by `set_citation_profile` (#255), under
 * `<workspaceRoot>/.sessions/<projectId>/citation-profile.json` — beside the clone, never inside
 * it, shared by every session on the project and outliving a restart.
 *
 * Fail-soft like `CompileDefaultsStore`: a missing file is `null` (no profile), and a malformed,
 * unreadable or invalid one is `null` too, logged to stderr. A broken file therefore never stops
 * `add_citation`: the entry is then appended exactly as fetched, as before a profile was set —
 * the direction that loses nothing, since a profile only ever removes fields.
 */
export class CitationProfileStore {
  constructor(private readonly workspaceRoot: string) {}

  async get(projectId: string): Promise<CitationProfile | null> {
    const file = citationProfilePath(this.workspaceRoot, projectId);
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      console.error(
        `citationProfileStore: could not read ${file} (${code ?? (err as Error).message}); ` +
          'treating as no profile.',
      );
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.error(
        `citationProfileStore: malformed JSON in ${file}, ignoring: ${(err as Error).message}`,
      );
      return null;
    }
    const checked = citationProfileSchema.safeParse(parsed);
    if (!checked.success) {
      console.error(
        `citationProfileStore: ${file} is not a valid citation profile, ignoring: ` +
          checked.error.message,
      );
      return null;
    }
    return isEmptyProfile(checked.data) ? null : checked.data;
  }

  async set(projectId: string, profile: CitationProfile): Promise<void> {
    await mkdir(sessionStateDir(this.workspaceRoot, projectId), { recursive: true });
    await writeAtomic(
      citationProfilePath(this.workspaceRoot, projectId),
      JSON.stringify(profile, null, 2),
    );
  }

  async clear(projectId: string): Promise<void> {
    await rm(citationProfilePath(this.workspaceRoot, projectId), { force: true });
  }
}
