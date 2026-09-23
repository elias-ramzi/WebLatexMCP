import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  ALLOCATION_ORDER,
  COMPLETE_STATUS_FIELDS,
  FLAT_LIST_ORDER,
  STATUS_COMMIT_MESSAGE_CAP,
  STATUS_COMMIT_TEXT_BUDGET,
  STATUS_CONTENT_BUDGET,
  STATUS_JSON_SCAFFOLD_OVERHEAD,
  STATUS_MAX_SESSIONS,
  STATUS_NOTE_RESERVE,
  STATUS_PEER_TEXT_PATHS,
  STATUS_COMPLETENESS_PROMISES,
  STATUS_UNPROMISED_POINTERS,
  buildStatusNote,
  pathCost,
  peerIdentityCost,
  peerPathCost,
  planCommitText,
  planStatusPayload,
  renderCommitBlock,
  renderPathListLine,
  type StatusPayloadInput,
  type StatusPayloadPlan,
  type StatusPeerInput,
} from '../../src/lib/statusBudget.js';
import type { RemoteCommit } from '../../src/services/gitService.js';

/**
 * `status` had no bound of any kind (#175) and ships every path list twice — once as a
 * `z.array(z.string())` in `structuredContent`, once `join(', ')`ed into the result text. These pin
 * the planner that bounds it.
 *
 * The central assertion is made against the bytes the tool actually sends (the JSON of the payload
 * PLUS the rendered text lines), not against a per-path constant: both channels ship in the same
 * result, so a budget counting a path once is wrong by 2x, which is #68's second-round lesson.
 */

const EMPTY: StatusPayloadInput = {
  staged: [],
  unstaged: [],
  untracked: [],
  externalChanges: [],
  sessionChanges: [],
  otherChanges: [],
  conflictedChanges: [],
  peers: [],
};

function input(over: Partial<StatusPayloadInput>): StatusPayloadInput {
  return { ...EMPTY, ...over };
}

/** A deep untracked tree: the ordinary shape that blows the payload up. */
function tree(prefix: string, n: number): string[] {
  return Array.from(
    { length: n },
    (_, i) =>
      `${prefix}/experiments/ablation-${String(i).padStart(4, '0')}/seed-${i % 7}/curve-precision-recall.pdf`,
  );
}

/** Every label the tool renders, so the size check charges the real text channel. */
const LABELS: Record<(typeof FLAT_LIST_ORDER)[number], string> = {
  conflictedChanges: '⚠ conflicted (this session vs a commit)',
  externalChanges: '⚠ changed directly (not via tools)',
  sessionChanges: 'this session ("alpha") changed',
  otherChanges: 'changed by others',
  staged: 'staged',
  unstaged: 'unstaged',
  untracked: 'untracked',
};

/**
 * What the tool sends for a plan, in BOTH channels: the JSON of every budgeted field plus the text
 * lines rendered from the same plan. Deliberately excludes `aheadCommits`/`behindCommits`, which
 * are outside this budget by decree (see the module note) and are covered by their own tests below.
 */
function renderedSize(plan: StatusPayloadPlan): number {
  const structured = {
    ...plan.lists,
    activeSessions: plan.peers.map((p) => ({
      session: p.session,
      live: p.live,
      lastSeen: p.lastSeen,
      changes: p.changes,
      changesOmitted: p.changesOmitted,
      lastWriteAt: p.lastWriteAt,
    })),
    activeSessionsOmitted: plan.activeSessionsOmitted,
    truncated: plan.truncated,
    ...(plan.truncated ? { pathsOmitted: plan.omitted } : {}),
    ...(plan.note ? { note: plan.note } : {}),
  };
  const lines = FLAT_LIST_ORDER.filter((name) => plan.lists[name].length > 0).map((name) =>
    renderPathListLine(LABELS[name], plan.lists[name], plan.omitted[name]),
  );
  const peerText = plan.peers
    .map((p) => {
      const shown = (p.changes ?? []).slice(0, STATUS_PEER_TEXT_PATHS);
      return `${p.session} (gone; ${shown.join(', ')} and 99 more; last write 3h ago)`;
    })
    .join(', ');
  return (
    JSON.stringify(structured).length +
    lines.join('\n').length +
    peerText.length +
    (plan.note ?? '').length
  );
}

function peer(over: Partial<StatusPeerInput> = {}): StatusPeerInput {
  return {
    session: 'beta',
    live: true,
    lastSeen: '2026-09-22T10:00:00.000Z',
    changes: [],
    lastWriteAt: '2026-09-22T09:59:00.000Z',
    ...over,
  };
}

function commit(hash: string, message: string, files = 5): RemoteCommit {
  return {
    hash,
    message,
    files: Array.from({ length: files }, (_, i) => ({
      path: `sections/chapter-${i}/very-long-file-name-for-this-commit.tex`,
      added: 12,
      removed: 3,
    })),
  };
}

describe('planStatusPayload: the budget is charged against what both channels render', () => {
  it('keeps a whole result inside the budget for a working tree far over it', () => {
    const untracked = tree('figures', 4000);
    const plan = planStatusPayload(
      input({ untracked, otherChanges: untracked, conflictedChanges: ['main.tex'] }),
    );

    expect(renderedSize(plan)).toBeLessThanOrEqual(STATUS_CONTENT_BUDGET);
    // Not vacuous: the budget must actually be USED, or "bounded" would be satisfied by returning
    // almost nothing. Half the budget is the floor this asserts against.
    expect(renderedSize(plan)).toBeGreaterThan(STATUS_CONTENT_BUDGET / 2);
    expect(plan.truncated).toBe(true);
    expect(plan.note).toBeDefined();
  });

  it('accounts for exactly what it cut, per list, with nothing lost and nothing double-counted', () => {
    const untracked = tree('figures', 2000);
    const staged = tree('build', 2000);
    const plan = planStatusPayload(input({ untracked, staged }));

    expect(plan.lists.untracked.length + plan.omitted.untracked).toBe(untracked.length);
    expect(plan.lists.staged.length + plan.omitted.staged).toBe(staged.length);
    // A kept list is a PREFIX of the input — never reordered, never cherry-picked for size.
    expect(plan.lists.staged).toEqual(staged.slice(0, plan.lists.staged.length));
  });

  it('cuts in ALLOCATION_ORDER: what blocks a commit survives, the untracked tree goes', () => {
    const big = tree('figures', 3000);
    const plan = planStatusPayload(
      input({
        conflictedChanges: ['refs/one.tex', 'refs/two.tex'],
        externalChanges: ['hand-edited.tex'],
        sessionChanges: big,
        otherChanges: big,
        staged: big,
        unstaged: big,
        untracked: big,
      }),
    );

    expect(plan.lists.conflictedChanges).toEqual(['refs/one.tex', 'refs/two.tex']);
    expect(plan.lists.externalChanges).toEqual(['hand-edited.tex']);
    expect(plan.omitted.conflictedChanges).toBe(0);
    expect(plan.omitted.externalChanges).toBe(0);
    // sessionChanges is allocated before otherChanges, which is allocated before the git triple,
    // which is cut with `untracked` last of all.
    expect(plan.lists.sessionChanges.length).toBeGreaterThan(plan.lists.otherChanges.length);
    expect(plan.lists.otherChanges.length).toBeGreaterThanOrEqual(plan.lists.staged.length);
    expect(plan.lists.untracked.length).toBeLessThanOrEqual(plan.lists.unstaged.length);
  });

  it('gives every lane a guaranteed share, so a big high-priority list cannot starve the rest', () => {
    // The shape this module exists for: ONE untracked tree lands in three lists at once. Under
    // strict priority alone `externalChanges` took the whole budget and `otherChanges`/`untracked`
    // came back with the single path keep-at-least-one forced — a bounded report, and a wrong one.
    const big = tree('figures', 400);
    const plan = planStatusPayload(
      input({ externalChanges: big, otherChanges: big, untracked: big }),
    );

    for (const name of ['externalChanges', 'otherChanges', 'untracked'] as const) {
      expect(plan.lists[name].length, `${name} was starved`).toBeGreaterThan(10);
    }
    // The surplus still goes by priority: the lane allocated first keeps the most.
    expect(plan.lists.externalChanges.length).toBeGreaterThan(plan.lists.untracked.length);
    expect(renderedSize(plan)).toBeLessThanOrEqual(STATUS_CONTENT_BUDGET);
  });

  it('leaves the surplus to priority when only one lane is large', () => {
    const plan = planStatusPayload(
      input({ untracked: tree('figures', 3000), conflictedChanges: ['main.tex'] }),
    );

    // Nothing else wanted its share, so the one big lane gets nearly the whole budget rather than
    // one eighth of it — the property the second pass exists for.
    expect(plan.lists.untracked.length).toBeGreaterThan(100);
  });

  it('never lets the budget forge an empty list (keep-at-least-one)', () => {
    const huge = ['x'.repeat(STATUS_CONTENT_BUDGET * 2)];
    const plan = planStatusPayload(
      input({
        conflictedChanges: huge,
        externalChanges: huge,
        sessionChanges: huge,
        otherChanges: huge,
        staged: huge,
        unstaged: huge,
        untracked: huge,
      }),
    );

    for (const name of FLAT_LIST_ORDER) {
      expect(plan.lists[name], `${name} must keep at least one path`).toHaveLength(1);
      expect(plan.omitted[name]).toBe(0);
    }
    // Nothing was cut, so `truncated` stays false: it says what the budget DID, never how close it
    // came, and an over-budget single path is a kept path.
    expect(plan.truncated).toBe(false);
  });

  it('leaves an unbudgeted call completely untouched', () => {
    const plan = planStatusPayload(
      input({
        staged: ['a.tex'],
        unstaged: ['b.tex'],
        untracked: ['c.tex'],
        sessionChanges: ['a.tex'],
        peers: [peer({ changes: ['d.tex'] })],
      }),
    );

    expect(plan.lists.staged).toEqual(['a.tex']);
    expect(plan.lists.untracked).toEqual(['c.tex']);
    expect(plan.peers[0]!.changes).toEqual(['d.tex']);
    expect(plan.peers[0]!.changesOmitted).toBe(0);
    expect(plan.truncated).toBe(false);
    expect(plan.note).toBeUndefined();
    expect(renderPathListLine('staged', ['a.tex'], 0)).toBe('staged: a.tex');
  });
});

describe('planStatusPayload: peers', () => {
  it("cuts a peer's changes and counts them, per peer and in the aggregate", () => {
    const plan = planStatusPayload(
      input({
        peers: [peer({ session: 'beta', changes: tree('beta', 1500) })],
      }),
    );

    const p = plan.peers[0]!;
    expect(p.changes).not.toBeNull();
    expect(p.changes!.length + p.changesOmitted).toBe(1500);
    expect(p.changesOmitted).toBeGreaterThan(0);
    expect(plan.omitted.activeSessionChanges).toBe(p.changesOmitted);
    expect(plan.truncated).toBe(true);
  });

  it('never empties a peer that recorded something — "nothing recorded" is a different claim', () => {
    // conflictedChanges is allocated first and is deliberately made to exhaust the whole budget, so
    // the peer lane starts with nothing left.
    const plan = planStatusPayload(
      input({
        conflictedChanges: tree('conflict', 3000),
        peers: [peer({ session: 'beta', changes: ['beta-owned.tex'] })],
      }),
    );

    expect(plan.peers[0]!.changes).toEqual(['beta-owned.tex']);
  });

  it('never reads an unreadable index as a cut', () => {
    const plan = planStatusPayload(
      input({
        conflictedChanges: tree('conflict', 3000),
        peers: [peer({ session: 'beta', changes: null })],
      }),
    );

    expect(plan.peers[0]!.changes).toBeNull();
    expect(plan.peers[0]!.changesOmitted).toBe(0);
  });

  it('lists at most STATUS_MAX_SESSIONS peers, live ones first, in the original order', () => {
    const peers: StatusPeerInput[] = Array.from({ length: 30 }, (_, i) =>
      peer({
        session: `s${String(i).padStart(2, '0')}`,
        live: i >= 25,
        lastSeen: new Date(1_700_000_000_000 + i * 1000).toISOString(),
      }),
    );
    const plan = planStatusPayload(input({ peers }));

    expect(plan.peers).toHaveLength(STATUS_MAX_SESSIONS);
    expect(plan.activeSessionsOmitted).toBe(10);
    // The five live ones are all kept, whatever their position in the input.
    for (const live of ['s25', 's26', 's27', 's28', 's29']) {
      expect(plan.peers.map((p) => p.session)).toContain(live);
    }
    // Presentation order is the input order, not the ranking.
    expect(plan.peers.map((p) => p.session)).toEqual([...plan.peers.map((p) => p.session)].sort());
    expect(plan.truncated).toBe(true);
    expect(plan.note).toContain('not the same as staleSessions');
  });

  it('charges a peer path in the text channel only while the text still renders it', () => {
    expect(peerPathCost('a.tex', true)).toBeGreaterThan(peerPathCost('a.tex', false));
    expect(peerPathCost('a.tex', false)).toBe(JSON.stringify('a.tex').length + 1);
  });
});

describe('the constants still account for what ships around the payload', () => {
  it('the worst note this module can produce fits STATUS_NOTE_RESERVE in both channels', () => {
    const worst: StatusPayloadPlan = {
      lists: {
        conflictedChanges: [],
        externalChanges: [],
        sessionChanges: [],
        otherChanges: [],
        staged: [],
        unstaged: [],
        untracked: [],
      },
      peers: [],
      omitted: Object.fromEntries(
        ALLOCATION_ORDER.map((n) => [n, 9_999_999]),
      ) as StatusPayloadPlan['omitted'],
      activeSessionsOmitted: 9_999_999,
      truncated: true,
    };
    const note = buildStatusNote(worst, { budget: STATUS_CONTENT_BUDGET, maxSessions: 20 });

    // It ships verbatim in the text and JSON-encoded in `structuredContent`, so it costs both.
    expect(note.length + JSON.stringify(note).length).toBeLessThanOrEqual(STATUS_NOTE_RESERVE);
  });

  it('STATUS_JSON_SCAFFOLD_OVERHEAD still covers the keys and labels around the paths', () => {
    // Every key `status` emits, with empty payloads, plus every text label — i.e. exactly what the
    // scaffold constant stands in for. `aheadCommits`/`behindCommits` are excluded on purpose:
    // they are outside this budget by decree.
    const scaffold = JSON.stringify({
      branch: 'master',
      ahead: 0,
      behind: 0,
      clean: true,
      staged: [],
      unstaged: [],
      untracked: [],
      syncState: 'in-sync',
      externalChanges: [],
      session: 'a-fairly-long-session-identifier',
      sessionChanges: [],
      otherChanges: [],
      conflictedChanges: [],
      activeSessions: [],
      staleSessions: 0,
      activeSessionsOmitted: 0,
      truncated: true,
      pathsOmitted: Object.fromEntries(ALLOCATION_ORDER.map((n) => [n, 9_999_999])),
    }).length;
    const labels = Object.values(LABELS).join('').length + FLAT_LIST_ORDER.length * 3;

    expect(scaffold + labels).toBeLessThanOrEqual(STATUS_JSON_SCAFFOLD_OVERHEAD);
  });

  it('pathCost charges a path in both channels, escaping included', () => {
    const p = 'sections/a"b\\c.tex';
    expect(pathCost(p)).toBe(JSON.stringify(p).length + 1 + p.length + 2);
    // A path needing escapes costs MORE than its raw length twice over, which a raw-length charge
    // would under-count.
    expect(pathCost(p)).toBeGreaterThan(p.length * 2);
  });

  it('peerIdentityCost covers the record a peer costs before any of its paths', () => {
    const cost = peerIdentityCost(peer({ changes: ['x.tex', 'y.tex'] }));
    const record = JSON.stringify({
      session: 'beta',
      live: true,
      lastSeen: '2026-09-22T10:00:00.000Z',
      changes: [],
      lastWriteAt: '2026-09-22T09:59:00.000Z',
      changesOmitted: 0,
    }).length;
    expect(cost).toBeGreaterThan(record);
  });
});

describe('planCommitText: the TEXT channel only', () => {
  it('bounds a block of many commits, and says how many more there are', () => {
    const commits = Array.from({ length: 60 }, (_, i) => commit(`${i}`.repeat(40), `commit ${i}`));
    const plan = planCommitText(commits);
    const text = renderCommitBlock(plan).join('\n');

    expect(text.length).toBeLessThanOrEqual(STATUS_COMMIT_TEXT_BUDGET);
    expect(plan.maxCommits).toBeLessThan(60);
    expect(text).toContain('more commit(s) (see structuredContent)');
    // The plan never touches the commits themselves — the structured channel keeps all 60.
    expect(plan.commits).toHaveLength(60);
  });

  it('clips a pathological commit message and leaves the original intact', () => {
    const long = 'A'.repeat(5000);
    const source = [commit('abcdef0123456789', long, 0)];
    const plan = planCommitText(source);

    expect(plan.messagesClipped).toBe(1);
    expect(plan.commits[0]!.message.length).toBeLessThanOrEqual(STATUS_COMMIT_MESSAGE_CAP + 1);
    expect(renderCommitBlock(plan).join('\n').length).toBeLessThanOrEqual(
      STATUS_COMMIT_TEXT_BUDGET,
    );
    // Never mutated: `structuredContent` must still carry the real message.
    expect(source[0]!.message).toBe(long);
  });

  it('keeps at least one commit even when that one alone is over budget', () => {
    const plan = planCommitText(
      [commit('a'.repeat(40), 'one', 5), commit('b'.repeat(40), 'two', 5)],
      {
        budget: 10,
      },
    );

    expect(plan.maxCommits).toBe(1);
    expect(renderCommitBlock(plan).join('\n')).toContain('1 more commit(s)');
  });

  it('leaves an ordinary block byte-identical to what status always rendered', () => {
    const commits = [commit('a'.repeat(40), 'fix the method section', 2)];
    const plan = planCommitText(commits);

    expect(plan.messagesClipped).toBe(0);
    expect(plan.maxCommits).toBe(1);
    // An unclipped commit is passed through by identity, never copied and never mutated.
    expect(plan.commits[0]).toBe(commits[0]);
    expect(renderCommitBlock(plan)).toEqual([
      '  aaaaaaaa fix the method section',
      '      +12/-3 sections/chapter-0/very-long-file-name-for-this-commit.tex',
      '      +12/-3 sections/chapter-1/very-long-file-name-for-this-commit.tex',
    ]);
  });

  it('renders nothing for an empty list', () => {
    const plan = planCommitText([]);
    expect(plan.maxCommits).toBe(0);
    expect(renderCommitBlock(plan)).toEqual([]);
  });
});

/**
 * The completeness inventory (#187) — the guard that makes a promise made in ANOTHER file fail
 * here, at the budget, rather than in prose nobody re-reads.
 *
 * #185 happened because `peerAttribution.ts` told a caller `status` answered uncapped and #175 then
 * capped it, with nothing between the two files. `conflictBudget.ts` made the same kind of promise
 * and survived only because that wave's spec named it. These assertions are the structural half:
 * every promise is registered, every registered promise is still made by the module that made it,
 * and no registered field is a budget lane.
 *
 * `evidence` is read out of the dependent's own source rather than restated here, so a pointer that
 * is deleted or reworded fails with "re-decide the exemption" instead of being inherited forever.
 */
describe('the status completeness inventory', () => {
  const repoRoot = new URL('../../', import.meta.url);
  const sourceOf = async (module: string): Promise<string> =>
    readFile(new URL(module, repoRoot), 'utf8');

  it('lists no field this budget cuts — the mistake #187 exists to catch', () => {
    for (const promise of STATUS_COMPLETENESS_PROMISES) {
      expect(
        ALLOCATION_ORDER as readonly string[],
        `\`${promise.field}\` is budgeted by ALLOCATION_ORDER and promised complete by ` +
          `${[...new Set(promise.dependents.map((d) => d.module))].join(', ')}. One of the two ` +
          'has to go: either ' +
          'drop the lane, or drop the promise AND the sentence in the dependent that makes it. ' +
          'This is #185 exactly — a budget landing on a field another file swears is whole.',
      ).not.toContain(promise.field);
    }
  });

  it('promises each field once, and never a field it also records as budgeted', () => {
    const promised = STATUS_COMPLETENESS_PROMISES.map((p) => p.field);
    expect(promised).toEqual([...COMPLETE_STATUS_FIELDS]);
    expect(new Set(promised).size, 'a field is promised twice; merge the dependents').toBe(
      promised.length,
    );
    expect(promised.length, 'an empty inventory guards nothing').toBeGreaterThan(0);

    const bounded = new Set<string>(STATUS_UNPROMISED_POINTERS.map((p) => p.field));
    for (const field of promised) {
      expect(
        bounded,
        `\`${field}\` is recorded both as promised complete and as deliberately budgeted. Those ` +
          'are opposite decisions about the same field.',
      ).not.toContain(field);
    }
  });

  it('records, for every promise, which code depends on it — a promise, not a preference', async () => {
    for (const promise of STATUS_COMPLETENESS_PROMISES) {
      expect(
        promise.dependents.length,
        `\`${promise.field}\` is exempt from the budget but names nobody who depends on that. An ` +
          'exemption with no dependent is a preference: drop the entry and let the field be ' +
          'budgeted like every other.',
      ).toBeGreaterThan(0);

      for (const dep of promise.dependents) {
        const source = await sourceOf(dep.module);
        expect(
          source,
          `${dep.module} is recorded as depending on \`status.${promise.field}\` being complete ` +
            `(via ${dep.cap}), but no longer contains "${dep.evidence}". Either the promise moved ` +
            '— point the entry at where it lives now — or it is gone, in which case that ' +
            'dependent, and possibly the whole exemption, should go with it. Do not just delete ' +
            'this assertion.',
        ).toContain(dep.evidence);
      }
    }
  });

  it('records the pointers that name a BUDGETED field, so the inventory is not read as "any pointer"', async () => {
    expect(
      STATUS_UNPROMISED_POINTERS.length,
      'the counter-examples are what stop this inventory reading as "every field a pointer names ' +
        'must be complete"; `otherChanges` is pointed at and budgeted on purpose (#185, #186)',
    ).toBeGreaterThan(0);

    for (const pointer of STATUS_UNPROMISED_POINTERS) {
      expect(
        ALLOCATION_ORDER as readonly string[],
        `\`${pointer.field}\` is recorded in ${pointer.module} as pointed at but bounded, and is ` +
          'no longer a budget lane. If it was exempted to make a sentence true, that is option 2 ' +
          'of #185, rejected in a comment in src/lib/peerAttribution.ts.',
      ).toContain(pointer.field);

      const source = await sourceOf(pointer.module);
      expect(
        source,
        `${pointer.module} no longer contains "${pointer.evidence}", so the wording that ` +
          `acknowledges \`${pointer.field}\` is budgeted has changed. Check it still tells the ` +
          'caller the list may be short before updating this entry.',
      ).toContain(pointer.evidence);
    }
  });
});
