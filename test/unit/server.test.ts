import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { WRITING_GUIDE_URI } from '../../src/resources/writingGuide.js';
import { CONCURRENCY_GUIDE_URI } from '../../src/resources/concurrencyGuide.js';
import type { AppContext } from '../../src/context.js';

// Tool/resource registration never touches the context (handlers do, lazily), so an
// empty stand-in is enough to exercise the server's initialization surface.
const fakeCtx = {} as unknown as AppContext;

async function connect(guide?: string, concurrencyGuide?: string): Promise<Client> {
  const server = createServer(fakeCtx, guide, concurrencyGuide);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('createServer writing guide', () => {
  it('advertises the guide as instructions and a fetchable resource', async () => {
    const guide = '# Guide\n\nUse the present tense.';
    const client = await connect(guide);

    expect(client.getInstructions()).toContain('Use the present tense.');
    expect(client.getServerCapabilities()?.resources).toBeDefined();

    const { resources } = await client.listResources();
    const entry = resources.find((r) => r.uri === WRITING_GUIDE_URI);
    expect(entry).toBeDefined();
    expect(entry?.mimeType).toBe('text/markdown');

    const read = await client.readResource({ uri: WRITING_GUIDE_URI });
    const content = read.contents[0];
    expect(content?.mimeType).toBe('text/markdown');
    expect(content && 'text' in content ? content.text : undefined).toBe(guide);

    await client.close();
  });

  it('always advertises the PDF-comment workflow, even with no guide', async () => {
    const client = await connect(undefined);

    // Instructions are always present (the comment workflow), but carry no guide text or resource.
    const instructions = client.getInstructions();
    expect(instructions).toContain('list_comments');
    expect(instructions).toContain('resolve_comments');
    expect(instructions).not.toContain('present tense');
    expect(client.getServerCapabilities()?.resources).toBeUndefined();

    await client.close();
  });

  it('advertises the concurrency guide as instructions and a fetchable resource', async () => {
    const writing = '# Writing\n\nUse the present tense.';
    const concurrency = '# Concurrency\n\nAlways pull-rebase before pushing.';
    const client = await connect(writing, concurrency);

    const instructions = client.getInstructions();
    expect(instructions).toContain('Use the present tense.');
    expect(instructions).toContain('Always pull-rebase before pushing.');

    const { resources } = await client.listResources();
    expect(resources.find((r) => r.uri === WRITING_GUIDE_URI)).toBeDefined();
    expect(resources.find((r) => r.uri === CONCURRENCY_GUIDE_URI)).toBeDefined();

    const read = await client.readResource({ uri: CONCURRENCY_GUIDE_URI });
    const content = read.contents[0];
    expect(content?.mimeType).toBe('text/markdown');
    expect(content && 'text' in content ? content.text : undefined).toBe(concurrency);

    await client.close();
  });
});

describe('createServer tool registration', () => {
  it('registers the citation tools', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('search_references');
    expect(names).toContain('add_citation');
    await client.close();
  });

  it('registers the reset_to_remote recovery tool', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('reset_to_remote');
    await client.close();
  });

  it('registers the viewer tool', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('viewer');
    await client.close();
  });

  it('registers the comment tools', async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('list_comments');
    expect(names).toContain('resolve_comments');
    await client.close();
  });

  it('registers the server_info tool', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('server_info');
    await client.close();
  });
});

describe('server_info', () => {
  it('advertises the package version and reports runtime config', async () => {
    const ctx = {
      config: { workspaceRoot: '/tmp/ws', workspaceIsLocal: true, compiler: 'latexmk' },
    } as unknown as AppContext;
    const server = createServer(ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    // The server advertises a real version (read from package.json), not a placeholder.
    expect(client.getServerVersion()?.version).toMatch(/^\d+\.\d+\.\d+/);

    const res = await client.callTool({ name: 'server_info', arguments: {} });
    const structured = res.structuredContent as Record<string, unknown>;
    expect(structured.name).toBe('web-latex-mcp');
    expect(structured.version).toBe(client.getServerVersion()?.version);
    expect(structured.workspaceRoot).toBe('/tmp/ws');
    expect(structured.workspaceLocal).toBe(true);
    expect(structured.compiler).toBe('latexmk');

    await client.close();
  });
});
