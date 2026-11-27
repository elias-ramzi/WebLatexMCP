import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
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

describe('edit_file non-unique refusal names excludeComments (tool layer)', () => {
  // The session this came from: a paper keeping old versions of each sentence as `%` lines made
  // every live sentence match twice, and the model abandoned edit_file for shell edits rather
  // than discover excludeComments. The refusal now says how the matches split.
  async function refusal(file: string, content: string, oldString: string): Promise<string> {
    const { client, userDir } = await setup();
    await writeFile(path.join(userDir, file), content, 'utf8');
    const res = await client.callTool({
      name: 'edit_file',
      arguments: { project: 'p', path: file, edits: [{ oldString, newString: 'NEW' }] },
    });
    expect(res.isError).toBe(true);
    // Refused, so nothing was written.
    expect(await readFile(path.join(userDir, file), 'utf8')).toBe(content);
    return textOf(res);
  }

  it('one live and two commented matches: points at excludeComments', async () => {
    const text = await refusal(
      'main.tex',
      '% Our method is fast.\n%Our method is fast.\nOur method is fast.\n',
      'Our method is fast.',
    );
    expect(text).toContain('matches 3 times in main.tex');
    expect(text).toContain('only once outside comments');
    expect(text).toContain('the other 2 match(es) are inside %-comments');
    expect(text).toContain('Set excludeComments: true on this edit');
  });

  it('two live and one commented match: says how many are commented, keeps the old advice', async () => {
    const text = await refusal(
      'main.tex',
      'Our method is fast.\n% Our method is fast.\nOur method is fast.\n',
      'Our method is fast.',
    );
    expect(text).toContain('matches 3 times in main.tex (2 outside comments, 1 inside %-comments)');
    expect(text).toContain('add more surrounding context for a unique match, or set replaceAll');
    expect(text).not.toContain('only once outside comments');
  });

  it('every match commented: says there is no live occurrence', async () => {
    const text = await refusal('main.tex', '% old one\n% old one\nnew\n', 'old one');
    expect(text).toContain('all 2 are inside %-comments');
    expect(text).toContain('no live occurrence');
  });

  it('a file without %-comment syntax gets no comment talk', async () => {
    const text = await refusal(
      'notes.md',
      '% Our method is fast.\nOur method is fast.\n',
      'Our method is fast.',
    );
    expect(text).toContain(
      'matches 2 times in notes.md; add more surrounding context for a unique match, or set replaceAll.',
    );
    expect(text).not.toMatch(/comment/i);
  });

  it('a single commented match is still applied, as documented', async () => {
    const { client, userDir } = await setup();
    await writeFile(path.join(userDir, 'main.tex'), '% old one\nlive\n', 'utf8');
    const res = await client.callTool({
      name: 'edit_file',
      arguments: {
        project: 'p',
        path: 'main.tex',
        edits: [{ oldString: 'old one', newString: 'new one' }],
      },
    });
    expect(res.isError ?? false).toBe(false);
    expect(await readFile(path.join(userDir, 'main.tex'), 'utf8')).toBe('% new one\nlive\n');
  });
});

describe('edit_file inline single-edit shorthand (tool layer)', () => {
  it('applies a top-level line range with no edits array', async () => {
    const { client, userDir } = await setup();
    await writeFile(path.join(userDir, 'main.tex'), 'one\ntwo\nthree\n', 'utf8');
    const res = await client.callTool({
      name: 'edit_file',
      arguments: { project: 'p', path: 'main.tex', startLine: 2, endLine: 2, newString: 'TWO' },
    });
    expect(res.isError ?? false).toBe(false);
    expect(structured<{ appliedEdits: number }>(res).appliedEdits).toBe(1);
    expect(await readFile(path.join(userDir, 'main.tex'), 'utf8')).toBe('one\nTWO\nthree\n');
  });

  it('applies a top-level string edit, excludeComments included', async () => {
    const { client, userDir } = await setup();
    await writeFile(path.join(userDir, 'main.tex'), '% foo\nfoo\n', 'utf8');
    const res = await client.callTool({
      name: 'edit_file',
      arguments: {
        project: 'p',
        path: 'main.tex',
        oldString: 'foo',
        newString: 'bar',
        excludeComments: true,
      },
    });
    expect(res.isError ?? false).toBe(false);
    expect(structured<{ commentMatches?: unknown[] }>(res).commentMatches).toEqual([
      { edit: 1, replaced: 1, skippedInComments: 1 },
    ]);
    expect(await readFile(path.join(userDir, 'main.tex'), 'utf8')).toBe('% foo\nbar\n');
  });

  it('refuses inline fields beside edits', async () => {
    const { client, userDir } = await setup();
    await writeFile(path.join(userDir, 'main.tex'), 'one\n', 'utf8');
    const res = await client.callTool({
      name: 'edit_file',
      arguments: {
        project: 'p',
        path: 'main.tex',
        oldString: 'one',
        newString: 'ONE',
        edits: [{ oldString: 'one', newString: 'uno' }],
      },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('not both');
    expect(await readFile(path.join(userDir, 'main.tex'), 'utf8')).toBe('one\n');
  });

  it('refuses an inline edit mixing the two shapes', async () => {
    const { client, userDir } = await setup();
    await writeFile(path.join(userDir, 'main.tex'), 'one\ntwo\n', 'utf8');
    const res = await client.callTool({
      name: 'edit_file',
      arguments: {
        project: 'p',
        path: 'main.tex',
        oldString: 'one',
        startLine: 2,
        endLine: 2,
        newString: 'X',
      },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('neither a string edit');
    expect(await readFile(path.join(userDir, 'main.tex'), 'utf8')).toBe('one\ntwo\n');
  });

  it('refuses a call with path and no edits at all, in server words', async () => {
    const { client, userDir } = await setup();
    await writeFile(path.join(userDir, 'main.tex'), 'one\n', 'utf8');
    const res = await client.callTool({
      name: 'edit_file',
      arguments: { project: 'p', path: 'main.tex' },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('No edits given');
  });

  it('advertises the inline fields as optional input properties', async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'edit_file');
    const schema = tool?.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    const keys = [
      'path',
      'edits',
      'files',
      'oldString',
      'newString',
      'replaceAll',
      'excludeComments',
      'startLine',
      'endLine',
    ];
    for (const key of keys) {
      expect(schema.properties?.[key], key).toBeDefined();
      expect(schema.required ?? [], key).not.toContain(key);
    }
  });
});
