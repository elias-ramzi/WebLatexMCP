import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { WRITING_GUIDE_URI } from '../../src/resources/writingGuide.js';
import { CONCURRENCY_GUIDE_URI } from '../../src/resources/concurrencyGuide.js';
import type { AppContext } from '../../src/context.js';
import type { Skill } from '../../src/lib/skills.js';

// Tool/resource registration never touches the context (handlers do, lazily), so an
// empty stand-in is enough to exercise the server's initialization surface.
const fakeCtx = {} as unknown as AppContext;

async function connect(
  guide?: string,
  concurrencyGuide?: string,
  skills?: Skill[],
): Promise<Client> {
  const server = createServer(fakeCtx, guide, concurrencyGuide, skills);
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

  it('registers the register_project tool', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('register_project');
    await client.close();
  });
});

describe('createServer skill prompts', () => {
  const skills: Skill[] = [
    { name: 'verify-citations', description: 'Audit the .bib against DBLP.', body: 'STEP ONE' },
    { name: 'summarize-paper', description: 'Write a local summary.', body: 'STEP TWO' },
  ];

  it('advertises each skill as a prompt carrying its description', async () => {
    const client = await connect(undefined, undefined, skills);
    expect(client.getServerCapabilities()?.prompts).toBeDefined();

    const listed = (await client.listPrompts()).prompts;
    expect(listed.map((p) => p.name)).toEqual(['verify-citations', 'summarize-paper']);
    expect(listed[0]?.description).toBe('Audit the .bib against DBLP.');
    expect(listed[0]?.arguments?.map((a) => a.name)).toEqual(['project']);
    expect(listed[0]?.arguments?.[0]?.required).toBe(false);

    await client.close();
  });

  it('returns the skill body, scoped to the project argument', async () => {
    const client = await connect(undefined, undefined, skills);

    const scoped = await client.getPrompt({
      name: 'verify-citations',
      arguments: { project: 'pictura' },
    });
    const message = scoped.messages[0];
    expect(message?.role).toBe('user');
    const text = message && 'text' in message.content ? message.content.text : undefined;
    expect(text).toContain('STEP ONE');
    expect(text).toContain('`pictura`');

    const unscoped = await client.getPrompt({ name: 'summarize-paper', arguments: {} });
    const plain = unscoped.messages[0];
    const plainText = plain && 'text' in plain.content ? plain.content.text : undefined;
    expect(plainText).toContain('STEP TWO');
    expect(plainText).toContain('Ask which project');

    await client.close();
  });

  it('advertises no prompts when no skills were loaded', async () => {
    const client = await connect();
    expect(client.getServerCapabilities()?.prompts).toBeUndefined();
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
