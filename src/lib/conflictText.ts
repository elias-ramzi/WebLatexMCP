import type { ConflictReport } from '../services/gitService.js';
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
  if (report.remoteCommits.length) {
    out.push('', `Landed upstream (${report.remoteCommits.length} commit(s)):`);
    for (const c of report.remoteCommits) out.push(`  ${c.hash.slice(0, 8)} ${c.message}`);
  }
  out.push(
    '',
    `Conflicted file(s) (${report.conflictPaths.length}): ${report.conflictPaths.join(', ')}`,
  );
  for (const f of report.files) {
    out.push('', `━━━━━ ${f.path} ━━━━━`);
    if (f.hunks.length) out.push('overlap:', renderHunks(f.hunks));
    out.push(renderSide('base (common ancestor)', f.base, 'see the overlap markers above'));
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

/** Success text: the summary plus, when present, the remote commits the change was rebased over. */
export function renderRebasedOver(commits?: Array<{ hash: string; message: string }>): string {
  if (!commits || commits.length === 0) return '';
  return [
    `Rebased over ${commits.length} commit(s) that landed underneath:`,
    ...commits.map((c) => `  ${c.hash.slice(0, 8)} ${c.message}`),
  ].join('\n');
}
