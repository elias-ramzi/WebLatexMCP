import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import { CompilerResolver } from '../../src/services/compilerResolver.js';
import { buildDir, buildPdfPathIn, logBaseDir } from '../../src/services/compiler.js';
import type { CompileOutcome, CompileRequest } from '../../src/services/compiler.js';
import { createFakeRemote } from './helpers/bareRepo.js';
import { minimalPdf } from '../helpers/minimalPdf.js';
import { expectNoUndeclaredKeys } from '../helpers/outputSchema.js';
import type { CompilerKind, ServerConfig } from '../../src/types.js';

/*
 * `compile`'s hints for #213 (a shell command the engine refused, now that every latexmk compile
 * runs with -no-shell-escape unless the caller opts in) and #216 item 2 (the overlay "never read"
 * hint, one budgeted line instead of one unbounded line per file), end to end through the MCP
 * client against a stub engine that writes exactly the log each test needs.
 */

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** A per-figure TikZ externalization failure, as latexmk prints it. */
const TIKZ_FAILURE =
  "./main.tex:6: Package tikz Error: Sorry, the system call 'pdflatex -halt-on-error " +
  '-interaction=batchmode -jobname "imgs/tikzmain-figure0" "..."\' did NOT result in a usable ' +
  "output file 'imgs/tikzmain-figure0' (expected one of .pdf:.jpg:). Please verify that you " +
  "have enabled system calls. For pdflatex, this is 'pdflatex -shell-escape'.\n";

/** What pdfTeX logs for an `.eps` figure under -no-shell-escape. */
const REPSTOPDF_REFUSED =
  'runsystem(repstopdf --outfile=fig-eps-converted-to.pdf fig.eps)...disabled.\n';

/** An engine that succeeds, opening only main.tex, and logs `behaviour.log`. */
function stubCompiler(
  requests: CompileRequest[],
  behaviour: { log: string; capturedOutput?: boolean },
) {
  return {
    isAvailable: async () => true,
    compile: async (req: CompileRequest): Promise<CompileOutcome> => {
      requests.push(req);
      const workDir = req.workDir ?? req.projectDir;
      const outDir = req.outDir ?? buildDir(req.projectDir);
      await mkdir(outDir, { recursive: true });
      const pdfPath = buildPdfPathIn(outDir, req.rootFile);
      await writeFile(pdfPath, minimalPdf(1, 300, 200));
      await writeFile(
        path.join(outDir, `${path.basename(req.rootFile, '.tex')}.fls`),
        `PWD ${path.join(workDir, logBaseDir(req.rootFile))}\nINPUT main.tex\n`,
      );
      return {
        success: true,
        pdfPath,
        durationSec: 0.1,
        log: behaviour.log,
        ...(behaviour.capturedOutput ? { capturedOutput: true } : {}),
        timedOut: false,
        logBaseDir: logBaseDir(req.rootFile),
        rebuilt: true,
      };
    },
  };
}

async function setup(files: Record<string, string>, backend: CompilerKind = 'latexmk') {
  const remote = await createFakeRemote(files);
  cleanups.push(remote.cleanup);
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'esc-hint-ws-'));
  cleanups.push(() => rm(workspace, { recursive: true, force: true }));
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
  const requests: CompileRequest[] = [];
  const behaviour: { log: string; capturedOutput?: boolean } = { log: '' };
  ctx.compiler = new CompilerResolver(backend, true, () => stubCompiler(requests, behaviour));
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
  const clone = path.join(workspace, 'demo');
  cleanups.push(() => rm(buildDir(clone), { recursive: true, force: true }));
  return { client, clone, requests, behaviour };
}

const MAIN_TEX = '\\documentclass{article}\n\\begin{document}\nHi.\n\\end{document}\n';

function hintOf(res: unknown): string {
  return (res as { structuredContent?: { hint?: string } }).structuredContent?.hint ?? '';
}

describe('compile: captured output is never read as an engine header (#232)', () => {
  it('a document-forged header in latexmk 4.67 captured output claims nothing', async () => {
    const { client, behaviour } = await setup({ 'main.tex': MAIN_TEX });
    // TL2019 latexmk under `$silent = 1` opens its captured output with the engine's own line;
    // a `\nonstopmode` document then writes a banner and a `**` line before the engine's.
    behaviour.log =
      'This is pdfTeX, Version 3.14159265-2.6-1.40.20 (TeX Live 2019/Debian)\n' +
      ' \\write18 enabled.\n**x\nentering extended mode\n(./main.tex\n' +
      TIKZ_FAILURE +
      '\n' +
      TIKZ_FAILURE.replace(/figure0/g, 'figure1');
    behaviour.capturedOutput = true;
    const res = await client.callTool({ name: 'compile', arguments: {} });
    const hint = hintOf(res);
    expect(hint).not.toContain('overrode -no-shell-escape');
    expect(hint).toContain('may have turned shell escape on');
    expect(hint).toContain('This document uses TikZ externalization');
    const errors =
      (res.structuredContent as { errors?: Array<{ message: string }> } | undefined)?.errors ?? [];
    const collapsed = errors.find((e) => e.message.startsWith('TikZ externalization failed'));
    expect(collapsed?.message).toContain('usually because shell escape is disabled');
    expect(collapsed?.message).not.toContain('although shell escape was on');
    await expectNoUndeclaredKeys(client, 'compile', res.structuredContent);
  });
});

describe('compile: a refused shell command gets a hint on every compile (#213)', () => {
  it('names restrictedShellEscape and its cost when a plain compile refused repstopdf', async () => {
    const { client, behaviour } = await setup({ 'main.tex': MAIN_TEX });
    behaviour.log = `This is pdfTeX\n${REPSTOPDF_REFUSED}Output written on main.pdf (1 page).\n`;
    const res = await client.callTool({ name: 'compile', arguments: {} });
    expect(res.isError ?? false, JSON.stringify(res.content)).toBe(false);
    const hint = hintOf(res);
    expect(hint).toContain('The engine refused a shell command the document ran');
    expect(hint).toContain('Retry with restrictedShellEscape: true');
    expect(hint).toContain('What that costs');
    expect(hint).toContain('makeindex -o can overwrite a source file');
    // Not the overlay's wording: there are no links to the source here.
    expect(hint).not.toContain('overlay');
    await expectNoUndeclaredKeys(client, 'compile', res.structuredContent);
  });

  it('is gated on the refusal and on the caller not having opted in', async () => {
    const { client, behaviour } = await setup({ 'main.tex': MAIN_TEX });
    behaviour.log = REPSTOPDF_REFUSED;
    // The same log, three ways: only the call that did not opt in is told to.
    const plain = await client.callTool({ name: 'compile', arguments: {} });
    expect(hintOf(plain)).toContain('refused a shell command');
    for (const args of [{ restrictedShellEscape: true }, { shellEscape: true }]) {
      const res = await client.callTool({ name: 'compile', arguments: args });
      expect(hintOf(res), JSON.stringify(args)).not.toContain('refused a shell command');
    }
    behaviour.log = 'runsystem(repstopdf fig.eps)...executed safely (allowed).\n';
    const ran = await client.callTool({ name: 'compile', arguments: {} });
    expect(hintOf(ran)).not.toContain('refused a shell command');
  });

  it('leaves a TikZ refusal to the TikZ hint alone: one cause, one retry instruction', async () => {
    const { client, behaviour } = await setup({ 'main.tex': MAIN_TEX });
    behaviour.log = 'runsystem(pdflatex -jobname imgs/x main.tex)...disabled.\n';
    const bare = await client.callTool({ name: 'compile', arguments: {} });
    expect(hintOf(bare)).toContain('The engine refused a shell command');
    // The same refusal, now explained by TikZ's own failure: the TikZ hint carries the retry.
    behaviour.log += TIKZ_FAILURE;
    const res = await client.callTool({ name: 'compile', arguments: {} });
    const hint = hintOf(res);
    expect(hint).toContain('TikZ externalization');
    expect(hint).not.toContain('The engine refused a shell command');
  });

  it('under tectonic points at shellEscape, which is the only switch it has', async () => {
    const { client, behaviour } = await setup({ 'main.tex': MAIN_TEX }, 'tectonic');
    behaviour.log = REPSTOPDF_REFUSED;
    const res = await client.callTool({ name: 'compile', arguments: {} });
    const hint = hintOf(res);
    expect(hint).toContain('Retry with shellEscape: true');
    expect(hint).toContain('tectonic has no restricted mode');
  });

  it('under tectonic, restrictedShellEscape is no opt-in: the refusal is still explained', async () => {
    // Tectonic ignores restrictedShellEscape (it has no restricted mode, so the backend passes no
    // flag and runs no command), so a caller who passed it is exactly who needs the hint.
    const { client, behaviour } = await setup({ 'main.tex': MAIN_TEX }, 'tectonic');
    behaviour.log = REPSTOPDF_REFUSED;
    const res = await client.callTool({
      name: 'compile',
      arguments: { restrictedShellEscape: true },
    });
    const hint = hintOf(res);
    expect(hint).toContain('The engine refused a shell command');
    expect(hint).toContain('Retry with shellEscape: true');
    // TikZ's own retry instruction names the one switch tectonic has, too.
    behaviour.log = TIKZ_FAILURE;
    const tikz = await client.callTool({
      name: 'compile',
      arguments: { restrictedShellEscape: true },
    });
    expect(hintOf(tikz)).toContain('TikZ externalization');
    expect(hintOf(tikz)).toContain('Retry compile with shellEscape: true');
    expect(hintOf(tikz)).not.toContain('restrictedShellEscape: true (preferred)');
    // An explicit shellEscape is an opt-in under tectonic as anywhere: no hint.
    behaviour.log = REPSTOPDF_REFUSED;
    const on = await client.callTool({ name: 'compile', arguments: { shellEscape: true } });
    expect(hintOf(on)).not.toContain('refused a shell command');
  });

  it("under lualatex reads pdftexcmds' 'executed.' without the enabled banner as a refusal", async () => {
    // TeX Live 2026 lualatex on `\includegraphics{fig.eps}`, three runs, lines verbatim. LuaTeX
    // logs no `runsystem(...)...disabled`; pdftexcmds.lua writes `executed.` whenever os.execute
    // exists, and under -no-shell-escape it exists as a stub that refuses. Only the banner, which
    // -no-shell-escape suppresses, tells the runs apart.
    const HEADER =
      'This is LuaHBTeX, Version 1.24.0 (TeX Live 2026)  (format=lualatex 2026.6.23)  ' +
      '28 SEP 2026 14:08\n';
    const CALL = 'system(repstopdf --outfile=fig-eps-converted-to.pdf fig.eps) executed.\n';
    const MISSING =
      "! Package luatex.def Error: File `fig-eps-converted-to.pdf' not found: using draft " +
      'setting.\n';
    const { client, behaviour } = await setup({ 'main.tex': MAIN_TEX });
    behaviour.log = `${HEADER}**main.tex\n(./main.tex\n${CALL}${MISSING}`;
    const refused = await client.callTool({ name: 'compile', arguments: { engine: 'lualatex' } });
    expect(hintOf(refused)).toContain('The engine refused a shell command');
    expect(hintOf(refused)).toContain('Retry with restrictedShellEscape: true');
    // The same call with the banner a shell-escape run prints (restricted, then full): it ran.
    for (const banner of [
      ' restricted system commands enabled.\n',
      ' system commands enabled.\n',
    ]) {
      behaviour.log = `${HEADER}${banner}**main.tex\n(./main.tex\n${CALL}`;
      const ran = await client.callTool({ name: 'compile', arguments: { engine: 'lualatex' } });
      expect(hintOf(ran), banner).not.toContain('refused a shell command');
    }
    // pdftexcmds' other branch, os.execute absent altogether, is a refusal whatever the banner.
    behaviour.log = `${HEADER} restricted system commands enabled.\nsystem(repstopdf fig.eps) disabled.\n`;
    const disabled = await client.callTool({ name: 'compile', arguments: { engine: 'lualatex' } });
    expect(hintOf(disabled)).toContain('The engine refused a shell command');
  });
});

describe('compile: the overlay "never read" hint is one budgeted line (#216)', () => {
  it('names a prefix of the unread files and counts the rest, in one line', async () => {
    // 20 overlaid files (the overlay cap), none of which the stub engine opens, with long names:
    // together far past the 2000-character share the list may take.
    const names = Array.from(
      { length: 20 },
      (_, i) => `sections/${'n'.repeat(120)}-${String(i).padStart(2, '0')}.tex`,
    );
    const files: Record<string, string> = { 'main.tex': MAIN_TEX };
    for (const n of names) files[n] = 'x\n';
    const { client } = await setup(files);
    const res = await client.callTool({
      name: 'compile',
      arguments: {
        rootFile: 'main.tex',
        overlay: names.map((file) => ({ file, edits: [{ oldString: 'x', newString: 'y' }] })),
      },
    });
    expect(res.isError ?? false, JSON.stringify(res.content)).toBe(false);
    const lines = hintOf(res)
      .split('\n')
      .filter((l) => l.includes('never read'));
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    const named = names.filter((n) => line.includes(`"${n}"`));
    // A prefix, in order, and the rest counted in the same sentence.
    expect(named).toEqual(names.slice(0, named.length));
    expect(named.length).toBeGreaterThan(0);
    expect(named.length).toBeLessThan(names.length);
    expect(line).toContain(`, and ${names.length - named.length} more (neither`);
    // Bounded: the names' share plus the fixed sentence around them.
    expect(line.length).toBeLessThan(2000 + 400);
    await expectNoUndeclaredKeys(client, 'compile', res.structuredContent);
  });
});

function textOf(res: unknown): string {
  const content = (res as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? '').join('\n');
}

describe('compile: a latexmkrc that turned shell escape back on is reported on every compile', () => {
  const HEADER = 'This is pdfTeX, Version 3.141592653-2.6-1.40.26 (TeX Live 2024)\n';

  it('says so in both channels when the banner shows full shell escape', async () => {
    const { client, behaviour } = await setup({ 'main.tex': MAIN_TEX });
    // What `$pdflatex = 'pdflatex %O -shell-escape %S'` produces: the later flag wins.
    behaviour.log = `${HEADER} \\write18 enabled.\n**main.tex\n(./main.tex)\n`;
    const res = await client.callTool({ name: 'compile', arguments: {} });
    expect(res.isError ?? false, JSON.stringify(res.content)).toBe(false);
    const hint = hintOf(res);
    expect(hint).toContain("Shell escape was requested off, but the engine's log shows it enabled");
    expect(hint).toContain('overrode -no-shell-escape');
    expect(hint).toContain('ARBITRARY');
    expect(textOf(res)).toContain(
      "Shell escape was requested off, but the engine's log shows it enabled",
    );
    await expectNoUndeclaredKeys(client, 'compile', res.structuredContent);
  });

  it('names restricted mode when that is what the banner shows', async () => {
    const { client, behaviour } = await setup({ 'main.tex': MAIN_TEX });
    behaviour.log = `${HEADER} restricted \\write18 enabled.\n**main.tex\n(./main.tex)\n`;
    const res = await client.callTool({ name: 'compile', arguments: {} });
    const hint = hintOf(res);
    expect(hint).toContain("shows it enabled (restricted to TeX's allow-list)");
    expect(textOf(res)).toContain("shows it enabled (restricted to TeX's allow-list)");
    await expectNoUndeclaredKeys(client, 'compile', res.structuredContent);
  });

  it('is quiet when the caller opted in, or when no banner shows', async () => {
    const { client, behaviour } = await setup({ 'main.tex': MAIN_TEX });
    behaviour.log = `${HEADER} \\write18 enabled.\n`;
    for (const args of [{ shellEscape: true }, { restrictedShellEscape: true }]) {
      const res = await client.callTool({ name: 'compile', arguments: args });
      expect(hintOf(res), JSON.stringify(args)).not.toContain('requested off');
    }
    behaviour.log = `${HEADER}**main.tex\n`;
    const plain = await client.callTool({ name: 'compile', arguments: {} });
    expect(hintOf(plain)).not.toContain('requested off');
  });
});

describe('compile: a refusal under restricted mode a latexmkrc forced names only shellEscape', () => {
  // The engine's banner in the log's header — before the `**` line, where the document cannot
  // write — is the only evidence of restricted mode that counts.
  const RESTRICTED = 'This is pdfTeX\n restricted \\write18 enabled.\n**main.tex\n(./main.tex\n';

  it('TikZ externalization: the retry names shellEscape: true, not restrictedShellEscape', async () => {
    const { client, behaviour } = await setup({ 'main.tex': MAIN_TEX });
    behaviour.log =
      RESTRICTED +
      'runsystem(pdflatex -halt-on-error -jobname "imgs/tikzmain-figure0" "...")...disabled ' +
      '(restricted).\n' +
      TIKZ_FAILURE;
    const res = await client.callTool({ name: 'compile', arguments: {} });
    const hint = hintOf(res);
    expect(hint).toContain('TikZ externalization');
    expect(hint).toContain('Retry compile with shellEscape: true');
    expect(hint).not.toContain('restrictedShellEscape: true (preferred)');
    await expectNoUndeclaredKeys(client, 'compile', res.structuredContent);
  });

  it('another refused command: the retry names shellEscape: true only', async () => {
    const { client, behaviour } = await setup({ 'main.tex': MAIN_TEX });
    behaviour.log = `${RESTRICTED}runsystem(gnuplot fig.gp)...disabled (restricted).\n`;
    const res = await client.callTool({ name: 'compile', arguments: {} });
    const hint = hintOf(res);
    expect(hint).toContain('The engine refused a shell command');
    expect(hint).toContain('Retry with shellEscape: true');
    expect(hint).not.toContain('restrictedShellEscape: true (or');
  });
});

describe('compile: an overlay compile names every unread file in one line', () => {
  it('two unread overlaid files: one line naming both', async () => {
    const files: Record<string, string> = {
      'main.tex': MAIN_TEX,
      'a.tex': 'x\n',
      'b.tex': 'x\n',
    };
    const { client } = await setup(files);
    const res = await client.callTool({
      name: 'compile',
      arguments: {
        rootFile: 'main.tex',
        overlay: ['a.tex', 'b.tex'].map((file) => ({
          file,
          edits: [{ oldString: 'x', newString: 'y' }],
        })),
      },
    });
    expect(res.isError ?? false, JSON.stringify(res.content)).toBe(false);
    const lines = hintOf(res)
      .split('\n')
      .filter((l) => l.includes('never read'));
    expect(lines).toEqual([
      'The build never read the overlaid files "a.tex", "b.tex" (neither its .fls nor its ' +
        '.fdb_latexmk lists them), so the overlay had no effect on them — overlay the path TeX ' +
        'actually opens instead (the target of a symbolic link, or the name the document inputs).',
    ]);
    // The variant line claims only what the source check covers, not a list of .git entries
    // that grows with what is watched (and that a project without its own .git does not have).
    expect(textOf(res)).toContain('no project file changed while it built');
    expect(textOf(res)).not.toContain('only its hooks, config and info/ are checked');
    await expectNoUndeclaredKeys(client, 'compile', res.structuredContent);
  });
});
