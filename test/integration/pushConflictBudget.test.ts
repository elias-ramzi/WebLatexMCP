import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFakeRemote, pushCommit, type FakeRemote } from './helpers/bareRepo.js';
import { createContext } from '../../src/context.js';
import { createServer } from '../../src/server.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { GitService } from '../../src/services/gitService.js';
import { CONFLICT_SIDE_CAP, CONFLICT_MAX_FILES } from '../../src/lib/conflictBudget.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * Drives the REAL registered `push` tool handler end-to-end (via a live MCP client, not
 * `planConflictPayload`/`renderConflictText`/`buildConflictFilePayload` called directly the way
 * `safePush.test.ts` does) — the seam finding 8 asked for. This is the only test that exercises
 * `safePushToolResult`, the `conflictDetail: 'auto'` default actually applying when the caller
 * passes nothing, `conflictTruncated`, and — implicitly — that `structuredContent` validates
 * against the tool's declared `outputSchema` (the MCP SDK validates every non-error tool result
 * against it server-side before it reaches the client; a schema-shape bug here would surface as a
 * thrown error from `callTool`, not as a passing test).
 */

const REL = 'main.tex';
const IDENTITY = { name: 'Test', email: 'test@example.com' };

function bigContent(lines: number): string {
  return (
    Array.from({ length: lines }, (_, i) => `line ${i} of the document body`).join('\n') + '\n'
  );
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

    for (let i = 0; i < TOTAL_FILES; i++) {
      const editRes = await client.callTool({
        name: 'edit_file',
        arguments: {
          path: `f${i}.tex`,
          edits: [{ oldString: 'b', newString: 'b-local' }],
        },
      });
      if (editRes.isError) throw new Error(`edit_file failed: ${JSON.stringify(editRes.content)}`);
    }
    const commitRes = await client.callTool({
      name: 'commit',
      arguments: { message: 'local edits every file' },
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
});
