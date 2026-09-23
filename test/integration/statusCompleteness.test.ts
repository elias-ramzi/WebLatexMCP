import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { simpleGit } from 'simple-git';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFakeRemote, type FakeRemote } from './helpers/bareRepo.js';
import { createContext } from '../../src/context.js';
import { createServer } from '../../src/server.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { GitService } from '../../src/services/gitService.js';
import type { ServerConfig } from '../../src/types.js';
import {
  COMPLETE_STATUS_FIELDS,
  STATUS_COMPLETENESS_PROMISES,
} from '../../src/lib/statusBudget.js';
import { CONFLICT_MAX_COMMITS } from '../../src/lib/conflictBudget.js';

/**
 * Every field `src/lib/statusBudget.ts` records as promised COMPLETE really does come back whole
 * from a real `status` call — in the one situation that matters, a call whose OTHER lists the
 * budget had to cut (#187).
 *
 * The unit guards say a promised field is not a lane of `ALLOCATION_ORDER`. That is the mistake
 * #185 was, but it is not the only way to make it: `status.ts` assembles the result itself, and a
 * cap applied there, or a plan field wired to the wrong list, would leave `ALLOCATION_ORDER`
 * untouched and still hand the caller a short list. Only a real call over a real clone sees that.
 *
 * The fixture is driven BY the inventory, not beside it: `EXPECTED` is asserted to cover exactly
 * the promised fields, so adding an entry to `STATUS_COMPLETENESS_PROMISES` fails here until the
 * fixture actually produces that field — an inventory entry cannot be added and left unproven.
 *
 * Harness copied from `test/integration/statusStaged.test.ts` (real MCP client, a local bare repo,
 * no network).
 */

const REL = 'sections/method.tex';
const BASE = ['\\section{Method}', 'The first paragraph opens the method.', ''].join('\n');
const IDENTITY = { name: 'Test', email: 'test@example.com' };

/** One past the conflict payload's own cap, which is what makes "uncapped" a testable claim. */
const COMMITS = CONFLICT_MAX_COMMITS + 1;

/** Enough untracked paths to overrun the 20000-character budget across both channels. */
const UNTRACKED = 300;

interface Session {
  client: Client;
  close: () => Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup(): Promise<{
  remote: FakeRemote;
  dir: string;
  session: (id: string) => Promise<Session>;
}> {
  const remote = await createFakeRemote({ [REL]: BASE });
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-statuscomplete-'));
  cleanups.push(remote.cleanup, () => rm(workspace, { recursive: true, force: true }));

  const baseConfig = {
    workspaceRoot: workspace,
    projects: [{ id: 'demo', gitUrl: remote.url }],
    defaultProject: 'demo',
  };
  const dir = path.join(workspace, 'demo');
  await new GitService(IDENTITY).clone(remote.url, dir, { username: 'git' });

  const session = async (id: string): Promise<Session> => {
    const config: ServerConfig = { ...baseConfig, sessionId: id };
    const ctx = createContext(config, new CredentialResolver({}), IDENTITY);
    const server = createServer(ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: `test-${id}`, version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const close = (): Promise<void> => client.close();
    cleanups.push(close);
    return { client, close };
  };

  return { remote, dir, session };
}

async function callFull(
  session: Session,
  name: string,
  args: Record<string, unknown>,
): Promise<{ structured: Record<string, unknown>; text: string }> {
  const res = await session.client.callTool({ name, arguments: args });
  if (res.isError) throw new Error(`${name} failed: ${JSON.stringify(res.content)}`);
  const content = res.content as Array<{ type: string; text?: string }>;
  return {
    structured: res.structuredContent as Record<string, unknown>,
    text: content.map((c) => c.text ?? '').join('\n'),
  };
}

describe('status keeps every promised field complete while its budget cuts the rest', () => {
  it('returns aheadCommits and behindCommits whole from a call that truncated its path lists', async () => {
    const { remote, dir, session } = await setup();
    const alpha = await session('alpha');

    // Upstream moves: COMMITS commits the clone has not seen. `behindCommits` must list them all.
    const upstream = await mkdtemp(path.join(os.tmpdir(), 'wlm-upstream-'));
    cleanups.push(() => rm(upstream, { recursive: true, force: true }));
    const theirs = simpleGit(upstream);
    await theirs.clone(remote.url, upstream);
    await theirs.addConfig('user.email', 'other@example.com');
    await theirs.addConfig('user.name', 'Other');
    for (let i = 0; i < COMMITS; i += 1) {
      await writeFile(path.join(upstream, `upstream-${i}.tex`), `% upstream ${i}\n`, 'utf8');
      await theirs.add('.');
      await theirs.commit(`Update on Overleaf ${i}`);
    }
    await theirs.push('origin', remote.branch);

    // Local moves: COMMITS commits not yet pushed. `aheadCommits` must list them all.
    const ours = simpleGit(dir);
    await ours.addConfig('user.email', IDENTITY.email);
    await ours.addConfig('user.name', IDENTITY.name);
    for (let i = 0; i < COMMITS; i += 1) {
      await writeFile(path.join(dir, `local-${i}.tex`), `% local ${i}\n`, 'utf8');
      await ours.add('.');
      await ours.commit(`local work ${i}`);
    }
    // Refresh the remote-tracking ref without moving HEAD, so the clone is genuinely behind too.
    await ours.fetch();

    // ...and a working tree big enough that the path budget has to cut something.
    await mkdir(path.join(dir, 'figures'), { recursive: true });
    for (let i = 0; i < UNTRACKED; i += 1) {
      await writeFile(
        path.join(dir, 'figures', `ablation-${String(i).padStart(4, '0')}-precision-recall.pdf`),
        'x',
        'utf8',
      );
    }

    const { structured } = await callFull(alpha, 'status', {});

    // The premise: this really is a cut result. Without it every assertion below passes vacuously.
    expect(structured.truncated, 'the fixture no longer overruns the budget').toBe(true);
    const pathsOmitted = structured.pathsOmitted as Record<string, number>;
    expect(pathsOmitted.untracked).toBeGreaterThan(0);
    expect(pathsOmitted.otherChanges).toBeGreaterThan(0);

    // How many entries each promised field must carry, keyed by field so the coverage check below
    // can prove the fixture exercises the whole inventory rather than the two names it knows.
    const EXPECTED: Record<string, number> = {
      aheadCommits: COMMITS,
      behindCommits: COMMITS,
    };
    expect(
      Object.keys(EXPECTED).sort(),
      'a field was added to STATUS_COMPLETENESS_PROMISES without this fixture producing it, so ' +
        'its completeness is recorded but never proven. Extend the fixture, not this assertion.',
    ).toEqual([...COMPLETE_STATUS_FIELDS].sort());

    for (const { field, dependents } of STATUS_COMPLETENESS_PROMISES) {
      const list = structured[field] as unknown[];
      expect(Array.isArray(list), `status did not return \`${field}\` as a list`).toBe(true);
      expect(
        list.length,
        `\`${field}\` came back with ${list.length} of ${EXPECTED[field]} entries from a call ` +
          `whose path lists were cut. ${[...new Set(dependents.map((d) => d.module))].join(
            ' and ',
          )} tell a caller this field holds the whole of what THEY cut, so a short ` +
          'one leaves them with no complete list anywhere (#185, #187).',
      ).toBe(EXPECTED[field]);
    }

    // The counts git reported, which the budget must never touch either.
    expect(structured.ahead).toBe(COMMITS);
    expect(structured.behind).toBe(COMMITS);
  });
});
