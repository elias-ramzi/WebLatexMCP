import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, readFile, symlink, lstat } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import { createFakeRemote, type FakeRemote } from './helpers/bareRepo.js';
import type { ServerConfig } from '../../src/types.js';

// A symlink INSIDE a project, `figures/x.png -> ../refs.bib`, passes assertNoSymlinkEscape (it
// never leaves the project) and its own name is not a .bib — so write_file/edit_file (whose guard
// is the literal isBibFile(relPath) check) and add_asset (whose destination allowlist also judges
// the name) would change refs.bib with no confirmBibEdit. These tests prove the guard now follows
// the link to where it actually lands.
//
// delete_file is the deliberate exception: FileService.delete ends in rm(abs), which unlinks the
// symlink itself and never touches refs.bib at the far end, so delete_file has no linkTarget
// check — only the literal isBibFile(relPath) guard, same as before. Refusing a stale/dangling
// link a collaborator committed would just block removing the link, while confirmBibEdit: true
// would "approve" a bibliography change that never actually happens.

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0xfd]);

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function isError(res: unknown): boolean {
  return (res as { isError?: boolean }).isError === true;
}

function plainText(res: unknown): string {
  const content = (res as { content?: Array<{ text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? '').join('\n');
}

async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function setupProject(): Promise<{ client: Client; remote: FakeRemote; clone: string }> {
  const remote = await createFakeRemote({
    'main.tex': '\\documentclass{article}\n',
    'refs.bib': '@misc{a, title={A}}\n',
    'real.png': 'not really a png, just seed content\n',
  });
  cleanups.push(remote.cleanup);
  const workspace = await tmp('ovl-biblink-ws-');
  const config: ServerConfig = {
    workspaceRoot: workspace,
    sessionId: 'test',
    projects: [{ id: 'demo', gitUrl: remote.url }],
    defaultProject: 'demo',
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
  cleanups.push(() => client.close());
  await client.callTool({ name: 'project_sync', arguments: { project: 'demo', mode: 'clone' } });

  const clone = path.join(workspace, 'demo');
  await mkdir(path.join(clone, 'figures'), { recursive: true });
  // Created directly in the clone (not committed) so the test stays git-agnostic across
  // platforms — CLAUDE.md notes git itself stores a symlink as mode 120000, which is the real
  // route a collaborator's commit would take, but the effect on FileService is identical either
  // way: what matters here is a symlink sitting in the working tree.
  await symlink(path.join('..', 'refs.bib'), path.join(clone, 'figures', 'x.png'));
  await symlink(path.join('..', 'real.png'), path.join(clone, 'figures', 'y.png'));

  return { client, remote, clone };
}

describe('the .bib guard follows a symlink to where it actually lands', () => {
  it('write_file refuses a symlink into refs.bib without confirmBibEdit, naming the target', async () => {
    const { client, clone } = await setupProject();
    const res = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'figures/x.png', content: 'PWNED' },
    });
    expect(isError(res)).toBe(true);
    expect(plainText(res)).toMatch(/is a link to "refs\.bib"/);
    // Nothing was written through the link.
    expect(await readFile(path.join(clone, 'refs.bib'), 'utf8')).toContain('@misc{a');
  });

  it('write_file succeeds through the link once confirmBibEdit: true is given', async () => {
    const { client, clone } = await setupProject();
    const res = await client.callTool({
      name: 'write_file',
      arguments: {
        project: 'demo',
        path: 'figures/x.png',
        content: '@misc{a, title={Edited}}\n',
        confirmBibEdit: true,
      },
    });
    expect(isError(res)).toBe(false);
    expect(await readFile(path.join(clone, 'refs.bib'), 'utf8')).toBe('@misc{a, title={Edited}}\n');
  });

  it('edit_file refuses the same link without confirmBibEdit', async () => {
    const { client } = await setupProject();
    const res = await client.callTool({
      name: 'edit_file',
      arguments: {
        project: 'demo',
        path: 'figures/x.png',
        edits: [{ oldString: 'A', newString: 'B' }],
      },
    });
    expect(isError(res)).toBe(true);
    expect(plainText(res)).toMatch(/is a link to "refs\.bib"/);
  });

  it('delete_file removes only the link, without confirmBibEdit, leaving refs.bib untouched', async () => {
    // delete_file has no linkTarget check (see the file-level comment above): FileService.delete
    // unlinks the symlink itself, so refs.bib at the far end is never touched — there is nothing
    // for confirmBibEdit to gate.
    const { client, clone } = await setupProject();
    const res = await client.callTool({
      name: 'delete_file',
      arguments: { project: 'demo', path: 'figures/x.png' },
    });
    expect(isError(res)).toBe(false);
    // The link itself is gone...
    await expect(lstat(path.join(clone, 'figures', 'x.png'))).rejects.toThrow();
    // ...but refs.bib survives, with its content unchanged.
    expect(await readFile(path.join(clone, 'refs.bib'), 'utf8')).toBe('@misc{a, title={A}}\n');
  });

  it('add_asset refuses writing through a link to refs.bib', async () => {
    const { client, clone } = await setupProject();
    const res = await client.callTool({
      name: 'add_asset',
      arguments: {
        project: 'demo',
        path: 'figures/x.png',
        contentBase64: PNG.toString('base64'),
      },
    });
    expect(isError(res)).toBe(true);
    expect(plainText(res)).toMatch(/link to "refs\.bib"/);
    expect(await readFile(path.join(clone, 'refs.bib'), 'utf8')).toContain('@misc{a');
  });

  it('add_asset is NOT refused by the link check for a link to another in-project asset (control)', async () => {
    const { client, clone } = await setupProject();
    const res = await client.callTool({
      name: 'add_asset',
      arguments: {
        project: 'demo',
        path: 'figures/y.png',
        contentBase64: PNG.toString('base64'),
      },
    });
    expect(isError(res)).toBe(false);
    expect(Buffer.compare(await readFile(path.join(clone, 'real.png')), PNG)).toBe(0);
  });
});
