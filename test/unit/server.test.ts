import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { WRITING_GUIDE_URI } from '../../src/resources/writingGuide.js';
import { CONCURRENCY_GUIDE_URI } from '../../src/resources/concurrencyGuide.js';
import { composeWritingGuide } from '../../src/lib/writingGuide.js';
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

  it('surfaces the SAME composed text (base + extra) to instructions AND the writing-guide resource', async () => {
    const { text: composed, hasExtra } = composeWritingGuide(
      '# Base guide\n\nUse the present tense.',
      'Write lidar, never LiDAR.',
    );
    expect(hasExtra).toBe(true);
    const server = createServer(fakeCtx, composed, undefined, undefined, hasExtra);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const instructions = client.getInstructions();
    expect(instructions).toContain('Write lidar, never LiDAR.');
    expect(instructions).toContain('Use the present tense.');

    const read = await client.readResource({ uri: WRITING_GUIDE_URI });
    const content = read.contents[0];
    const resourceText = content && 'text' in content ? content.text : undefined;
    expect(resourceText).toBe(composed);
    // The resource text must be a substring of instructions too (same string, not a re-derivation).
    expect(instructions).toContain(resourceText as string);

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
    expect(names).toContain('list_references');
    expect(names).toContain('check_citations');
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

  it('registers the set_credential tool', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('set_credential');
    await client.close();
  });

  it('registers the credential_portal tool', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('credential_portal');
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
      config: {
        workspaceRoot: '/tmp/ws',
        workspaceIsLocal: true,
        workspaceExcludePattern: '/.web_latex_mcp/',
        compiler: 'latexmk',
      },
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
    // The clone dir is already git-excluded; say so, or the caller adds a redundant .gitignore.
    expect(structured.workspaceExcludePattern).toBe('/.web_latex_mcp/');
    const text = (res.content as Array<{ text: string }>)[0]?.text ?? '';
    expect(text).toContain('/.web_latex_mcp/');
    expect(text).toContain('collaborators will not see it');

    await client.close();
  });

  it('omits the exclude line when nothing was excluded', async () => {
    const ctx = {
      config: { workspaceRoot: '/tmp/ws', workspaceIsLocal: false, compiler: 'latexmk' },
    } as unknown as AppContext;
    const server = createServer(ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const res = await client.callTool({ name: 'server_info', arguments: {} });
    expect(
      (res.structuredContent as Record<string, unknown>).workspaceExcludePattern,
    ).toBeUndefined();
    expect((res.content as Array<{ text: string }>)[0]?.text).not.toContain('.git/info/exclude');

    await client.close();
  });

  it('omits the extra writing guide fields when not configured', async () => {
    const ctx = {
      config: { workspaceRoot: '/tmp/ws', workspaceIsLocal: false, compiler: 'latexmk' },
    } as unknown as AppContext;
    const server = createServer(ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const res = await client.callTool({ name: 'server_info', arguments: {} });
    const structured = res.structuredContent as Record<string, unknown>;
    expect(structured.writingGuideExtraPath).toBeUndefined();
    expect(structured.writingGuideExtraLoaded).toBeUndefined();

    await client.close();
  });

  it('reports the extra writing guide path when configured and loaded', async () => {
    const ctx = {
      config: {
        workspaceRoot: '/tmp/ws',
        workspaceIsLocal: false,
        compiler: 'latexmk',
        extraWritingGuidePath: '/home/user/paper/conventions.md',
        extraWritingGuideLoaded: true,
      },
    } as unknown as AppContext;
    const server = createServer(ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const res = await client.callTool({ name: 'server_info', arguments: {} });
    const structured = res.structuredContent as Record<string, unknown>;
    expect(structured.writingGuideExtraPath).toBe('/home/user/paper/conventions.md');
    expect(structured.writingGuideExtraLoaded).toBe(true);
    const text = (res.content as Array<{ text: string }>)[0]?.text ?? '';
    expect(text).toContain('/home/user/paper/conventions.md');
    expect(text.toLowerCase()).toContain('loaded');

    await client.close();
  });

  it('reports the extra writing guide as NOT in effect when it failed to load', async () => {
    const ctx = {
      config: {
        workspaceRoot: '/tmp/ws',
        workspaceIsLocal: false,
        compiler: 'latexmk',
        extraWritingGuidePath: '/home/user/paper/conventions.md',
        extraWritingGuideLoaded: false,
      },
    } as unknown as AppContext;
    const server = createServer(ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const res = await client.callTool({ name: 'server_info', arguments: {} });
    const structured = res.structuredContent as Record<string, unknown>;
    expect(structured.writingGuideExtraPath).toBe('/home/user/paper/conventions.md');
    expect(structured.writingGuideExtraLoaded).toBe(false);
    const text = (res.content as Array<{ text: string }>)[0]?.text ?? '';
    expect(text).toContain('/home/user/paper/conventions.md');
    // The critical case: a user must be able to see that their conventions are NOT in effect.
    expect(text.toLowerCase()).toContain('not in effect');

    await client.close();
  });
});

describe('doctor', () => {
  it('renders the diagnosis, hints included, from an injected toolchain', async () => {
    const ctx = {
      config: { workspaceRoot: '/tmp/ws', compiler: 'latexmk' },
      credentials: { allSecrets: () => [] },
      doctor: {
        diagnose: () =>
          Promise.resolve({
            ok: true,
            engines: ['pdflatex'],
            checks: [
              { name: 'compiler', status: 'ok', detail: 'latexmk: Version 4.67' },
              { name: 'distribution', status: 'warn', detail: 'TeX Live 2019 — past end of life' },
            ],
            hints: ['Upgrade the TeX distribution.'],
          }),
      },
    } as unknown as AppContext;
    const server = createServer(ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    expect((await client.listTools()).tools.map((t) => t.name)).toContain('doctor');

    const res = await client.callTool({ name: 'doctor', arguments: {} });
    const structured = res.structuredContent as Record<string, unknown>;
    expect(structured.ok).toBe(true);
    expect(structured.engines).toEqual(['pdflatex']);
    const text = (res.content as Array<{ text: string }>)[0]?.text ?? '';
    expect(text).toContain('nothing missing, 1 warning(s)');
    expect(text).toContain('past end of life');
    expect(text).toContain('- Upgrade the TeX distribution.');

    await client.close();
  });
});

describe('list_skills', () => {
  const skills: Skill[] = [
    { name: 'verify-citations', description: 'Audit the .bib against DBLP.', body: 'STEP ONE' },
    { name: 'summarize-paper', description: 'Write a local summary.', body: 'STEP TWO' },
  ];

  it('lists every bundled skill with its description', async () => {
    const client = await connect(undefined, undefined, skills);

    const res = await client.callTool({ name: 'list_skills', arguments: {} });
    const structured = res.structuredContent as { skills: Array<Record<string, string>> };
    expect(structured.skills.map((s) => s.name)).toEqual(['verify-citations', 'summarize-paper']);
    expect(structured.skills[0]?.description).toBe('Audit the .bib against DBLP.');
    // The catalogue alone is useless without the way to fetch one, so the text carries it.
    expect((res.content as Array<{ text: string }>)[0]?.text).toContain('list_skills');
    // Listing is not fetching — no procedure comes back until one is asked for.
    expect((res.structuredContent as Record<string, unknown>).instructions).toBeUndefined();

    await client.close();
  });

  it('returns one skill in full, scoped to a project', async () => {
    const client = await connect(undefined, undefined, skills);

    const res = await client.callTool({
      name: 'list_skills',
      arguments: { skill: 'verify-citations', project: 'pictura' },
    });
    const instructions = (res.structuredContent as Record<string, string>).instructions ?? '';
    expect(instructions).toContain('STEP ONE');
    expect(instructions).toContain('`pictura`');
    expect((res.content as Array<{ text: string }>)[0]?.text).toBe(instructions);

    await client.close();
  });

  it('names the available skills when asked for one that does not exist', async () => {
    const client = await connect(undefined, undefined, skills);

    const res = await client.callTool({ name: 'list_skills', arguments: { skill: 'nope' } });
    expect(res.isError).toBe(true);
    const text = (res.content as Array<{ text: string }>)[0]?.text ?? '';
    expect(text).toContain('Unknown skill "nope"');
    expect(text).toContain('verify-citations, summarize-paper');

    await client.close();
  });

  it('is registered, and reports an empty catalogue, even with no skills bundled', async () => {
    const client = await connect();
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('list_skills');

    const res = await client.callTool({ name: 'list_skills', arguments: {} });
    expect((res.structuredContent as { skills: unknown[] }).skills).toEqual([]);
    expect((res.content as Array<{ text: string }>)[0]?.text).toContain('No skills are bundled');

    await client.close();
  });
});
