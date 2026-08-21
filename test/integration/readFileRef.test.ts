import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import { createFakeRemote } from './helpers/bareRepo.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * `read_file` with a `ref` is how a caller fetches `base`/`theirs` for a `push` resolution, and
 * those are written back into the repository verbatim — so the bytes it returns, and whether it
 * calls them truncated, are part of the contract rather than cosmetics.
 */

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup(files: Record<string, string>) {
  const remote = await createFakeRemote(files);
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-refws-'));
  cleanups.push(remote.cleanup, () => rm(workspace, { recursive: true, force: true }));

  const config: ServerConfig = {
    workspaceRoot: workspace,
    sessionId: 'test',
    projects: [{ id: 'demo', gitUrl: remote.url }],
    defaultProject: 'demo',
  };
  const ctx = createContext(
    config,
    new CredentialResolver({}),
    { name: 'Test', email: 'test@example.com' },
    new ProjectRegistry(workspace),
  );
  const server = createServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(() => client.close());
  await client.callTool({ name: 'project_sync', arguments: { project: 'demo', mode: 'clone' } });
  return client;
}

interface ReadResult {
  content: string;
  totalLines: number;
  truncated: boolean;
}

describe('read_file at a ref', () => {
  it('returns the blob verbatim, and does not call a whole-file read truncated', async () => {
    const full = 'alpha\nbeta\ngamma\n';
    const client = await setup({ 'main.tex': full });

    const whole = (
      await client.callTool({
        name: 'read_file',
        arguments: { project: 'demo', path: 'main.tex', ref: 'HEAD' },
      })
    ).structuredContent as unknown as ReadResult;
    expect(whole.content).toBe(full); // trailing newline included: push writes this back as-is
    expect(whole.truncated).toBe(false);
    expect(whole.totalLines).toBe(3);

    // startLine: 1 with no end is still the whole file, and must agree with the read above —
    // the working-tree branch computes `truncated` from the bounds, so this one must too.
    const fromOne = (
      await client.callTool({
        name: 'read_file',
        arguments: { project: 'demo', path: 'main.tex', ref: 'HEAD', startLine: 1 },
      })
    ).structuredContent as unknown as ReadResult;
    expect(fromOne.content).toBe(full);
    expect(fromOne.truncated).toBe(false);

    const ranged = (
      await client.callTool({
        name: 'read_file',
        arguments: { project: 'demo', path: 'main.tex', ref: 'HEAD', startLine: 2, endLine: 2 },
      })
    ).structuredContent as unknown as ReadResult;
    expect(ranged.content).toBe('beta');
    expect(ranged.truncated).toBe(true);
  });

  it('does not rewrite CRLF line endings on the way out', async () => {
    const crlf = 'alpha\r\nbeta\r\n';
    const client = await setup({ 'main.tex': crlf });

    const res = (
      await client.callTool({
        name: 'read_file',
        arguments: { project: 'demo', path: 'main.tex', ref: 'HEAD' },
      })
    ).structuredContent as unknown as ReadResult;
    expect(res.content).toBe(crlf);
  });
});
