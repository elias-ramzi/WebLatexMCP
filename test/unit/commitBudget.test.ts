import { describe, it, expect } from 'vitest';
import {
  COMMIT_CONTENT_BUDGET,
  COMMIT_BUDGET_RESERVE,
  planCommitLists,
  committedFileCost,
  leftUncommittedCost,
  renderCommittedFileLine,
  renderLeftUncommittedLine,
  renderFilesOmittedLine,
  renderLeftUncommittedOmittedLine,
  type CommittedFile,
} from '../../src/lib/commitBudget.js';
import { resolveCommitScope } from '../../src/lib/commitScope.js';

const file = (i: number): CommittedFile => ({
  path: `generated/figure-${String(i).padStart(4, '0')}.txt`,
  added: 1,
  removed: 0,
});
const left = (i: number): string => `build/out-${String(i).padStart(4, '0')}.aux`;

/** Both channels exactly as `commit` renders the two lists (plus the counters' JSON). */
function rendered(plan: ReturnType<typeof planCommitLists>, sha: string): number {
  const text = [
    ...plan.files.map(renderCommittedFileLine),
    plan.filesOmitted > 0 ? renderFilesOmittedLine(plan.filesOmitted, sha) : '',
    plan.leftUncommitted.length ? renderLeftUncommittedLine(plan.leftUncommitted) : '',
    plan.leftUncommittedOmitted > 0
      ? renderLeftUncommittedOmittedLine(plan.leftUncommittedOmitted)
      : '',
  ]
    .filter(Boolean)
    .join('\n');
  const json = JSON.stringify({
    files: plan.files,
    filesOmitted: plan.filesOmitted,
    leftUncommitted: plan.leftUncommitted,
    leftUncommittedOmitted: plan.leftUncommittedOmitted,
  });
  return text.length + json.length;
}

describe('planCommitLists', () => {
  it('returns small lists whole, with zero counters', () => {
    const files = [file(1), file(2)];
    const plan = planCommitLists({ files, leftUncommitted: [left(1)] });
    expect(plan).toEqual({
      files,
      filesOmitted: 0,
      leftUncommitted: [left(1)],
      leftUncommittedOmitted: 0,
    });
  });

  it('keeps the rendered size of both lists within the budget, across both channels', () => {
    const files = Array.from({ length: 3000 }, (_, i) => file(i));
    const leftList = Array.from({ length: 3000 }, (_, i) => left(i));
    const sha = 'f'.repeat(40);
    for (const [f, l] of [
      [files, []],
      [[], leftList],
      [files, leftList],
    ] as const) {
      const plan = planCommitLists({ files: f, leftUncommitted: l });
      expect(plan.files.length + plan.filesOmitted).toBe(f.length);
      expect(plan.leftUncommitted.length + plan.leftUncommittedOmitted).toBe(l.length);
      expect(rendered(plan, sha)).toBeLessThanOrEqual(COMMIT_CONTENT_BUDGET);
      // And the budget is actually used, not padded into meaninglessness.
      expect(rendered(plan, sha)).toBeGreaterThan(COMMIT_CONTENT_BUDGET * 0.9);
    }
  });

  it('spends in strict priority: files first, and a starved lane still keeps one path', () => {
    const files = Array.from({ length: 3000 }, (_, i) => file(i));
    const plan = planCommitLists({ files, leftUncommitted: [left(1), left(2)] });
    expect(plan.filesOmitted).toBeGreaterThan(0);
    expect(plan.leftUncommitted).toEqual([left(1)]);
    expect(plan.leftUncommittedOmitted).toBe(1);
  });

  it('keeps a lone oversized entry rather than forging an empty list', () => {
    const huge = 'x/'.repeat(20000) + 'y.tex';
    const plan = planCommitLists({
      files: [{ path: huge, added: 1, removed: 1 }, file(1)],
      leftUncommitted: [huge, left(1)],
    });
    expect(plan.files.map((f) => f.path)).toEqual([huge]);
    expect(plan.filesOmitted).toBe(1);
    expect(plan.leftUncommitted).toEqual([huge]);
    expect(plan.leftUncommittedOmitted).toBe(1);
  });

  it('charges each element what it renders to in both channels', () => {
    const f = { path: 'a "quoted" \\ path.tex', added: 12, removed: 3 };
    expect(committedFileCost(f)).toBe(
      JSON.stringify(f).length + 1 + renderCommittedFileLine(f).length + 1,
    );
    const p = 'dir/with "quote".tex';
    expect(leftUncommittedCost(p)).toBe(JSON.stringify(p).length + 1 + p.length + 2);
  });

  it('the files-omitted line names a parent range, says a root commit has none, and does not overclaim', () => {
    const sha = 'a'.repeat(40);
    const line = renderFilesOmittedLine(12, sha);
    expect(line).toContain('12 more committed file(s)');
    expect(line).toContain(`"${sha}~1..${sha}"`);
    // A root commit has no `~1`: the line must not offer that range as the only way to see them.
    expect(line).toMatch(/first commit/);
    expect(line).toMatch(/no parent/);
    // `diff` is budgeted too, so it cannot be promised to list every file.
    expect(line).not.toMatch(/lists them/);
    expect(line).toMatch(/budgeted/);
  });

  it('the reserve pays for the longest trailing lines and the counters, with little to spare', () => {
    const worst =
      renderFilesOmittedLine(9_999_999, 'f'.repeat(40)).length +
      renderLeftUncommittedOmittedLine(9_999_999).length +
      // `"filesOmitted":N,` and `"leftUncommittedOmitted":N,` at seven digits, the two array
      // brackets pairs and the two newlines joining the trailing lines.
      JSON.stringify({ filesOmitted: 9_999_999, leftUncommittedOmitted: 9_999_999 }).length +
      4 +
      2;
    expect(worst).toBeLessThanOrEqual(COMMIT_BUDGET_RESERVE);
    expect(worst).toBeGreaterThan(COMMIT_BUDGET_RESERVE / 2);
  });
});

describe('resolveCommitScope (commit with no scope)', () => {
  it('is "session" whenever this session tracks a change, peers or not', () => {
    expect(resolveCommitScope({ tracksChanges: true, livePeerIds: ['beta'] })).toEqual({
      scope: 'session',
    });
  });

  it('falls back to "all" only when no live peer shares the clone', () => {
    expect(resolveCommitScope({ tracksChanges: false, livePeerIds: [] })).toEqual({
      scope: 'all',
    });
  });

  it('refuses, naming the peers and scope "all", when a live peer shares the clone', () => {
    const d = resolveCommitScope({ tracksChanges: false, livePeerIds: ['beta', 'gamma'] });
    expect('refusal' in d).toBe(true);
    const msg = (d as { refusal: string }).refusal;
    expect(msg).toMatch(/"beta", "gamma"/);
    expect(msg).toMatch(/scope "all" explicitly/);
    expect(msg).toMatch(/scope "paths"/);
  });
});
