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
import type { ServerConfig } from '../../src/types.js';

/**
 * `edit_file`'s tool layer for the two new edit shapes: that the union schema round-trips through
 * a real MCP client (a mixed object is refused by validation, not silently half-read), that
 * `excludeComments` is refused on a file whose comment character is not `%`, and that a skipped
 * match is reported in BOTH channels.
 *
 * A local project needs no git and no network — only temp dirs — so this stays a unit test.
 */

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup(): Promise<{ client: Client; userDir: string }> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-edits-ws-'));
  const userDir = await mkdtemp(path.join(os.tmpdir(), 'ovl-edits-dir-'));
  cleanups.push(
    () => rm(workspace, { recursive: true, force: true }),
    () => rm(userDir, { recursive: true, force: true }),
  );
  const config: ServerConfig = { workspaceRoot: workspace, sessionId: 'test', projects: [] };
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
  await client.callTool({ name: 'register_project', arguments: { project: 'p', path: userDir } });
  return { client, userDir };
}

function structured<T>(res: unknown): T {
  return (res as { structuredContent: T }).structuredContent;
}

function textOf(res: unknown): string {
  return JSON.stringify((res as { content?: unknown }).content ?? '');
}

describe('edit_file line ranges (tool layer)', () => {
  it('replaces the named lines and reports them applied', async () => {
    const { client, userDir } = await setup();
    await writeFile(path.join(userDir, 'main.tex'), 'one\ntwo\nthree\n', 'utf8');
    const res = await client.callTool({
      name: 'edit_file',
      arguments: {
        project: 'p',
        path: 'main.tex',
        edits: [{ startLine: 2, endLine: 2, newString: 'TWO' }],
      },
    });
    expect(res.isError ?? false).toBe(false);
    expect(structured<{ appliedEdits: number }>(res).appliedEdits).toBe(1);
    expect(await readFile(path.join(userDir, 'main.tex'), 'utf8')).toBe('one\nTWO\nthree\n');
  });

  it('accepts a string edit and a range edit in the same array', async () => {
    const { client, userDir } = await setup();
    await writeFile(path.join(userDir, 'main.tex'), 'one\ntwo\nthree\n', 'utf8');
    const res = await client.callTool({
      name: 'edit_file',
      arguments: {
        project: 'p',
        path: 'main.tex',
        edits: [
          { oldString: 'one', newString: 'ONE' },
          { startLine: 3, endLine: 3, newString: 'THREE' },
        ],
      },
    });
    expect(res.isError ?? false).toBe(false);
    expect(await readFile(path.join(userDir, 'main.tex'), 'utf8')).toBe('ONE\ntwo\nTHREE\n');
  });

  it('refuses an edit object that mixes the two shapes instead of silently ignoring half of it', async () => {
    const { client, userDir } = await setup();
    await writeFile(path.join(userDir, 'main.tex'), 'one\ntwo\nthree\n', 'utf8');
    const reason = await client
      .callTool({
        name: 'edit_file',
        arguments: {
          project: 'p',
          path: 'main.tex',
          edits: [{ oldString: 'one', newString: 'ONE', startLine: 3, endLine: 3 }],
        },
      })
      .then(
        (res) => (res.isError === true ? textOf(res) : 'NOT REFUSED'),
        (err: unknown) => String(err),
      );
    // Refused by the schema itself, not by some later accident — the two shapes are strict
    // objects in a union, so an object carrying both matches neither branch.
    expect(reason).toMatch(/nrecognized key|nvalid|union/);
    expect(await readFile(path.join(userDir, 'main.tex'), 'utf8')).toBe('one\ntwo\nthree\n');
  });

  it('reports an out-of-range request in server words and leaves the file alone', async () => {
    const { client, userDir } = await setup();
    await writeFile(path.join(userDir, 'main.tex'), 'one\ntwo\n', 'utf8');
    const res = await client.callTool({
      name: 'edit_file',
      arguments: {
        project: 'p',
        path: 'main.tex',
        edits: [{ startLine: 2, endLine: 9, newString: 'x' }],
      },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('which has 2 line(s)');
    expect(await readFile(path.join(userDir, 'main.tex'), 'utf8')).toBe('one\ntwo\n');
  });
});

describe('edit_file excludeComments (tool layer)', () => {
  it('skips commented matches and reports the split in both channels', async () => {
    const { client, userDir } = await setup();
    await writeFile(
      path.join(userDir, 'main.tex'),
      'OldName lives\n% OldName is history\nOldName lives again\n',
      'utf8',
    );
    const res = await client.callTool({
      name: 'edit_file',
      arguments: {
        project: 'p',
        path: 'main.tex',
        edits: [
          { oldString: 'OldName', newString: 'NewName', replaceAll: true, excludeComments: true },
        ],
      },
    });
    expect(res.isError ?? false).toBe(false);
    expect(structured<{ commentMatches?: unknown[] }>(res).commentMatches).toEqual([
      { edit: 1, replaced: 2, skippedInComments: 1 },
    ]);
    expect(textOf(res)).toContain('skipped 1 inside comments');
    expect(await readFile(path.join(userDir, 'main.tex'), 'utf8')).toBe(
      'NewName lives\n% OldName is history\nNewName lives again\n',
    );
  });

  it('omits commentMatches entirely when no edit asked for it', async () => {
    const { client, userDir } = await setup();
    await writeFile(path.join(userDir, 'main.tex'), 'a\n', 'utf8');
    const res = await client.callTool({
      name: 'edit_file',
      arguments: { project: 'p', path: 'main.tex', edits: [{ oldString: 'a', newString: 'b' }] },
    });
    expect(structured<{ commentMatches?: unknown }>(res).commentMatches).toBeUndefined();
  });

  it('refuses excludeComments on a file whose comment character is not %', async () => {
    // Filtering a .md against `%` would find no comments and rewrite every match the caller
    // asked to protect — the silent failure this refusal exists to prevent.
    const { client, userDir } = await setup();
    await writeFile(path.join(userDir, 'notes.md'), 'OldName\n% OldName\n', 'utf8');
    const res = await client.callTool({
      name: 'edit_file',
      arguments: {
        project: 'p',
        path: 'notes.md',
        edits: [
          { oldString: 'OldName', newString: 'NewName', replaceAll: true, excludeComments: true },
        ],
      },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('no %-line-comment syntax');
    expect(await readFile(path.join(userDir, 'notes.md'), 'utf8')).toBe('OldName\n% OldName\n');
  });

  it('names the offending edit by its 1-based position', async () => {
    const { client, userDir } = await setup();
    await writeFile(path.join(userDir, 'notes.md'), 'a\nOldName\n', 'utf8');
    const res = await client.callTool({
      name: 'edit_file',
      arguments: {
        project: 'p',
        path: 'notes.md',
        edits: [
          { oldString: 'a', newString: 'A' },
          { oldString: 'OldName', newString: 'NewName', excludeComments: true },
        ],
      },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('Edit 2 sets excludeComments');
  });
});
