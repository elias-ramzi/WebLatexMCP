import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext, type AppContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import { expectNoUndeclaredKeys } from '../helpers/outputSchema.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * A markdown document in the viewer, end to end through the real tools: `viewer` with `document`
 * hands back the document page, a comment POSTed by that page comes back from `list_comments` with
 * the document as `file` and the server-resolved source `line`, and `resolve_comments` clears it.
 * The project is a LOCAL one — the case a bare-PDF review folder is opened through — so nothing
 * here may need git. `listTools()` runs first, which arms the client's per-tool output validator,
 * so an undeclared `structuredContent` key fails the call rather than passing silently.
 */

const DOC = 'paper-review.local/run/final-review.md';
const TEXT = [
  '# Review',
  '',
  '## Weaknesses',
  '',
  '1. **The student is adapted** on the evaluation scenes.',
  '   The baselines are not.',
  '',
].join('\n');

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function harness(opts: { followSymlinks?: boolean; viewerPort?: number } = {}): Promise<{
  client: Client;
  ctx: AppContext;
  userDir: string;
  outside: string;
}> {
  const workspace = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ovl-viewdoc-ws-')));
  const userDir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ovl-viewdoc-')));
  const outside = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ovl-viewdoc-out-')));
  cleanups.push(
    () => rm(workspace, { recursive: true, force: true }),
    () => rm(userDir, { recursive: true, force: true }),
    () => rm(outside, { recursive: true, force: true }),
  );
  await mkdir(path.join(userDir, 'paper-review.local', 'run'), { recursive: true });
  await writeFile(path.join(userDir, DOC), TEXT, 'utf8');
  await writeFile(path.join(userDir, 'main.tex'), '\\documentclass{article}\n', 'utf8');
  await writeFile(path.join(outside, 'secret.md'), '# not yours\n', 'utf8');

  const config: ServerConfig = {
    workspaceRoot: workspace,
    sessionId: 'test',
    projects: [],
    ...(opts.viewerPort !== undefined ? { viewerPort: opts.viewerPort } : {}),
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
  cleanups.push(
    () => client.close(),
    () => ctx.viewer.close(),
  );
  await client.listTools();
  const reg = await client.callTool({
    name: 'register_project',
    arguments: {
      project: 'rev',
      path: userDir,
      ...(opts.followSymlinks ? { followSymlinks: true } : {}),
    },
  });
  expect(reg.isError, JSON.stringify(reg.content)).toBeFalsy();
  return { client, ctx, userDir, outside };
}

function textOf(res: unknown): string {
  return (res as { content: Array<{ text?: string }> }).content.map((c) => c.text ?? '').join('\n');
}

async function openViewer(
  client: Client,
  document: string,
): Promise<{ url: string; document?: string; isError: boolean; text: string; raw: unknown }> {
  const res = await client.callTool({
    name: 'viewer',
    arguments: { project: 'rev', document, open: false },
  });
  const sc = (res.structuredContent ?? {}) as { url: string; document?: string };
  return { ...sc, isError: Boolean(res.isError), text: textOf(res), raw: res.structuredContent };
}

describe('viewer: markdown document', () => {
  it('opens a document of a local project, and a comment on it round-trips with its line', async () => {
    const { client } = await harness();
    const opened = await openViewer(client, DOC);
    expect(opened.isError, opened.text).toBe(false);
    expect(opened.document).toBe(DOC);
    expect(opened.url).toContain('/p/rev/doc?path=' + encodeURIComponent(DOC));
    await expectNoUndeclaredKeys(client, 'viewer', opened.raw);

    const page = await fetch(opened.url);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toMatch(/img-src 'none'/);

    const docBase = opened.url.replace('/doc?', '/doc/render?');
    const rendered = (await (await fetch(docBase)).json()) as { html: string; version: string };
    expect(rendered.html).toContain('data-src="5-6"');

    // What the page POSTs for a selection inside the numbered item (source lines 5–6).
    const post = await fetch(opened.url.replace('/doc?', '/doc/comments?'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        note: 'say which scenes',
        quote: 'The baselines are not.',
        blockStart: 5,
        blockEnd: 6,
      }),
    });
    expect(post.status).toBe(201);

    const listed = await client.callTool({
      name: 'list_comments',
      arguments: { project: 'rev', document: DOC },
    });
    expect(listed.isError, textOf(listed)).toBeFalsy();
    const sc = listed.structuredContent as {
      comments: Array<{
        id: string;
        document?: string;
        file?: string;
        line?: number;
        page?: number;
        snippet?: string;
        note: string;
      }>;
    };
    expect(sc.comments).toHaveLength(1);
    const c = sc.comments[0]!;
    expect(c).toMatchObject({ document: DOC, file: DOC, line: 6, note: 'say which scenes' });
    expect(c.page).toBeUndefined();
    expect(c.snippet).toContain('The baselines are not.');
    expect(textOf(listed)).toContain(`${DOC}:6`);
    await expectNoUndeclaredKeys(client, 'list_comments', listed.structuredContent);

    // The same document spelled with `./` is the same document.
    const again = await client.callTool({
      name: 'list_comments',
      arguments: { project: 'rev', document: './' + DOC },
    });
    expect((again.structuredContent as { comments: unknown[] }).comments).toHaveLength(1);

    // The PDF page's own listing does not show a document's comment.
    const pdfList = (await (
      await fetch(opened.url.split('/doc?')[0] + '/comments')
    ).json()) as unknown[];
    expect(pdfList).toEqual([]);

    const resolved = await client.callTool({
      name: 'resolve_comments',
      arguments: { project: 'rev', document: DOC },
    });
    expect((resolved.structuredContent as { resolved: number }).resolved).toBe(1);
    const after = await client.callTool({
      name: 'list_comments',
      arguments: { project: 'rev', document: DOC },
    });
    expect((after.structuredContent as { comments: unknown[] }).comments).toEqual([]);
  });

  it('reads a snippet only for a document comment on its own document, never for a PDF comment naming a .md', async () => {
    const { client, ctx } = await harness();
    // A PDF comment whose synctex `file` names the markdown file — what a forged record could say.
    // The source-extension gate still applies to it: no snippet, as before this feature.
    ctx.comments.add('rev', { page: 1, x: 1, y: 1, note: 'pdf', file: DOC, line: 6 });
    // A document comment on that document: its own rule, snippet shown.
    ctx.comments.add('rev', { document: DOC, file: DOC, line: 6, note: 'doc' });
    const listed = await client.callTool({ name: 'list_comments', arguments: { project: 'rev' } });
    const comments = (
      listed.structuredContent as { comments: Array<{ note: string; snippet?: string }> }
    ).comments;
    expect(comments.find((c) => c.note === 'pdf')?.snippet).toBeUndefined();
    expect(comments.find((c) => c.note === 'doc')?.snippet).toContain('The baselines are not.');
  });

  it('refuses a path outside the project, a non-markdown file, and a missing document', async () => {
    const { client, outside } = await harness();
    // A file that EXISTS outside the project, so the refusal is the sandbox's, not a missing file's.
    const escape = '../' + path.basename(outside) + '/secret.md';
    for (const bad of [escape, 'main.tex', 'paper-review.local/run/nope.md']) {
      const r = await openViewer(client, bad);
      expect(r.isError, `${bad}: ${r.text}`).toBe(true);
    }
    const escaped = await openViewer(client, escape);
    expect(escaped.text).not.toContain('not yours');
    expect(escaped.text).not.toContain('No such document');
    expect(escaped.text).toContain('Cannot show document');
    expect((await openViewer(client, 'main.tex')).text).toContain('Not a markdown document');
    expect((await openViewer(client, 'paper-review.local/run/nope.md')).text).toContain(
      'No such document',
    );
  });

  it('quotes the path in every refusal, escaping invisible characters', async () => {
    const { client } = await harness();
    const r = await openViewer(client, '../\u202Eevil.md');
    expect(r.isError, r.text).toBe(true);
    expect(r.text).toContain('\\u{202E}');
    expect(r.text).not.toContain('\u202E');
  });

  it("withholds a document comment's location once its document can no longer be read", async () => {
    const { client, ctx, userDir } = await harness();
    ctx.comments.add('rev', { document: 'gone.md', file: 'gone.md', line: 2, note: 'was here' });
    await writeFile(path.join(userDir, 'kept.md'), 'one\ntwo\n', 'utf8');
    ctx.comments.add('rev', { document: 'kept.md', file: 'kept.md', line: 2, note: 'still here' });
    const listed = await client.callTool({ name: 'list_comments', arguments: { project: 'rev' } });
    const comments = (
      listed.structuredContent as {
        comments: Array<{ note: string; file?: string; line?: number; document?: string }>;
      }
    ).comments;
    const gone = comments.find((c) => c.note === 'was here')!;
    expect(gone.file).toBeUndefined();
    expect(gone.line).toBeUndefined();
    expect(gone.document).toBe('gone.md'); // which document it was on stays known
    expect(comments.find((c) => c.note === 'still here')).toMatchObject({
      file: 'kept.md',
      line: 2,
    });
  });

  it('names the real reason a document cannot be read, not the sandbox', async (t) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) t.skip(); // mode 000 does not stop root
    const { client, userDir } = await harness();
    const locked = path.join(userDir, 'locked.md');
    await writeFile(locked, '# locked\n', 'utf8');
    await chmod(locked, 0o000);
    cleanups.unshift(() => chmod(locked, 0o644)); // before the directory is removed
    const r = await openViewer(client, 'locked.md');
    expect(r.isError, r.text).toBe(true);
    expect(r.text).toContain('Cannot show document "locked.md": permission denied');
    expect(r.text).not.toContain('outside the project');
  });

  it('scopes listing and resolving to PDF comments with pdfOnly', async () => {
    const { client, ctx } = await harness();
    ctx.comments.add('rev', { page: 1, x: 1, y: 1, note: 'on the pdf' });
    ctx.comments.add('rev', { document: DOC, file: DOC, line: 6, note: 'on the doc' });

    const listed = await client.callTool({
      name: 'list_comments',
      arguments: { project: 'rev', pdfOnly: true },
    });
    expect(listed.isError, textOf(listed)).toBeFalsy();
    const notes = (listed.structuredContent as { comments: Array<{ note: string }> }).comments.map(
      (c) => c.note,
    );
    expect(notes).toEqual(['on the pdf']);
    await expectNoUndeclaredKeys(client, 'list_comments', listed.structuredContent);

    // `document` wins over pdfOnly.
    const both = await client.callTool({
      name: 'list_comments',
      arguments: { project: 'rev', pdfOnly: true, document: DOC },
    });
    expect(
      (both.structuredContent as { comments: Array<{ note: string }> }).comments.map((c) => c.note),
    ).toEqual(['on the doc']);

    const resolved = await client.callTool({
      name: 'resolve_comments',
      arguments: { project: 'rev', pdfOnly: true },
    });
    expect(resolved.isError, textOf(resolved)).toBeFalsy();
    expect((resolved.structuredContent as { resolved: number }).resolved).toBe(1);
    await expectNoUndeclaredKeys(client, 'resolve_comments', resolved.structuredContent);

    const open = await client.callTool({ name: 'list_comments', arguments: { project: 'rev' } });
    expect(
      (open.structuredContent as { comments: Array<{ note: string }> }).comments.map((c) => c.note),
    ).toEqual(['on the doc']);
  });

  it("keeps a document comment's location when the owner's link policy shows the document", async (t) => {
    const { client, userDir, outside } = await harness({ followSymlinks: true });
    try {
      await symlink(path.join(outside, 'secret.md'), path.join(userDir, 'notes.md'));
    } catch {
      t.skip(); // no symlink privilege (Windows without developer mode)
    }
    const opened = await openViewer(client, 'notes.md');
    expect(opened.isError, opened.text).toBe(false);
    const post = await fetch(opened.url.replace('/doc?', '/doc/comments?'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: 'fine', quote: 'not yours', blockStart: 1, blockEnd: 1 }),
    });
    expect(post.status).toBe(201);
    const listed = await client.callTool({
      name: 'list_comments',
      arguments: { project: 'rev', document: 'notes.md' },
    });
    expect(listed.isError, textOf(listed)).toBeFalsy();
    const [c] = (
      listed.structuredContent as {
        comments: Array<{ file?: string; line?: number; snippet?: string }>;
      }
    ).comments;
    expect(c).toMatchObject({ file: 'notes.md', line: 1 });
    expect(c?.snippet).toContain('not yours');
  });

  it('refuses a document reached through a symlink out of the project', async (t) => {
    const { client, userDir, outside } = await harness();
    try {
      await symlink(path.join(outside, 'secret.md'), path.join(userDir, 'link.md'));
    } catch {
      t.skip(); // no symlink privilege (Windows without developer mode)
    }
    const r = await openViewer(client, 'link.md');
    expect(r.isError, r.text).toBe(true);
    expect(r.text).not.toContain('not yours');

    // And the page route, asked directly, does not serve it either.
    const ok = await openViewer(client, DOC);
    const res = await fetch(
      ok.url.replace(encodeURIComponent(DOC), 'link.md').replace('/doc?', '/doc/render?'),
    );
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('not yours');
  });
});

describe('viewer: the port cannot be bound', () => {
  it('is a tool error naming the port, not an output-validation failure', async () => {
    // A configured port someone else holds. Without `isError` the reply carried no
    // structuredContent, and the client's output validator turned it into -32602 with no result.
    const holder = net.createServer();
    await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise((resolve) => holder.close(resolve)));
    const port = (holder.address() as net.AddressInfo).port;

    const { client } = await harness({ viewerPort: port });
    const opened = await openViewer(client, DOC);
    expect(opened.isError).toBe(true);
    expect(opened.text).toContain(`port ${port}`);
    expect(opened.text).toContain('WEB_LATEX_MCP_VIEWER_PORT');
  });
});
