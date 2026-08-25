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
import { CompilerResolver } from '../../src/services/compilerResolver.js';
import type { CompileOutcome, LatexCompiler } from '../../src/services/compiler.js';
import type { CompilerKind, ServerConfig } from '../../src/types.js';

/**
 * The compile tool against backends that are not installed — the case a user hit on a machine with
 * tectonic and no latexmk, where `compile` died with a raw `spawn latexmk ENOENT` naming neither
 * WEB_LATEX_MCP_COMPILER nor the backend sitting on their PATH that would have worked.
 *
 * Everything but the binaries is real here — the tool, the resolver, the project manager, the
 * sandboxed FileService — so these pin what a caller actually sees. Which backends "exist" is
 * scripted per test, because the interesting machines are precisely the ones CI is not: this
 * suite must assert the latexmk-missing behaviour on a runner that has latexmk, and the
 * tectonic-present behaviour on one that has never heard of it. A TeX-gated smoke could not:
 * it would need both backends installed and would auto-skip on every machine the bug is about.
 */

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/**
 * Appends its own kind to `ran` when it compiles, so a test can prove which backend actually ran
 * rather than only what the selection *claimed*. Without that, returning the wrong compiler
 * instance alongside the right `kind` — which is the original bug, dressed up — passes silently.
 */
function stubBackend(
  kind: CompilerKind,
  installed: readonly CompilerKind[],
  ran: CompilerKind[],
  log = 'Output written on main.pdf (1 page).',
): LatexCompiler {
  return {
    isAvailable: async () => installed.includes(kind),
    compile: async (): Promise<CompileOutcome> => {
      ran.push(kind);
      return {
        success: true,
        durationSec: 0.1,
        log,
        timedOut: false,
        logBaseDir: '',
      };
    },
  };
}

async function setup(opts: {
  configured: CompilerKind;
  explicit: boolean;
  /** Which backends this machine "has". */
  installed: readonly CompilerKind[];
  /** Canned compile log, for tests about what the tool makes of one. */
  log?: string;
}) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-cfbws-'));
  const userDir = await mkdtemp(path.join(os.tmpdir(), 'ovl-cfbdir-'));
  cleanups.push(
    () => rm(workspace, { recursive: true, force: true }),
    () => rm(userDir, { recursive: true, force: true }),
  );
  await writeFile(
    path.join(userDir, 'main.tex'),
    '\\documentclass{article}\n\\begin{document}\nhi\n\\end{document}\n',
    'utf8',
  );

  const config: ServerConfig = {
    workspaceRoot: workspace,
    sessionId: 'test',
    projects: [{ id: 'doc', mode: 'local', path: userDir }],
    compiler: opts.configured,
    compilerExplicit: opts.explicit,
  };
  const ctx = createContext(
    config,
    new CredentialResolver({}),
    { name: 'Test', email: 'test@example.com' },
    new ProjectRegistry(workspace),
  );
  // The real resolver, over backends whose availability this test decides. `ran` records which
  // backend instance was actually handed the compile, which is the claim under test.
  const ran: CompilerKind[] = [];
  ctx.compiler = new CompilerResolver(opts.configured, opts.explicit, (kind) =>
    stubBackend(kind, opts.installed, ran, opts.log),
  );
  const server = createServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(() => client.close());
  return { client, ran };
}

function textOf(res: unknown): string {
  const content = (res as { content?: Array<{ text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? '').join('\n');
}

function structured(res: unknown): Record<string, unknown> {
  return ((res as { structuredContent?: Record<string, unknown> }).structuredContent ??
    {}) as Record<string, unknown>;
}

describe('compile: backend preflight and fallback', () => {
  it('substitutes an installed backend for a default that is missing, and says so', async () => {
    // The reporting user's machine exactly: tectonic on PATH, no latexmk, env var never set.
    const { client, ran } = await setup({
      configured: 'latexmk',
      explicit: false,
      installed: ['tectonic'],
    });

    const res = await client.callTool({ name: 'compile', arguments: { project: 'doc' } });

    expect(res.isError).toBeFalsy();
    expect(structured(res).compiler).toBe('tectonic');
    expect(structured(res).success).toBe(true);
    const text = textOf(res);
    // The substitution is reported, not silent — and in the *text*, for clients that drop
    // structuredContent entirely.
    expect(text).toMatch(/tectonic/);
    expect(text).toMatch(/WEB_LATEX_MCP_COMPILER/);
    // And it says what changes as a result, since tectonic yields no source snippets at all.
    expect(text).toMatch(/no source snippets/i);
    // The claim that matters: the tectonic *instance* did the compiling, not just the label.
    // Returning the configured backend under the substitute's name is the original bug in
    // disguise — a green result announcing tectonic while latexmk spawns and ENOENTs.
    expect(ran).toEqual(['tectonic']);
  });

  it('refuses to substitute for an explicitly chosen backend, and names the way forward', async () => {
    // Just outside the guard: identical machine, but the user *asserted* latexmk.
    const { client, ran } = await setup({
      configured: 'latexmk',
      explicit: true,
      installed: ['tectonic'],
    });

    const res = await client.callTool({ name: 'compile', arguments: { project: 'doc' } });

    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toMatch(/latexmk is not on PATH/);
    // Both routes out, so the caller can act without guessing.
    expect(text).toMatch(/compiler: "tectonic"/);
    expect(text).toMatch(/WEB_LATEX_MCP_COMPILER=tectonic/);
    // A refusal that offers tectonic has to say what tectonic costs, exactly as a substitution
    // does — otherwise the caller retries with `compiler: "tectonic"` and silently loses every
    // source snippet. Pins `caveatFor(alt)`: naming the *missing* backend instead would omit it.
    expect(text).toMatch(/no source snippets/i);
    // The regression itself: never again a bare Node spawn error.
    expect(text).not.toMatch(/ENOENT/);
    expect(structured(res).compiler).toBeUndefined();
    // A refusal must not have compiled with anything on the way to refusing.
    expect(ran).toEqual([]);
  });

  it('honours a per-call compiler override', async () => {
    const { client, ran } = await setup({
      configured: 'latexmk',
      explicit: false,
      installed: ['latexmk', 'tectonic'],
    });

    const res = await client.callTool({
      name: 'compile',
      arguments: { project: 'doc', compiler: 'tectonic' },
    });

    expect(res.isError).toBeFalsy();
    expect(structured(res).compiler).toBe('tectonic');
    // An explicit request is not a substitution, so nothing is reported as one.
    expect(structured(res).hint).toBeUndefined();
    // ...and the override actually reached the engine, rather than only the label.
    expect(ran).toEqual(['tectonic']);
  });

  it('never substitutes for a per-call request, even when nothing was configured', async () => {
    // Just outside the guard: `explicit: false` licenses substituting the *default*, and that
    // licence must not extend to a backend the call itself named.
    const { client, ran } = await setup({
      configured: 'latexmk',
      explicit: false,
      installed: ['tectonic'],
    });

    const res = await client.callTool({
      name: 'compile',
      arguments: { project: 'doc', compiler: 'latexmk' },
    });

    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toMatch(/compiler: "latexmk" was requested/);
    expect(text).not.toMatch(/ENOENT/);
    // Crucially it did not quietly compile with tectonic instead.
    expect(ran).toEqual([]);
  });

  it('reports honestly when no backend at all is installed', async () => {
    const { client, ran } = await setup({ configured: 'latexmk', explicit: false, installed: [] });

    const res = await client.callTool({ name: 'compile', arguments: { project: 'doc' } });

    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toMatch(/doctor/);
    // Must not claim a substitute exists when none does.
    expect(text).not.toMatch(/is installed/);
    expect(ran).toEqual([]);
  });

  it('names the backend that ran even when nothing was substituted', async () => {
    const { client, ran } = await setup({
      configured: 'latexmk',
      explicit: false,
      installed: ['latexmk', 'tectonic'],
    });

    const res = await client.callTool({ name: 'compile', arguments: { project: 'doc' } });

    expect(res.isError).toBeFalsy();
    expect(structured(res).compiler).toBe('latexmk');
    expect(structured(res).hint).toBeUndefined();
    expect(textOf(res)).toMatch(/with latexmk/);
    expect(ran).toEqual(['latexmk']);
  });

  it('advises on missing packages in terms of the backend that ran, not tlmgr', async () => {
    // The fallback newly routes a default-configured user onto tectonic, where `tlmgr install` is
    // both absent and irrelevant — it manages a system TeX installation, which is not what
    // compiled. Sending them after it is the wrong-path detour this whole change exists to stop.
    const { client } = await setup({
      configured: 'latexmk',
      explicit: false,
      installed: ['tectonic'],
      log: "! LaTeX Error: File `fontawesome.sty' not found.",
    });

    const res = await client.callTool({ name: 'compile', arguments: { project: 'doc' } });

    expect(structured(res).compiler).toBe('tectonic');
    expect(structured(res).missingPackages).toEqual(['fontawesome']);
    const hint = String(structured(res).hint ?? '');
    expect(hint).toMatch(/fontawesome/);
    expect(hint).not.toMatch(/tlmgr install/);
    expect(hint).not.toMatch(/mpm --install/);
    // ...and it names the route that would actually work.
    expect(hint).toMatch(/latexmk/);
  });

  it('still gives tlmgr advice when latexmk is what ran', async () => {
    const { client } = await setup({
      configured: 'latexmk',
      explicit: false,
      installed: ['latexmk'],
      log: "! LaTeX Error: File `fontawesome.sty' not found.",
    });

    const res = await client.callTool({ name: 'compile', arguments: { project: 'doc' } });

    expect(structured(res).compiler).toBe('latexmk');
    expect(String(structured(res).hint ?? '')).toMatch(/tlmgr install fontawesome/);
  });
});
