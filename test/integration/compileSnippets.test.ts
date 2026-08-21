import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import { logBaseDir } from '../../src/services/compiler.js';
import type { CompileOutcome, CompileRequest } from '../../src/services/compiler.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * The compile tool end to end, against a stub engine: everything but TeX is real — the tool, the
 * project manager, the sandboxed FileService and the revision tracker — so these pin the behaviour
 * a caller actually sees, which unit tests over the snippet layer alone cannot.
 */

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** A stand-in engine that returns a canned log, so no TeX is needed. */
function stubCompiler(log: string) {
  return {
    isAvailable: async () => true,
    compile: async (req: CompileRequest): Promise<CompileOutcome> => ({
      success: false,
      durationSec: 0.1,
      log,
      timedOut: false,
      logBaseDir: logBaseDir(req.rootFile),
    }),
  };
}

async function setup(files: Record<string, string>, log: string) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-snipws-'));
  const userDir = await mkdtemp(path.join(os.tmpdir(), 'ovl-snipdir-'));
  cleanups.push(
    () => rm(workspace, { recursive: true, force: true }),
    () => rm(userDir, { recursive: true, force: true }),
  );
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(userDir, rel)), { recursive: true });
    await writeFile(path.join(userDir, rel), content, 'utf8');
  }

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
  ctx.compiler = stubCompiler(log);
  const server = createServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(() => client.close());
  return { client, userDir };
}

function textOf(res: unknown): string {
  const content = (res as { content?: Array<{ text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? '').join('\n');
}

describe('compile: source context', () => {
  it('does not disarm the out-of-band-edit guard, root file detection included', async () => {
    // No main.tex, so detecting the root has to *read* the .tex files — the path that used to
    // record a baseline for every one of them, on every compile.
    const { client, userDir } = await setup(
      { 'paper.tex': '\\documentclass{article}\n\\begin{document}\nhi\n\\end{document}\n' },
      './paper.tex:3: Undefined control sequence.\nl.3 hi',
    );

    await client.callTool({ name: 'read_file', arguments: { project: 'doc', path: 'paper.tex' } });
    // The user edits the file directly, in their own editor.
    await writeFile(path.join(userDir, 'paper.tex'), 'EDITED BY HAND\n', 'utf8');
    await client.callTool({ name: 'compile', arguments: { project: 'doc' } });

    const write = await client.callTool({
      name: 'write_file',
      arguments: { project: 'doc', path: 'paper.tex', content: 'from the agent\n' },
    });
    expect(textOf(write)).toMatch(/changed on disk/);
    expect(await readFile(path.join(userDir, 'paper.tex'), 'utf8')).toBe('EDITED BY HAND\n');
  });

  it('returns the source around each error in structuredContent and in the text', async () => {
    const body = [
      '\\documentclass{article}',
      '\\begin{document}',
      'bad \\nope',
      'ok',
      '\\end{document}',
      '',
    ];
    const { client } = await setup(
      { 'main.tex': body.join('\n') },
      ['./main.tex:3: Undefined control sequence.', 'l.3 bad \\nope', ''].join('\n'),
    );

    const res = await client.callTool({ name: 'compile', arguments: { project: 'doc' } });
    const structured = res.structuredContent as {
      errors: Array<{ line?: number; snippet?: string; snippetStartLine?: number }>;
      omittedSnippetLocations: number;
    };

    expect(structured.errors[0]?.snippet).toContain('bad \\nope');
    expect(structured.errors[0]?.snippetStartLine).toBe(1);
    expect(structured.omittedSnippetLocations).toBe(0);
    // A client that strips structuredContent still gets it, numbered and marked.
    expect(textOf(res)).toContain('> 3 | bad \\nope');
  });

  it('rebases a warning’s file too, so read_file can open it', async () => {
    const { client } = await setup(
      {
        'paper/main.tex': '\\documentclass{article}\n\\begin{document}\nhi\n\\end{document}\n',
        'paper/sections/intro.tex': 'one\ntwo\nthree\n',
      },
      [
        '(./sections/intro.tex',
        "LaTeX Warning: Reference `fig:x' undefined on input line 2.",
        ')',
      ].join('\n'),
    );

    const res = await client.callTool({
      name: 'compile',
      arguments: { project: 'doc', rootFile: 'paper/main.tex' },
    });
    const structured = res.structuredContent as { warnings: Array<{ file?: string }> };
    expect(structured.warnings[0]?.file).toBe('paper/sections/intro.tex');

    // The point of rebasing: the path a diagnostic names is one the caller can open.
    const read = await client.callTool({
      name: 'read_file',
      arguments: { project: 'doc', path: structured.warnings[0]?.file },
    });
    expect(read.isError ?? false).toBe(false);
  });

  it('reads the root file’s own directory, not a same-named file at the project root', async () => {
    // latexmk's -cd makes the log say "./main.tex" for a document at paper/main.tex.
    const { client } = await setup(
      {
        'paper/main.tex':
          '\\documentclass{article}\n\\begin{document}\nreal \\nope\n\\end{document}\n',
        'main.tex': 'DECOY 1\nDECOY 2\nDECOY LINE 3\nDECOY 4\n',
      },
      ['./main.tex:3: Undefined control sequence.', 'l.3 real \\nope', ''].join('\n'),
    );

    const res = await client.callTool({
      name: 'compile',
      arguments: { project: 'doc', rootFile: 'paper/main.tex' },
    });
    const structured = res.structuredContent as {
      errors: Array<{ file?: string; snippet?: string }>;
    };
    expect(structured.errors[0]?.file).toBe('paper/main.tex');
    expect(structured.errors[0]?.snippet).toContain('real \\nope');
    expect(structured.errors[0]?.snippet).not.toContain('DECOY');
    expect(textOf(res)).not.toContain('DECOY');
  });

  it('prints every excerpt it read, even past the error-listing window', async () => {
    // The routine pair — "Undefined control sequence" then "Missing $ inserted" — puts two errors
    // on each line, so twelve errors span six locations. Capping the text by error position
    // dropped excerpts the client that cannot read structuredContent will never see otherwise.
    const body = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
    const log: string[] = [];
    for (let i = 1; i <= 6; i++) {
      log.push(`./main.tex:${i}: Undefined control sequence.`, `l.${i} line ${i}`);
      log.push(`./main.tex:${i}: Missing $ inserted.`, `l.${i} line ${i}`);
    }
    const { client } = await setup({ 'main.tex': body }, log.join('\n'));

    const res = await client.callTool({ name: 'compile', arguments: { project: 'doc' } });
    const structured = res.structuredContent as {
      errors: Array<{ snippet?: string }>;
      omittedSnippetLocations: number;
    };
    const text = textOf(res);

    expect(structured.errors).toHaveLength(12);
    const withSnippet = structured.errors.filter((e) => e.snippet !== undefined);
    expect(withSnippet).toHaveLength(6); // one per location
    expect(structured.omittedSnippetLocations).toBe(0);
    // Every one of them reaches the text, marked at its own line.
    for (let i = 1; i <= 6; i++) expect(text).toContain(`> ${i} | line ${i}`);
  });

  it('shows source for an accented document, where the elision cuts a character in half', async () => {
    // The whole log line, verbatim from a real pdflatex run on the source below.
    const line =
      'Nous considérons une méthode qui améliore nettement la précision pour la tache ' +
      'etudiee ici \\undefmac3 fin.';
    const { client } = await setup(
      { 'main.tex': `\\documentclass{article}\n\\begin{document}\n${line}\n\\end{document}\n` },
      [
        './main.tex:3: Undefined control sequence.',
        '...\uFFFDcision pour la tache etudiee ici \\undefmac'.replace(/^/, 'l.3 '),
        '',
      ].join('\n'),
    );

    const res = await client.callTool({ name: 'compile', arguments: { project: 'doc' } });
    const structured = res.structuredContent as {
      errors: Array<{ snippet?: string }>;
      omittedSnippetLocations: number;
    };
    expect(structured.errors[0]?.snippet).toContain('undefmac');
    expect(structured.omittedSnippetLocations).toBe(0);
    expect(textOf(res)).toContain('> 3 |');
  });

  it('says how many locations went without context instead of leaving a silent gap', async () => {
    const { client } = await setup(
      { 'main.tex': '\\documentclass{article}\n\\begin{document}\nhi\n\\end{document}\n' },
      // A file the compile never opened, named by the document, and one line past the end.
      [
        './secrets.env:2: Undefined control sequence.',
        './main.tex:99: Undefined control sequence.',
        '',
      ].join('\n'),
    );

    const res = await client.callTool({ name: 'compile', arguments: { project: 'doc' } });
    const structured = res.structuredContent as {
      errors: Array<{ snippet?: string }>;
      omittedSnippetLocations: number;
    };
    expect(structured.errors.every((e) => e.snippet === undefined)).toBe(true);
    expect(structured.omittedSnippetLocations).toBe(2);
    const text = textOf(res);
    expect(text).toContain('no source context for 2 error location(s)');
    // The reason that dominates in practice — and always, under tectonic — has to be among the
    // ones named, or the caller goes hunting for a cap that was never hit.
    expect(text).toMatch(/did not name the file and line outright/);
  });
});
