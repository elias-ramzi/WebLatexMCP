import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import { logBaseDir } from '../../src/services/compiler.js';
import { CompilerResolver } from '../../src/services/compilerResolver.js';
import type { CompileOutcome, CompileRequest } from '../../src/services/compiler.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * `compile`'s `warningsFilter` trims `warnings[]` and `logTail` in lockstep, so a box warning does
 * not ship twice (once structured, once as raw text in the de-noised tail) on a warning-heavy
 * document. Driven through the real MCP client, over a stub compiler that returns a canned log —
 * no TeX needed, following the pattern in compilePageCount.test.ts / compilerFallback.test.ts.
 */

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** Two files each with an Overfull \hbox warning, plus one real error, plus the output summary. */
const CANNED_LOG = [
  '(./main.tex',
  '! Undefined control sequence.',
  'l.5 \\badcommand',
  '(./sections/intro.tex',
  'Overfull \\hbox (12.0pt too wide) in paragraph at lines 4--5',
  ')',
  '(./sections/other.tex',
  'Overfull \\hbox (7.0pt too wide) in paragraph at lines 9--10',
  ')',
  ')',
  'Output written on main.pdf (1 page, 100 bytes).',
].join('\n');

function stubCompiler() {
  return {
    isAvailable: async () => true,
    compile: async (req: CompileRequest): Promise<CompileOutcome> => ({
      success: true,
      pdfPath: undefined,
      durationSec: 0.1,
      log: CANNED_LOG,
      timedOut: false,
      logBaseDir: logBaseDir(req.rootFile),
      rebuilt: true,
    }),
  };
}

async function setup() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-wfws-'));
  const userDir = await mkdtemp(path.join(os.tmpdir(), 'ovl-wfdir-'));
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
  };
  const ctx = createContext(
    config,
    new CredentialResolver({}),
    { name: 'Test', email: 'test@example.com' },
    new ProjectRegistry(workspace),
  );
  ctx.compiler = new CompilerResolver('latexmk', false, () => stubCompiler());
  const server = createServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(() => client.close());
  return { client };
}

function structured(res: unknown): Record<string, unknown> {
  return ((res as { structuredContent?: Record<string, unknown> }).structuredContent ??
    {}) as Record<string, unknown>;
}

interface Warning {
  file?: string;
  rule?: string;
  message: string;
}

describe('compile: warningsFilter', () => {
  it('with no filter, returns every warning and every box line in logTail', async () => {
    const { client } = await setup();
    const res = await client.callTool({ name: 'compile', arguments: { project: 'doc' } });

    const s = structured(res);
    expect(s.warnings).toHaveLength(2);
    expect(s.warningsOmitted).toBe(0);
    const logTail = s.logTail as string;
    expect(logTail).toMatch(/Overfull \\hbox \(12\.0pt too wide\)/);
    expect(logTail).toMatch(/Overfull \\hbox \(7\.0pt too wide\)/);
  });

  it('excludeRule drops the matching warnings from both warnings[] and logTail, keeping the error', async () => {
    const { client } = await setup();
    const res = await client.callTool({
      name: 'compile',
      arguments: { project: 'doc', warningsFilter: { excludeRule: ['Overfull \\hbox'] } },
    });

    const s = structured(res);
    expect(s.warnings).toEqual([]);
    expect(s.warningsOmitted).toBe(2);
    const logTail = s.logTail as string;
    // This is the assertion that proves the two channels agree: the box lines are gone from the
    // de-noised tail too, not only from the structured list.
    expect(logTail).not.toMatch(/Overfull/);
    expect(logTail).toMatch(/Undefined control sequence/);
    expect(logTail).toMatch(/Output written on/);
  });

  it('file filters both channels down to the named file', async () => {
    const { client } = await setup();
    const res = await client.callTool({
      name: 'compile',
      arguments: { project: 'doc', warningsFilter: { file: ['sections/intro.tex'] } },
    });

    const s = structured(res);
    const warnings = s.warnings as Warning[];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.file).toBe('sections/intro.tex');
    expect(s.warningsOmitted).toBe(1);
    const logTail = s.logTail as string;
    expect(logTail).toMatch(/12\.0pt too wide/);
    expect(logTail).not.toMatch(/7\.0pt too wide/);
  });

  it('rawLog: true filters warnings[] but leaves logTail whole', async () => {
    const { client } = await setup();
    const res = await client.callTool({
      name: 'compile',
      arguments: {
        project: 'doc',
        rawLog: true,
        warningsFilter: { excludeRule: ['Overfull \\hbox'] },
      },
    });

    const s = structured(res);
    expect(s.warnings).toEqual([]);
    expect(s.warningsOmitted).toBe(2);
    const logTail = s.logTail as string;
    // rawLog means raw: both box lines are still there even though warnings[] was filtered.
    expect(logTail).toMatch(/12\.0pt too wide/);
    expect(logTail).toMatch(/7\.0pt too wide/);
  });

  it('never removes an error, under any filter', async () => {
    const { client } = await setup();
    const res = await client.callTool({
      name: 'compile',
      arguments: { project: 'doc', warningsFilter: { file: ['nonexistent.tex'] } },
    });

    const s = structured(res);
    const errors = s.errors as Array<{ message: string }>;
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/Undefined control sequence/);
    expect(s.warnings).toEqual([]);
    expect(s.warningsOmitted).toBe(2);
    const logTail = s.logTail as string;
    expect(logTail).toMatch(/Undefined control sequence/);
  });
});

/**
 * A path the *document* named that leaves the project through a symlink is withheld from the
 * result (`withoutUnopenableLocation`), so the caller sees no `file` on that warning. The filter
 * must judge both channels on what the caller sees — not on the log's original path — or a
 * `file` filter naming the withheld path empties `warnings[]` while leaving that very warning
 * sitting in `logTail`, which is the inverse of the lockstep the feature promises.
 */
describe('compile: warningsFilter and a withheld path', () => {
  const ESCAPING_LOG = [
    '(./main.tex',
    '(./outside.tex',
    'Overfull \\hbox (12.0pt too wide) in paragraph at lines 4--5',
    ')',
    ')',
    'Output written on main.pdf (1 page, 100 bytes).',
  ].join('\n');

  async function setupEscaping() {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-wfesc-ws-'));
    const userDir = await mkdtemp(path.join(os.tmpdir(), 'ovl-wfesc-dir-'));
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), 'ovl-wfesc-out-'));
    cleanups.push(
      () => rm(workspace, { recursive: true, force: true }),
      () => rm(userDir, { recursive: true, force: true }),
      () => rm(outsideDir, { recursive: true, force: true }),
    );
    await writeFile(
      path.join(userDir, 'main.tex'),
      '\\documentclass{article}\n\\begin{document}\nhi\n\\end{document}\n',
      'utf8',
    );
    await writeFile(path.join(outsideDir, 'secret.tex'), 'secret\n', 'utf8');
    await symlink(path.join(outsideDir, 'secret.tex'), path.join(userDir, 'outside.tex'));

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
    ctx.compiler = new CompilerResolver('latexmk', false, () => ({
      isAvailable: async () => true,
      compile: async (req: CompileRequest): Promise<CompileOutcome> => ({
        success: true,
        pdfPath: undefined,
        durationSec: 0.1,
        log: ESCAPING_LOG,
        timedOut: false,
        logBaseDir: logBaseDir(req.rootFile),
        rebuilt: true,
      }),
    }));
    const server = createServer(ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(() => client.close());
    return { client };
  }

  it('withholds the escaping path from the warning, so a file filter naming it drops the line from BOTH channels', async () => {
    const { client } = await setupEscaping();
    const unfiltered = structured(
      await client.callTool({ name: 'compile', arguments: { project: 'doc' } }),
    );
    // Precondition: the path really was withheld, or this test proves nothing about the filter.
    const shown = unfiltered.warnings as Warning[];
    expect(shown).toHaveLength(1);
    expect(shown[0]?.file).toBeUndefined();

    const res = structured(
      await client.callTool({
        name: 'compile',
        arguments: { project: 'doc', warningsFilter: { file: ['outside.tex'] } },
      }),
    );
    expect(res.warnings).toHaveLength(0);
    expect(res.warningsOmitted).toBe(1);
    // The point: logTail agrees. Before the predicate applied the withholding itself, the tail
    // kept this line because the paren stack still called it "outside.tex".
    expect(res.logTail as string).not.toMatch(/Overfull/);
  });
});
