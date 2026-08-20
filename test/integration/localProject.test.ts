import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry, readProjectRegistry } from '../../src/services/projectRegistry.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * A project the user already has on disk — a `.tex` inside a repo of their own, which is the case
 * that used to force registering the *whole surrounding repo* as a git project and left two copies
 * of the document to drift apart.
 */
const CV = ['\\documentclass{article}', '\\begin{document}', 'Elias', '\\end{document}', ''].join(
  '\n',
);

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

interface Harness {
  client: Client;
  workspace: string;
  userDir: string;
}

async function setup(): Promise<Harness> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-localws-'));
  const userDir = await mkdtemp(path.join(os.tmpdir(), 'ovl-userdir-'));
  cleanups.push(
    () => rm(workspace, { recursive: true, force: true }),
    () => rm(userDir, { recursive: true, force: true }),
  );
  // A dot-directory, like the .claude/context/ case this came from.
  await mkdir(path.join(userDir, '.context'), { recursive: true });
  await writeFile(path.join(userDir, '.context', 'resume.tex'), CV);

  const config: ServerConfig = { workspaceRoot: workspace, sessionId: 'test', projects: [] };
  const ctx = createContext(
    config,
    new CredentialResolver({}),
    {
      name: 'Test',
      email: 'test@example.com',
    },
    new ProjectRegistry(workspace),
  );
  const server = createServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(() => client.close());
  return { client, workspace, userDir };
}

/** Tool text, the way the other integration tests read it (the SDK result type is a union). */
function textOf(res: unknown): string {
  return JSON.stringify((res as { content?: unknown }).content ?? '');
}

describe('local (in-place) projects', () => {
  it('registers a directory without cloning anything', async () => {
    const { client, workspace, userDir } = await setup();

    const res = await client.callTool({
      name: 'register_project',
      arguments: { project: 'cv', path: userDir },
    });
    const structured = res.structuredContent as Record<string, unknown>;
    expect(structured.mode).toBe('local');
    expect(structured.cloned).toBe(true);
    expect(structured.path).toBe(userDir.split(path.sep).join('/'));

    // The point of the whole mode: no second copy of the document anywhere.
    const inWorkspace = await readdir(workspace);
    expect(inWorkspace).not.toContain('cv');
    expect(textOf(res)).toContain('in place');

    // ...and it survives a restart, like any other registration.
    expect(readProjectRegistry(workspace)).toEqual([
      { id: 'cv', mode: 'local', path: userDir, rootFile: undefined },
    ]);
  });

  it('edits the user’s own file, in place', async () => {
    const { client, userDir } = await setup();
    await client.callTool({
      name: 'register_project',
      arguments: { project: 'cv', path: userDir },
    });

    const listed = await client.callTool({ name: 'list_files', arguments: { project: 'cv' } });
    expect(textOf(listed)).toContain('.context/resume.tex');

    const read = await client.callTool({
      name: 'read_file',
      arguments: { project: 'cv', path: '.context/resume.tex' },
    });
    expect(textOf(read)).toContain('Elias');

    const edited = await client.callTool({
      name: 'edit_file',
      arguments: {
        project: 'cv',
        path: '.context/resume.tex',
        edits: [{ oldString: 'Elias', newString: 'Elias Ramzi' }],
      },
    });
    expect(edited.isError).toBeFalsy();

    // The file the user has open in their editor is the file that changed.
    const onDisk = await readFile(path.join(userDir, '.context', 'resume.tex'), 'utf8');
    expect(onDisk).toContain('Elias Ramzi');
  });

  it('refuses to write outside the registered directory', async () => {
    const { client, userDir } = await setup();
    await client.callTool({
      name: 'register_project',
      arguments: { project: 'cv', path: userDir },
    });

    const res = await client.callTool({
      name: 'write_file',
      arguments: { project: 'cv', path: '../escaped.tex', content: 'nope' },
    });
    expect(res.isError).toBe(true);
  });

  it('refuses every git operation, and says what to do instead', async () => {
    const { client, userDir } = await setup();
    await client.callTool({
      name: 'register_project',
      arguments: { project: 'cv', path: userDir },
    });

    const gitCalls: Array<[string, Record<string, unknown>]> = [
      ['status', {}],
      ['diff', {}],
      ['commit', { message: 'nope' }],
      ['push', { confirm: true }],
      ['discard', { confirm: true }],
      ['project_sync', {}],
      ['reset_to_remote', { confirm: true }],
      ['read_file', { path: '.context/resume.tex', ref: 'origin/master' }],
    ];

    for (const [name, args] of gitCalls) {
      const res = await client.callTool({ name, arguments: { project: 'cv', ...args } });
      expect(res.isError, `${name} should refuse a local project`).toBe(true);
      expect(textOf(res), `${name} message`).toMatch(/local \(edited in place/);
    }
  });

  it('reports the mode in list_projects, alongside git projects', async () => {
    const { client, userDir } = await setup();
    await client.callTool({
      name: 'register_project',
      arguments: { project: 'cv', path: userDir },
    });
    await client.callTool({
      name: 'register_project',
      arguments: { project: 'thesis', gitUrl: 'https://git.example/thesis', clone: false },
    });

    const res = await client.callTool({ name: 'list_projects', arguments: {} });
    const { projects } = res.structuredContent as {
      projects: Array<Record<string, unknown>>;
    };
    expect(projects.find((p) => p.project === 'cv')).toMatchObject({
      mode: 'local',
      cloned: true,
    });
    expect(projects.find((p) => p.project === 'thesis')).toMatchObject({
      mode: 'git',
      gitUrl: 'https://git.example/thesis',
      cloned: false,
    });
    expect(textOf(res)).toContain('[local, in place]');
  });

  it('rejects a registration that is ambiguous, empty, or points nowhere', async () => {
    const { client, userDir } = await setup();

    const both = await client.callTool({
      name: 'register_project',
      arguments: { project: 'x', path: userDir, gitUrl: 'https://git.example/x' },
    });
    expect(both.isError).toBe(true);
    expect(textOf(both)).toMatch(/not both/);

    const neither = await client.callTool({
      name: 'register_project',
      arguments: { project: 'x' },
    });
    expect(neither.isError).toBe(true);

    const missing = await client.callTool({
      name: 'register_project',
      arguments: { project: 'x', path: path.join(userDir, 'does-not-exist') },
    });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toMatch(/No such directory/);

    const notADir = await client.callTool({
      name: 'register_project',
      arguments: { project: 'x', path: path.join(userDir, '.context', 'resume.tex') },
    });
    expect(notADir.isError).toBe(true);
    expect(textOf(notADir)).toMatch(/is a file, not a directory/);
  });
});
