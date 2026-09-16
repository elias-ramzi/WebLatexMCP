import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, readdir, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import { buildDir, buildPdfPath, buildAuxPath } from '../../src/services/compiler.js';
import { minimalPdf } from '../helpers/minimalPdf.js';
import { toPosix } from '../../src/lib/paths.js';
import type { ServerConfig } from '../../src/types.js';

const MAIN_TEX = [
  '\\documentclass{article}',
  '\\begin{document}',
  'Hi',
  '\\end{document}',
  '',
].join('\n');

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

interface Harness {
  client: Client;
  workspace: string;
  userDir: string;
}

async function setup(): Promise<Harness> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-geomws-'));
  const userDir = await mkdtemp(path.join(os.tmpdir(), 'ovl-geomdir-'));
  cleanups.push(
    () => rm(workspace, { recursive: true, force: true }),
    () => rm(userDir, { recursive: true, force: true }),
    () => rm(buildDir(userDir), { recursive: true, force: true }),
  );
  await writeFile(path.join(userDir, 'main.tex'), MAIN_TEX);

  const config: ServerConfig = { workspaceRoot: workspace, sessionId: 'test', projects: [] };
  const ctx = createContext(
    config,
    new CredentialResolver({}),
    { name: 'Test', email: 'test@example.com' },
    new ProjectRegistry(workspace),
  );
  const server = createServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(() => client.close());

  await client.callTool({
    name: 'register_project',
    arguments: { project: 'poster', path: userDir },
  });

  return { client, workspace, userDir };
}

/** Stage a "compiled" PDF at the path `compile` would have left one, without running latexmk. */
async function stagePdf(userDir: string, pages: number): Promise<void> {
  const pdfPath = buildPdfPath(userDir, 'main.tex');
  await mkdir(path.dirname(pdfPath), { recursive: true });
  await writeFile(pdfPath, minimalPdf(pages));
}

async function stageAux(userDir: string, content: string): Promise<void> {
  const auxPath = buildAuxPath(userDir, 'main.tex');
  await mkdir(path.dirname(auxPath), { recursive: true });
  await writeFile(auxPath, content);
}

interface ContentBlock {
  type: string;
  text?: string;
}

function textOf(res: unknown): string {
  return ((res as { content?: ContentBlock[] }).content ?? []).map((b) => b.text ?? '').join('\n');
}

interface GeometryBoxOut {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  text?: string;
  source?: 'image' | 'form';
}

interface GeometryPageOut {
  page: number;
  pageWidthPt: number;
  pageHeightPt: number;
  text?: GeometryBoxOut[];
  images?: GeometryBoxOut[];
  textOmitted: number;
  imagesOmitted: number;
}

interface GeometryOut {
  pdfPath?: string;
  pageCount?: number;
  pages: GeometryPageOut[];
  skippedPages: number[];
  floats?: Array<{ label: string; number: string; page: string }>;
  floatsOmitted?: number;
  floatsDropped?: number;
  note?: string;
}

function structuredOf(res: unknown): GeometryOut {
  return (res as { structuredContent: GeometryOut }).structuredContent;
}

/**
 * Every entry (file or directory) under `dir`, relative paths, recursively.
 *
 * `fs.readdir(dir, { recursive: true })` builds each nested entry with the platform's own
 * `path.join`, so on win32 it yields `.sessions\poster`, not `.sessions/poster` — the first
 * separator-sensitive assertion in this file (the other legs only ever compare two snapshots to
 * each other, so they were immune). Normalise through `toPosix` — the project's standard helper,
 * also used for every path this server actually returns to a caller — so every entry here is
 * POSIX on every OS and the exact-list assertions below stay separator-safe by construction.
 */
async function listAllEntries(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true });
  return entries.map(toPosix).sort();
}

describe('pdf_geometry', () => {
  it('fails naming compile when nothing has been compiled yet', async () => {
    const { client } = await setup();
    const res = await client.callTool({ name: 'pdf_geometry', arguments: { project: 'poster' } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('compile');
    expect(textOf(res)).toContain('pdf_geometry');
  });

  it('reports a plausible shape for a staged PDF with no text or images', async () => {
    const { client, userDir } = await setup();
    await stagePdf(userDir, 1);

    const res = await client.callTool({ name: 'pdf_geometry', arguments: { project: 'poster' } });
    expect(res.isError ?? false).toBe(false);

    const out = structuredOf(res);
    expect(out.pageCount).toBe(1);
    expect(out.pages).toHaveLength(1);
    const page = out.pages[0]!;
    expect(page.page).toBe(1);
    // minimalPdf's default page box is 200x100pt (see test/helpers/minimalPdf.ts).
    expect(page.pageWidthPt).toBeCloseTo(200, 5);
    expect(page.pageHeightPt).toBeCloseTo(100, 5);
    expect(Array.isArray(page.text)).toBe(true);
    expect(Array.isArray(page.images)).toBe(true);
    expect(out.skippedPages).toEqual([]);
    expect(out.floats).toBeUndefined();
  });

  it('parses floats from a staged .aux, and reports none with a note when there is no .aux', async () => {
    const { client, userDir } = await setup();
    await stagePdf(userDir, 1);

    const withoutAux = await client.callTool({
      name: 'pdf_geometry',
      arguments: { project: 'poster', kinds: ['floats'] },
    });
    expect(withoutAux.isError ?? false).toBe(false);
    const withoutOut = structuredOf(withoutAux);
    expect(withoutOut.floats).toEqual([]);
    expect(withoutOut.note).toMatch(/\.aux/);

    await stageAux(userDir, '\\newlabel{fig:one}{{1}{3}}\n\\newlabel{tab:two}{{1}{4}}\n');
    const withAux = await client.callTool({
      name: 'pdf_geometry',
      arguments: { project: 'poster', kinds: ['floats'] },
    });
    expect(withAux.isError ?? false).toBe(false);
    const withOut = structuredOf(withAux);
    expect(withOut.floats).toEqual([
      { label: 'fig:one', number: '1', page: '3' },
      { label: 'tab:two', number: '1', page: '4' },
    ]);
    expect(withOut.floatsOmitted).toBe(0);
    expect(withOut.note).toBeUndefined();
    // kinds: ['floats'] alone requests no per-page geometry, and (FIX8) never opens the PDF at
    // all — pages comes back empty (not one entry with text/images undefined), and pageCount is
    // honestly absent rather than a number that was never actually computed.
    expect(withOut.pages).toEqual([]);
    expect(withOut.pageCount).toBeUndefined();
  });

  it('reports floatsDropped through the tool for an .aux entry whose field ran past the cap', async () => {
    // The lib half (readAuxFloats/AuxFloatsResult.dropped) is covered by
    // test/unit/auxFloats.test.ts; this exercises the tool's own outputSchema wiring
    // (structuredContent is validated by the MCP SDK AFTER the handler returns, so a
    // schema/field mismatch here would not be caught by the handler's try/catch — it would
    // surface as an opaque "Output validation error" instead of a normal assertion failure).
    const { client, userDir } = await setup();
    await stagePdf(userDir, 1);
    // One good \newlabel, and one whose page field runs past the per-field length cap
    // (MAX_FIELD_LENGTH = 200 in src/lib/auxFloats.ts) — dropped, and counted, never silently
    // absorbed into `floats` or `floatsOmitted`.
    const overLongPage = 'p'.repeat(201);
    await stageAux(
      userDir,
      [`\\newlabel{fig:one}{{1}{3}}`, `\\newlabel{fig:toolong}{{1}{${overLongPage}}}`].join('\n'),
    );

    const res = await client.callTool({
      name: 'pdf_geometry',
      arguments: { project: 'poster', kinds: ['floats'] },
    });
    expect(res.isError ?? false).toBe(false);
    const out = structuredOf(res);
    expect(out.floats).toEqual([{ label: 'fig:one', number: '1', page: '3' }]);
    expect(out.floatsDropped).toBe(1);
  });

  it('kinds: ["floats"] alone never opens the compiled PDF (FIX8)', async () => {
    const { client, userDir } = await setup();
    // Deliberately NOT a real PDF: opening this would fail (no @napi-rs/canvas DOM globals aside,
    // this content isn't even parseable as a PDF at all). locateProjectPdf only stats the path, so
    // this still counts as "something has been compiled" for the purposes of finding it.
    const pdfPath = buildPdfPath(userDir, 'main.tex');
    await mkdir(path.dirname(pdfPath), { recursive: true });
    await writeFile(pdfPath, Buffer.from('this is not a pdf at all'));
    await stageAux(userDir, '\\newlabel{fig:one}{{1}{3}}\n');

    const floatsOnly = await client.callTool({
      name: 'pdf_geometry',
      arguments: { project: 'poster', kinds: ['floats'] },
    });
    expect(floatsOnly.isError ?? false).toBe(false);
    const floatsOut = structuredOf(floatsOnly);
    expect(floatsOut.floats).toEqual([{ label: 'fig:one', number: '1', page: '3' }]);
    expect(floatsOut.pages).toEqual([]);
    expect(floatsOut.pageCount).toBeUndefined();

    // Contrast: asking for page geometry on the SAME (unopenable) PDF really does try to open it
    // and fails — proving the floats-only call above genuinely skipped opening the document,
    // rather than opening it and happening not to use the result.
    const withText = await client.callTool({
      name: 'pdf_geometry',
      arguments: { project: 'poster', kinds: ['text'] },
    });
    expect(withText.isError).toBe(true);
  });

  it('kinds: ["floats"] alone succeeds when an .aux exists but no PDF was ever produced (FIX-pdfless-floats)', async () => {
    // A compile that fails on a missing package or undefined control sequence still lets
    // pdflatex write main.aux (carrying every \newlabel from the previous converged run) before
    // it dies without producing a PDF — the exact "help me find which page a float landed on"
    // moment this path exists for. Deliberately no stagePdf() call here.
    const { client, userDir } = await setup();
    await stageAux(userDir, '\\newlabel{fig:one}{{1}{3}}\n');

    const res = await client.callTool({
      name: 'pdf_geometry',
      arguments: { project: 'poster', kinds: ['floats'] },
    });
    expect(res.isError ?? false).toBe(false);
    const out = structuredOf(res);
    expect(out.floats).toEqual([{ label: 'fig:one', number: '1', page: '3' }]);
    expect(out.pdfPath).toBeUndefined();
    expect(out.pageCount).toBeUndefined();
    expect(out.pages).toEqual([]);
  });

  it('kinds: ["text"] still fails naming compile when an .aux exists but no PDF was ever produced', async () => {
    const { client, userDir } = await setup();
    await stageAux(userDir, '\\newlabel{fig:one}{{1}{3}}\n');

    const res = await client.callTool({
      name: 'pdf_geometry',
      arguments: { project: 'poster', kinds: ['text'] },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('compile');
    expect(textOf(res)).toContain('pdf_geometry');
  });

  it('works for a mode: local project (requireProjectDir, not requireGitProject)', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-geomws-local-'));
    const localDir = await mkdtemp(path.join(os.tmpdir(), 'ovl-geomdir-local-'));
    cleanups.push(
      () => rm(workspace, { recursive: true, force: true }),
      () => rm(localDir, { recursive: true, force: true }),
      () => rm(buildDir(localDir), { recursive: true, force: true }),
    );
    await writeFile(path.join(localDir, 'main.tex'), MAIN_TEX);

    const config: ServerConfig = { workspaceRoot: workspace, sessionId: 'test', projects: [] };
    const ctx = createContext(
      config,
      new CredentialResolver({}),
      { name: 'Test', email: 'test@example.com' },
      new ProjectRegistry(workspace),
    );
    const server = createServer(ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(() => client.close());

    // No gitUrl — registering with only `path` makes this a mode:'local' project (a directory
    // the user already has, used in place, never git-backed).
    await client.callTool({
      name: 'register_project',
      arguments: { project: 'localpaper', path: localDir },
    });
    await stagePdf(localDir, 2);

    const res = await client.callTool({
      name: 'pdf_geometry',
      arguments: { project: 'localpaper' },
    });
    expect(res.isError ?? false).toBe(false);
    const out = structuredOf(res);
    expect(out.pageCount).toBe(2);
    expect(out.pages).toHaveLength(2);
  });

  it('never writes into the project directory or the build dir (in-place invariant)', async () => {
    const { client, userDir } = await setup();
    await stagePdf(userDir, 1);
    await stageAux(userDir, '\\newlabel{fig:one}{{1}{3}}\n');

    // Widened beyond the project dir (FIX12): buildDir() resolves under os.tmpdir(), outside the
    // project entirely, so a regression that scratches a file there — exactly what render_pages,
    // the tool this one was copied from, legitimately does — would pass a project-dir-only check.
    const projectBefore = await listAllEntries(userDir);
    const buildBefore = await listAllEntries(buildDir(userDir));

    const res = await client.callTool({
      name: 'pdf_geometry',
      arguments: { project: 'poster', kinds: ['text', 'images', 'floats'] },
    });
    expect(res.isError ?? false).toBe(false);

    const after = await listAllEntries(userDir);
    expect(after).toEqual(projectBefore);
    expect(await listAllEntries(buildDir(userDir))).toEqual(buildBefore);
  });

  it('writes only the project lock directory under the workspace root, and leaves no lock file behind', async () => {
    // Deliberately does NOT call register_project before snapshotting: that call itself takes
    // the project lock (via ProjectManager.runExclusive -> withFileLock's
    // mkdir(dirname(lockPath), {recursive: true})) and so already creates
    // <workspace>/.sessions/<id>/ before this test's "before" snapshot would ever see it empty.
    // Supplying the project via server config instead means the workspace root is genuinely
    // untouched at the start, so this test can prove what pdf_geometry itself creates rather
    // than reusing a directory the test harness happened to create first.
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-geomws-lock-'));
    const localUserDir = await mkdtemp(path.join(os.tmpdir(), 'ovl-geomdir-lock-'));
    cleanups.push(
      () => rm(workspace, { recursive: true, force: true }),
      () => rm(localUserDir, { recursive: true, force: true }),
      () => rm(buildDir(localUserDir), { recursive: true, force: true }),
    );
    await writeFile(path.join(localUserDir, 'main.tex'), MAIN_TEX);
    await stagePdf(localUserDir, 1);

    const config: ServerConfig = {
      workspaceRoot: workspace,
      sessionId: 'test',
      projects: [{ id: 'poster', mode: 'local', path: localUserDir }],
    };
    const ctx = createContext(
      config,
      new CredentialResolver({}),
      { name: 'Test', email: 'test@example.com' },
      new ProjectRegistry(workspace),
    );
    const server = createServer(ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(() => client.close());

    const workspaceBefore = await listAllEntries(workspace);
    expect(workspaceBefore).toEqual([]);

    const res = await client.callTool({ name: 'pdf_geometry', arguments: { project: 'poster' } });
    expect(res.isError ?? false).toBe(false);

    // pdf_geometry takes the project lock like render_pages (see the handler's own comment), and
    // withFileLock's mkdir(dirname(lockPath), {recursive: true}) leaves that directory behind
    // even though the lock FILE inside it is removed on release. The true invariant is therefore
    // narrower than "writes nothing, anywhere": it creates exactly
    // <workspace>/.sessions/<id>/ (and its .sessions parent) and nothing else, and the lock file
    // itself is gone once the call returns.
    const workspaceAfter = await listAllEntries(workspace);
    expect(workspaceAfter).toEqual(['.sessions', '.sessions/poster']);
  });
});
