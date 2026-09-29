import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * #222 end to end: a `.bib` carrying a bare `\makeatletter` / `\@ifundefined{theHchapter}{…}{}` /
 * `\makeatother` block outside `@preamble` made `check_citations` list `theHchapter` among the
 * uncited entries — a reference that does not exist. A local project, so no git is involved.
 */

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

describe('check_citations: a TeX control sequence in a .bib is not an entry', () => {
  it('does not report \\@ifundefined{theHchapter} as an uncited entry', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-cs-ws-'));
    const userDir = await mkdtemp(path.join(os.tmpdir(), 'ovl-cs-dir-'));
    cleanups.push(
      () => rm(workspace, { recursive: true, force: true }),
      () => rm(userDir, { recursive: true, force: true }),
    );
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

    await writeFile(
      path.join(userDir, 'main.tex'),
      '\\documentclass{article}\n\\begin{document}\nSee \\cite{a1}.\n' +
        '\\bibliography{refs}\n\\end{document}\n',
    );
    await writeFile(
      path.join(userDir, 'refs.bib'),
      '\\makeatletter\n\\@ifundefined{theHchapter}{\\def\\theHchapter{\\arabic{chapter}}}{}\n' +
        '\\makeatother\n\n@article{a1,\n  title = {A Title},\n  year = {2020}\n}\n' +
        '@article{b2,\n  title = {Another},\n  year = {2021}\n}\n',
    );
    await client.callTool({ name: 'register_project', arguments: { project: 'p', path: userDir } });

    const res = await client.callTool({ name: 'check_citations', arguments: { project: 'p' } });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { uncitedEntries: Array<{ key: string }> };
    // b2 proves the uncited list is populated at all; theHchapter must not be in it.
    expect(sc.uncitedEntries.map((e) => e.key)).toEqual(['b2']);
  });
});
