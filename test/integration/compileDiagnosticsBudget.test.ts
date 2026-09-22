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
import { logBaseDir } from '../../src/services/compiler.js';
import { CompilerResolver } from '../../src/services/compilerResolver.js';
import { expectDeclaredField, expectNoUndeclaredKeys } from '../helpers/outputSchema.js';
import { DIAGNOSTICS_CONTENT_BUDGET } from '../../src/lib/diagnosticsBudget.js';
import type { CompileOutcome, CompileRequest } from '../../src/services/compiler.js';
import type { ServerConfig } from '../../src/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * `compile`'s diagnostics budget (issue #162), measured end to end on what a client actually
 * receives.
 *
 * `test/unit/diagnosticsBudget.test.ts` pins the planner. This file pins the thing the planner
 * exists for and that a unit test structurally cannot reach: the size of the REAL tool result,
 * text channel plus JSON-encoded structured channel, off a real MCP round trip over a real
 * (stubbed-engine) compile of a warning-heavy document. Pre-fix the structured channel alone came
 * back at ~140k characters — the shape of payload a client rejected outright in #68, delivering
 * nothing at all — on a **successful** compile of an ordinary document.
 */

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** How many `Overfull \hbox` lines the generated log carries. A wide table in a thesis. */
const WARNING_COUNT = 1200;

/** How many `-file-line-error` errors it carries, spread over distinct source lines. */
const ERROR_COUNT = 12;

const SOURCE_LINES = 80;

/** A document long enough for every error's location to exist and be readable. */
const MAIN_TEX =
  [
    '\\documentclass{article}',
    '\\begin{document}',
    ...Array.from({ length: SOURCE_LINES }, (_, i) => `Paragraph ${i} of the body text.`),
    '\\end{document}',
  ].join('\n') + '\n';

/**
 * A successful build of a document whose every table row overflows, plus (when `withErrors`) a
 * handful of real errors the log names outright so they earn their snippets.
 */
function cannedLog(withErrors: boolean): string {
  const lines = ['(./main.tex'];
  if (withErrors) {
    for (let i = 0; i < ERROR_COUNT; i++) {
      // -file-line-error form: the only shape that earns a snippet, and the provenance guard this
      // change must not relax.
      lines.push(`./main.tex:${3 + i * 4}: Undefined control sequence \\macro${i}.`);
    }
  }
  for (let i = 0; i < WARNING_COUNT; i++) {
    lines.push(
      `Overfull \\hbox (${i}.0pt too wide) in paragraph at lines ${i}--${i + 1} of the table`,
    );
  }
  lines.push(')', 'Output written on main.pdf (1 page, 100 bytes).');
  return lines.join('\n');
}

function stubCompiler(log: string) {
  return {
    isAvailable: async () => true,
    compile: async (req: CompileRequest): Promise<CompileOutcome> => ({
      success: true,
      pdfPath: undefined,
      durationSec: 0.1,
      log,
      timedOut: false,
      logBaseDir: logBaseDir(req.rootFile),
      rebuilt: true,
    }),
  };
}

async function setup(log: string) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-dbws-'));
  const userDir = await mkdtemp(path.join(os.tmpdir(), 'ovl-dbdir-'));
  cleanups.push(
    () => rm(workspace, { recursive: true, force: true }),
    () => rm(userDir, { recursive: true, force: true }),
  );
  await writeFile(path.join(userDir, 'main.tex'), MAIN_TEX, 'utf8');

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
  ctx.compiler = new CompilerResolver('latexmk', false, () => stubCompiler(log));
  const server = createServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(() => client.close());
  return { client };
}

interface CompileStructured {
  success: boolean;
  errors: Array<{ file?: string; line?: number; message: string; snippet?: string }>;
  warnings: Array<{ file?: string; rule?: string; message: string }>;
  warningsOmitted: number;
  errorsOmittedByCap: number;
  warningsOmittedByCap: number;
  omittedSnippetLocations: number;
  logTail: string;
  note?: string;
}

function structured(res: CallToolResult): CompileStructured {
  return res.structuredContent as unknown as CompileStructured;
}

function textOf(res: CallToolResult): string {
  return (res.content as Array<{ type: string; text?: string }>)
    .map((c) => c.text ?? '')
    .join('\n');
}

/** Everything the caller receives: the model-visible text AND the JSON handed beside it. */
function receivedChars(res: CallToolResult): number {
  return textOf(res).length + JSON.stringify(res.structuredContent ?? {}).length;
}

describe('compile: errors[] and warnings[] are budgeted', () => {
  it('bounds a warning-heavy successful compile and counts what the cap cut', async () => {
    const { client } = await setup(cannedLog(false));
    const res = (await client.callTool({
      name: 'compile',
      arguments: { project: 'doc' },
    })) as CallToolResult;
    const s = structured(res);

    expect(s.success).toBe(true);
    // The claim of the whole issue. Pre-fix, `warnings` alone rendered to ~140k characters.
    expect(JSON.stringify(s.errors).length + JSON.stringify(s.warnings).length).toBeLessThanOrEqual(
      DIAGNOSTICS_CONTENT_BUDGET,
    );
    // And the whole result, both channels, stays far below the ~67k a client rejected in #68 —
    // `logTail`'s own 80-line bound is what keeps the rest of it small.
    expect(receivedChars(res)).toBeLessThan(40_000);

    // Nothing cut silently: total = shown + omitted.
    expect(s.warnings.length).toBeGreaterThan(0);
    expect(s.warnings.length + s.warningsOmittedByCap).toBe(WARNING_COUNT);
    // The cap is NOT the filter. No warningsFilter was passed, so that counter stays 0 — and a
    // reader who added the two would be double-counting two different claims.
    expect(s.warningsOmitted).toBe(0);
    expect(s.warningsOmittedByCap).toBeGreaterThan(900);

    expect(s.note).toBeDefined();
    expect(s.note).toMatch(/NOT warningsFilter/);
    // The client this text channel exists for cannot read the counters at all, so the note is
    // rendered there too rather than leaving a silently short list.
    expect(textOf(res)).toContain('warnings: showing');

    // logTail keeps its own, separate 80-line bound: it is the fallback evidence for the warnings
    // this cut removed, so the box lines are still there.
    // filterLog keeps the TAIL of the log, so it is the last box lines that survive there.
    expect(s.logTail).toMatch(/Overfull \\hbox \(1199\.0pt too wide\)/);
    // 80 kept lines plus filterLog's own "N earlier diagnostic line(s) omitted" notice.
    expect(s.logTail.split('\n').length).toBeLessThanOrEqual(81);
  });

  it('cuts the warnings and keeps every error, snippets included', async () => {
    const { client } = await setup(cannedLog(true));
    const res = (await client.callTool({
      name: 'compile',
      arguments: { project: 'doc' },
    })) as CallToolResult;
    const s = structured(res);

    // ALLOCATION_ORDER, end to end: the warnings pay for the errors, never the other way round.
    expect(s.errors).toHaveLength(ERROR_COUNT);
    expect(s.errorsOmittedByCap).toBe(0);
    expect(s.warningsOmittedByCap).toBeGreaterThan(0);

    // Snippet provenance is untouched: the log named these outright, so they still carry source.
    expect(s.errors[0]?.snippet).toContain('Paragraph');
    expect(s.errors[0]?.file).toBe('main.tex');
    // Ten locations get one, the remaining two are reported — the pre-existing promise, unchanged
    // by the budget, which is why an error the cap drops is counted in errorsOmittedByCap instead.
    expect(s.omittedSnippetLocations).toBe(ERROR_COUNT - 10);
    expect(textOf(res)).toMatch(/> 3 \| Paragraph 0 of the body text\./);

    expect(JSON.stringify(s.errors).length + JSON.stringify(s.warnings).length).toBeLessThanOrEqual(
      DIAGNOSTICS_CONTENT_BUDGET,
    );
  });

  it('keeps the filter counter and the cap counter apart on one call', async () => {
    const { client } = await setup(cannedLog(true));
    const res = (await client.callTool({
      name: 'compile',
      // Every warning in this log is an Overfull \hbox, so the filter removes all of them.
      arguments: { project: 'doc', warningsFilter: { excludeRule: ['Overfull \\hbox'] } },
    })) as CallToolResult;
    const s = structured(res);

    expect(s.warnings).toHaveLength(0);
    // What the caller asked to remove...
    expect(s.warningsOmitted).toBe(WARNING_COUNT);
    // ...and nothing left for the size cap to remove, so it reports nothing. Reusing one counter
    // for both would have made this 2400, or made one of the two claims false.
    expect(s.warningsOmittedByCap).toBe(0);
    expect(s.errors).toHaveLength(ERROR_COUNT);
  });

  it('declares every counter in the schema it advertises', async () => {
    const { client } = await setup(cannedLog(true));
    const res = (await client.callTool({
      name: 'compile',
      arguments: { project: 'doc' },
    })) as CallToolResult;

    // An undeclared key is a broken tool: the SDK's client compiles an ajv validator per
    // advertised schema at listTools() and rejects the whole call with -32602 (#137, #146). This
    // audits the WHOLE payload, which a named-pointer assertion structurally cannot.
    await expectNoUndeclaredKeys(client, 'compile', res.structuredContent);

    await expectDeclaredField(client, 'compile', 'errorsOmittedByCap', { required: true });
    await expectDeclaredField(client, 'compile', 'warningsOmittedByCap', {
      required: true,
      description: /NOT warningsOmitted/,
    });
    await expectDeclaredField(client, 'compile', 'note', { required: false });
    // The existing field keeps its own meaning, and says so where a caller will read it.
    await expectDeclaredField(client, 'compile', 'warningsOmitted', {
      description: /warningsOmittedByCap/,
    });
    await expectDeclaredField(client, 'compile', 'omittedSnippetLocations', {
      description: /errorsOmittedByCap/,
    });
  });
});
