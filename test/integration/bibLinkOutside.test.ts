import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, readFile, writeFile, symlink, realpath } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import { toPosix } from '../../src/lib/paths.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * `bibLinkGuard.test.ts` covers a symlink that lands on a .bib *inside* the same (git) project.
 * This is the other shape `FileService.linkTarget` supports: a local (`mode: 'local'`) project
 * registered with `followSymlinks: true`, whose link leaves the project directory entirely and
 * lands on a `refs.bib` elsewhere on disk — the shared-bibliography layout `followSymlinks`
 * exists for (see CLAUDE.md and `localProject.test.ts`). `linkTarget` returns the *absolute*
 * POSIX path in that case (there is no project-relative name to give it), and `write_file` must
 * still refuse it under `bibEditBlockedMessage` unless `confirmBibEdit: true`. This is a coverage
 * addition: it passes on current code, proving the guard already follows an outside-landing link,
 * not just an inside one.
 */

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
  // Realpath'd so macOS's /tmp -> /private/tmp symlink (and similar) doesn't itself get counted
  // as "leaving the project" or change which string the guard reports.
  return realpath(dir);
}

async function setup(): Promise<{ client: Client; userDir: string; outsideBib: string }> {
  const workspace = await tmp('ovl-bibout-ws-');
  const userDir = await tmp('ovl-bibout-user-');
  const outside = await tmp('ovl-bibout-outside-');

  const outsideBib = path.join(outside, 'refs.bib');
  await writeFile(outsideBib, '@misc{a, title={Shared}}\n', 'utf8');
  await mkdir(path.join(userDir, 'figures'), { recursive: true });
  await symlink(outsideBib, path.join(userDir, 'figures', 'x.png'));

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

  await client.callTool({
    name: 'register_project',
    arguments: { project: 'cv', path: userDir, followSymlinks: true },
  });

  return { client, userDir, outsideBib };
}

describe('the .bib guard follows a link that leaves a local (followSymlinks) project', () => {
  it('write_file refuses without confirmBibEdit, naming the outside target', async () => {
    const { client, outsideBib } = await setup();

    const res = await client.callTool({
      name: 'write_file',
      arguments: { project: 'cv', path: 'figures/x.png', content: 'PWNED' },
    });
    expect(isError(res)).toBe(true);
    const text = plainText(res);
    expect(text).toContain('is a link to');
    expect(text).toContain(toPosix(outsideBib));
    // Nothing was written through the link.
    expect(await readFile(outsideBib, 'utf8')).toBe('@misc{a, title={Shared}}\n');
  });

  it('write_file succeeds through the link once confirmBibEdit: true is given', async () => {
    const { client, outsideBib } = await setup();

    const res = await client.callTool({
      name: 'write_file',
      arguments: {
        project: 'cv',
        path: 'figures/x.png',
        content: '@misc{a, title={Edited}}\n',
        confirmBibEdit: true,
      },
    });
    expect(isError(res)).toBe(false);
    expect(await readFile(outsideBib, 'utf8')).toBe('@misc{a, title={Edited}}\n');
  });
});
