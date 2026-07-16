import path from 'node:path';
import { createHash } from 'node:crypto';

/** Content hash used as a file's revision fingerprint. */
function hash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Remembers the content the server last read or wrote for each file, so mutating tools can
 * detect out-of-band edits (the user editing a clone directly in their editor) before they
 * overwrite them. Keyed by absolute path; lives for the server session.
 *
 * This is the file-level analogue of the server's git guarantees: like `push` refusing when
 * behind, a write refuses when the file changed underneath it — divergence is surfaced, never
 * silently clobbered.
 */
export class FileRevisionTracker {
  private readonly baselines = new Map<string, string>();

  /** Record the current content as the baseline for `absPath`. */
  record(absPath: string, content: string): void {
    this.baselines.set(path.resolve(absPath), hash(content));
  }

  /** Drop the baseline for `absPath` (e.g. after deleting the file). */
  forget(absPath: string): void {
    this.baselines.delete(path.resolve(absPath));
  }

  /** Drop every baseline under `dir` (e.g. after a pull or discard rewrote the tree). */
  reset(dir: string): void {
    const root = path.resolve(dir);
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    for (const key of this.baselines.keys()) {
      if (key === root || key.startsWith(prefix)) this.baselines.delete(key);
    }
  }

  /** Whether a baseline has been recorded for `absPath` this session. */
  hasBaseline(absPath: string): boolean {
    return this.baselines.has(path.resolve(absPath));
  }

  /**
   * True when there is a baseline for `absPath` but the on-disk content no longer matches it —
   * i.e. the file changed since the server last touched it. A file with no baseline is not
   * "stale" (the server never promised anything about it), so this returns false.
   */
  isStale(absPath: string, currentContent: string): boolean {
    const baseline = this.baselines.get(path.resolve(absPath));
    return baseline !== undefined && baseline !== hash(currentContent);
  }

  /**
   * True when the current on-disk content is not what the tools last read/wrote — either
   * because the server never saw the file (no baseline) or because it changed since. Used to
   * flag files a human edited directly, as opposed to changes the tools themselves made.
   */
  isExternal(absPath: string, currentContent: string): boolean {
    const baseline = this.baselines.get(path.resolve(absPath));
    return baseline === undefined || baseline !== hash(currentContent);
  }
}
