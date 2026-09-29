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
import { collectOutcome, logBaseDir } from '../../src/services/compiler.js';
import { CompilerResolver } from '../../src/services/compilerResolver.js';
import { expectNoUndeclaredKeys } from '../helpers/outputSchema.js';
import type { CompileOutcome, CompileRequest } from '../../src/services/compiler.js';
import type { ExecResult } from '../../src/lib/exec.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * The compile tool when the engine latexmk shells out to is not installed. The stub stands in for
 * latexmk's exec only: its canned output goes through the real `collectOutcome` against a real
 * temp build dir, exactly as `LatexmkCompiler` hands it over, so everything from the outcome to
 * both result channels is the production path.
 */

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** What a real latexmk 4.67 run printed with `-pdfxe` on a machine without xelatex (trimmed). */
const NO_XELATEX: ExecResult = {
  code: 12,
  stdout:
    "Latexmk: applying rule 'xelatex'...\nLatexmk: Errors, so I did not complete making targets",
  stderr: [
    "Run number 1 of rule 'xelatex'",
    'Running \'xelatex -no-pdf -interaction=nonstopmode -file-line-error "main.tex"\'',
    'sh: 1: xelatex: not found',
    "  xelatex: Command for 'xelatex' gave return code 127",
    "   (Pdf)LaTeX didn't generate the expected log file '/tmp/b/main.log'",
  ].join('\n'),
  timedOut: false,
};

async function setup(opts: { staleLog?: string } = {}) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-noengine-ws-'));
  const userDir = await mkdtemp(path.join(os.tmpdir(), 'ovl-noengine-dir-'));
  const build = await mkdtemp(path.join(os.tmpdir(), 'ovl-noengine-build-'));
  cleanups.push(
    () => rm(workspace, { recursive: true, force: true }),
    () => rm(userDir, { recursive: true, force: true }),
    () => rm(build, { recursive: true, force: true }),
  );
  await writeFile(
    path.join(userDir, 'main.tex'),
    '\\documentclass{article}\n\\begin{document}\nhi \\nope\n\\end{document}\n',
  );
  if (opts.staleLog !== undefined) await writeFile(path.join(build, 'main.log'), opts.staleLog);

  const stub = {
    isAvailable: async () => true,
    compile: (req: CompileRequest): Promise<CompileOutcome> =>
      collectOutcome(build, req.rootFile, NO_XELATEX, 0.4, logBaseDir(req.rootFile), null, {
        detectMissingEngine: true,
      }),
  };
  const config: ServerConfig = {
    workspaceRoot: workspace,
    sessionId: 'test',
    projects: [{ id: 'doc', mode: 'local', path: userDir }],
  };
  const ctx = createContext(
    config,
    new CredentialResolver({}),
    { name: 'Test', email: 'test@example.com' },
    new ProjectRegistry(workspace),
  );
  ctx.compiler = new CompilerResolver('latexmk', false, () => stub);
  const server = createServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(() => client.close());
  return client;
}

function textOf(res: unknown): string {
  const content = (res as { content?: Array<{ text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? '').join('\n');
}

describe('compile: an engine latexmk could not run', () => {
  it('names the engine and the way out in hint and in the text, not just "0 error(s)"', async () => {
    const client = await setup();
    const res = await client.callTool({
      name: 'compile',
      arguments: { project: 'doc', engine: 'xelatex' },
    });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { success: boolean; errors: unknown[]; hint?: string };
    expect(sc.success).toBe(false);
    // Located nowhere: the message is a hint, never a fabricated error entry.
    expect(sc.errors).toEqual([]);
    expect(sc.hint).toMatch(/^The xelatex engine is not installed \(latexmk could not run it\)/);
    expect(sc.hint).toMatch(/engine: "pdflatex" or "lualatex"/);

    const text = textOf(res);
    expect(text).toMatch(/^FAILED main\.tex with latexmk in 0\.4s — 0 error\(s\), 0 warning\(s\)/);
    expect(text).toMatch(/\nhint: The xelatex engine is not installed/);
    // Fixed server text only: no captured output line is echoed into the hint.
    expect(sc.hint).not.toContain('sh: 1:');

    await expectNoUndeclaredKeys(client, 'compile', res.structuredContent);
  });

  it('still says so when the build dir holds a clean .log from an earlier run', async () => {
    const client = await setup({
      staleLog: 'This is pdfTeX\nOutput written on main.pdf (1 page, 1000 bytes).\n',
    });
    const res = await client.callTool({
      name: 'compile',
      arguments: { project: 'doc', engine: 'xelatex' },
    });
    expect((res.structuredContent as { hint?: string }).hint).toMatch(
      /The xelatex engine is not installed/,
    );
  });

  it('never masks an error the log does name', async () => {
    const client = await setup({
      staleLog: './main.tex:3: Undefined control sequence.\nl.3 hi \\nope\n',
    });
    const res = await client.callTool({
      name: 'compile',
      arguments: { project: 'doc', engine: 'xelatex' },
    });
    const sc = res.structuredContent as { errors: unknown[]; hint?: string };
    expect(sc.errors).toHaveLength(1);
    expect(sc.hint ?? '').not.toMatch(/engine is not installed/);
    expect(textOf(res)).not.toMatch(/engine is not installed/);
  });
});
