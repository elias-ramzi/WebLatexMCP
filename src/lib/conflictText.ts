import type { ConflictReport, RemoteCommit } from '../services/gitService.js';
import type { ConflictHunk } from './conflictParser.js';

/**
 * Render a {@link ConflictReport} into the plain text of the tool result — the part an MCP client
 * always shows the model. The structured fields carry the same data, but a client may drop them, so
 * everything needed to compute a merge (per-file sides, the remote head, what landed) also goes
 * here. Large sides are elided with a `read_file(path, ref)` pointer to keep the payload bounded.
 */

/** Above this many characters, a side is elided from the text (still available via read_file/struct). */
const INLINE_CAP = 12000;

function renderSide(label: string, content: string | null, hint: string): string {
  if (content === null) return `${label}: (absent — added or deleted on this side)`;
  if (content.length > INLINE_CAP) return `${label}: (${content.length} chars, elided — ${hint})`;
  return `${label}:\n${content}`;
}

/** Git-style `<<<<<<< ours / ======= / >>>>>>> theirs` blocks for the overlapping regions. */
function renderHunks(hunks: ConflictHunk[]): string {
  return hunks
    .map(
      (h) =>
        `<<<<<<< ours (lines ${h.startLine}-${h.endLine})\n${h.local.join('\n')}\n` +
        `=======\n${h.remote.join('\n')}\n>>>>>>> theirs`,
    )
    .join('\n');
}

export function renderConflictText(summary: string, report: ConflictReport): string {
  const out: string[] = [summary, '', report.guidance, ''];
  out.push(`remoteHead: ${report.remoteHead} (${report.remoteHead.slice(0, 8)})`);
  out.push('Pass remoteHead back as `expectedRemoteHead` when you resolve.');
  if (report.mergeBase) {
    out.push(`mergeBase: ${report.mergeBase} (${report.mergeBase.slice(0, 8)})`);
  }
  if (report.remoteCommits.length) {
    out.push(
      '',
      `Landed upstream (${report.remoteCommits.length} commit(s)):`,
      ...renderCommitLines(report.remoteCommits),
    );
  }
  out.push(
    '',
    `Conflicted file(s) (${report.conflictPaths.length}): ${report.conflictPaths.join(', ')}`,
  );
  // Fetch pointer for a side that's too large to inline — an exact ref, no shell needed.
  const baseHint = (p: string): string =>
    report.mergeBase
      ? `read_file("${p}", ref="${report.mergeBase}")`
      : 'see the overlap markers above';
  for (const f of report.files) {
    out.push('', `━━━━━ ${f.path} ━━━━━`);
    if (f.hunks.length) out.push('overlap:', renderHunks(f.hunks));
    out.push(renderSide('base (common ancestor)', f.base, baseHint(f.path)));
    out.push(renderSide('ours (local)', f.ours, `read_file("${f.path}", ref="HEAD")`));
    out.push(
      renderSide(
        'theirs (remote that landed)',
        f.theirs,
        `read_file("${f.path}", ref="${report.rebasedOnto}")`,
      ),
    );
  }
  return out.join('\n');
}

/**
 * Render commits (newest first) as text lines: `  <sha8> <subject>`, then each file the commit
 * touched as `      +<added>/-<removed> <path>` (capped at `maxFiles`, past which a "… N more
 * file(s)" line stands in), and past `maxCommits` a trailing "… N more commit(s)" line pointing
 * at structuredContent for the rest. Shared by `renderRebasedOver` and the "Landed upstream" block
 * below, and by `status`'s rendering of the same shape.
 */
export function renderCommitLines(
  commits: RemoteCommit[],
  opts?: { maxCommits?: number; maxFiles?: number },
): string[] {
  const maxCommits = opts?.maxCommits ?? 20;
  const maxFiles = opts?.maxFiles ?? 5;
  const out: string[] = [];
  for (const c of commits.slice(0, maxCommits)) {
    out.push(`  ${c.hash.slice(0, 8)} ${c.message}`);
    for (const f of c.files.slice(0, maxFiles)) {
      out.push(`      +${f.added}/-${f.removed} ${f.path}`);
    }
    if (c.files.length > maxFiles) {
      out.push(`      … ${c.files.length - maxFiles} more file(s)`);
    }
  }
  if (commits.length > maxCommits) {
    out.push(`  … ${commits.length - maxCommits} more commit(s) (see structuredContent)`);
  }
  return out;
}

/** `remote-moved` text: what landed upstream, without calling it "rebased over" — nothing was replayed onto it. */
export function renderLandedUpstream(commits?: RemoteCommit[]): string {
  if (!commits || commits.length === 0) return '';
  return [`Landed upstream (${commits.length} commit(s)):`, ...renderCommitLines(commits)].join(
    '\n',
  );
}

/** Success text: the summary plus, when present, the remote commits the change was rebased over. */
export function renderRebasedOver(commits?: RemoteCommit[]): string {
  if (!commits || commits.length === 0) return '';
  return [
    `Rebased over ${commits.length} commit(s) that landed underneath:`,
    ...renderCommitLines(commits),
  ].join('\n');
}
