import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  return { client, dir: path.join(workspace, 'demo') };
}

interface ReadResult {
  content: string;
  totalLines: number;
  truncated: boolean;
}

describe('read_file at a ref', () => {
  it('returns the blob verbatim, and does not call a whole-file read truncated', async () => {
    const full = 'alpha\nbeta\ngamma\n';
    const { client } = await setup({ 'main.tex': full });

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
    const { client } = await setup({ 'main.tex': crlf });

    const res = (
      await client.callTool({
        name: 'read_file',
        arguments: { project: 'demo', path: 'main.tex', ref: 'HEAD' },
      })
    ).structuredContent as unknown as ReadResult;
    expect(res.content).toBe(crlf);
  });
});

/**
 * Issue #181: `read_file` passed `recordBaseline: true` whatever the caller asked for, and
 * `FileService.read` recorded the WHOLE file before slicing — so five lines of a long document
 * claimed the baseline for all of it, and the next `write_file` replaced a hand edit outside the
 * range with no refusal. Recording RESETS the guard rather than arming it, which is why the whole
 * read has to come first here: without it there is no baseline to disarm and nothing to see.
 */
describe('the out-of-band-edit baseline a read may claim', () => {
  it('does not let a ranged read vouch for the lines it did not return', async () => {
    const original = 'alpha\nbeta\ngamma\n';
    const { client, dir } = await setup({ 'main.tex': original });

    // The agent reads the file whole, which arms the guard.
    await client.callTool({
      name: 'read_file',
      arguments: { project: 'demo', path: 'main.tex' },
    });
    // The user then hand-edits a part of it the agent is about to not look at.
    const handEdited = 'alpha\nbeta\nedited by the user\n';
    await writeFile(path.join(dir, 'main.tex'), handEdited, 'utf8');

    // The agent reads one line back — and is shown nothing of the edit.
    const ranged = (
      await client.callTool({
        name: 'read_file',
        arguments: { project: 'demo', path: 'main.tex', startLine: 1, endLine: 1 },
      })
    ).structuredContent as unknown as ReadResult;
    expect(ranged.content).toBe('alpha');

    // So the whole-file write that follows is still refused, and the edit survives.
    const wrote = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'main.tex', content: 'agent version\n' },
    });
    expect(wrote.isError).toBe(true);
    expect(JSON.stringify(wrote.content)).toContain('changed on disk');
    expect(await readFile(path.join(dir, 'main.tex'), 'utf8')).toBe(handEdited);
  });

  it('still lets a whole read acknowledge the change, so the guard stays usable', async () => {
    const { client, dir } = await setup({ 'main.tex': 'alpha\nbeta\n' });

    await client.callTool({ name: 'read_file', arguments: { project: 'demo', path: 'main.tex' } });
    await writeFile(path.join(dir, 'main.tex'), 'edited by the user\n', 'utf8');
    // Narrowing the claim must not become a blanket refusal to record: a whole read is the
    // acknowledgement, and after it the write goes through.
    await client.callTool({ name: 'read_file', arguments: { project: 'demo', path: 'main.tex' } });

    const wrote = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'main.tex', content: 'agent version\n' },
    });
    expect(wrote.isError).toBeFalsy();
  });
});
