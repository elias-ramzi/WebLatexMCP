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
import { expectDeclaredField } from '../helpers/outputSchema.js';
import { GROUP_SKIP_SCAN } from '../../src/lib/auxFloats.js';
import type { ServerConfig } from '../../src/types.js';
import type { AppContext } from '../../src/context.js';
import type { GeometryPage, GeometryResult } from '../../src/services/pdfRender.js';

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
  /** Exposed so a test can swap `ctx.pdfRenderer` for a stub. The point of doing that is narrow:
   *  what the walk measures is already pinned by test/unit/pdfRender.test.ts against hand-built
   *  operator lists, and what is NOT covered there is the boundary — whether the tool carries
   *  those measurements out and declares them. A stub is the right instrument for the first half:
   *  it makes the service's output the test's own input, so a failure can only be the tool.
   *
   *  It says nothing about the second half. A field the service computes and the schema does not
   *  declare is NOT stripped and NOT rejected (#130): the SDK validates `structuredContent` and
   *  then forwards the handler's own object, so an undeclared key reaches the caller verbatim
   *  while `tools/list` — the only place a caller can learn the field exists — never mentions it.
   *  That was the defect in `annotationImagesSkipped` and `unreliableCtm`: computed, transmitted,
   *  undeclared. So the schema half is asserted off a real `listTools()` round trip
   *  (test/helpers/outputSchema.ts), never off `structuredContent`. */
  ctx: AppContext;
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

  return { client, workspace, userDir, ctx };
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
  approximate?: true;
  unreliableCtm?: true;
}

interface GeometryPageOut {
  page: number;
  pageWidthPt: number;
  pageHeightPt: number;
  text?: GeometryBoxOut[];
  images?: GeometryBoxOut[];
  textOmitted: number;
  imagesOmitted: number;
  annotationImagesSkipped?: number;
}

interface GeometryOut {
  pdfPath?: string;
  pageCount?: number;
  pages: GeometryPageOut[];
  skippedPages: number[];
  floats?: Array<{ label: string; number: string; page: string }>;
  floatsOmitted?: number;
  floatsOmittedBySize?: number;
  floatsDropped?: number;
  floatsRefused?: number;
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
    // test/unit/auxFloats.test.ts; this is the tool's own boundary — that the count reaches the
    // caller AND is advertised.
    //
    // Those are two different assertions and only one of them is about `structuredContent`. The
    // MCP SDK validates the result against the outputSchema after the handler returns and then
    // discards the parsed value (#130), so the direction that a `structuredContent` assertion
    // catches is a REQUIRED field going missing — the parse fails and `callTool` surfaces an
    // opaque "Output validation error". The other direction is invisible to it: a key the schema
    // does not declare is neither stripped nor rejected, it is forwarded as-is. So the declaration
    // is asserted off `listTools()` below.
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
    // Declared, not merely emitted: a caller decides whether to look for a dropped count by
    // reading the published schema, and an undeclared key is one nothing is ever told about.
    await expectDeclaredField(client, 'pdf_geometry', 'floatsDropped');
  });

  it('reports floatsRefused through the tool, apart from floatsDropped and never folded into it', async () => {
    // The lib half is covered by test/unit/auxFloats.test.ts ("#80 §3: counts a refused marker
    // apart from a dropped entry"); this is the tool boundary, which until now computed the count
    // and dropped it on the floor. The undeclared-field half needs its own assertion: the MCP SDK
    // neither strips nor rejects a key the outputSchema omits (#130), so only the schema from a
    // real `listTools()` round trip can say whether the field is in the contract.
    const { client, userDir } = await setup();
    // The same hostile .aux as the lib test: fig:real's group never closes within the scan
    // budget, so the \newlabel-shaped text buried inside it is REFUSED (not an entry), while
    // fig:real itself is DROPPED (a real entry the caller does not get).
    const pad = 'x'.repeat(GROUP_SKIP_SCAN + 2000);
    await stageAux(
      userDir,
      [
        `\\newlabel{fig:real}{{1}{7}{${pad}\\newlabel{fig:fake}{{9}{999}} tail}{figure.1}{}}`,
        '\\newlabel{fig:after}{{4}{8}}',
      ].join('\n'),
    );

    const res = await client.callTool({
      name: 'pdf_geometry',
      arguments: { project: 'poster', kinds: ['floats'] },
    });
    expect(res.isError ?? false).toBe(false);
    const out = structuredOf(res);
    expect(out.floats).toEqual([{ label: 'fig:after', number: '4', page: '8' }]);
    // The two counts say different things and the tool must keep them apart: one entry lost,
    // one fabrication declined. A single number would report the fabrication as a loss.
    expect(out.floatsDropped).toBe(1);
    expect(out.floatsRefused).toBe(1);
    // And the text channel says so in words that do not claim a loss.
    expect(textOf(res)).toContain('1 refused as not an entry');

    // The field also has to be DECLARED, not merely present in the payload: the MCP SDK passes
    // an undeclared key through, so a caller (a model reading the schema) would never learn the
    // count exists. Asserted off the advertised outputSchema rather than off the result — and
    // declared as the thing it is, not as a second floatsDropped.
    await expectDeclaredField(client, 'pdf_geometry', 'floatsRefused', {
      description: /NOT a second floatsDropped/,
    });
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

describe('the floats payload is bounded by rendered size, not only by count', () => {
  it('cuts the tail, counts it apart from the entry cap, and says which bound fired', async () => {
    const { client, userDir } = await setup();
    await stagePdf(userDir, 1);
    // 200 entries — exactly DEFAULT_MAX_FLOATS, so the COUNT cap does not fire and anything cut
    // here is cut by the size budget alone. Backslash-dense labels on purpose: `structuredContent`
    // is JSON, every backslash doubles once encoded, and charging raw .length rather than the
    // encoded length is the specific under-count that made the #68 conflict budget wrong twice.
    const entries = Array.from(
      { length: 200 },
      (_, i) => `\\newlabel{fig:${'a'.repeat(60)}\\x\\y${i}}{{${i}}{${i}}}`,
    );
    await stageAux(userDir, entries.join('\n'));

    const res = await client.callTool({
      name: 'pdf_geometry',
      arguments: { project: 'poster', kinds: ['floats'] },
    });
    expect(res.isError ?? false).toBe(false);
    const out = structuredOf(res);

    // The bound is on what the client actually receives, so assert it there rather than on any
    // internal running total.
    expect(JSON.stringify(out.floats).length).toBeLessThanOrEqual(20000);
    expect(out.floats!.length).toBeLessThan(200);
    expect(out.floatsOmittedBySize).toBe(200 - out.floats!.length);
    // Not folded into floatsOmitted, which means "past the 200-entry cap" and did not fire.
    expect(out.floatsOmitted).toBe(0);
    expect(out.floatsDropped).toBe(0);
    // The note names the bound that fired and not the other one — the conflictBudget rule.
    expect(out.note).toContain('floats payload budget');
    expect(out.note).not.toContain('first float entry alone');
    expect(textOf(res)).toContain('past the size budget');

    // The kept entries are the .aux's own first ones, in order: a caller matches a float by its
    // label against the document it is reading, so a reordered or size-cherry-picked list would
    // be a different answer to the question asked.
    expect(out.floats![0]!.number).toBe('0');
    expect(out.floats![1]!.number).toBe('1');
  });

  it('leaves a small floats payload untouched, with no counter and no note', async () => {
    const { client, userDir } = await setup();
    await stagePdf(userDir, 1);
    await stageAux(userDir, '\\newlabel{fig:one}{{1}{3}}\n\\newlabel{tab:two}{{1}{4}}\n');

    const res = await client.callTool({
      name: 'pdf_geometry',
      arguments: { project: 'poster', kinds: ['floats'] },
    });
    const out = structuredOf(res);
    // A budget that quietly trims the ordinary case is a budget nobody can reason about.
    expect(out.floats).toHaveLength(2);
    expect(out.floatsOmittedBySize).toBe(0);
    expect(out.note).toBeUndefined();
    // `res`, not `out`: textOf reads the content blocks, and handing it the already-structured
    // object would make this assertion pass against every possible implementation.
    expect(textOf(res)).not.toContain('size budget');
  });
});

describe('the response boundary carries what the walk measured', () => {
  /**
   * A stub page shaped exactly as `walkImageGeometry` now returns one. The numbers are arbitrary.
   *
   * Be precise about what was wrong before this, because the obvious guess is wrong and was
   * believed here for a while: an undeclared field is NOT stripped from `structuredContent`. The
   * MCP SDK validates with `safeParseAsync` and then **discards the parsed value**
   * (`validateToolOutput` in server/mcp.js), sending the handler's own object verbatim — so
   * `annotationImagesSkipped` did reach a client even while the schema said nothing about it, as
   * the mutation check on the test below confirms.
   *
   * What was actually broken is the tool's advertised CONTRACT. The same schema is converted to
   * JSON Schema and published in `tools/list`, which is the only thing a caller — a model
   * included — can read to learn a field exists. A counted gap nobody is told about buys very
   * little over a silent one: the whole argument for counting rather than dropping
   * (`annotationImagesSkipped`, `omittedSnippetLocations`) is that the caller LEARNS the figure
   * was there, and a field absent from the schema is a field the caller has no reason to look
   * for. A strict client validating against the published schema is entitled to reject it too.
   *
   * So the load-bearing test here is the `tools/list` one, which fails against the unfixed
   * schema. The `structuredContent` tests below pin the handler and the text channel — they pass
   * either way, and are not evidence about the schema. Saying so is the point: a test whose
   * failure mode you have not checked is not proof of anything.
   */
  function stubPage(over: Partial<GeometryPage> = {}): GeometryPage {
    return {
      page: 1,
      pageWidthPt: 612,
      pageHeightPt: 792,
      text: [],
      images: [],
      textOmitted: 0,
      imagesOmitted: 0,
      annotationImagesSkipped: 0,
      ...over,
    };
  }

  function stubGeometry(ctx: AppContext, result: GeometryResult): void {
    ctx.pdfRenderer = {
      ...ctx.pdfRenderer,
      geometry: async (): Promise<GeometryResult> => result,
    };
  }

  it('declares both fields in the outputSchema it publishes to clients', async () => {
    const { client } = await setup();
    // Walked off the published JSON Schema rather than the zod object: this is the document a
    // client actually receives, and the conversion is the SDK's, not ours.
    //
    // Required, not merely present: absent must never be a caller's only clue that a page had
    // nothing skipped, because absent is also what a server that never counted would send.
    await expectDeclaredField(client, 'pdf_geometry', 'pages[].annotationImagesSkipped', {
      required: true,
    });
    // Optional, and correctly so: the flag is an exception, and a box without it is the norm.
    await expectDeclaredField(client, 'pdf_geometry', 'pages[].images[].unreliableCtm', {
      required: false,
    });
    // It appears on the text boxes too, because both arrays share geometryBoxShape — but that is
    // a fact about the shape, NOT a guarantee about text boxes: the text path has no CTM latch
    // and never sets the flag. Assert the consequence and pin the description that says so, or
    // the shared shape silently advertises a safety property nothing provides ("no unreliableCtm,
    // therefore safe to collide") over a whole kind of box.
    await expectDeclaredField(client, 'pdf_geometry', 'pages[].text[].unreliableCtm', {
      description: 'IMAGE OR FORM box only',
    });
  });

  it('reports annotationImagesSkipped in structuredContent AND in the text', async () => {
    const { client, userDir, ctx } = await setup();
    await stagePdf(userDir, 1);
    stubGeometry(ctx, {
      pageCount: 1,
      pages: [
        stubPage({
          images: [{ x0: 10, y0: 20, x1: 30, y1: 40, source: 'image' }],
          annotationImagesSkipped: 2,
        }),
      ],
      skippedPages: [],
    });

    const res = await client.callTool({
      name: 'pdf_geometry',
      arguments: { project: 'poster', kinds: ['images'] },
    });
    expect(res.isError ?? false).toBe(false);

    expect(structuredOf(res).pages[0]!.annotationImagesSkipped).toBe(2);
    // The text channel too. A client reading only the text would otherwise be told "1 image
    // rect(s)" for a page holding three figures, with nothing to say the other two exist.
    expect(textOf(res)).toContain('2 in annotation(s), not measured');
  });

  it('keeps annotationImagesSkipped apart from imagesOmitted, which is the cap alone', async () => {
    const { client, userDir, ctx } = await setup();
    await stagePdf(userDir, 1);
    stubGeometry(ctx, {
      pageCount: 1,
      pages: [stubPage({ images: [], imagesOmitted: 5, annotationImagesSkipped: 3 })],
      skippedPages: [],
    });

    const res = await client.callTool({
      name: 'pdf_geometry',
      arguments: { project: 'poster', kinds: ['images'] },
    });
    const page = structuredOf(res).pages[0]!;
    // Two different claims: five rectangles were computed and trimmed for size, three paint
    // operators were never measured at all. Folding them into one number would say a rectangle
    // existed for something the walk never produced one for.
    expect(page.imagesOmitted).toBe(5);
    expect(page.annotationImagesSkipped).toBe(3);
    const text = textOf(res);
    expect(text).toContain('5 image rect(s) omitted');
    expect(text).toContain('3 in annotation(s), not measured');
  });

  it('reports a zero rather than omitting the field, so absent never has to mean zero', async () => {
    const { client, userDir, ctx } = await setup();
    await stagePdf(userDir, 1);
    stubGeometry(ctx, { pageCount: 1, pages: [stubPage()], skippedPages: [] });

    const res = await client.callTool({
      name: 'pdf_geometry',
      arguments: { project: 'poster', kinds: ['images'] },
    });
    const page = structuredOf(res).pages[0]!;
    // Two halves of the same promise, and `structuredContent` can only show one of them. What the
    // handler sent: the key is present and zero, not omitted.
    expect(Object.hasOwn(page, 'annotationImagesSkipped')).toBe(true);
    expect(page.annotationImagesSkipped).toBe(0);
    // What the contract says: required, not optional — a caller must never have to guess whether
    // a missing field means "none were skipped" or "this server does not report it", and a schema
    // marking it optional licenses exactly that guess however faithfully this handler behaves.
    await expectDeclaredField(client, 'pdf_geometry', 'pages[].annotationImagesSkipped', {
      required: true,
    });
    // And a zero stays out of the text, which reports exceptions, not every counter at rest.
    expect(textOf(res)).not.toContain('not measured');
  });

  it('carries unreliableCtm through on the box that has it, and only on that box', async () => {
    const { client, userDir, ctx } = await setup();
    await stagePdf(userDir, 1);
    stubGeometry(ctx, {
      pageCount: 1,
      pages: [
        stubPage({
          images: [
            { x0: 0, y0: 0, x1: 10, y1: 10, source: 'image' },
            { x0: 1, y0: 1, x1: 2, y1: 2, source: 'image', unreliableCtm: true },
            { x0: 2, y0: 2, x1: 3, y1: 3, source: 'form', approximate: true, unreliableCtm: true },
          ],
        }),
      ],
      skippedPages: [],
    });

    const res = await client.callTool({
      name: 'pdf_geometry',
      arguments: { project: 'poster', kinds: ['images'] },
    });
    const images = structuredOf(res).pages[0]!.images!;
    expect(images[1]!.unreliableCtm).toBe(true);
    // Both flags on one box: they answer different questions (extent vs. placement), so the
    // schema must not let one crowd out the other.
    expect(images[2]!.approximate).toBe(true);
    expect(images[2]!.unreliableCtm).toBe(true);
    // Absent — not false — on a good box, so `'unreliableCtm' in box` and a value read agree.
    expect(Object.hasOwn(images[0]!, 'unreliableCtm')).toBe(false);
  });
});
