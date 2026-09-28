import { describe, it, expect, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import { CompilerResolver } from '../../src/services/compilerResolver.js';
import {
  buildDir,
  buildPdfPath,
  buildPdfPathIn,
  latexmkArgs,
  logBaseDir,
} from '../../src/services/compiler.js';
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

/** How the stub engine behaves on its next run; tests flip it between calls. */
interface StubBehaviour {
  /** Abort on main.tex, before ever opening sections/b.tex: no PDF, and a .fls without it. */
  failEarly?: boolean;
  /** Appended to a successful run's log. */
  extraLog?: string;
  /** Run inside the build, with the directory the engine was handed. */
  duringBuild?: (workDir: string) => Promise<void>;
}

/** An engine that "typesets" sections/b.tex, read through `workDir`, into a one-page PDF. */
function stubCompiler(requests: CompileRequest[], behaviour: StubBehaviour = {}) {
  return {
    isAvailable: async () => true,
    compile: async (req: CompileRequest): Promise<CompileOutcome> => {
      requests.push(req);
      const workDir = req.workDir ?? req.projectDir;
      // What a document can do from inside the farm that the server cannot stop: a project rc
      // re-enabling shell escape, lualatex's io.open, tectonic's unrestricted \openout.
      if (behaviour.duringBuild) await behaviour.duringBuild(workDir);
      const outDir = req.outDir ?? buildDir(req.projectDir);
      await mkdir(outDir, { recursive: true });
      if (behaviour.failEarly) {
        await writeFile(
          path.join(outDir, `${path.basename(req.rootFile, '.tex')}.fls`),
          `PWD ${path.join(workDir, logBaseDir(req.rootFile))}\nINPUT main.tex\n`,
        );
        return {
          success: false,
          durationSec: 0.1,
          log: './main.tex:3: Undefined control sequence.\n',
          timedOut: false,
          logBaseDir: logBaseDir(req.rootFile),
          rebuilt: false,
        };
      }
      const body = (await readFile(path.join(workDir, 'sections/b.tex'), 'utf8')).trim();
      const pdfPath = buildPdfPathIn(outDir, req.rootFile);
      await writeFile(pdfPath, minimalPdf(1, 300, 200, { text: () => body }));
      // The recorder file latexmk asks for: the engine's cwd, then what it opened (relative to it).
      await writeFile(
        path.join(outDir, `${path.basename(req.rootFile, '.tex')}.fls`),
        `PWD ${path.join(workDir, logBaseDir(req.rootFile))}\nINPUT main.tex\nINPUT ./sections/b.tex\n`,
      );
      // One error located in the overlaid file, so the snippet has to come from the variant.
      const log = './sections/b.tex:1: Undefined control sequence.\n' + (behaviour.extraLog ?? '');
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
  const behaviour: StubBehaviour = { extraLog: opts.extraLog, duringBuild: opts.duringBuild };
  ctx.compiler = new CompilerResolver('latexmk', false, () => stubCompiler(requests, behaviour));
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
  return { client, clone, workspace, requests, behaviour };
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
      'The source (checked: no project file changed while it built — of .git, only its ' +
        'hooks, config and info/ are checked), the main build, the surfaced PDF and the viewer ' +
        'are untouched. Shell escape was off for this build.',
    );
    const escaped = await client.callTool({
      name: 'compile',
      arguments: { overlay: OVERLAY, restrictedShellEscape: true },
    });
    expect(textOf(escaped)).toContain(
      "Shell escape was on, so the document's shell commands could write anywhere",
    );
  });

  it('disables shell escape for a variant the caller did not opt in for, as for any compile', async () => {
    // TeX Live's default `shell_escape = p` runs allow-listed commands with no flag; in the farm a
    // `makeindex -o sections/b.tex` writes the source through its link. So latexmk gets
    // -no-shell-escape unless the caller opted in — for a normal compile too (#213).
    const { client, requests } = await setup();
    await client.callTool({ name: 'compile', arguments: {} });
    await client.callTool({ name: 'compile', arguments: { overlay: OVERLAY } });
    await client.callTool({
      name: 'compile',
      arguments: { overlay: OVERLAY, restrictedShellEscape: true },
    });
    await client.callTool({ name: 'compile', arguments: { overlay: OVERLAY, shellEscape: true } });
    expect(requests).toHaveLength(4);
    const shellFlags = requests.map((r) => latexmkArgs(r, '/build').filter((a) => /shell/.test(a)));
    expect(shellFlags).toEqual([
      ['-no-shell-escape'],
      ['-no-shell-escape'],
      ['-shell-restricted'],
      ['-shell-escape'],
    ]);
  });

  it("says when a variant refused a shell command, in the overlay's own words", async () => {
    const { client } = await setup({
      extraLog: 'runsystem(makeindex -q -o sections/b.tex main.tex)...disabled.\n',
    });
    const hintOf = (res: unknown) =>
      (res as { structuredContent?: { hint?: string } }).structuredContent?.hint ?? '';
    const variant = await client.callTool({ name: 'compile', arguments: { overlay: OVERLAY } });
    expect(hintOf(variant)).toContain('an overlay compile disables shell escape');
    expect(hintOf(variant)).toContain('restrictedShellEscape: true');
    expect(textOf(variant)).toContain('lifts that guarantee');
    // A normal compile disables shell escape too (#213) and says so — in its own words, since
    // there are no links to the source to warn about.
    const plain = await client.callTool({ name: 'compile', arguments: {} });
    expect(hintOf(plain)).not.toContain('disables shell escape');
    expect(hintOf(plain)).toContain('The engine refused a shell command');
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

  it.skipIf(process.platform === 'win32')(
    'says which path kept the source from being checked, and never calls it unchanged',
    async () => {
      // A committed link loop cannot be followed, so every overlay compile fails the check; the
      // result names the path and the reason, or the caller cannot tell why it never passes.
      const { client, clone } = await setup();
      await symlink(path.join(clone, 'loop.tex'), path.join(clone, 'loop.tex'));
      const res = await client.callTool({ name: 'compile', arguments: { overlay: OVERLAY } });
      expect(res.isError ?? false, textOf(res)).toBe(false);
      expect(textOf(res)).toContain(
        'whether the build wrote a project file could not be checked this time ' +
          '("loop.tex" could not be examined (ELOOP)).',
      );
      expect(textOf(res)).not.toContain('checked: no project file changed');
    },
  );

  it('names a write through a link into the workspace when a local project contains it', async () => {
    // The workspace-local layout: a local project registered at the launch dir holds the
    // workspace, and a project link reaches into a sibling clone. The workspace is left out of
    // the check by equality only — pinned here at the wiring, since a containment skip there
    // passes every library test and reports this write as "no project file changed".
    const project = await tmp('ovl-local-');
    const workspace = path.join(project, '.web_latex_mcp');
    await mkdir(path.join(workspace, 'shared', 'figs'), { recursive: true });
    await mkdir(path.join(project, 'sections'));
    await writeFile(path.join(project, 'main.tex'), MAIN_TEX);
    await writeFile(path.join(project, 'sections/b.tex'), B_TEX);
    // A directory link: a junction on Windows, which needs no privilege.
    await symlink(path.join(workspace, 'shared', 'figs'), path.join(project, 'figs'), 'junction');
    const config: ServerConfig = {
      workspaceRoot: workspace,
      workspaceIsLocal: true,
      sessionId: 'test',
      projects: [{ id: 'loc', mode: 'local', path: project }],
      defaultProject: 'loc',
    };
    const ctx = createContext(
      config,
      new CredentialResolver({}),
      { name: 'Test', email: 'test@example.com' },
      new ProjectRegistry(workspace),
    );
    const requests: CompileRequest[] = [];
    ctx.compiler = new CompilerResolver('latexmk', false, () =>
      stubCompiler(requests, {
        duringBuild: (workDir) => writeFile(path.join(workDir, 'figs', 'new.pdf'), 'x'),
      }),
    );
    const server = createServer(ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(() => client.close());
    cleanups.push(() => rm(buildDir(project), { recursive: true, force: true }));

    const res = await client.callTool({ name: 'compile', arguments: { overlay: OVERLAY } });
    expect(res.isError ?? false, textOf(res)).toBe(false);
    // The stub really wrote into the sibling directory through the farm's link.
    expect(await readFile(path.join(workspace, 'shared', 'figs', 'new.pdf'), 'utf8')).toBe('x');
    const hint = (res.structuredContent as { hint?: string }).hint ?? '';
    expect(hint).toContain('changed 1 project file(s) while it ran: "figs/new.pdf"');
    expect(textOf(res)).toContain('CHANGED');
    expect(textOf(res)).not.toContain('checked: no project file changed');
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

  it('refuses a root spelled with `..`, absolute or drive-qualified, before reading or staging anything', async () => {
    // One check (refuseLinkedRootDir) on the RAW spelling. lstat judged the normalised spelling
    // while latexmk got the raw one: `paper/../p1/main.tex` normalises to a p1/ that does not
    // exist, and -cd resolved it physically — through the farm's link to drafts/p1, so the engine
    // ran inside the SOURCE directory. `../demo/main.tex` names a file INSIDE the project (the
    // clone is `<workspace>/demo`), but in the variant's mirror a sibling of the mirror: refused by
    // spelling, not resolution. An absolute root sends -cd straight into the source, and a drive
    // prefix is refused on every platform, not only where Windows would read it.
    const { client, clone, requests } = await setup();
    const real = path.join(clone, 'drafts', 'p1');
    await mkdir(real, { recursive: true });
    await writeFile(path.join(real, 'main.tex'), MAIN_TEX);
    await symlink(real, path.join(clone, 'paper'), 'junction');
    const cases: Array<[string, string]> = [
      ['paper/../p1/main.tex', '".."'],
      ['paper/../main.tex', '".."'],
      ['../demo/main.tex', '".."'],
      ['sections/../../elsewhere/main.tex', '".."'],
      [path.join(clone, 'drafts', 'p1', 'main.tex'), 'rootFile: "drafts/p1/main.tex"'],
      [path.join(clone, 'main.tex'), 'rootFile: "main.tex"'],
      ['C:main.tex', 'drive prefix'],
    ];
    for (const [rootFile, message] of cases) {
      const res = await client.callTool({
        name: 'compile',
        arguments: { rootFile, overlay: OVERLAY },
      });
      expect(res.isError, `${rootFile}: ${textOf(res)}`).toBe(true);
      expect(textOf(res), rootFile).toContain(message);
    }
    // Judged before the overlay is read: an overlay entry that would fail on its own (a missing
    // file) does not get to answer first.
    const masked = await client.callTool({
      name: 'compile',
      arguments: {
        rootFile: 'paper/main.tex',
        overlay: [{ file: 'sections/nope.tex', edits: [{ oldString: 'x', newString: 'y' }] }],
      },
    });
    expect(masked.isError, textOf(masked)).toBe(true);
    expect(textOf(masked)).toContain('through "paper", which is a symbolic link');
    expect(textOf(masked)).not.toContain('no such file');
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

describe('compile with an overlay: refusals and retention', () => {
  const isWin = process.platform === 'win32';
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  it('says the build stopped before reading an overlaid file when it failed first', async () => {
    const { client, behaviour } = await setup();
    behaviour.failEarly = true;
    const res = await client.callTool({
      name: 'compile',
      arguments: { rootFile: 'main.tex', overlay: OVERLAY },
    });
    expect(res.isError ?? false, textOf(res)).toBe(false);
    const out = res.structuredContent as { success: boolean; hint?: string };
    expect(out.success).toBe(false);
    const hint = out.hint ?? '';
    expect(hint).toContain(
      'The build stopped before reading the overlaid file "sections/b.tex" (neither its .fls ' +
        'nor its .fdb_latexmk lists it)',
    );
    // Not the advice for a SUCCESSFUL build that skipped the file: nothing says the path is wrong.
    expect(hint).not.toContain('never read');
    expect(hint).not.toContain('overlay the path TeX actually opens');
  });

  it('names both records the never-read check consults on a successful build', async () => {
    const { client } = await setup();
    const res = await client.callTool({
      name: 'compile',
      arguments: {
        rootFile: 'main.tex',
        overlay: [{ file: 'notes.tex', edits: [{ oldString: 'Notes', newString: 'Changed' }] }],
      },
    });
    expect((res.structuredContent as { hint?: string }).hint ?? '').toContain(
      'The build never read the overlaid file "notes.tex" (neither its .fls nor its ' +
        '.fdb_latexmk lists it)',
    );
  });

  it('keeps the four most recently compiled variants and refuses the evicted one by name', async () => {
    const { client } = await setup();
    const handles: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const res = await client.callTool({
        name: 'compile',
        arguments: {
          rootFile: 'main.tex',
          overlay: [
            {
              file: 'sections/b.tex',
              edits: [{ oldString: 'Section B original.', newString: `Section B take ${i}.` }],
            },
          ],
        },
      });
      expect(res.isError ?? false, textOf(res)).toBe(false);
      handles.push((res.structuredContent as { variant: string }).variant);
      // usedAt is a millisecond timestamp: keep the order strict.
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(new Set(handles).size).toBe(5);
    const [first, ...kept] = handles;
    for (const name of ['extract_text', 'render_pages']) {
      const gone = await client.callTool({
        name,
        arguments: { variant: first, ...(name === 'render_pages' ? { inline: false } : {}) },
      });
      expect(gone.isError, `${name}: ${textOf(gone)}`).toBe(true);
      expect(textOf(gone)).toMatch(
        new RegExp(`No variant "${first}" for project "demo": it was evicted`),
      );
    }
    for (const [i, handle] of kept.entries()) {
      const res = await client.callTool({ name: 'extract_text', arguments: { variant: handle } });
      expect(res.isError ?? false, textOf(res)).toBe(false);
      expect(textOf(res)).toContain(`Section B take ${i + 2}.`);
    }
  });

  it.skipIf(isWin || isRoot)(
    'keeps a finished compile when an old variant cannot be removed, and says so',
    async () => {
      const { client, clone } = await setup();
      const stamp = (n: number) => new Date(Date.UTC(2020, 0, 1, 0, n)).toISOString();
      const old = ['v00000000000a', 'v00000000000b', 'v00000000000c', 'v00000000000d'];
      for (const [i, h] of old.entries()) {
        const p = variantPaths(clone, h);
        await mkdir(p.out, { recursive: true });
        await writeManifest(p.manifest, {
          rootFile: 'main.tex',
          createdAt: stamp(i),
          usedAt: stamp(i),
          files: [],
          compiler: 'latexmk',
          engine: 'pdflatex',
        });
      }
      // The oldest is the one eviction removes; make its out/ unremovable (EACCES on unlink). The
      // file it cannot unlink has a right-to-left override and a newline in its name, and the
      // failure's message quotes that path: it must reach neither the hint nor stderr raw.
      const locked = variantPaths(clone, old[0]!).out;
      const rlo = String.fromCodePoint(0x202e);
      await writeFile(path.join(locked, `held${rlo}\nforged.pdf`), 'held');
      await chmod(locked, 0o555);
      // Restore before the build dir is removed (cleanups run in order).
      cleanups.unshift(() => chmod(locked, 0o755).catch(() => undefined));

      const stderr: string[] = [];
      const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        stderr.push(args.map(String).join(' '));
      });
      cleanups.unshift(async () => spy.mockRestore());
      const res = await client.callTool({
        name: 'compile',
        arguments: { rootFile: 'main.tex', overlay: OVERLAY },
      });
      spy.mockRestore();
      expect(res.isError ?? false, textOf(res)).toBe(false);
      const out = res.structuredContent as { success: boolean; variant?: string; hint?: string };
      expect(out.success).toBe(true);
      expect(out.variant).toMatch(/^v[0-9a-f]{12}$/);
      // stderr names the project as every message does, and escapes the failure: a newline in a
      // path must not forge a log line.
      const logged = stderr.filter((l) => l.includes('could not remove an old variant'));
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain('of "demo": ');
      expect(logged[0]).toContain('held\\u{202E}\\u{A}forged.pdf');
      expect(logged[0]).not.toContain(rlo);
      expect(logged[0]).not.toContain('\n');
      // The hint is escaped as every supplied value is: the override and the newline written out.
      const hint = out.hint ?? '';
      expect(hint).toContain('held\\u{202E}\\u{A}forged.pdf');
      expect(hint).not.toContain(rlo);
      expect(hint.split('\n').some((line) => line.startsWith('forged.pdf'))).toBe(false);
      expect(hint).toMatch(
        /An older variant of this project could not be removed \(.*EACCES.*\); this compile is unaffected/,
      );
      expect(textOf(res)).toContain('could not be removed');
      await expectNoUndeclaredKeys(client, 'compile', res.structuredContent);
    },
  );

  it('refuses an overlay path that leaves the project, and touches nothing', async () => {
    const { client, clone, requests } = await setup();
    const outside = await tmp('ovl-outside-');
    await writeFile(path.join(outside, 'secret.tex'), 'outside original\n');
    // A directory link out of the project: a junction on Windows, which needs no privilege.
    await symlink(outside, path.join(clone, 'outdir'), 'junction');
    const cases: string[] = [
      '../secret.tex',
      path.join(outside, 'secret.tex'),
      'sections/../../secret.tex',
      'outdir/secret.tex',
    ];
    // File symlinks need a privilege on Windows that CI runners do not grant.
    if (!isWin) {
      await symlink(path.join(outside, 'secret.tex'), path.join(clone, 'escape.tex'));
      await symlink(path.join(outside, 'missing.tex'), path.join(clone, 'dangling.tex'));
      cases.push('escape.tex', 'dangling.tex');
    }
    for (const file of cases) {
      const res = await client.callTool({
        name: 'compile',
        arguments: {
          rootFile: 'main.tex',
          overlay: [{ file, edits: [{ oldString: 'outside', newString: 'EDITED' }] }],
        },
      });
      expect(res.isError, `${file}: ${textOf(res)}`).toBe(true);
      expect(textOf(res), file).toMatch(
        /escapes the project root|must be relative to the project root/,
      );
    }
    expect(requests).toHaveLength(0);
    expect(await readFile(path.join(outside, 'secret.tex'), 'utf8')).toBe('outside original\n');
    await expect(stat(path.join(outside, 'missing.tex'))).rejects.toThrow();
    expect((await lstat(path.join(clone, 'outdir'))).isSymbolicLink()).toBe(true);
    if (!isWin) {
      expect((await lstat(path.join(clone, 'escape.tex'))).isSymbolicLink()).toBe(true);
      expect((await lstat(path.join(clone, 'dangling.tex'))).isSymbolicLink()).toBe(true);
    }
    expect(await readFile(path.join(clone, 'sections/b.tex'), 'utf8')).toBe(B_TEX);
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
    const variantAux = path.join(paths.out, 'main.aux');
    await writeFile(variantAux, '\\relax\n\\newlabel{fig:x}{{1}{2}{A caption}{figure.1}{}}\n');
    // A finished compile closes its .aux before its PDF, and a label lookup refuses a build whose
    // .aux is the newer by any margin ('stalePdf', #220). Back-date the staged one so the order the
    // steps ran in cannot read as a stale build.
    const past = new Date(Date.now() - 60_000);
    await utimes(variantAux, past, past);
    // One shipout mark per page of the variant's PDF: a label lookup refuses a log that shipped
    // nothing beside a PDF with pages, so this is also the log that lookup must read.
    await writeFile(
      path.join(paths.out, 'main.log'),
      'This is pdfTeX, Version 3.141592653\n [1] [2] (./main.aux) )\n',
    );
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
