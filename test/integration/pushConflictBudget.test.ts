import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { simpleGit } from 'simple-git';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFakeRemote, pushCommit, type FakeRemote } from './helpers/bareRepo.js';
import { createContext } from '../../src/context.js';
import { createServer } from '../../src/server.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { GitService } from '../../src/services/gitService.js';
import {
  CONFLICT_SIDE_CAP,
  CONFLICT_MAX_FILES,
  CONFLICT_MAX_COMMITS,
} from '../../src/lib/conflictBudget.js';
import { expectDeclaredField } from '../helpers/outputSchema.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * Drives the REAL registered `push` tool handler end-to-end (via a live MCP client, not
 * `planConflictPayload`/`renderConflictText`/`buildConflictFilePayload` called directly the way
 * `safePush.test.ts` does) — the seam finding 8 asked for. This is the only test that exercises
 * `safePushToolResult`, the `conflictDetail: 'auto'` default actually applying when the caller
 * passes nothing, and `conflictTruncated`.
 *
 * It also reaches the tool's declared `outputSchema`, but only halfway on its own, and the halves
 * are worth keeping apart (#130). The MCP SDK validates every non-error tool result against the
 * schema server-side before it reaches the client, so a **required field going missing** here
 * surfaces as a thrown error from `callTool` rather than as a passing test — that much a
 * `structuredContent` assertion does get for free. The other direction it does not get at all:
 * the SDK discards the parsed value and forwards the handler's own object, and a zod object
 * strips rather than rejects, so a key the schema never declared is transmitted verbatim and
 * nothing fails. `push` builds its conflict payload by assigning onto a plain object
 * (`structured.conflictTruncated = …`), which is exactly the shape that slips through, so the
 * budget's own reporting fields are asserted off a `listTools()` round trip below
 * (test/helpers/outputSchema.ts).
 */

const REL = 'main.tex';
const IDENTITY = { name: 'Test', email: 'test@example.com' };

function bigContent(lines: number): string {
  return (
    Array.from({ length: lines }, (_, i) => `line ${i} of the document body`).join('\n') + '\n'
  );
}

/**
 * Push `count` commits to `remote` from a SINGLE reused clone (unlike `pushCommit`, which clones
 * fresh per call — too slow for a loop of 25) so the remote gains a real, ordered commit history.
 * Every commit but the last touches its own new, unique file (so it never overlaps with anything
 * else); the last rewrites `finalRel` to `finalContent`, which is the one meant to collide with a
 * local edit on the same file/line.
 */
async function pushManyRemoteCommits(
  remote: FakeRemote,
  count: number,
  finalRel: string,
  finalContent: string,
): Promise<void> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ovl-pushmany-'));
  try {
    const git = simpleGit(tmp);
    await git.clone(remote.url, tmp);
    await git.addConfig('user.email', 'other@example.com');
    await git.addConfig('user.name', 'Other');
    await git.addConfig('core.autocrlf', 'false');
    for (let i = 0; i < count - 1; i++) {
      await writeFile(path.join(tmp, `note${i}.tex`), `note ${i}\n`);
      await git.add('.');
      await git.commit(`remote note ${i}`);
    }
    await writeFile(path.join(tmp, finalRel), finalContent);
    await git.add('.');
    await git.commit('remote edits line 10 (conflict)');
    await git.push('origin', remote.branch);
  } finally {
    await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

describe('push tool end-to-end: conflict payload budget (finding 8)', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  async function setup(): Promise<{ remote: FakeRemote; client: Client }> {
    const original = bigContent(600); // ~18k chars — comfortably over CONFLICT_SIDE_CAP
    const remote = await createFakeRemote({ [REL]: original });
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-pushbudget-'));
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
    const client = new Client({ name: 'test-alpha', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(() => client.close());

    // Local edit, committed — mirrors safePush.test.ts's big-conflict setup, but through the real
    // edit_file/commit tools instead of FileService directly.
    const editRes = await client.callTool({
      name: 'edit_file',
      arguments: {
        path: REL,
        edits: [{ oldString: 'line 10 of the document body', newString: 'line 10 LOCAL' }],
      },
    });
    if (editRes.isError) throw new Error(`edit_file failed: ${JSON.stringify(editRes.content)}`);
    const commitRes = await client.callTool({
      name: 'commit',
      arguments: { message: 'local edits line 10' },
    });
    if (commitRes.isError) throw new Error(`commit failed: ${JSON.stringify(commitRes.content)}`);

    // A collaborator edits the SAME line on the remote — a genuine (small) overlap on a file whose
    // whole content, on every side, is large.
    const remoteEdited = original.replace('line 10 of the document body', 'line 10 REMOTE');
    await pushCommit(remote, { [REL]: remoteEdited }, 'remote edits line 10');

    return { remote, client };
  }

  it('defaults to conflictDetail "auto", elides oversized sides, and reports conflictTruncated', async () => {
    const { client } = await setup();

    // No conflictDetail passed at all — proving the 'auto' default actually applies.
    const res = await client.callTool({
      name: 'push',
      arguments: { confirm: true },
    });

    expect(res.isError).toBeFalsy();
    const structured = res.structuredContent as Record<string, unknown>;
    expect(structured.status).toBe('conflict');
    expect(structured.conflictTruncated).toBe(true);
    // Top-level fields survive regardless of what got elided inside conflictFiles.
    expect(structured.conflictPaths).toEqual([REL]);
    expect(structured.remoteHead).toBeTruthy();
    expect(structured.mergeBase).toBeTruthy();

    const files = structured.conflictFiles as Array<{
      path: string;
      base: string | null;
      ours: string | null;
      theirs: string | null;
      elided?: Record<string, { chars: number; ref?: string }>;
    }>;
    const entry = files.find((f) => f.path === REL);
    expect(entry).toBeDefined();
    expect(entry!.base).toBeNull();
    expect(entry!.ours).toBeNull();
    expect(entry!.theirs).toBeNull();
    expect(entry!.elided?.base?.chars).toBeGreaterThan(CONFLICT_SIDE_CAP);
    expect(entry!.elided?.ours?.chars).toBeGreaterThan(CONFLICT_SIDE_CAP);
    expect(entry!.elided?.theirs?.chars).toBeGreaterThan(CONFLICT_SIDE_CAP);
    expect(entry!.elided?.base?.ref).toContain('read_file');

    // Both fields are what tells a caller the payload was cut — so both have to be in the
    // published contract, not merely in this response. Optional on purpose: absent is the
    // ordinary case (nothing was cut), and `conflictTruncated` is documented as absent unless
    // the result is a conflict at all.
    await expectDeclaredField(client, 'push', 'conflictTruncated', { required: false });
    await expectDeclaredField(client, 'push', 'conflictFiles[].elided', { required: false });

    // The text channel agrees — it's what a client without structuredContent support sees.
    const text = (res.content as Array<{ type: string; text?: string }>)
      .map((c) => c.text ?? '')
      .join('\n');
    expect(text).toContain(REL);
    expect(text).toContain('elided');
  });

  it('conflictDetail: "full" restores the complete sides, with no elided entry', async () => {
    const { client } = await setup();

    // The clone is back at its pre-push state after the first (default) attempt aborts — retrying
    // with a different conflictDetail just re-runs the same rebase and re-conflicts.
    const res = await client.callTool({
      name: 'push',
      arguments: { confirm: true, conflictDetail: 'full' },
    });

    expect(res.isError).toBeFalsy();
    const structured = res.structuredContent as Record<string, unknown>;
    expect(structured.status).toBe('conflict');
    expect(structured.conflictTruncated).toBe(false);

    const files = structured.conflictFiles as Array<{
      path: string;
      base: string | null;
      ours: string | null;
      theirs: string | null;
      elided?: unknown;
    }>;
    const entry = files.find((f) => f.path === REL)!;
    expect(entry.base?.length).toBeGreaterThan(CONFLICT_SIDE_CAP);
    expect(entry.ours?.length).toBeGreaterThan(CONFLICT_SIDE_CAP);
    expect(entry.theirs?.length).toBeGreaterThan(CONFLICT_SIDE_CAP);
    expect(entry.elided).toBeUndefined();

    const text = (res.content as Array<{ type: string; text?: string }>)
      .map((c) => c.text ?? '')
      .join('\n');
    expect(text).toContain(entry.base!);
  });

  it('caps conflictFiles at CONFLICT_MAX_FILES while conflictPaths stays complete', async () => {
    // Regression for finding 3, at the real tool seam: CONFLICT_MAX_FILES did not exist pre-fix,
    // so a conflict touching more files than the cap got a full per-file block for every one of
    // them — this asserts the cap actually applies when the caller goes through `push`, not just
    // through the planner directly.
    const TOTAL_FILES = 25;
    const initial = Object.fromEntries(
      Array.from({ length: TOTAL_FILES }, (_, i) => [`f${i}.tex`, 'a\nb\nc\n']),
    );
    const remote = await createFakeRemote(initial);
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-pushbudget-cap-'));
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
    const client = new Client({ name: 'test-cap', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(() => client.close());

    // Setup writes the working tree directly and commits with scope "all", rather than making
    // TOTAL_FILES round trips through `edit_file`. The seam under test is `push`'s conflict
    // payload; how the local commit came to exist is not part of the claim, and either route
    // produces the same commit. The round trips were: each one takes the project lock (in-process
    // mutex + lock file), records a shadow entry and renders a confirmation diff, which made this
    // the slowest test in the suite (~4.6s on Linux) and a repeat timeout on `windows-latest`,
    // where it tripped the 30s budget and blocked three unrelated PRs in one afternoon. If you
    // need this test to go through `edit_file`, restore the loop AND give the test its own
    // timeout — do not quietly shrink TOTAL_FILES below CONFLICT_MAX_FILES + 1, which would make
    // the cap assertion vacuous.
    await Promise.all(
      Array.from({ length: TOTAL_FILES }, (_, i) =>
        writeFile(path.join(dir, `f${i}.tex`), 'a\nb-local\nc\n'),
      ),
    );
    const commitRes = await client.callTool({
      name: 'commit',
      arguments: { message: 'local edits every file', scope: 'all' },
    });
    if (commitRes.isError) throw new Error(`commit failed: ${JSON.stringify(commitRes.content)}`);

    const remoteEdited = Object.fromEntries(
      Array.from({ length: TOTAL_FILES }, (_, i) => [`f${i}.tex`, 'a\nb-remote\nc\n']),
    );
    await pushCommit(remote, remoteEdited, 'remote edits every file');

    const res = await client.callTool({ name: 'push', arguments: { confirm: true } });
    expect(res.isError).toBeFalsy();
    const structured = res.structuredContent as {
      status: string;
      conflictTruncated: boolean;
      conflictPaths: string[];
      conflictFiles: Array<{ path: string }>;
    };
    expect(structured.status).toBe('conflict');
    expect(structured.conflictPaths).toHaveLength(TOTAL_FILES);
    expect(structured.conflictFiles.length).toBeLessThanOrEqual(CONFLICT_MAX_FILES);
    expect(structured.conflictFiles.length).toBeLessThan(TOTAL_FILES);
    expect(structured.conflictTruncated).toBe(true);

    const text = (res.content as Array<{ type: string; text?: string }>)
      .map((c) => c.text ?? '')
      .join('\n');
    // Every path is still named at the top level, even though only some got a detailed block.
    for (let i = 0; i < TOTAL_FILES; i++) expect(text).toContain(`f${i}.tex`);
  });

  it(
    'caps structuredContent.remoteCommits at CONFLICT_MAX_COMMITS with remoteCommitsOmitted, ' +
      'and the text points at status.behindCommits (follow-up to #68: remoteCommits was sent ' +
      'verbatim, uncapped, on a conflict result)',
    async () => {
      // 25 real remote commits — comfortably exercises the cap (20) with 5 left over. Measured at
      // ~7-8s total for this test on this machine; if it proves flaky-slow in CI, drop to 22 (still
      // > CONFLICT_MAX_COMMITS) and note it here.
      const TOTAL_REMOTE_COMMITS = 25;
      const initial = { [REL]: 'alpha\nline 10 of the document body\nomega\n' };
      const remote = await createFakeRemote(initial);
      const workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-pushbudget-commits-'));
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
      const client = new Client({ name: 'test-commits', version: '0.0.0' });
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      cleanups.push(() => client.close());

      const editRes = await client.callTool({
        name: 'edit_file',
        arguments: {
          path: REL,
          edits: [{ oldString: 'line 10 of the document body', newString: 'line 10 LOCAL' }],
        },
      });
      if (editRes.isError) throw new Error(`edit_file failed: ${JSON.stringify(editRes.content)}`);
      const commitRes = await client.callTool({
        name: 'commit',
        arguments: { message: 'local edit line 10' },
      });
      if (commitRes.isError) throw new Error(`commit failed: ${JSON.stringify(commitRes.content)}`);

      await pushManyRemoteCommits(
        remote,
        TOTAL_REMOTE_COMMITS,
        REL,
        'alpha\nline 10 REMOTE\nomega\n',
      );

      const res = await client.callTool({ name: 'push', arguments: { confirm: true } });
      expect(res.isError).toBeFalsy();
      const structured = res.structuredContent as {
        status: string;
        conflictPaths: string[];
        remoteCommits: Array<{ hash: string; message: string; files: unknown[] }>;
        remoteCommitsOmitted?: number;
      };
      expect(structured.status).toBe('conflict');
      expect(structured.remoteCommits).toHaveLength(CONFLICT_MAX_COMMITS);
      expect(structured.remoteCommitsOmitted).toBe(TOTAL_REMOTE_COMMITS - CONFLICT_MAX_COMMITS);
      expect(structured.conflictPaths).toEqual([REL]);

      // Declared, not just emitted: a count of what was cut is useless to a caller who is never
      // told to look for it, and an undeclared key reaches the client without `tools/list` ever
      // mentioning it.
      await expectDeclaredField(client, 'push', 'remoteCommitsOmitted', { required: false });
      await expectDeclaredField(client, 'push', 'remoteCommits[].filesOmitted', {
        required: false,
      });

      // Pre-fix (remoteCommits sent verbatim, uncapped), this exact scenario's structuredContent
      // measured 4100 characters; post-fix it must be smaller — proof the cap actually shrank the
      // payload here, not just that the field exists.
      const jsonSize = JSON.stringify(structured).length;
      expect(jsonSize).toBeLessThan(4100);

      const text = (res.content as Array<{ type: string; text?: string }>)
        .map((c) => c.text ?? '')
        .join('\n');
      expect(text).toContain(
        '(see status.behindCommits — the clone is back at its pre-push state, so status lists them all)',
      );
      expect(text).not.toContain('see structuredContent');

      // The clone is back at its pre-push state after the aborted rebase — retry with
      // conflictDetail: "full" re-runs the same rebase and re-conflicts, this time with the
      // commit cap lifted: structuredContent.remoteCommits must hold every one of the 25 commits,
      // with no remoteCommitsOmitted key and no per-commit filesOmitted, and the text's pointer
      // must switch to "(see structuredContent)" since that field is now actually complete.
      const fullRes = await client.callTool({
        name: 'push',
        arguments: { confirm: true, conflictDetail: 'full' },
      });
      expect(fullRes.isError).toBeFalsy();
      const fullStructured = fullRes.structuredContent as {
        status: string;
        remoteCommits: Array<{ hash: string; message: string; filesOmitted?: number }>;
        remoteCommitsOmitted?: number;
      };
      expect(fullStructured.status).toBe('conflict');
      expect(fullStructured.remoteCommits).toHaveLength(TOTAL_REMOTE_COMMITS);
      expect('remoteCommitsOmitted' in fullStructured).toBe(false);
      for (const c of fullStructured.remoteCommits) {
        expect('filesOmitted' in c).toBe(false);
      }

      const fullText = (fullRes.content as Array<{ type: string; text?: string }>)
        .map((c) => c.text ?? '')
        .join('\n');
      expect(fullText).toContain('(see structuredContent)');
      expect(fullText).not.toContain('status.behindCommits');
    },
    // 25 real commits + two rebase conflicts: ~7 s locally, but Windows CI runs git several
    // times slower and tripped 15 s (CI run 34941611023). 60 s is a bound, not a target.
    60_000,
  );
});
