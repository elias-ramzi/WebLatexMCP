import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import { CompilerResolver } from '../../src/services/compilerResolver.js';
import { buildDir, buildPdfPath, buildPdfPathIn, logBaseDir } from '../../src/services/compiler.js';
import type { CompileOutcome, CompileRequest } from '../../src/services/compiler.js';
import { variantPaths, writeManifest } from '../../src/lib/variants.js';
import { toPosix } from '../../src/lib/paths.js';
import { createFakeRemote } from './helpers/bareRepo.js';
import { minimalPdf } from '../helpers/minimalPdf.js';
import { expectNoUndeclaredKeys } from '../helpers/outputSchema.js';
import type { ServerConfig } from '../../src/types.js';

/*
 * `compile` with `overlay` (#205), end to end against a stub engine: everything but TeX is real.
 * The stub reads its input THROUGH the working directory it was handed — the variant's link
 * farm — and writes a PDF whose one line is what it read, so the tests see exactly what an engine
 * would have compiled. Then the PDF tools read that variant back by its handle.
 */

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const MAIN_TEX =
  '\\documentclass{article}\n\\begin{document}\n\\input{sections/b}\n\\end{document}\n';
const B_TEX = 'Section B original.\n';

/** An engine that "typesets" sections/b.tex, read through `workDir`, into a one-page PDF. */
function stubCompiler(
  requests: CompileRequest[],
  extraLog = '',
  duringBuild?: (workDir: string) => Promise<void>,
) {
  return {
    isAvailable: async () => true,
    compile: async (req: CompileRequest): Promise<CompileOutcome> => {
      requests.push(req);
      const workDir = req.workDir ?? req.projectDir;
      // What a document can do from inside the farm that the server cannot stop: a project rc
      // re-enabling shell escape, lualatex's io.open, tectonic's unrestricted \openout.
      if (duringBuild) await duringBuild(workDir);
      const outDir = req.outDir ?? buildDir(req.projectDir);
      await mkdir(outDir, { recursive: true });
      const body = (await readFile(path.join(workDir, 'sections/b.tex'), 'utf8')).trim();
      const pdfPath = buildPdfPathIn(outDir, req.rootFile);
      await writeFile(pdfPath, minimalPdf(1, 300, 200, { text: () => body }));
      // The recorder file latexmk asks for: the engine's cwd, then what it opened (relative to it).
      await writeFile(
        path.join(outDir, `${path.basename(req.rootFile, '.tex')}.fls`),
        `PWD ${path.join(workDir, logBaseDir(req.rootFile))}\nINPUT main.tex\nINPUT ./sections/b.tex\n`,
      );
      // One error located in the overlaid file, so the snippet has to come from the variant.
      const log = './sections/b.tex:1: Undefined control sequence.\n' + extraLog;
      return {
        success: true,
        pdfPath,
        durationSec: 0.1,
        log,
        timedOut: false,
        logBaseDir: logBaseDir(req.rootFile),
        rebuilt: true,
      };
    },
  };
}

async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function setup(
  opts: { extraLog?: string; duringBuild?: (workDir: string) => Promise<void> } = {},
) {
  const remote = await createFakeRemote({
    'main.tex': MAIN_TEX,
    'sections/b.tex': B_TEX,
    'notes.tex': 'Notes nobody inputs.\n',
  });
  cleanups.push(remote.cleanup);
  const workspace = await tmp('ovl-overlay-ws-');
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
  ctx.compiler = new CompilerResolver('latexmk', false, () =>
    stubCompiler(requests, opts.extraLog, opts.duringBuild),
  );
  const server = createServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(() => client.close());
  const sync = await client.callTool({
    name: 'project_sync',
    arguments: { project: 'demo', mode: 'clone' },
  });
  expect(sync.isError ?? false, textOf(sync)).toBe(false);
  const clone = path.join(workspace, 'demo');
  cleanups.push(() => rm(buildDir(clone), { recursive: true, force: true }));
  return { client, clone, workspace, requests };
}

function textOf(res: unknown): string {
  return ((res as { content?: Array<{ text?: string }> }).content ?? [])
    .map((c) => c.text ?? '')
    .join('\n');
}

interface CompileOut {
  success: boolean;
  variant?: string;
  pdfPath?: string;
  errors: Array<{ file?: string; line?: number; snippet?: string }>;
}

const OVERLAY = [
  {
    file: 'sections/b.tex',
    edits: [{ oldString: 'Section B original.', newString: 'Section B VARIANT.' }],
  },
];

describe('compile with an overlay', () => {
  it('compiles the edited text in a variant and leaves the source, main build and session alone', async () => {
    const { client, clone, workspace, requests } = await setup();
    // A main build already on disk: the overlay must not touch it.
    const mainPdf = buildPdfPath(clone, 'main.tex');
    await mkdir(path.dirname(mainPdf), { recursive: true });
    const mainBytes = minimalPdf(1, 300, 200, { text: () => 'MAIN BUILD' });
    await writeFile(mainPdf, mainBytes);

    const res = await client.callTool({
      name: 'compile',
      arguments: { rootFile: 'main.tex', overlay: OVERLAY },
    });
    expect(res.isError ?? false, textOf(res)).toBe(false);
    const out = res.structuredContent as unknown as CompileOut;
    expect(out.variant).toMatch(/^v[0-9a-f]{12}$/);
    const paths = variantPaths(clone, out.variant!);

    // The engine ran in the farm, into the variant's own build dir.
    expect(requests).toHaveLength(1);
    expect(requests[0]!.workDir).toBe(paths.src);
    expect(requests[0]!.outDir).toBe(paths.out);
    expect(requests[0]!.projectDir).toBe(clone);
    expect(await readFile(path.join(paths.src, 'sections/b.tex'), 'utf8')).toBe(
      'Section B VARIANT.\n',
    );
    expect(out.pdfPath).toBe(toPosix(buildPdfPathIn(paths.out, 'main.tex')));
    // The error's snippet is the variant's text, the one the engine compiled.
    expect(out.errors[0]?.file).toBe('sections/b.tex');
    expect(out.errors[0]?.snippet).toContain('Section B VARIANT.');
    expect(textOf(res)).toContain(`variant ${out.variant}: pass variant to render_pages`);
    expect(textOf(res)).toMatch(/^compiled variant v[0-9a-f]{12} of main\.tex/);

    // The source is byte-identical, nothing was surfaced, the main build is untouched.
    expect(await readFile(path.join(clone, 'sections/b.tex'), 'utf8')).toBe(B_TEX);
    expect(await readFile(path.join(clone, 'main.tex'), 'utf8')).toBe(MAIN_TEX);
    await expect(stat(path.join(workspace, 'demo.pdf'))).rejects.toThrow();
    expect((await readFile(mainPdf)).equals(mainBytes)).toBe(true);

    // Nothing is recorded as this session's change.
    const status = await client.callTool({ name: 'status', arguments: {} });
    const st = status.structuredContent as { clean: boolean; sessionChanges: unknown[] };
    expect(st.sessionChanges).toEqual([]);
    expect(st.clean).toBe(true);

    // And no baseline was recorded. Nothing read the file before the overlay did, so a baseline
    // now could only have come from the overlay — of the original bytes or of the edited ones.
    // Change the file by hand: with a baseline of either, the next edit would be refused as an
    // external change; with none, it goes through.
    await writeFile(path.join(clone, 'sections/b.tex'), `${B_TEX}Added by hand.\n`);
    const edit = await client.callTool({
      name: 'edit_file',
      arguments: {
        path: 'sections/b.tex',
        edits: [{ oldString: 'original', newString: 'edited' }],
      },
    });
    expect(edit.isError ?? false, textOf(edit)).toBe(false);

    await expectNoUndeclaredKeys(client, 'compile', res.structuredContent);
  });

  it('qualifies "untouched" when shell escape was on', async () => {
    const { client } = await setup();
    const plain = await client.callTool({ name: 'compile', arguments: { overlay: OVERLAY } });
    expect(textOf(plain)).toContain(
      'The source (checked: no project file changed while it built), the main build, the ' +
        'surfaced PDF and the viewer are untouched. Shell escape was off for this build.',
    );
    const escaped = await client.callTool({
      name: 'compile',
      arguments: { overlay: OVERLAY, restrictedShellEscape: true },
    });
    expect(textOf(escaped)).toContain(
      "Shell escape was on, so the document's shell commands could write anywhere",
    );
  });

  it('disables shell escape for a variant the caller did not opt in for, and only then', async () => {
    // TeX Live's default `shell_escape = p` runs allow-listed commands with no flag; in the farm a
    // `makeindex -o sections/b.tex` writes the source through its link. So a variant asks the
    // backend for -no-shell-escape — and a normal compile's request is exactly what it was.
    const { client, requests } = await setup();
    await client.callTool({ name: 'compile', arguments: {} });
    await client.callTool({ name: 'compile', arguments: { overlay: OVERLAY } });
    await client.callTool({
      name: 'compile',
      arguments: { overlay: OVERLAY, restrictedShellEscape: true },
    });
    await client.callTool({ name: 'compile', arguments: { overlay: OVERLAY, shellEscape: true } });
    expect(requests).toHaveLength(4);
    expect(requests.map((r) => r.noShellEscape)).toEqual([undefined, true, undefined, undefined]);
    expect(requests[0]).not.toHaveProperty('noShellEscape');
  });

  it('says when a variant refused a shell command, and never for a normal compile', async () => {
    const { client } = await setup({
      extraLog: 'runsystem(makeindex -q -o sections/b.tex main.tex)...disabled.\n',
    });
    const hintOf = (res: unknown) =>
      (res as { structuredContent?: { hint?: string } }).structuredContent?.hint ?? '';
    const variant = await client.callTool({ name: 'compile', arguments: { overlay: OVERLAY } });
    expect(hintOf(variant)).toContain('an overlay compile disables shell escape');
    expect(hintOf(variant)).toContain('restrictedShellEscape: true');
    expect(textOf(variant)).toContain('lifts that guarantee');
    // A normal compile never passed -no-shell-escape, so the line is not the server's doing.
    const plain = await client.callTool({ name: 'compile', arguments: {} });
    expect(hintOf(plain)).not.toContain('disables shell escape');
    // Opted in: the caller already knows, and the flag was theirs.
    const optedIn = await client.callTool({
      name: 'compile',
      arguments: { overlay: OVERLAY, restrictedShellEscape: true },
    });
    expect(hintOf(optedIn)).not.toContain('disables shell escape');
  });

  it('refuses to overlay a latexmk rc file, before compiling or staging anything', async () => {
    const { client, clone, requests } = await setup();
    await writeFile(path.join(clone, '.latexmkrc'), '$pdf_mode = 1;\n');
    const res = await client.callTool({
      name: 'compile',
      arguments: {
        overlay: [
          {
            file: '.latexmkrc',
            edits: [{ oldString: '$pdf_mode = 1;', newString: 'system("touch pwned");' }],
          },
        ],
      },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('".latexmkrc") is a latexmk configuration file');
    expect(requests).toHaveLength(0);
    expect(await readFile(path.join(clone, '.latexmkrc'), 'utf8')).toBe('$pdf_mode = 1;\n');
    await expect(stat(path.join(buildDir(clone), 'variants'))).rejects.toThrow();
  });

  it('refuses an overlay whose root file is reached through a linked directory', async () => {
    // latexmk's -cd chdir()s into the root's directory; in the farm a linked directory is ONE link
    // to the source's absolute path, so the engine would run inside the SOURCE directory, read none
    // of the farm's overlays and write relative names into the source — or, once an overlay
    // materialised the directory, resolve `../` against the link's parent instead of its target.
    const { client, clone, requests } = await setup();
    const real = path.join(clone, 'drafts', 'p1');
    await mkdir(real, { recursive: true });
    await writeFile(path.join(real, 'main.tex'), MAIN_TEX);
    // 'junction' is ignored on POSIX and is what win32 can create without a privilege.
    await symlink(real, path.join(clone, 'paper'), 'junction');
    const res = await client.callTool({
      name: 'compile',
      arguments: { rootFile: 'paper/main.tex', overlay: OVERLAY },
    });
    expect(res.isError, textOf(res)).toBe(true);
    expect(textOf(res)).toContain('through "paper", which is a symbolic link');
    expect(textOf(res)).toContain('rootFile: "drafts/p1/main.tex"');
    expect(requests).toHaveLength(0);
    expect(await readFile(path.join(real, 'main.tex'), 'utf8')).toBe(MAIN_TEX);
    expect(await readFile(path.join(clone, 'sections/b.tex'), 'utf8')).toBe(B_TEX);
    await expect(stat(path.join(buildDir(clone), 'variants'))).rejects.toThrow();

    // The same document named through its real path is an ordinary overlay compile.
    const ok = await client.callTool({
      name: 'compile',
      arguments: { rootFile: 'drafts/p1/main.tex', overlay: OVERLAY },
    });
    expect(ok.isError ?? false, textOf(ok)).toBe(false);
    const out = ok.structuredContent as unknown as CompileOut;
    expect(out.success).toBe(true);
    expect(out.variant).toMatch(/^v[0-9a-f]{12}$/);
    expect(requests).toHaveLength(1);
    expect(toPosix(requests[0]!.rootFile)).toBe('drafts/p1/main.tex');
  });

  it('names a project file the build changed, and never then calls the source untouched', async () => {
    // A write from inside the farm through a file's link lands in the SOURCE (on win32 the farm's
    // file is a hard link to it, which a write reaches just the same). The server cannot stop
    // every such write, so it checks the project's files before and after, and says what changed.
    const { client, clone } = await setup({
      duringBuild: (workDir) => writeFile(path.join(workDir, 'notes.tex'), 'PWNED\n'),
    });
    const res = await client.callTool({ name: 'compile', arguments: { overlay: OVERLAY } });
    expect(res.isError ?? false, textOf(res)).toBe(false);
    // The stub really did reach the source: this is the case being reported, not a hypothetical.
    expect(await readFile(path.join(clone, 'notes.tex'), 'utf8')).toBe('PWNED\n');
    const hint = (res.structuredContent as { hint?: string }).hint ?? '';
    expect(hint).toContain('changed 1 project file(s) while it ran: "notes.tex"');
    expect(textOf(res)).not.toMatch(/source[^.]*untouched/i);
    expect(textOf(res)).toContain('CHANGED');
    await expectNoUndeclaredKeys(client, 'compile', res.structuredContent);
  });

  it('does not claim shell escape was disabled when the log shows the project re-enabled it', async () => {
    // latexmk's -no-shell-escape reaches the engine only through %O: a project latexmkrc of
    // `$pdflatex = 'pdflatex %O -shell-escape %S'` (or one with no %O) turns it back on, and the
    // engine's banner is what says so.
    const { client } = await setup({ extraLog: ' \\write18 enabled.\n' });
    const res = await client.callTool({ name: 'compile', arguments: { overlay: OVERLAY } });
    expect(res.isError ?? false, textOf(res)).toBe(false);
    expect(textOf(res)).not.toMatch(/shell escape was disabled/i);
    expect(textOf(res)).toContain("a latexmkrc (the project's own, or a user or system one)");
  });

  it('refuses a root spelled with `..` or as an absolute path, before staging anything', async () => {
    // lstat judged the normalised spelling while latexmk got the raw one: `paper/../p1/main.tex`
    // normalises to a p1/ that does not exist, and -cd resolved it physically — through the
    // farm's link to drafts/p1, so the engine ran inside the SOURCE directory. And an absolute
    // root sent -cd straight into the source.
    const { client, clone, requests } = await setup();
    const real = path.join(clone, 'drafts', 'p1');
    await mkdir(real, { recursive: true });
    await writeFile(path.join(real, 'main.tex'), MAIN_TEX);
    await symlink(real, path.join(clone, 'paper'), 'junction');
    const dotted = await client.callTool({
      name: 'compile',
      arguments: { rootFile: 'paper/../p1/main.tex', overlay: OVERLAY },
    });
    expect(dotted.isError, textOf(dotted)).toBe(true);
    expect(textOf(dotted)).toContain('".."');
    const absolute = await client.callTool({
      name: 'compile',
      arguments: { rootFile: path.join(clone, 'drafts', 'p1', 'main.tex'), overlay: OVERLAY },
    });
    expect(absolute.isError, textOf(absolute)).toBe(true);
    expect(textOf(absolute)).toContain('rootFile: "drafts/p1/main.tex"');
    expect(requests).toHaveLength(0);
    await expect(stat(path.join(buildDir(clone), 'variants'))).rejects.toThrow();
  });

  it('says when the build never read an overlaid file, and only then', async () => {
    const { client } = await setup();
    const unread = await client.callTool({
      name: 'compile',
      arguments: {
        rootFile: 'main.tex',
        overlay: [{ file: 'notes.tex', edits: [{ oldString: 'Notes', newString: 'Changed' }] }],
      },
    });
    expect(unread.isError ?? false, textOf(unread)).toBe(false);
    const hint = (unread.structuredContent as { hint?: string }).hint ?? '';
    expect(hint).toContain('The build never read the overlaid file "notes.tex"');
    expect(textOf(unread)).toContain('never read the overlaid file "notes.tex"');

    const read = await client.callTool({
      name: 'compile',
      arguments: { rootFile: 'main.tex', overlay: OVERLAY },
    });
    expect((read.structuredContent as { hint?: string }).hint ?? '').not.toContain('never read');
  });

  it('refuses a duplicate file, a missing file, too many edits and a non-UTF-8 file', async () => {
    const { client, clone, requests } = await setup();
    await writeFile(path.join(clone, 'latin1.tex'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    const edit = { oldString: 'x', newString: 'y' };
    const cases: Array<[unknown, RegExp]> = [
      [
        [
          { file: 'sections/b.tex', edits: [edit] },
          { file: './sections/b.tex', edits: [edit] },
        ],
        /name each file once and list all its edits in that entry/,
      ],
      [[{ file: 'sections/nope.tex', edits: [edit] }], /no such file/],
      [[{ file: 'main.tex', edits: Array(101).fill(edit) }], /101 edits; at most 100/],
      [[{ file: 'latin1.tex', edits: [edit] }], /not valid UTF-8/],
    ];
    for (const [overlay, message] of cases) {
      const res = await client.callTool({ name: 'compile', arguments: { overlay } });
      expect(res.isError, textOf(res)).toBe(true);
      expect(textOf(res)).toMatch(message);
    }
    expect(requests).toHaveLength(0);
  });
});

describe('PDF tools read a variant by its handle', () => {
  const HANDLE = 'v0123456789ab';

  /** A variant compiled from main.tex, with its own PDF, .aux and .log; and a main build. */
  async function stage(clone: string): Promise<{ variantPdf: string }> {
    const paths = variantPaths(clone, HANDLE);
    await mkdir(paths.out, { recursive: true });
    await writeManifest(paths.manifest, {
      rootFile: 'main.tex',
      createdAt: new Date().toISOString(),
      usedAt: new Date().toISOString(),
      files: ['sections/b.tex'],
      compiler: 'latexmk',
      engine: 'pdflatex',
    });
    const variantPdf = buildPdfPathIn(paths.out, 'main.tex');
    await writeFile(
      variantPdf,
      minimalPdf(2, 300, 200, { text: (n) => `VARIANT page ${n}, Figure 1 caption\n${n}` }),
    );
    await writeFile(
      path.join(paths.out, 'main.aux'),
      '\\relax\n\\newlabel{fig:x}{{1}{2}{A caption}{figure.1}{}}\n',
    );
    await writeFile(path.join(paths.out, 'main.log'), 'This is pdfTeX, Version 3.141592653\n');
    const mainPdf = buildPdfPath(clone, 'main.tex');
    await writeFile(mainPdf, minimalPdf(3, 300, 200, { text: (n) => `MAIN page ${n}` }));
    return { variantPdf };
  }

  it('extract_text, render_pages and pdf_geometry read the variant, and echo it', async () => {
    const { client, clone } = await setup();
    const { variantPdf } = await stage(clone);

    const text = await client.callTool({
      name: 'extract_text',
      arguments: { variant: HANDLE, labels: ['fig:x'] },
    });
    expect(text.isError ?? false, textOf(text)).toBe(false);
    const ts = text.structuredContent as {
      variant?: string;
      pdfPath: string;
      pageCount: number;
      pages: Array<{ lines: string[] }>;
    };
    expect(ts.variant).toBe(HANDLE);
    expect(ts.pdfPath).toBe(toPosix(variantPdf));
    expect(ts.pageCount).toBe(2);
    // fig:x resolved through the VARIANT's .aux (the main build has none).
    expect(ts.pages[0]?.lines).toEqual(['VARIANT page 2, Figure 1 caption', '2']);
    expect(textOf(text)).toContain(`(variant ${HANDLE})`);
    await expectNoUndeclaredKeys(client, 'extract_text', text.structuredContent);

    const render = await client.callTool({
      name: 'render_pages',
      arguments: { variant: HANDLE, pages: [1], inline: false },
    });
    expect(render.isError ?? false, textOf(render)).toBe(false);
    const rs = render.structuredContent as {
      variant?: string;
      pdfPath: string;
      outDir: string;
      pages: Array<{ pngPath: string }>;
    };
    expect(rs.variant).toBe(HANDLE);
    expect(rs.pdfPath).toBe(toPosix(variantPdf));
    const renderDir = toPosix(variantPaths(clone, HANDLE).render);
    expect(rs.outDir).toBe(renderDir);
    expect(rs.pages[0]?.pngPath.startsWith(`${renderDir}/`)).toBe(true);
    await expect(stat(rs.pages[0]!.pngPath)).resolves.toBeTruthy();
    await expectNoUndeclaredKeys(client, 'render_pages', render.structuredContent);

    const geo = await client.callTool({
      name: 'pdf_geometry',
      arguments: { variant: HANDLE, kinds: ['text', 'floats'] },
    });
    expect(geo.isError ?? false, textOf(geo)).toBe(false);
    const gs = geo.structuredContent as {
      variant?: string;
      pdfPath: string;
      pageCount: number;
      floats: unknown[];
    };
    expect(gs.variant).toBe(HANDLE);
    expect(gs.pdfPath).toBe(toPosix(variantPdf));
    expect(gs.pageCount).toBe(2);
    expect(gs.floats).toEqual([{ label: 'fig:x', number: '1', page: '2' }]);
    await expectNoUndeclaredKeys(client, 'pdf_geometry', geo.structuredContent);

    // Without `variant`, the main build is what they read.
    const main = await client.callTool({ name: 'extract_text', arguments: { pages: [1] } });
    const ms = main.structuredContent as { variant?: string; pages: Array<{ lines: string[] }> };
    expect(ms.variant).toBeUndefined();
    expect(ms.pages[0]?.lines).toEqual(['MAIN page 1']);
  });

  it('pdf_geometry floats-only on a variant without a PDF says the variant produced none', async () => {
    const { client, clone } = await setup();
    await stage(clone);
    await rm(buildPdfPathIn(variantPaths(clone, HANDLE).out, 'main.tex'));
    const res = await client.callTool({
      name: 'pdf_geometry',
      arguments: { variant: HANDLE, kinds: ['floats'] },
    });
    expect(res.isError ?? false, textOf(res)).toBe(false);
    expect(textOf(res)).toContain(`no PDF (kinds: floats only; variant ${HANDLE} produced none)`);
    expect(textOf(res)).not.toContain('none was ever compiled');
    expect((res.structuredContent as { floats: unknown[] }).floats).toHaveLength(1);
  });

  it('refuses an invalid handle, an unknown variant and a different rootFile', async () => {
    const { client, clone } = await setup();
    await stage(clone);
    for (const name of ['extract_text', 'render_pages', 'pdf_geometry']) {
      const invalid = await client.callTool({ name, arguments: { variant: '../main' } });
      expect(invalid.isError, name).toBe(true);
      expect(textOf(invalid)).toContain('Not a variant handle: "../main"');

      const unknown = await client.callTool({ name, arguments: { variant: 'v999999999999' } });
      expect(unknown.isError, name).toBe(true);
      expect(textOf(unknown)).toMatch(/No variant "v999999999999" for project "demo".*evicted/);

      const mismatch = await client.callTool({
        name,
        arguments: { variant: HANDLE, rootFile: 'other.tex' },
      });
      expect(mismatch.isError, name).toBe(true);
      expect(textOf(mismatch)).toContain('was compiled from "main.tex", not "other.tex"');
    }
  });

  it('reads a variant an overlay compile made, end to end', async () => {
    const { client } = await setup();
    const compiled = await client.callTool({
      name: 'compile',
      arguments: { rootFile: 'main.tex', overlay: OVERLAY },
    });
    const handle = (compiled.structuredContent as { variant: string }).variant;
    const text = await client.callTool({ name: 'extract_text', arguments: { variant: handle } });
    expect(textOf(text)).toContain('Section B VARIANT.');
    const plain = await client.callTool({ name: 'compile', arguments: { rootFile: 'main.tex' } });
    expect((plain.structuredContent as { variant?: string }).variant).toBeUndefined();
    const main = await client.callTool({ name: 'extract_text', arguments: {} });
    expect(textOf(main)).toContain('Section B original.');
    expect(textOf(main)).not.toContain('VARIANT');
  });
});
