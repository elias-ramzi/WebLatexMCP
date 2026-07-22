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

  it('omits instructions and the resource when no guide is present', async () => {
    const client = await connect(undefined);

    expect(client.getInstructions()).toBeUndefined();
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
});
