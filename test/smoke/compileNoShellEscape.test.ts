import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { LatexmkCompiler, buildDir, buildRoot } from '../../src/services/compiler.js';
import type { ServerConfig } from '../../src/types.js';

/*
 * #213 against real TeX: TeX Live's texmf.cnf sets `shell_escape = p`, so a compile that passed no
 * flag could run the restricted allow-list — `makeindex -o sections/a.tex` truncated a source file
 * in a compile the caller never opted into. Every latexmk compile now passes -no-shell-escape
 * unless the caller opts in, and the result says which switch brings the command back.
 * #215 rides along: the build root this real compile used is private to this user.
 */

const compiler = new LatexmkCompiler();
const available = await compiler.isAvailable();

describe.skipIf(!available)('a plain compile runs no shell command (#213)', () => {
  const cleanups: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  it('refuses the allow-listed makeindex a plain compile used to run, and says how to opt in', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'noesc-smoke-ws-'));
    const userDir = await mkdtemp(path.join(os.tmpdir(), 'noesc-smoke-src-'));
    cleanups.push(
      () => rm(workspace, { recursive: true, force: true }),
      () => rm(userDir, { recursive: true, force: true }),
      () => rm(buildDir(userDir), { recursive: true, force: true }),
    );
    const A = 'Section A, which no compile may overwrite.\n';
    await mkdir(path.join(userDir, 'sections'));
    await writeFile(path.join(userDir, 'sections', 'a.tex'), A);
    await writeFile(path.join(userDir, 'sections', 'b.tex'), 'Section B.\n');
    await writeFile(
      path.join(userDir, 'main.tex'),
      '\\documentclass{article}\n\\begin{document}\n' +
        // makeindex is on TeX Live's restricted allow-list; its -o writes relative to the
        // engine's cwd, which is the project.
        '\\immediate\\write18{makeindex -q -o sections/a.tex sections/b.tex}\n' +
        'Hello.\n\\end{document}\n',
    );
    const config: ServerConfig = {
      workspaceRoot: workspace,
      sessionId: 'test',
      projects: [{ id: 'esc', mode: 'local', path: userDir, rootFile: 'main.tex' }],
      defaultProject: 'esc',
    };
    const ctx = createContext(config, new CredentialResolver({}), {
      name: 'Test',
      email: 'test@example.com',
    });
    const server = createServer(ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(() => client.close());

    const res = await client.callTool({ name: 'compile', arguments: {} }, undefined, {
      timeout: 240_000,
    });
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
    const out = res.structuredContent as { success: boolean; hint?: string; logPath?: string };
    // The source first: it is the promise.
    expect(await readFile(path.join(userDir, 'sections', 'a.tex'), 'utf8')).toBe(A);
    const log = await readFile(out.logPath ?? '', 'utf8');
    expect(log).toMatch(/runsystem\(makeindex[^)]*\)\.\.\.disabled/);
    expect(out.hint ?? '').toContain('Retry with restrictedShellEscape: true');
    if (process.platform !== 'win32') {
      expect((await stat(buildRoot())).mode & 0o777).toBe(0o700);
    }
  }, 300_000);
});
