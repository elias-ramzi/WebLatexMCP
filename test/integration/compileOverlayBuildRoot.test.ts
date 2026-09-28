import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readdir, rm, symlink } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import { CompilerResolver } from '../../src/services/compilerResolver.js';
import { buildRoot } from '../../src/services/compiler.js';
import type { CompileOutcome } from '../../src/services/compiler.js';
import { createFakeRemote } from './helpers/bareRepo.js';
import type { ServerConfig } from '../../src/types.js';

/*
 * #215, the overlay route: the build root is judged BEFORE the overlay is applied, not merely
 * before the variant is staged. `applyOverlay` can write under the root on its own (the case probe
 * it runs for several entries creates `<root>/<proj>-<hash>/variants/` and a probe file there), so
 * a check placed after it let a planted root receive a project-named directory first.
 *
 * Observed through ordering: an overlay whose one edit cannot apply fails inside `applyOverlay`,
 * so the refusal the caller gets says which check ran first. `os.tmpdir()` reads TMPDIR on every
 * call (POSIX), so the build root moves into a private temp dir for this test only.
 */

const cleanups: Array<() => Promise<unknown>> = [];
const savedTmp = process.env.TMPDIR;
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  if (savedTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmp;
});

const MAIN_TEX = '\\documentclass{article}\n\\begin{document}\nHi.\n\\end{document}\n';

describe.skipIf(process.platform === 'win32')('compile overlay: planted build root (#215)', () => {
  it('is refused before the overlay is applied, and nothing lands in the planted target', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'wlm-overlay-root-'));
    cleanups.push(() => rm(tmp, { recursive: true, force: true }));
    process.env.TMPDIR = tmp;
    const remote = await createFakeRemote({ 'main.tex': MAIN_TEX });
    cleanups.push(remote.cleanup);
    const workspace = await mkdtemp(path.join(tmp, 'ws-'));
    const config: ServerConfig = {
      workspaceRoot: workspace,
      workspaceIsLocal: true,
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
    let ran = 0;
    ctx.compiler = new CompilerResolver('latexmk', true, () => ({
      isAvailable: async () => true,
      compile: async (): Promise<CompileOutcome> => {
        ran += 1;
        throw new Error('the backend must not run');
      },
    }));
    const server = createServer(ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(() => client.close());
    const sync = await client.callTool({
      name: 'project_sync',
      arguments: { project: 'demo', mode: 'clone' },
    });
    expect(sync.isError ?? false, JSON.stringify(sync.content)).toBe(false);

    // Another local user's directory, linked where this server's build root would be.
    expect(path.dirname(buildRoot())).toBe(tmp);
    const theirs = path.join(tmp, 'theirs');
    await mkdir(theirs, { mode: 0o777 });
    await symlink(theirs, buildRoot());

    const res = await client.callTool({
      name: 'compile',
      arguments: {
        overlay: [{ file: 'main.tex', edits: [{ oldString: 'NOT IN THE FILE', newString: 'x' }] }],
      },
    });
    expect(res.isError).toBe(true);
    const text = JSON.stringify(res.content);
    // The build-root refusal, not the overlay's own "not found": the root was judged first.
    expect(text).toContain('Refusing to build in');
    expect(text).toContain('symbolic link');
    expect(text).not.toMatch(/not found/i);
    expect(ran).toBe(0);
    expect(await readdir(theirs)).toEqual([]);
  });
});
