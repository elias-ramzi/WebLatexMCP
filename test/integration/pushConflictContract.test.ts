import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { simpleGit } from 'simple-git';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFakeRemote, type FakeRemote } from './helpers/bareRepo.js';
import { createContext } from '../../src/context.js';
import { createServer } from '../../src/server.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { GitService } from '../../src/services/gitService.js';
import {
  CONFLICT_MAX_COMMIT_FILES,
  CONFLICT_MAX_COMMITS,
  CONFLICT_MAX_FILES,
} from '../../src/lib/conflictBudget.js';
import {
  advertisedOutputSchema,
  expectNoUndeclaredKeys,
  undeclaredKeys,
} from '../helpers/outputSchema.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * The WHOLE `push` conflict payload against the `outputSchema` `push` advertises over
 * `tools/list` — not the named pointers `pushConflictBudget.test.ts` asks about.
 *
 * `push` assembles its conflict result by assigning onto a plain object and spreading planner
 * output into it (`conflictFiles[]`, each file's `elided`, `remoteCommits[]` with `filesOmitted`),
 * which is exactly the shape a key can grow on without anyone asking about it by name. An
 * undeclared key does not fail on the server — `McpServer` keeps only `parseResult.success` — it
 * fails in the client, which refuses the whole result with -32602 (#137, #146). So:
 *
 * - the client calls `listTools()` BEFORE pushing, so the SDK `Client` has compiled a validator
 *   for `push` and would itself reject a result carrying an undeclared key;
 * - the result is then audited key by key with `expectNoUndeclaredKeys`, judged on the wire form;
 * - one scenario drives every cut the conflict budget can make at once — per-side elision, the
 *   aggregate cut that elides hunks, the `CONFLICT_MAX_FILES` file cap, the
 *   `CONFLICT_MAX_COMMITS` commit cap and the per-commit `CONFLICT_MAX_COMMIT_FILES` cap — in
 *   `conflictDetail: 'auto'`, then the same conflict again in `'full'`, where none of them fire;
 * - and the audit is shown not to be vacuous: keys planted in a COPY of each real result, at the
 *   top level and inside both arrays, are reported by name and make the helper throw.
 */

const IDENTITY = { name: 'Test', email: 'test@example.com' };
/** Sorts ahead of every `f<n>.tex`, so the big file is among the ones the file cap keeps. */
const BIG = 'big.tex';
/** Small conflicted files beside BIG: one more than the cap once BIG is counted. */
const SMALL_FILES = CONFLICT_MAX_FILES;
/** Remote commits ahead of the local one: past the commit cap. */
const REMOTE_COMMITS = CONFLICT_MAX_COMMITS + 2;
/** Files the first remote commit touches: past the per-commit file cap. */
const WIDE_COMMIT_FILES = CONFLICT_MAX_COMMIT_FILES + 3;

const PAD = 'x'.repeat(160);

/** 600 long lines; `tag` rewrites every 10th, so both sides conflict in ~60 separate hunks. */
function bigContent(tag?: string): string {
  return (
    Array.from({ length: 600 }, (_, i) =>
      tag !== undefined && i % 10 === 0 ? `line ${i} ${tag} ${PAD}` : `line ${i} ${PAD}`,
    ).join('\n') + '\n'
  );
}

const small = (i: number) => `f${String(i).padStart(2, '0')}.tex`;

/**
 * Push REMOTE_COMMITS commits from one reused clone: the first adds WIDE_COMMIT_FILES new notes
 * (past the per-commit file cap), the middle ones a note each, and the last rewrites BIG and every
 * small file — the one that collides with the local commit.
 */
async function pushRemoteHistory(remote: FakeRemote): Promise<void> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'wlm-pushcontract-remote-'));
  try {
    const git = simpleGit(tmp);
    await git.clone(remote.url, tmp);
    await git.addConfig('user.email', 'other@example.com');
    await git.addConfig('user.name', 'Other');
    await git.addConfig('core.autocrlf', 'false');
    for (let i = 0; i < WIDE_COMMIT_FILES; i++) {
      await writeFile(path.join(tmp, `wide${i}.tex`), `wide ${i}\n`);
    }
    await git.add('.');
    await git.commit('remote: a wide commit');
    for (let i = 1; i < REMOTE_COMMITS - 1; i++) {
      await writeFile(path.join(tmp, `note${i}.tex`), `note ${i}\n`);
      await git.add('.');
      await git.commit(`remote note ${i}`);
    }
    await writeFile(path.join(tmp, BIG), bigContent('REMOTE'));
    for (let i = 0; i < SMALL_FILES; i++) {
      await writeFile(path.join(tmp, small(i)), 'a\nb-remote\nc\n');
    }
    await git.add('.');
    await git.commit('remote edits every file (conflict)');
    await git.push('origin', remote.branch);
  } finally {
    await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

describe('push conflict result: the whole payload is declared in the advertised outputSchema', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  async function setup(): Promise<Client> {
    const initial: Record<string, string> = { [BIG]: bigContent() };
    for (let i = 0; i < SMALL_FILES; i++) initial[small(i)] = 'a\nb\nc\n';
    const remote = await createFakeRemote(initial);
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-pushcontract-'));
    cleanups.push(remote.cleanup, () => rm(workspace, { recursive: true, force: true }));
    const dir = path.join(workspace, 'demo');
    await new GitService(IDENTITY).clone(remote.url, dir, { username: 'git' });

    const config: ServerConfig = {
      workspaceRoot: workspace,
      sessionId: 'alpha',
      projects: [{ id: 'demo', gitUrl: remote.url }],
      defaultProject: 'demo',
    };
    const ctx = createContext(config, new CredentialResolver({}), IDENTITY);
    const server = createServer(ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-contract', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(() => client.close());

    // Before anything else: this is what makes the SDK Client compile a validator for `push`, so
    // an undeclared key in the push result would fail `callTool` itself with -32602.
    await client.listTools();

    // The local side, written straight into the tree and committed with scope "all" — how the
    // local commit came to exist is not the claim here, and one commit beats 21 edit_file trips.
    await writeFile(path.join(dir, BIG), bigContent('LOCAL'));
    await Promise.all(
      Array.from({ length: SMALL_FILES }, (_, i) =>
        writeFile(path.join(dir, small(i)), 'a\nb-local\nc\n'),
      ),
    );
    const commitRes = await client.callTool({
      name: 'commit',
      arguments: { message: 'local edits every file', scope: 'all' },
    });
    if (commitRes.isError) throw new Error(`commit failed: ${JSON.stringify(commitRes.content)}`);

    await pushRemoteHistory(remote);
    return client;
  }

  /**
   * Plant undeclared keys in a deep copy of a real result, at the top level and inside both
   * arrays, and require the audit to name exactly those — and the helper to throw on them. Were
   * the walker to stop at the top level, or a union branch to swallow every key, this fails.
   */
  async function expectAuditCatchesPlantedKeys(
    client: Client,
    structured: Record<string, unknown>,
  ): Promise<void> {
    const tampered = JSON.parse(JSON.stringify(structured)) as {
      conflictFiles: Array<Record<string, unknown>>;
      remoteCommits: Array<Record<string, unknown>>;
      [k: string]: unknown;
    };
    tampered.plantedTopLevel = 1;
    tampered.conflictFiles[0]!.plantedInFile = 1;
    tampered.remoteCommits[0]!.plantedInCommit = 1;
    const schema = await advertisedOutputSchema(client, 'push');
    expect(undeclaredKeys(schema, tampered)).toEqual([
      'conflictFiles[].plantedInFile',
      'plantedTopLevel',
      'remoteCommits[].plantedInCommit',
    ]);
    await expect(expectNoUndeclaredKeys(client, 'push', tampered)).rejects.toThrow(
      /does not declare/,
    );
  }

  it(
    'declares every key of an "auto" conflict with every cut firing, then of the same ' +
      'conflict in "full"',
    async () => {
      const client = await setup();

      const res = await client.callTool({ name: 'push', arguments: { confirm: true } });
      expect(res.isError).toBeFalsy();
      const structured = res.structuredContent as Record<string, unknown> & {
        status: string;
        conflictTruncated: boolean;
        conflictPaths: string[];
        conflictFiles: Array<{ path: string; elided?: Record<string, unknown> }>;
        remoteCommits: Array<{ filesOmitted?: number }>;
        remoteCommitsOmitted?: number;
      };
      expect(structured.status).toBe('conflict');
      // Every cut this audit claims to cover has to have actually fired, or its keys were never
      // on the wire to be audited.
      expect(structured.conflictTruncated).toBe(true);
      expect(structured.conflictPaths).toHaveLength(SMALL_FILES + 1);
      expect(structured.conflictFiles.length).toBeLessThanOrEqual(CONFLICT_MAX_FILES);
      const big = structured.conflictFiles.find((f) => f.path === BIG);
      expect(big?.elided).toBeDefined();
      expect(Object.keys(big!.elided!)).toEqual(
        expect.arrayContaining(['base', 'ours', 'theirs', 'hunks']),
      );
      expect(structured.remoteCommits).toHaveLength(CONFLICT_MAX_COMMITS);
      expect(structured.remoteCommitsOmitted).toBe(REMOTE_COMMITS - CONFLICT_MAX_COMMITS);
      expect(structured.remoteCommits.some((c) => (c.filesOmitted ?? 0) > 0)).toBe(true);

      await expectNoUndeclaredKeys(client, 'push', structured);
      await expectAuditCatchesPlantedKeys(client, structured);

      // The clone is back at its pre-push state; the same rebase re-conflicts, uncut.
      const fullRes = await client.callTool({
        name: 'push',
        arguments: { confirm: true, conflictDetail: 'full' },
      });
      expect(fullRes.isError).toBeFalsy();
      const full = fullRes.structuredContent as Record<string, unknown> & {
        status: string;
        conflictTruncated: boolean;
        conflictFiles: Array<{ elided?: unknown }>;
        remoteCommits: unknown[];
      };
      expect(full.status).toBe('conflict');
      expect(full.conflictTruncated).toBe(false);
      expect(full.conflictFiles).toHaveLength(SMALL_FILES + 1);
      expect(full.conflictFiles.every((f) => f.elided === undefined)).toBe(true);
      expect(full.remoteCommits).toHaveLength(REMOTE_COMMITS);

      await expectNoUndeclaredKeys(client, 'push', full);
      await expectAuditCatchesPlantedKeys(client, full);
    },
    // ~25 real commits and two rebase conflicts; Windows CI runs git several times slower (see
    // pushConflictBudget.test.ts). A bound, not a target.
    60_000,
  );
});
