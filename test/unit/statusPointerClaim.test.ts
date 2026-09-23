/**
 * Ties the `push`/`project_sync` peer refusal's pointer into `status` to what `status`'s payload
 * budget actually does — issue #185.
 *
 * The regression this exists to stop happened because the two live in different files with nothing
 * between them. `src/lib/peerAttribution.ts` told a stuck caller that `status` names every omitted
 * path *uncapped*; #175 (PR #183) then budgeted `otherChanges` and capped `activeSessions`, and
 * nothing failed. A test asserting only the new wording would have been green before #175 too, so
 * it would not have caught that change and will not catch the next one.
 *
 * So the assertions here are joins, in three directions:
 *
 *  1. **Wording → shipped contract.** Every field the line names resolves in the `outputSchema`
 *     `status` advertises over a real `listTools()` round trip (`test/helpers/outputSchema.ts`),
 *     so telling the caller to check a counter that does not exist fails here.
 *  2. **Wording → planner.** The lane names under `pathsOmitted` and the lane names
 *     `planStatusPayload` reports in `omitted` are asserted equal as sets, because `status.ts`
 *     ships the latter AS the former (`pathsOmitted: plan.omitted`, a spread). Renaming a lane on
 *     either side fails here.
 *  3. **Wording → behaviour.** A payload large enough to trip the budget must actually cut
 *     `otherChanges`, actually cut a peer's `changes`, and actually drop peers — which is what
 *     makes "those lists are budgeted too" a true warning rather than a defensive one. Exempting
 *     `otherChanges` from the budget (option 2 of #185, rejected in a comment in
 *     `peerAttribution.ts`) fails here, at the line that would be made to lie by it.
 *
 * A fourth join was added by #187: every field `src/lib/statusBudget.ts` records as promised
 * COMPLETE (`STATUS_COMPLETENESS_PROMISES`) is asserted to be advertised, and advertised as
 * uncapped, and each promise made inside a tool's own advertised schema is asserted to still be
 * there. That is the inverse direction of the three above — those check a pointer at a BUDGETED
 * field is honest about the budget, this checks a pointer at an EXEMPT field still has its
 * exemption.
 *
 * What it does NOT catch, stated rather than implied: nothing here proves the refusal points at
 * `status` at all rather than somewhere else, and nothing here (the inventory included) detects a
 * *new* third pointer whose author never registered it — a third file can still cut its own list
 * and promise `status` holds the rest, and no test will notice. What #187 bought is that
 * registering is one line, and that a registered promise then fails at the budget.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import type { AppContext } from '../../src/context.js';
import { advertisedOutputSchema, declaredField } from '../helpers/outputSchema.js';
import type { JsonSchemaNode } from '../helpers/outputSchema.js';
import { renderPeerRefusal, REFUSAL_PATH_CAP } from '../../src/lib/peerAttribution.js';
import type { Attribution } from '../../src/lib/peerAttribution.js';
import {
  planStatusPayload,
  ALLOCATION_ORDER,
  STATUS_COMPLETENESS_PROMISES,
  STATUS_MAX_SESSIONS,
} from '../../src/lib/statusBudget.js';
import type { StatusPayloadInput, StatusPeerInput } from '../../src/lib/statusBudget.js';

const NOW = Date.parse('2024-05-01T12:00:00.000Z');

/** The pointer line as a caller reads it: 21 disputed paths, so the header trips the cap. */
function pointerLine(): string {
  const paths = Array.from({ length: REFUSAL_PATH_CAP + 1 }, (_, i) => `u${i}.tex`);
  const a: Attribution = { sessions: [], unowned: paths };
  const line = renderPeerRefusal(paths, a, NOW)
    .split('\n')
    .find((l) => l.startsWith('Lists here are capped'));
  expect(
    line,
    'the refusal rendered no pointer line at all for a payload over the cap',
  ).toBeDefined();
  return line!;
}

/**
 * Each field the pointer names, as the caller reads it in the message and as it resolves in the
 * advertised schema. `required` is asserted too where the sentence depends on it: the line tells
 * the caller to read `truncated` first *because* `pathsOmitted` is present only when something was
 * cut, so a counter's absence is not a zero.
 */
const POINTED_AT: Array<{ inMessage: string; pointer: string; required: boolean }> = [
  { inMessage: '`otherChanges`', pointer: 'otherChanges', required: true },
  { inMessage: '`activeSessions[].changes`', pointer: 'activeSessions[].changes', required: true },
  { inMessage: '`truncated`', pointer: 'truncated', required: true },
  {
    inMessage: '`pathsOmitted.otherChanges`',
    pointer: 'pathsOmitted.otherChanges',
    required: true,
  },
  { inMessage: '`activeSessionsOmitted`', pointer: 'activeSessionsOmitted', required: true },
  {
    inMessage: '`changesOmitted`',
    pointer: 'activeSessions[].changesOmitted',
    required: true,
  },
  { inMessage: '`note`', pointer: 'note', required: false },
];

/** A dirty tree big enough to trip every bound the pointer line names at once. */
function overflowingInput(): StatusPayloadInput {
  const many = (prefix: string, n: number): string[] =>
    Array.from({ length: n }, (_, i) => `${prefix}/section-${i}/chapter-${i}.tex`);
  const peers: StatusPeerInput[] = Array.from(
    { length: STATUS_MAX_SESSIONS + 5 },
    (_, i): StatusPeerInput => ({
      session: `peer-${i}`,
      live: true,
      lastSeen: new Date(NOW - i * 1000).toISOString(),
      changes: many(`peer${i}`, 50),
      lastWriteAt: new Date(NOW - i * 2000).toISOString(),
    }),
  );
  return {
    conflictedChanges: many('conflicted', 5),
    externalChanges: many('external', 20),
    sessionChanges: many('mine', 200),
    otherChanges: many('theirs', 500),
    staged: many('staged', 100),
    unstaged: many('unstaged', 200),
    untracked: many('untracked', 800),
    peers,
  };
}

describe("the peer refusal's pointer into `status` (issue #185)", () => {
  let schema: JsonSchemaNode;

  beforeAll(async () => {
    // `listTools()` needs no context: it reads the schemas `createServer` registers, which is the
    // document a client actually receives (the reason `test/helpers/outputSchema.ts` exists).
    const server = createServer({} as unknown as AppContext);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'status-pointer-test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    schema = await advertisedOutputSchema(client, 'status');
    await client.close();
  });

  it('names every counter a caller needs to tell a complete `status` answer from a cut one', () => {
    const line = pointerLine();
    for (const { inMessage } of POINTED_AT) expect(line).toContain(inMessage);
  });

  it('names only fields `status` actually advertises, with the presence its advice assumes', () => {
    for (const { inMessage, pointer, required } of POINTED_AT) {
      const field = declaredField(schema, pointer);
      expect(
        field,
        `the peer refusal tells a stuck caller to read ${inMessage}, but \`status\` does not ` +
          `declare \`${pointer}\` in the outputSchema it advertises. That is issue #185 one level ` +
          `down: advice pointing at a field that does not ship.`,
      ).toBeDefined();
      expect(
        field!.required,
        `\`status\`.\`${pointer}\` changed presence. The pointer line leads with \`truncated\` ` +
          `precisely because \`pathsOmitted\` is optional — an absent counter is not a zero — so ` +
          `the wording has to change with it.`,
      ).toBe(required);
    }
  });

  it('`pathsOmitted` keys the same lanes the planner counts, so the named counter is the real one', () => {
    const declared = declaredField(schema, 'pathsOmitted');
    expect(declared).toBeDefined();
    const advertised = Object.keys(declared!.node.properties ?? {}).sort();
    // `status.ts` ships `pathsOmitted: plan.omitted` — the planner's own record, spread — so these
    // two lists are the same names or the tool is broken.
    const planned = Object.keys(planStatusPayload(overflowingInput()).omitted).sort();
    expect(advertised).toEqual(planned);
    expect(advertised).toContain('otherChanges');
  });

  it('the lists it points at are really cut when the tree is large — the warning is warranted', () => {
    const plan = planStatusPayload(overflowingInput());

    expect(plan.truncated).toBe(true);
    // The load-bearing one. Option 2 of #185 — exempt `otherChanges` from the budget so the old
    // "uncapped" sentence becomes true again — fails right here, which is the point: the list that
    // blows up in practice is the one whose bound must not be traded away for a sentence.
    expect(
      plan.omitted.otherChanges,
      'otherChanges was not cut by an overflowing payload. If its bound was removed, the peer ' +
        'refusal in src/lib/peerAttribution.ts is now over-warning — and, more importantly, the ' +
        'undelivered-payload failure #175 fixed is back for the list most likely to cause it.',
    ).toBeGreaterThan(0);
    expect(plan.activeSessionsOmitted).toBe(5);
    expect(plan.peers.some((p) => p.changesOmitted > 0)).toBe(true);

    // The pointer's last resort — "`status`'s own `note` then names the routes that enumerate the
    // same ground" — is a claim about this note, so it is asserted here rather than trusted.
    expect(plan.note).toBeDefined();
    expect(plan.note).toContain('list_files');
    expect(plan.note).toContain('diff');
  });

  it('both lists it points at are still under a bound at all', () => {
    // The declarative form of the test above, against the constants themselves: these are the two
    // lines someone taking option 2 would delete, and deleting either falsifies the pointer.
    expect(ALLOCATION_ORDER).toContain('otherChanges');
    expect(ALLOCATION_ORDER).toContain('activeSessionChanges');
    expect(Number.isFinite(STATUS_MAX_SESSIONS)).toBe(true);
  });
});

/**
 * The other direction (#187): a field `status` is recorded as keeping COMPLETE has to be advertised
 * as such, and the promise a tool makes inside its own advertised schema has to still be there.
 *
 * These read the wire form for the same reason the joins above do — `tools/list` is the only
 * document a client or a model actually sees, so a promise that lives only in a source comment is
 * not a promise anyone can act on.
 */
describe('the status completeness inventory, against what the server advertises', () => {
  let statusSchema: JsonSchemaNode;
  let pushSchemaJson: string;

  beforeAll(async () => {
    const server = createServer({} as unknown as AppContext);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'status-completeness-test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    statusSchema = await advertisedOutputSchema(client, 'status');
    pushSchemaJson = JSON.stringify(await advertisedOutputSchema(client, 'push'));
    await client.close();
  });

  it('advertises every promised field, always present and described as uncapped', () => {
    for (const { field, dependents } of STATUS_COMPLETENESS_PROMISES) {
      const declared = declaredField(statusSchema, field);
      expect(
        declared,
        `\`${field}\` is recorded as complete for ${dependents
          .map((d) => d.module)
          .join(', ')}, but \`status\` does not advertise it at all.`,
      ).toBeDefined();
      expect(
        declared!.required,
        `\`${field}\` is promised complete, so it must always ship: an absent list and an empty ` +
          'one are the same value to a caller reading it as the full answer.',
      ).toBe(true);
      expect(
        declared!.node.description ?? '',
        `\`${field}\` is exempt from the payload budget because other code points at it for a ` +
          'complete list, and its own description has to say so — that description is what a ' +
          'model reads to decide whether the field can be trusted as whole.',
      ).toMatch(/never capped/i);
    }
  });

  it('keeps each promise a TOOL makes in its own advertised schema', () => {
    const inTools = STATUS_COMPLETENESS_PROMISES.flatMap((p) =>
      p.dependents.filter((d) => d.module === 'src/tools/push.ts').map((d) => ({ ...d, ...p })),
    );
    // Not vacuous: `push` is the one tool that makes this promise in its schema today, and this
    // assertion is worthless if that list is ever silently empty.
    expect(inTools.length).toBeGreaterThan(0);

    for (const dep of inTools) {
      expect(
        pushSchemaJson,
        `\`push\` is recorded as sending a caller to \`status.${dep.field}\` for the commits its ` +
          `own ${dep.cap} dropped, but its advertised outputSchema no longer contains ` +
          `"${dep.evidence}". Either the pointer moved — repoint the inventory entry — or it is ` +
          'gone and the exemption may be up for re-decision.',
      ).toContain(dep.evidence);
    }
  });
});
