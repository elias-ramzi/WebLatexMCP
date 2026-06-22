/**
 * Parse Git conflict markers out of a conflicted file. Pure and side-effect-free
 * (like {@link ../services/logParser}), so it is unit-testable against canned
 * strings without touching git.
 *
 * A standard (merge-style) conflict looks like:
 *
 *     <<<<<<< HEAD
 *     ...head side...
 *     =======
 *     ...other side...
 *     >>>>>>> a1b2c3d (some commit)
 *
 * With `merge.conflictStyle = diff3` an extra base section appears between the
 * head side and `=======`, introduced by `|||||||`; we skip it.
 *
 * During a `git pull --rebase` / `git rebase`, HEAD is the branch we are rebasing
 * *onto* — i.e. the upstream/remote tip — and the lower side is our commit being
 * replayed. So by default the HEAD side maps to `remote` and the other side to
 * `local`. Pass `headSide: 'local'` to flip it for a plain merge.
 */

export interface ConflictHunk {
  /** 1-based line of the `<<<<<<<` marker in the conflicted working file. */
  startLine: number;
  /** 1-based line of the `>>>>>>>` marker. */
  endLine: number;
  /** Our version (the commit being replayed during a rebase). */
  local: string[];
  /** Upstream version (what already landed on the base branch). */
  remote: string[];
}

export interface ConflictFile {
  /** POSIX-separated path, relative to the project root. */
  path: string;
  hunks: ConflictHunk[];
}

const OURS = '<<<<<<<';
const BASE = '|||||||';
const SEP = '=======';
const THEIRS = '>>>>>>>';

type Phase = 'none' | 'head' | 'base' | 'other';

/** Extract the conflict hunks from a file's contents. Returns `[]` when there are none. */
export function parseConflictHunks(
  content: string,
  opts: { headSide?: 'local' | 'remote' } = {},
): ConflictHunk[] {
  const headIsRemote = (opts.headSide ?? 'remote') === 'remote';
  const lines = content.split('\n');
  const hunks: ConflictHunk[] = [];

  let phase: Phase = 'none';
  let startLine = 0;
  let headLines: string[] = [];
  let otherLines: string[] = [];

  const marker = (line: string, token: string): boolean => line.startsWith(token);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    switch (phase) {
      case 'none':
        if (marker(line, OURS)) {
          phase = 'head';
          startLine = i + 1;
          headLines = [];
          otherLines = [];
        }
        break;
      case 'head':
        if (marker(line, BASE)) phase = 'base';
        else if (marker(line, SEP)) phase = 'other';
        else headLines.push(line);
        break;
      case 'base':
        // Skip the diff3 base section entirely.
        if (marker(line, SEP)) phase = 'other';
        break;
      case 'other':
        if (marker(line, THEIRS)) {
          hunks.push({
            startLine,
            endLine: i + 1,
            local: headIsRemote ? otherLines : headLines,
            remote: headIsRemote ? headLines : otherLines,
          });
          phase = 'none';
        } else {
          otherLines.push(line);
        }
        break;
    }
  }

  return hunks;
}
