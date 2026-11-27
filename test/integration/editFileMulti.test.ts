import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import { renderCost, DIFF_CONTENT_BUDGET } from '../../src/lib/diffBudget.js';
import { expectNoUndeclaredKeys } from '../helpers/outputSchema.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * `edit_file` with `files`: several files in one call, all or nothing. Every file gets the guards
 * a single-file call gives it (the .bib gate on the literal and the link-resolved name, the
 * external-change check, rewrite preservation, excludeComments), every file is planned before
 * the first write, and the confirmation diffs share one budget.
 */

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup(): Promise<{ client: Client; userDir: string }> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-multiedit-ws-'));
  const userDir = await mkdtemp(path.join(os.tmpdir(), 'wlm-multiedit-dir-'));
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
  return ((res as { content?: Array<{ text?: string }> }).content ?? [])
    .map((c) => c.text ?? '')
    .join('\n');
}

async function seed(dir: string, files: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(dir, name), content, 'utf8');
  }
}

async function contents(dir: string, names: string[]): Promise<string[]> {
  return Promise.all(names.map((n) => readFile(path.join(dir, n), 'utf8')));
}

interface FileOut {
  path: string;
  appliedEdits: number;
  diff: string;
  diffTruncated: boolean;
  rewriteMode: string;
  preservedEdits: number;
  commentMatches?: unknown[];
}

describe('edit_file with files', () => {
  it('applies every file and reports each one', async () => {
    const { client, userDir } = await setup();
    await seed(userDir, { 'a.tex': 'alpha\n', 'b.tex': 'beta\ngamma\n' });
    const res = await client.callTool({
      name: 'edit_file',
      arguments: {
        project: 'p',
        files: [
          { path: 'a.tex', edits: [{ oldString: 'alpha', newString: 'ALPHA' }] },
          {
            path: 'b.tex',
            edits: [
              { oldString: 'beta', newString: 'BETA' },
              { startLine: 2, endLine: 2, newString: 'GAMMA' },
            ],
          },
        ],
      },
    });
    expect(res.isError ?? false).toBe(false);
    expect(await contents(userDir, ['a.tex', 'b.tex'])).toEqual(['ALPHA\n', 'BETA\nGAMMA\n']);
    const out = structured<{ appliedEdits: number; files: FileOut[] }>(res);
    expect(out.appliedEdits).toBe(3);
    expect(out.files.map((f) => [f.path, f.appliedEdits])).toEqual([
      ['a.tex', 1],
      ['b.tex', 2],
    ]);
    expect(out.files[0]?.diff).toContain('+ALPHA');
    expect(out.files[1]?.diff).toContain('+GAMMA');
    const text = textOf(res);
    expect(text).toContain('applied 3 edit(s) across 2 file(s)');
    expect(text).toContain('applied 1 edit(s) to a.tex');
    expect(text).toContain('applied 2 edit(s) to b.tex');
  });

  it("writes nothing when a later file's oldString is not found, and names it", async () => {
    const { client, userDir } = await setup();
    await seed(userDir, { 'a.tex': 'alpha\n', 'b.tex': 'beta\n' });
    const res = await client.callTool({
      name: 'edit_file',
      arguments: {
        project: 'p',
        files: [
          { path: 'a.tex', edits: [{ oldString: 'alpha', newString: 'ALPHA' }] },
          {
            path: 'b.tex',
            edits: [
              { oldString: 'beta', newString: 'BETA' },
              { oldString: 'missing', newString: 'x' },
            ],
          },
        ],
      },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('files[2] "b.tex"');
    expect(textOf(res)).toContain('Edit 2: oldString not found');
    expect(textOf(res)).toContain('Nothing was written');
    expect(await contents(userDir, ['a.tex', 'b.tex'])).toEqual(['alpha\n', 'beta\n']);
  });

  it('refuses a .bib among the files without confirmBibEdit, writing nothing', async () => {
    const { client, userDir } = await setup();
    await seed(userDir, { 'a.tex': 'alpha\n', 'refs.bib': '@misc{k, title={T}}\n' });
    const files = [
      { path: 'a.tex', edits: [{ oldString: 'alpha', newString: 'ALPHA' }] },
      { path: 'refs.bib', edits: [{ oldString: 'T', newString: 'U' }] },
    ];
    const res = await client.callTool({ name: 'edit_file', arguments: { project: 'p', files } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('confirmBibEdit');
    expect(await contents(userDir, ['a.tex', 'refs.bib'])).toEqual([
      'alpha\n',
      '@misc{k, title={T}}\n',
    ]);

    // confirmBibEdit is a flag of the call, and applies to every file it names.
    const ok = await client.callTool({
      name: 'edit_file',
      arguments: { project: 'p', files, confirmBibEdit: true },
    });
    expect(ok.isError ?? false).toBe(false);
    expect(await contents(userDir, ['a.tex', 'refs.bib'])).toEqual([
      'ALPHA\n',
      '@misc{k, title={U}}\n',
    ]);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a link onto a .bib among the files, writing nothing',
    async () => {
      const { client, userDir } = await setup();
      await seed(userDir, { 'a.tex': 'alpha\n', 'refs.bib': '@misc{k, title={T}}\n' });
      await symlink('refs.bib', path.join(userDir, 'notes.tex'));
      const res = await client.callTool({
        name: 'edit_file',
        arguments: {
          project: 'p',
          files: [
            { path: 'a.tex', edits: [{ oldString: 'alpha', newString: 'ALPHA' }] },
            { path: 'notes.tex', edits: [{ oldString: 'T', newString: 'U' }] },
          ],
        },
      });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('files[2] "notes.tex"');
      expect(textOf(res)).toContain('confirmBibEdit');
      expect(await contents(userDir, ['a.tex', 'refs.bib'])).toEqual([
        'alpha\n',
        '@misc{k, title={T}}\n',
      ]);
    },
  );

  it('writes nothing when one file changed on disk since it was read', async () => {
    const { client, userDir } = await setup();
    await seed(userDir, { 'a.tex': 'alpha\n', 'b.tex': 'beta\n' });
    await client.callTool({ name: 'read_file', arguments: { project: 'p', path: 'b.tex' } });
    // The user edits b.tex by hand after the read.
    await writeFile(path.join(userDir, 'b.tex'), 'beta\nhand edit\n', 'utf8');
    const files = [
      { path: 'a.tex', edits: [{ oldString: 'alpha', newString: 'ALPHA' }] },
      { path: 'b.tex', edits: [{ oldString: 'beta', newString: 'BETA' }] },
    ];
    const res = await client.callTool({ name: 'edit_file', arguments: { project: 'p', files } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('files[2] "b.tex"');
    expect(textOf(res)).toContain('overrideExternalChanges');
    expect(await contents(userDir, ['a.tex', 'b.tex'])).toEqual(['alpha\n', 'beta\nhand edit\n']);

    // overrideExternalChanges is a flag of the call, and applies to every file.
    const ok = await client.callTool({
      name: 'edit_file',
      arguments: { project: 'p', files, overrideExternalChanges: true },
    });
    expect(ok.isError ?? false).toBe(false);
    expect(await contents(userDir, ['a.tex', 'b.tex'])).toEqual(['ALPHA\n', 'BETA\nhand edit\n']);
  });

  it('refuses one file named twice, by spelling', async () => {
    const { client, userDir } = await setup();
    await seed(userDir, { 'a.tex': 'alpha beta\n' });
    const res = await client.callTool({
      name: 'edit_file',
      arguments: {
        project: 'p',
        files: [
          { path: 'a.tex', edits: [{ oldString: 'alpha', newString: 'ALPHA' }] },
          { path: './a.tex', edits: [{ oldString: 'beta', newString: 'BETA' }] },
        ],
      },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('names the same file twice');
    expect(await contents(userDir, ['a.tex'])).toEqual(['alpha beta\n']);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses one file named twice, through a link',
    async () => {
      const { client, userDir } = await setup();
      await seed(userDir, { 'a.tex': 'alpha beta\n' });
      await symlink('a.tex', path.join(userDir, 'b.tex'));
      const res = await client.callTool({
        name: 'edit_file',
        arguments: {
          project: 'p',
          files: [
            { path: 'a.tex', edits: [{ oldString: 'alpha', newString: 'ALPHA' }] },
            { path: 'b.tex', edits: [{ oldString: 'beta', newString: 'BETA' }] },
          ],
        },
      });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('names the same file twice');
      expect(await contents(userDir, ['a.tex'])).toEqual(['alpha beta\n']);
    },
  );

  it('refuses files beside a top-level path, edits or inline edit', async () => {
    const { client, userDir } = await setup();
    await seed(userDir, { 'a.tex': 'alpha\n' });
    const files = [{ path: 'a.tex', edits: [{ oldString: 'alpha', newString: 'ALPHA' }] }];
    for (const extra of [
      { path: 'a.tex' },
      { edits: [{ oldString: 'alpha', newString: 'x' }] },
      { oldString: 'alpha', newString: 'x' },
    ]) {
      const res = await client.callTool({
        name: 'edit_file',
        arguments: { project: 'p', files, ...extra },
      });
      expect(res.isError, JSON.stringify(extra)).toBe(true);
      expect(textOf(res)).toContain('files cannot be combined with top-level');
    }
    expect(await contents(userDir, ['a.tex'])).toEqual(['alpha\n']);
  });

  it('refuses more than 20 files', async () => {
    const { client } = await setup();
    const files = Array.from({ length: 21 }, (_, i) => ({
      path: `f${i}.tex`,
      edits: [{ oldString: 'a', newString: 'b' }],
    }));
    const res = await client
      .callTool({ name: 'edit_file', arguments: { project: 'p', files } })
      .then(
        (r) => (r.isError === true ? textOf(r) : 'NOT REFUSED'),
        (err: unknown) => String(err),
      );
    // Refused for its length (the advertised `maxItems`), not for some other reason.
    expect(res).toMatch(/files/);
    expect(res).toMatch(/20/);
  });

  it('applies rewrite preservation and excludeComments per file', async () => {
    const { client, userDir } = await setup();
    const para = 'The quick brown fox jumps over the lazy dog while the sun sets slowly.';
    await seed(userDir, {
      'a.tex': `${para}\n`,
      'b.tex': '% Old name here\nOld name here\n',
      'c.md': `${para}\n`,
    });
    const res = await client.callTool({
      name: 'edit_file',
      arguments: {
        project: 'p',
        preserveOriginal: true,
        files: [
          { path: 'a.tex', edits: [{ oldString: para, newString: 'A new sentence.' }] },
          {
            path: 'b.tex',
            edits: [{ oldString: 'Old name', newString: 'New name', excludeComments: true }],
          },
          { path: 'c.md', edits: [{ oldString: para, newString: 'A new sentence.' }] },
        ],
      },
    });
    expect(res.isError ?? false).toBe(false);
    const out = structured<{ preservedEdits: number; files: FileOut[] }>(res);
    expect(out.files.map((f) => [f.rewriteMode, f.preservedEdits])).toEqual([
      ['always', 1],
      ['always', 0],
      ['off', 0],
    ]);
    expect(out.preservedEdits).toBe(1);
    expect(out.files[1]?.commentMatches).toEqual([{ edit: 1, replaced: 1, skippedInComments: 1 }]);
    expect(await contents(userDir, ['a.tex', 'b.tex', 'c.md'])).toEqual([
      `% ${para}\nA new sentence.\n`,
      '% Old name here\nNew name here\n',
      'A new sentence.\n',
    ]);
    expect(textOf(res)).toContain('preserveOriginal was ignored: c.md has no %-line-comment');
  });

  it('cuts the per-file diffs from one shared budget, never to empty', async () => {
    const { client, userDir } = await setup();
    // 20 files, each changing 40 separate lines: far more than any budget holds.
    const names = Array.from({ length: 20 }, (_, i) => `sec${i}.tex`);
    const body = Array.from({ length: 200 }, (_, j) => `line ${j} ${'x'.repeat(60)}`).join('\n');
    await seed(userDir, Object.fromEntries(names.map((n) => [n, `${body}\n`])));
    const edits = Array.from({ length: 40 }, (_, j) => ({
      startLine: j * 5 + 1,
      endLine: j * 5 + 1,
      newString: `changed ${j} ${'y'.repeat(60)}`,
    }));
    const res = await client.callTool({
      name: 'edit_file',
      arguments: { project: 'p', files: names.map((n) => ({ path: n, edits })) },
    });
    expect(res.isError ?? false).toBe(false);
    const out = structured<{ files: FileOut[] }>(res);
    expect(out.files).toHaveLength(20);
    for (const f of out.files) {
      // Every file changed, so every diff says so — cut, never emptied.
      expect(f.diff).toContain(`diff --git a/${f.path}`);
      expect(f.diffTruncated).toBe(true);
    }
    // Both channels together, the diffs stay within the one pool.
    const charged = out.files.reduce((n, f) => n + renderCost(f.diff), 0);
    expect(charged).toBeLessThanOrEqual(DIFF_CONTENT_BUDGET);
    // The text channel carries the same cut diffs, not the full patches.
    expect(textOf(res).length).toBeLessThan(DIFF_CONTENT_BUDGET);
  });

  it('declares every key a files result carries (listTools round trip)', async () => {
    const { client, userDir } = await setup();
    await seed(userDir, { 'a.tex': '% old\nold\n', 'b.tex': 'beta\n' });
    const res = await client.callTool({
      name: 'edit_file',
      arguments: {
        project: 'p',
        files: [
          {
            path: 'a.tex',
            edits: [{ oldString: 'old', newString: 'new', excludeComments: true }],
          },
          { path: 'b.tex', edits: [{ oldString: 'beta', newString: 'BETA' }] },
        ],
      },
    });
    expect(res.isError ?? false).toBe(false);
    const out = structured<{ files: FileOut[] }>(res);
    // The optional per-file key is populated, so its declaration is actually judged.
    expect(out.files[0]?.commentMatches).toBeDefined();
    await expectNoUndeclaredKeys(client, 'edit_file', res.structuredContent);

    // And the single-file and inline shapes, against the same advertised schema.
    const single = await client.callTool({
      name: 'edit_file',
      arguments: { project: 'p', path: 'b.tex', oldString: 'BETA', newString: 'beta' },
    });
    expect(single.isError ?? false).toBe(false);
    await expectNoUndeclaredKeys(client, 'edit_file', single.structuredContent);
  });
});
