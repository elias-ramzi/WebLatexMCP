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

/**
 * As CANNED_LOG, plus a `Package pdftex.def Warning:` line — a dotted package name, the case
 * PACKAGE_WARNING's `\w+` name class used to match nothing at all (#73's follow-up): not
 * misclassified, just invisible to both `warnings[]` and `warningsOmitted`.
 */
const LOG_WITH_DOTTED_PACKAGE = [
  '(./main.tex',
  '! Undefined control sequence.',
  'l.5 \\badcommand',
  '(./sections/intro.tex',
  "Package pdftex.def Warning: Option `width' ignored for bitmap image on input line 7.",
  'Overfull \\hbox (12.0pt too wide) in paragraph at lines 4--5',
  ')',
  '(./sections/other.tex',
  'Overfull \\hbox (7.0pt too wide) in paragraph at lines 9--10',
  ')',
  ')',
  'Output written on main.pdf (1 page, 100 bytes).',
].join('\n');

function stubCompiler(log: string = CANNED_LOG) {
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

async function setup(log: string = CANNED_LOG) {
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
  ctx.compiler = new CompilerResolver('latexmk', false, () => stubCompiler(log));
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

  it('rule (an INCLUDE list) keeps only the named rule in both channels', async () => {
    // CANNED_LOG's two warnings both carry rule "Overfull \hbox", so a filter naming exactly that
    // rule would keep both and exclude nothing — that would exercise the include-list plumbing
    // without ever proving it narrows anything. LOG_WITH_DOTTED_PACKAGE has a third warning with a
    // different rule ("pdftex.def"), so naming a rule that ISN'T "Overfull \hbox" gives the
    // include list something real to exclude.
    const { client } = await setup(LOG_WITH_DOTTED_PACKAGE);
    const res = await client.callTool({
      name: 'compile',
      arguments: { project: 'doc', warningsFilter: { rule: ['pdftex.def'] } },
    });

    const s = structured(res);
    const warnings = s.warnings as Warning[];
    // Only the pdftex.def warning survives — both Overfull \hbox warnings are excluded.
    expect(warnings).toHaveLength(1);
    expect(warnings.every((w) => w.rule === 'pdftex.def')).toBe(true);
    // The count that makes this non-vacuous: the include list actually removed something.
    expect(s.warningsOmitted).toBe(2);
    const logTail = s.logTail as string;
    // Both channels move in lockstep: the excluded Overfull lines are gone from logTail too.
    expect(logTail).not.toMatch(/12\.0pt too wide/);
    expect(logTail).not.toMatch(/7\.0pt too wide/);
    expect(logTail).toMatch(/Option `width' ignored for bitmap image/);
    // The error survives regardless — it is never subject to warningsFilter.
    expect(logTail).toMatch(/Undefined control sequence/);
  });

  /**
   * The one deliberate lockstep asymmetry (documented on `warningsOmitted` and in
   * ALWAYS_KEEP_PATTERNS): the "Label(s) may have changed" rerun hint IS a structured warning
   * with rule "LaTeX", so excludeRule: ['LaTeX'] removes it from warnings[] and counts it in
   * warningsOmitted — but ALWAYS_KEEP_PATTERNS protects the line itself in logTail regardless,
   * because it is the only thing telling the caller their cross-references are stale. A future
   * change that made warnings[] and logTail agree here would be a silent behaviour change, so this
   * test exists to catch it.
   */
  it('excludeRule: [LaTeX] drops the rerun-hint warning from warnings[] but ALWAYS_KEEP_PATTERNS keeps its line in logTail', async () => {
    const RERUN_LOG = [
      '(./main.tex',
      'LaTeX Warning: Label(s) may have changed. Rerun to get cross-references right.',
      'Overfull \\hbox (12.0pt too wide) in paragraph at lines 4--5',
      ')',
      'Output written on main.pdf (1 page, 100 bytes).',
    ].join('\n');
    const { client } = await setup(RERUN_LOG);

    // Fact 1: the rerun hint IS structured with rule "LaTeX" — precondition for the rest.
    const unfiltered = structured(
      await client.callTool({ name: 'compile', arguments: { project: 'doc' } }),
    );
    const unfilteredWarnings = unfiltered.warnings as Warning[];
    expect(
      unfilteredWarnings.some((w) => w.rule === 'LaTeX' && /Rerun to get/.test(w.message)),
    ).toBe(true);

    const res = await client.callTool({
      name: 'compile',
      arguments: { project: 'doc', warningsFilter: { excludeRule: ['LaTeX'] } },
    });
    const s = structured(res);
    const warnings = s.warnings as Warning[];
    // Fact 2: excludeRule: ['LaTeX'] removes it from warnings[] and counts it.
    expect(warnings.some((w) => w.rule === 'LaTeX')).toBe(false);
    expect(s.warningsOmitted).toBe(1);
    // Fact 3: the line survives in logTail regardless — ALWAYS_KEEP_PATTERNS wins.
    const logTail = s.logTail as string;
    expect(logTail).toContain('Rerun to get cross-references right.');
  });
});

/**
 * Regression: `Package pdftex.def Warning: ...` used to match neither `parseLog` nor
 * `warningRuleOf`'s PACKAGE_WARNING regex (`\w+` matches neither `.` nor `-`), so it was never
 * structured — invisible to `warnings[]`, and dropped from `logTail` by `warningsFilter` with
 * nothing anywhere in the result saying so (warningsOmitted stayed 0 for it). Now it is counted.
 */
describe('compile: warningsFilter counts a dotted-package warning it removes from logTail', () => {
  it('an include-rule filter that keeps only the Overfull warnings now counts the pdftex.def warning it drops', async () => {
    const { client } = await setup(LOG_WITH_DOTTED_PACKAGE);
    const res = await client.callTool({
      name: 'compile',
      arguments: { project: 'doc', warningsFilter: { rule: ['Overfull \\hbox'] } },
    });

    const s = structured(res);
    const warnings = s.warnings as Warning[];
    expect(warnings).toHaveLength(2);
    expect(warnings.every((w) => w.rule === 'Overfull \\hbox')).toBe(true);
    // The dotted-package warning is now structured (rule "pdftex.def") and is what the include
    // filter above dropped, alongside nothing else — so warningsOmitted is exactly 1.
    expect(s.warningsOmitted).toBe(1);
    const logTail = s.logTail as string;
    expect(logTail).not.toMatch(/pdftex\.def/);
    expect(logTail).toMatch(/12\.0pt too wide/);
    expect(logTail).toMatch(/7\.0pt too wide/);
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
