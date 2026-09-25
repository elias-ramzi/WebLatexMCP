import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { LatexmkCompiler, buildDir, probeOnPath } from '../../src/services/compiler.js';
import type { ServerConfig } from '../../src/types.js';

/*
 * An overlay compile (#205) against real TeX: a project whose root sits in a subdirectory and
 * reaches its inputs through every path shape the link farm has to reproduce — `./` and `../`
 * inputs, `\include` (whose .aux lands in a subdirectory of the build dir), `\graphicspath`, a
 * local .sty and a bibliography. The variant must compile, show its own text, leave the main
 * build and the surfaced PDF alone, and leave every source byte where it was.
 */

const compiler = new LatexmkCompiler();
const available = await compiler.isAvailable();
const hasBiber = available && (await probeOnPath('biber', '--version').catch(() => false));

// A 1x1 PNG: enough for \includegraphics, and nothing to generate at test time.
const DOT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

function mainTex(): string {
  const bib = hasBiber
    ? ['\\usepackage[backend=biber]{biblatex}', '\\addbibresource{refs.bib}']
    : [];
  const printBib = hasBiber
    ? ['\\printbibliography']
    : ['\\bibliographystyle{plain}', '\\bibliography{refs}'];
  return [
    '\\documentclass{article}',
    '\\usepackage{graphicx}',
    '\\usepackage{localsty}',
    ...bib,
    '\\graphicspath{{figs/}}',
    '\\input{../shared/defs}',
    '\\begin{document}',
    '\\hello',
    '\\input{sections/a}',
    '\\input{./sections/b}',
    '\\include{chap/c1}',
    '\\includegraphics[width=1cm]{dot}',
    '\\includegraphics[width=1cm]{./figs/dot}',
    'Shared: \\shareddef. \\cite{knuth}',
    ...printBib,
    '\\end{document}',
    '',
  ].join('\n');
}

const FILES: Record<string, string | Buffer> = {
  'paper/main.tex': mainTex(),
  'paper/localsty.sty': '\\ProvidesPackage{localsty}\n\\newcommand\\hello{Hello from localsty.}\n',
  'paper/refs.bib': '@book{knuth, author={Knuth, Donald}, title={The TeXbook}, year={1984}}\n',
  'paper/sections/a.tex': 'Section A text.\n',
  'paper/sections/b.tex': 'Section B original.\n',
  'paper/chap/c1.tex': '\\section{Chap}\\label{sec:c1} Chapter one.\n',
  'paper/figs/dot.png': DOT_PNG,
  'shared/defs.tex': '\\newcommand\\shareddef{shared-macro}\n',
  'paper/unused.tex': 'Never input by the document.\n',
};

/** Every file under `dir`, relative path -> bytes. */
async function snapshot(dir: string): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) await walk(abs);
      else out.set(path.relative(dir, abs), await readFile(abs));
    }
  };
  await walk(dir);
  return out;
}

interface Compiled {
  success: boolean;
  pageCount?: number;
  variant?: string;
  pdfPath?: string;
  hint?: string;
}

describe.skipIf(!available)('compile with an overlay (real TeX)', () => {
  const cleanups: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  it('builds a variant in a link farm and leaves the source, main build and surfaced PDF alone', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-smoke-ws-'));
    const userDir = await mkdtemp(path.join(os.tmpdir(), 'ovl-smoke-src-'));
    cleanups.push(
      () => rm(workspace, { recursive: true, force: true }),
      () => rm(userDir, { recursive: true, force: true }),
      () => rm(buildDir(userDir), { recursive: true, force: true }),
    );
    for (const [rel, content] of Object.entries(FILES)) {
      await mkdir(path.dirname(path.join(userDir, rel)), { recursive: true });
      await writeFile(path.join(userDir, rel), content);
    }
    const before = await snapshot(userDir);

    const config: ServerConfig = {
      workspaceRoot: workspace,
      workspaceIsLocal: true,
      sessionId: 'test',
      projects: [{ id: 'ovl', mode: 'local', path: userDir, rootFile: 'paper/main.tex' }],
      defaultProject: 'ovl',
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

    const compile = async (args: Record<string, unknown>): Promise<Compiled> => {
      // Past the client's 60 s default: a cold biber run on a loaded CI machine can take that.
      const res = await client.callTool(
        { name: 'compile', arguments: { project: 'ovl', rootFile: 'paper/main.tex', ...args } },
        undefined,
        { timeout: 240_000 },
      );
      const s = res.structuredContent as Compiled | undefined;
      if (s?.success !== true) {
        // CI's TeX is not this machine's: show the log excerpt and the bibliography tool's own
        // log, which the engine's log does not carry.
        const out = res.structuredContent as { logTail?: string; logPath?: string } | undefined;
        const blg = out?.logPath
          ? await readFile(path.join(path.dirname(out.logPath), 'main.blg'), 'utf8').catch(
              (e: unknown) => `(no main.blg: ${String(e)})`,
            )
          : '(no logPath)';
        expect.fail(
          `${JSON.stringify(res.content).slice(0, 4000)}\n${String(out?.logTail)}\n--- main.blg ---\n${blg.slice(-3000)}`,
        );
      }
      return s as Compiled;
    };
    const text = async (args: Record<string, unknown>): Promise<string> => {
      const res = await client.callTool({
        name: 'extract_text',
        arguments: { project: 'ovl', ...args },
      });
      expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
      return ((res.content as Array<{ text?: string }>)[0]?.text ?? '').replace(/\s+/g, ' ');
    };

    // The main build first — which the \include from a subdirectory root alone used to break
    // ("I can't write on file `chap/c1.aux'").
    const main = await compile({});
    expect(main.variant).toBeUndefined();
    const surfaced = path.join(workspace, 'ovl.pdf');
    const surfacedBefore = await readFile(surfaced);
    const mainText = await text({});
    expect(mainText).toContain('Section B original.');
    expect(mainText).toContain('Hello from localsty.');
    expect(mainText).toContain('shared-macro');
    expect(mainText).toContain('Chapter one.');
    expect(mainText).toMatch(/TeXbook/);

    // A text overlay on a file that is NOT the root: the root stays a link in the farm, so this
    // also proves the backend reads the farm's copy of an input and not the source's.
    const textVariant = await compile({
      overlay: [
        {
          file: 'paper/sections/b.tex',
          edits: [{ oldString: 'Section B original.', newString: 'Section B VARIANT.' }],
        },
      ],
    });
    expect(textVariant.variant).toMatch(/^v[0-9a-f]{12}$/);
    const variantText = await text({ variant: textVariant.variant });
    expect(variantText).toContain('Section B VARIANT.');
    expect(variantText).not.toContain('Section B original.');
    expect(variantText).toContain('Chapter one.');
    expect(variantText).toContain('shared-macro');
    expect(variantText).toMatch(/TeXbook/);
    // The build read the overlaid file, so the .fls check (against real latexmk output) is quiet.
    expect(textVariant.hint ?? '').not.toContain('never read');

    // A .bib overlay: read by bibtex/biber, never by the engine — so not reported as unread.
    const bibVariant = await compile({
      overlay: [
        {
          file: 'paper/refs.bib',
          edits: [{ oldString: 'The TeXbook', newString: 'The VARIANTbook' }],
        },
      ],
    });
    expect(bibVariant.hint ?? '').not.toContain('never read');
    expect(await text({ variant: bibVariant.variant })).toContain('VARIANTbook');

    // A file the document never inputs: the variant is the main build, and the hint says why.
    const unusedVariant = await compile({
      overlay: [
        { file: 'paper/unused.tex', edits: [{ oldString: 'Never', newString: 'Still never' }] },
      ],
    });
    expect(unusedVariant.hint).toContain(
      'The build never read the overlaid file "paper/unused.tex"',
    );

    // A layout overlay that changes the page count.
    const pageVariant = await compile({
      overlay: [
        {
          file: 'paper/main.tex',
          edits: [{ oldString: '\\hello\n', newString: '\\hello\n\\newpage\n' }],
        },
      ],
    });
    expect(pageVariant.variant).not.toBe(textVariant.variant);
    expect(main.pageCount).toBeGreaterThan(0);
    expect(pageVariant.pageCount).toBe((main.pageCount ?? 0) + 1);

    // The main build and the surfaced PDF are exactly what the plain compile left.
    expect((await readFile(surfaced)).equals(surfacedBefore)).toBe(true);
    expect(await text({})).toContain('Section B original.');

    // A plain compile afterwards still builds the original.
    const again = await compile({ clean: true });
    expect(again.variant).toBeUndefined();
    expect(again.pageCount).toBe(main.pageCount);
    expect(await text({})).toContain('Section B original.');

    // Every source file byte-identical, and nothing added beside them.
    const after = await snapshot(userDir);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [rel, bytes] of before) {
      expect(after.get(rel)?.equals(bytes), rel).toBe(true);
    }
  }, 900_000);

  it('runs no shell command from an overlay the caller did not opt into, so none writes through the farm', async () => {
    // TeX Live's default `shell_escape = p` lets a document run makeindex with no flag at all.
    // In the farm, sections/a.tex is a link to the SOURCE file, so `makeindex -o sections/a.tex`
    // run from the farm truncated the source. An overlay compile disables shell escape unless the
    // caller asked for it.
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-smoke-ws-'));
    const userDir = await mkdtemp(path.join(os.tmpdir(), 'ovl-smoke-src-'));
    cleanups.push(
      () => rm(workspace, { recursive: true, force: true }),
      () => rm(userDir, { recursive: true, force: true }),
      () => rm(buildDir(userDir), { recursive: true, force: true }),
    );
    const files: Record<string, string> = {
      'main.tex': [
        '\\documentclass{article}',
        '\\begin{document}',
        '\\input{sections/a}',
        '\\end{document}',
        '',
      ].join('\n'),
      'sections/a.tex': 'Section A text.\n',
      'sections/b.tex': 'Section B text.\n',
    };
    for (const [rel, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(userDir, rel)), { recursive: true });
      await writeFile(path.join(userDir, rel), content);
    }
    const before = await snapshot(userDir);

    const config: ServerConfig = {
      workspaceRoot: workspace,
      workspaceIsLocal: true,
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

    const res = await client.callTool(
      {
        name: 'compile',
        arguments: {
          project: 'esc',
          overlay: [
            {
              file: 'main.tex',
              edits: [
                {
                  oldString: '\\begin{document}\n',
                  // makeindex is on TeX Live's restricted allow-list, and its input is an ordinary
                  // project file, so the command is portable wherever TeX Live is.
                  newString:
                    '\\begin{document}\n' +
                    '\\immediate\\write18{makeindex -q -o sections/a.tex sections/b.tex}\n',
                },
              ],
            },
          ],
        },
      },
      undefined,
      { timeout: 240_000 },
    );
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
    const out = res.structuredContent as { hint?: string; logPath?: string; variant?: string };
    expect(out.variant).toMatch(/^v[0-9a-f]{12}$/);
    // The source first: it is the promise. Then why it held — the engine refused the command —
    // and that the caller is told the variant ran without shell escape.
    const after = await snapshot(userDir);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [rel, bytes] of before) {
      expect(after.get(rel)?.toString('utf8'), rel).toBe(bytes.toString('utf8'));
    }
    const log = await readFile(out.logPath ?? '', 'utf8');
    expect(log).toMatch(/runsystem\(makeindex[^)]*\)\.\.\.disabled/);
    expect(out.hint ?? '').toContain('disables shell escape');
  }, 300_000);
});
