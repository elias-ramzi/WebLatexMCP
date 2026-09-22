import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext, type AppContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import { COMMENTS_CONTENT_BUDGET } from '../../src/lib/commentsBudget.js';
import { expectNoUndeclaredKeys } from '../helpers/outputSchema.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * `list_comments` returned every comment whole, in BOTH channels (#163): the same `note`, `quote`
 * and five-line `snippet` rendered into `structuredContent.comments` and again into the result
 * text. The case that bites is ordinary rather than hostile — a review pass leaving 200 comments on
 * a paper, each with a paragraph-sized PDF selection.
 *
 * These drive the real tool through a real MCP `Client`, so the cut is proved where the caller
 * actually sees it — the text channel included, and measured on the wire rather than on the
 * handler's objects.
 *
 * The client calls `listTools()` first, deliberately. The SDK compiles an ajv validator per
 * advertised output schema at that point and checks every later result against it, with every
 * object node `additionalProperties: false` — so a counter added to `structuredContent` but not
 * declared in `outputSchema` makes the call fail with `-32602` and return nothing at all
 * (#137, #146). A client that never lists tools caches no validator and proves nothing here.
 */

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

interface ListedComment {
  id: string;
  number: number;
  note: string;
  quote?: string;
  file?: string;
  line?: number;
  snippet?: string;
  noteOmittedChars?: number;
  quoteOmittedChars?: number;
  snippetOmittedChars?: number;
}

interface Listing {
  comments: ListedComment[];
  commentsOmitted: number;
  quotesOmitted: number;
  snippetsOmitted: number;
  truncated: boolean;
  budgetNote?: string;
}

/** A source file long enough that every comment's synctex line really resolves to a snippet. */
function source(lines: number): string {
  return Array.from(
    { length: lines },
    (_, i) => `\\textbf{row ${i}} & ${'value '.repeat(40)} \\\\`,
  ).join('\n');
}

async function harness(): Promise<{ client: Client; ctx: AppContext; userDir: string }> {
  // Realpath'd so macOS's /tmp -> /private/tmp symlink is not itself counted as "leaving".
  const workspace = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ovl-cmtbudget-ws-')));
  const userDir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ovl-cmtbudget-')));
  cleanups.push(
    () => rm(workspace, { recursive: true, force: true }),
    () => rm(userDir, { recursive: true, force: true }),
  );
  await writeFile(path.join(userDir, 'main.tex'), source(400), 'utf8');

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
  // Arms the per-tool ajv validator — see the header.
  await client.listTools();
  await client.callTool({
    name: 'register_project',
    arguments: { project: 'doc', path: userDir },
  });
  return { client, ctx, userDir };
}

async function list(
  client: Client,
  args: Record<string, unknown> = {},
): Promise<{ listing: Listing; text: string; wire: number }> {
  const res = await client.callTool({
    name: 'list_comments',
    arguments: { project: 'doc', ...args },
  });
  expect(res.isError, `list_comments failed: ${JSON.stringify(res.content)}`).toBeFalsy();
  const content = (res as { content: Array<{ type: string; text?: string }> }).content;
  const text = content.map((c) => c.text ?? '').join('\n');
  return {
    listing: res.structuredContent as unknown as Listing,
    text,
    // What the caller is actually sent: the JSON payload AND the rendered text. Both channels.
    wire: JSON.stringify(res.structuredContent).length + text.length,
  };
}

/** Seed `n` comments whose quote, note and source line are each realistically long. */
function seed(ctx: AppContext, n: number): void {
  for (let i = 1; i <= n; i += 1) {
    ctx.comments.add('doc', {
      page: 1 + (i % 10),
      x: 10,
      y: 20,
      note: `NOTE${i}: this sentence needs rewriting, it is far too long and reads badly. `.repeat(
        3,
      ),
      quote: `QUOTE${i} ${'the selected passage of the compiled pdf '.repeat(20)}`,
      file: 'main.tex',
      line: i + 2,
    });
  }
}

describe('list_comments bounds its result (#163)', () => {
  it('keeps a 200-comment review pass inside the budget, in BOTH channels', async () => {
    const { client, ctx } = await harness();
    seed(ctx, 200);

    const { listing, text, wire } = await list(client);

    expect(wire).toBeLessThanOrEqual(COMMENTS_CONTENT_BUDGET);
    // Not vacuous: what the store holds, shipped whole into both channels the way this tool used
    // to, is an order of magnitude past the budget — and past what a client will take at all.
    const unbudgeted = 2 * JSON.stringify(ctx.comments.list('doc')).length;
    expect(unbudgeted).toBeGreaterThan(10 * COMMENTS_CONTENT_BUDGET);
    expect(listing.truncated).toBe(true);
    expect(text).toContain(listing.budgetNote!);
  });

  it('every listed comment stays addressable by id, and resolve_comments takes the last one', async () => {
    const { client, ctx } = await harness();
    seed(ctx, 200);

    const { listing } = await list(client);
    const last = listing.comments[listing.comments.length - 1]!;

    for (const c of listing.comments) {
      expect(c.id).toBeTypeOf('string');
      expect(c.note).toContain('NOTE');
    }
    expect(listing.comments.length + listing.commentsOmitted).toBe(200);
    expect(listing.commentsOmitted).toBeGreaterThan(0);

    // The point of keeping identity over content: the deepest comment in the list is still
    // actionable, and resolving it brings the omitted tail within reach on the next call.
    const resolved = await client.callTool({
      name: 'resolve_comments',
      arguments: { project: 'doc', ids: [last.id] },
    });
    expect((resolved.structuredContent as { resolved: number }).resolved).toBe(1);
  });

  it('cuts snippets before quotes, and quotes before comments', async () => {
    const { client, ctx } = await harness();
    seed(ctx, 20);

    const { listing } = await list(client);

    expect(listing.comments).toHaveLength(20);
    expect(listing.commentsOmitted).toBe(0); // no comment dropped while snippets were still shown
    expect(listing.snippetsOmitted).toBeGreaterThan(0);
    for (const c of listing.comments) {
      if (c.snippet === undefined) expect(c.snippetOmittedChars).toBeGreaterThan(0);
    }
  });

  it('renders the text from the cut payload, not from the full one', async () => {
    const { client, ctx } = await harness();
    seed(ctx, 200);

    const { listing, text } = await list(client);
    const dropped = listing.comments.filter(
      (c) => c.quote === undefined && c.quoteOmittedChars !== undefined,
    );

    expect(listing.quotesOmitted).toBe(dropped.length);
    expect(dropped.length).toBeGreaterThan(0);
    for (const c of dropped) expect(text).not.toContain(`QUOTE${c.number} `);
    // A comment the budget dropped entirely is nowhere in the text either.
    expect(text).not.toContain('NOTE200');
  });

  it('publishes every counter it returns, so the call is not rejected -32602', async () => {
    const { client, ctx } = await harness();
    seed(ctx, 200);

    const { listing } = await list(client);
    await expectNoUndeclaredKeys(client, 'list_comments', listing);

    expect(listing.commentsOmitted).toBeTypeOf('number');
    expect(listing.quotesOmitted).toBeTypeOf('number');
    expect(listing.snippetsOmitted).toBeTypeOf('number');
    expect(listing.truncated).toBe(true);
    expect(listing.budgetNote).toBeTypeOf('string');
  });

  it('leaves an ordinary three-comment listing exactly as it was', async () => {
    const { client, ctx } = await harness();
    ctx.comments.add('doc', {
      page: 1,
      x: 1,
      y: 2,
      note: 'tighten this',
      quote: 'The opening line',
      file: 'main.tex',
      line: 4,
    });
    ctx.comments.add('doc', { page: 2, x: 1, y: 2, note: 'citation missing' });

    const { listing, text } = await list(client);

    expect(listing.truncated).toBe(false);
    expect(listing.budgetNote).toBeUndefined();
    expect(listing.commentsOmitted).toBe(0);
    expect(listing.quotesOmitted).toBe(0);
    expect(listing.snippetsOmitted).toBe(0);
    expect(listing.comments[0]!.snippet).toBeTypeOf('string');
    expect(listing.comments[0]!.quote).toBe('The opening line');
    // A comment the user selected no text for: absent quote, and no counter claiming a cut.
    expect(listing.comments[1]!.quote).toBeUndefined();
    expect(listing.comments[1]!.quoteOmittedChars).toBeUndefined();
    expect(text).toContain('#1 [');
    expect(text).not.toContain('chars cut');
    await expectNoUndeclaredKeys(client, 'list_comments', listing);
  });

  it('never resurrects a location the unopenable-path guard withheld', async () => {
    // The budget runs after the guard and only removes fields. A comment whose synctex path leaves
    // the project comes back with no file/line/snippet — and no snippetOmittedChars either, which
    // would be a claim that a snippet existed and was cut for size.
    const { client, ctx, userDir } = await harness();
    const outside = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ovl-cmtbudget-out-')));
    cleanups.push(() => rm(outside, { recursive: true, force: true }));
    await writeFile(path.join(outside, 'secret.tex'), source(20), 'utf8');
    await symlink(path.join(outside, 'secret.tex'), path.join(userDir, 'linked.tex'));
    ctx.comments.add('doc', {
      page: 1,
      x: 1,
      y: 2,
      note: 'this one points out of the project',
      file: 'linked.tex',
      line: 3,
    });
    seed(ctx, 50);

    const { listing, wire } = await list(client);
    const escaped = listing.comments.find((c) => c.note.startsWith('this one points'))!;

    // Both halves matter, and only together: the result is bounded (which is what fails on the
    // pre-fix tool) AND the withheld location stays withheld under that bound.
    expect(wire).toBeLessThanOrEqual(COMMENTS_CONTENT_BUDGET);
    expect(listing.snippetsOmitted).toBeGreaterThan(0);
    expect(escaped.file).toBeUndefined();
    expect(escaped.line).toBeUndefined();
    expect(escaped.snippet).toBeUndefined();
    expect(escaped.snippetOmittedChars).toBeUndefined();
  });
});
