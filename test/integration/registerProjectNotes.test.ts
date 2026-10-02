import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext, type AppContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import type { ServerConfig } from '../../src/types.js';
import { quoteId } from '../../src/lib/projectId.js';
import { toPosix } from '../../src/lib/paths.js';
import { createFakeRemote } from './helpers/bareRepo.js';

/**
 * What `register_project`'s messages say about a registration: the fields a re-registration
 * dropped reach the caller even when the clone after it fails, and a file name off the caller's
 * disk is quoted and escaped before it reaches the result text.
 */

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup(
  workspaceName = 'ws',
): Promise<{ ctx: AppContext; client: Client; root: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wlm-regnotes-'));
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const workspace = path.join(root, workspaceName);
  await mkdir(workspace);
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
  return { ctx, client, root };
}

function textOf(res: unknown): string {
  const content = (res as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? '').join('\n');
}

describe('register_project { gitUrl } whose clone fails', () => {
  it('still names the fields the persisted re-registration dropped', async () => {
    const remote = await createFakeRemote({ 'paper.tex': 'alpha\n' });
    cleanups.push(remote.cleanup);
    const { ctx, client, root } = await setup();

    const first = await client.callTool({
      name: 'register_project',
      arguments: { project: 'paper', gitUrl: remote.url, rootFile: 'paper.tex', clone: false },
    });
    expect(first.isError, textOf(first)).toBeFalsy();

    // A typo'd URL with no rootFile: the replacement is persisted before the clone runs, so the
    // clone's failure is the only place the loss can be reported — a retry finds nothing to drop.
    const typo = pathToFileURL(path.join(root, 'no-such-repo.git')).href;
    const res = await client.callTool({
      name: 'register_project',
      arguments: { project: 'paper', gitUrl: typo, clone: true },
    });
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toContain('Replaced the previous configuration of "paper"');
    expect(text).toContain('rootFile="paper.tex"');
    expect(ctx.projectManager.registeredRootFile('paper')).toBeUndefined();

    const retry = await client.callTool({
      name: 'register_project',
      arguments: { project: 'paper', gitUrl: typo, clone: true },
    });
    expect(retry.isError).toBe(true);
    expect(textOf(retry)).not.toContain('rootFile=');
  });
});

describe('register_project { path } pointed at a file', () => {
  /** Register a local project by pointing at `name` inside a fresh directory. */
  async function pointAt(name: string, rootFile?: string): Promise<string> {
    const { client, root } = await setup();
    const dir = path.join(root, 'draft');
    await mkdir(dir);
    await writeFile(path.join(dir, name), '\\documentclass{article}\n');
    const res = await client.callTool({
      name: 'register_project',
      arguments: {
        project: 'draft',
        path: path.join(dir, name),
        ...(rootFile ? { rootFile } : {}),
      },
    });
    expect(res.isError, textOf(res)).toBeFalsy();
    return textOf(res);
  }

  it('quotes and escapes the file name and the LaTeX root it inferred', async () => {
    const text = await pointAt('ma\u202Ein.tex');
    expect(text).not.toContain('\u202E');
    expect(text).toContain('Pointed at "ma\\u{202E}in.tex", so registered the folder holding it.');
    expect(text).toContain('LaTeX root: "ma\\u{202E}in.tex".');
  });

  it('names the root it registered: an explicit rootFile over the file pointed at', async () => {
    const text = await pointAt('chapter.tex', 'main.tex');
    expect(text).toContain('Pointed at "chapter.tex"');
    expect(text).toContain('LaTeX root: "main.tex".');
  });

  // Windows refuses a newline in a file name.
  it.skipIf(process.platform === 'win32')(
    'never lets a newline in the file name break the message',
    async () => {
      const text = await pointAt('notes\nForged line.md');
      expect(text).toContain('Pointed at "notes\\u{A}Forged line.md"');
      expect(text).not.toMatch(/\nForged line/);
    },
  );
});

/**
 * Every path and URL `register_project` echoes is the caller's (or under a workspace the
 * environment named), so a bidi override or a newline in one is escaped, never written raw.
 * Windows refuses a newline in a file name, so there only the override is used.
 */
const FORGE = process.platform === 'win32' ? '\u202E' : '\u202E\nForged line';

describe('register_project quotes the paths and URLs it echoes', () => {
  function expectNothingRaw(text: string): void {
    expect(text).not.toContain('\u202E');
    expect(text).not.toMatch(/\nForged line/);
  }

  it('a local directory', async () => {
    const { client, root } = await setup();
    const dir = path.join(root, `draft${FORGE}`);
    await mkdir(dir);
    const res = await client.callTool({
      name: 'register_project',
      arguments: { project: 'draft', path: dir },
    });
    expect(res.isError, textOf(res)).toBeFalsy();
    const text = textOf(res);
    expectNothingRaw(text);
    expect(text).toContain(`Registered "draft" -> ${quoteId(toPosix(dir))} (local`);
  });

  it('a path that does not exist', async () => {
    const { client, root } = await setup();
    const missing = path.join(root, `gone${FORGE}`);
    const res = await client.callTool({
      name: 'register_project',
      arguments: { project: 'draft', path: missing },
    });
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expectNothingRaw(text);
    expect(text).toContain(`No such file or directory: ${quoteId(toPosix(missing))}.`);
  });

  it('a git URL', async () => {
    const { client } = await setup();
    const url = `https://example.invalid/pa${FORGE}per.git`;
    const res = await client.callTool({
      name: 'register_project',
      arguments: { project: 'paper', gitUrl: url, clone: false },
    });
    expect(res.isError, textOf(res)).toBeFalsy();
    const text = textOf(res);
    expectNothingRaw(text);
    expect(text).toContain(`Registered "paper" -> ${quoteId(url)} (persisted`);
  });

  it('the clone directory, under a workspace whose name carries them', async () => {
    const remote = await createFakeRemote({ 'paper.tex': 'alpha\n' });
    cleanups.push(remote.cleanup);
    const { ctx, client } = await setup(`ws${FORGE}`);
    const res = await client.callTool({
      name: 'register_project',
      arguments: { project: 'paper', gitUrl: remote.url },
    });
    expect(res.isError, textOf(res)).toBeFalsy();
    const text = textOf(res);
    expectNothingRaw(text);
    expect(text).toContain(
      `Cloned at ${quoteId(toPosix(ctx.projectManager.projectPath('paper')))}.`,
    );
  });
});
