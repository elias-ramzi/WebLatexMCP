import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import { buildDir, buildPdfPath, logBaseDir } from '../../src/services/compiler.js';
import { CompilerResolver } from '../../src/services/compilerResolver.js';
import { toFileUrl } from '../../src/lib/paths.js';
import { minimalPdf } from '../helpers/minimalPdf.js';
import { expectDeclaredField } from '../helpers/outputSchema.js';
import type { CompileOutcome, CompileRequest } from '../../src/services/compiler.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * "File paths are always POSIX (`/`-separated), on every OS" — the first line of docs/tools.md,
 * repeated in CLAUDE.md. `compile` (`pdfPath`, `logPath`), `render_pages` (`pdfPath`, `outDir`,
 * every `pngPath`) and `pdf_geometry` (`pdfPath`) returned absolute paths straight from
 * `path.join`, so on Windows one result object contradicted itself: a `toPosix`'d field beside a
 * backslashed `pdfPath`, in both the result text and `structuredContent`.
 *
 * These tests run on all three CI legs, from one harness parameterized on `process.platform`.
 *
 * On **Windows** nothing has to be arranged: `path.sep` is genuinely `'\\'`, the server's own
 * absolute paths genuinely contain backslashes, and the conversion genuinely converts. The
 * harness stubs nothing and uses a plain directory name, and the assertions below run unchanged
 * against the real thing — which is the platform this bug was ever about.
 *
 * On **Linux and macOS** the same assertions would be vacuous: `path.sep` is already `/`, the
 * conversion is the identity, and every one of them passes against the unfixed code. Two facts
 * make them bite there instead, and neither is a hack around the fix:
 *
 *  1. `path.sep` is a writable, configurable data property of the `node:path` module object, and
 *     patching it does NOT disturb `path.join`/`resolve`/`relative`/`basename` — their POSIX
 *     implementations use a literal `'/'` internally, never `path.sep`. So a test can make the
 *     server's own conversion (`toPosix`/`toPosixOut`, which split on `path.sep`) genuinely
 *     convert, while every real filesystem call keeps working.
 *  2. A literal backslash is a legal character in a POSIX filename. So the server's own absolute
 *     paths can be made to actually CONTAIN a backslash, giving the stubbed separator something
 *     to convert.
 *
 * So: the stub (`withWindowsSep`) and the backslash-bearing directory name (`SEGMENT`) are what
 * make the POSIX legs non-vacuous, and both stand down on Windows, where the platform supplies
 * the real separators. Exactly one test stays POSIX-only — see `pdfUrl` below, which pins a
 * distinction that only the stubbed harness can observe.
 */

const cleanups: Array<() => Promise<unknown>> = [];

/**
 * Load Node's async recursive-remove implementation BEFORE any test stubs `path.sep`.
 *
 * `internal/fs/rimraf` captures `path.sep` once, at module load, and builds every child path it
 * walks by concatenating it — and it is loaded lazily, on the first recursive `fs.rm`. A tool
 * call inside the stub window performs one (`withFileLock` removes its lock file that way), so
 * without this the module would be loaded holding a backslash, every later recursive rm in the
 * process would build child paths that do not exist, `force: true` would swallow the resulting
 * ENOENTs, and the final `rmdir` would fail ENOTEMPTY — not for this file's cleanup only, but for
 * every other test file sharing the worker. Warmed with the real separator first, a live stub is
 * harmless: this is a load-time capture, not a live read.
 */
beforeAll(async () => {
  await rm(path.join(os.tmpdir(), 'web-latex-mcp-rimraf-warmup-does-not-exist'), {
    recursive: true,
    force: true,
  });
});

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const WINDOWS = process.platform === 'win32';

/**
 * The directory segment every path under test runs through.
 *
 * On POSIX a literal backslash is a legal filename character, so this segment is what gives the
 * stubbed separator something to actually convert. On Windows a backslash cannot appear in a
 * filename at all — and does not need to: there the separators between the real segments are
 * already backslashes.
 */
const SEGMENT = WINDOWS ? 'outdir' : 'out\\dir';

/** What the server must return for a native path, once the separator is converted. */
function posixOf(native: string): string {
  return native.split('\\').join('/');
}

/**
 * Run `fn` with `path.sep` stubbed to a backslash, restoring the real descriptor in a `finally`
 * so a failure inside can never leak the stub into another test. Keep the window as narrow as
 * possible — ideally just the `client.callTool` await.
 *
 * On Windows this is a pass-through: `path.sep` is already `'\\'`, so there is nothing to stub,
 * and stubbing would only assert something the platform already provides.
 */
async function withWindowsSep<T>(fn: () => Promise<T>): Promise<T> {
  if (WINDOWS) return await fn();
  const original = Object.getOwnPropertyDescriptor(path, 'sep');
  Object.defineProperty(path, 'sep', { value: '\\', configurable: true, writable: true });
  try {
    return await fn();
  } finally {
    if (original) Object.defineProperty(path, 'sep', original);
  }
}

const MAIN_TEX = [
  '\\documentclass{article}',
  '\\begin{document}',
  'Hi',
  '\\end{document}',
  '',
].join('\n');

function textOf(res: unknown): string {
  const content = (res as { content?: Array<{ text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? '').join('\n');
}

async function connect(ctx: ReturnType<typeof createContext>): Promise<Client> {
  const server = createServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  // unshift, not push: close the client before the temp directories it was pointed at are
  // removed, so nothing on the server side is still looking at a tree being torn down.
  cleanups.unshift(() => client.close());
  return client;
}

/* ------------------------------------------------------------------ compile */

/**
 * A log with eleven `-file-line-error` diagnostics, naming files that do not exist so none of
 * them earns a snippet. Eleven, not one: `compile`'s text lists at most ten errors and then
 * prints `… N more error(s) — see structuredContent or <logPath>` — which is the only place the
 * result TEXT carries an absolute path other than the `file://` URL, and so the only way to prove
 * the text channel and `structuredContent` were rendered from the same converted value.
 */
const ELEVEN_ERRORS = [
  'This is pdfTeX, Version 3.141592653',
  ...Array.from(
    { length: 11 },
    (_unused, i) => `./missing${i + 1}.tex:${i + 1}: Undefined control sequence.`,
  ),
  'Output written on main.pdf (1 page).',
].join('\n');

/** A stand-in engine that "produces" whatever the test staged, so no TeX is involved. */
function stubCompiler(pdfPath: string, logPath: string) {
  return {
    isAvailable: async () => true,
    compile: async (req: CompileRequest): Promise<CompileOutcome> => ({
      success: false,
      pdfPath,
      durationSec: 0.1,
      log: ELEVEN_ERRORS,
      logPath,
      timedOut: false,
      logBaseDir: logBaseDir(req.rootFile),
      rebuilt: true,
    }),
  };
}

interface CompileHarness {
  client: Client;
  nativePdfPath: string;
  nativeLogPath: string;
}

async function setupCompile(): Promise<CompileHarness> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-posixws-'));
  const userDir = await mkdtemp(path.join(os.tmpdir(), 'ovl-posixdir-'));
  cleanups.push(
    () => rm(workspace, { recursive: true, force: true }),
    () => rm(userDir, { recursive: true, force: true }),
  );
  await writeFile(path.join(userDir, 'main.tex'), MAIN_TEX, 'utf8');

  // The one directory segment the harness controls: on POSIX it carries a literal backslash, and
  // is the whole reason the stubbed separator has anything to convert. On Windows it is an
  // ordinary name and the separators around it are the real thing.
  const outDir = path.join(workspace, SEGMENT);
  await mkdir(outDir, { recursive: true });
  const nativePdfPath = path.join(outDir, 'main.pdf');
  const nativeLogPath = path.join(outDir, 'main.log');
  // A real PDF, so ctx.pdfRenderer.pageCount() on the native path behaves as it would in the wild.
  await writeFile(nativePdfPath, minimalPdf(1));
  await writeFile(nativeLogPath, ELEVEN_ERRORS, 'utf8');

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
  // `workspaceIsLocal` is unset, so `compile` reports the backend's own pdfPath verbatim — which
  // makes the staged, backslash-bearing path above exactly what reaches the response boundary.
  ctx.compiler = new CompilerResolver('latexmk', false, () =>
    stubCompiler(nativePdfPath, nativeLogPath),
  );
  const client = await connect(ctx);
  return { client, nativePdfPath, nativeLogPath };
}

interface CompileOut {
  pdfPath?: string;
  pdfUrl?: string;
  logPath?: string;
  pageCount?: number;
}

function compileOut(res: unknown): CompileOut {
  return (res as { structuredContent: CompileOut }).structuredContent;
}

describe('compile: paths at the response boundary', () => {
  it('returns pdfPath with POSIX separators', async () => {
    const { client, nativePdfPath } = await setupCompile();

    const res = await withWindowsSep(() =>
      client.callTool({ name: 'compile', arguments: { project: 'doc' } }),
    );

    const out = compileOut(res);
    expect(out.pdfPath).toBeTruthy();
    expect(out.pdfPath).toBe(posixOf(nativePdfPath));
    expect(out.pdfPath).not.toContain('\\');
    // The genuinely load-bearing half of WHERE the conversion sits. `ctx.pdfRenderer.pageCount`
    // opens the PDF off the real filesystem, so it must be handed the host's own spelling: the
    // harness staged a real one-page `minimalPdf` at the native path, so a conversion moved even
    // one line too early hands `pageCount` a path nothing is at, the read throws, and the tool's
    // own catch reports `undefined` instead of a number — silently, since a missing count is
    // never fatal. Assert the count survived, not merely that the string looks right.
    expect(out.pageCount).toBe(1);
  });

  it.skipIf(WINDOWS)(
    'builds pdfUrl from the NATIVE path, never from the converted one',
    async () => {
      // What this pins is a discipline about what a value is FOR, not a bug being dodged:
      // `toFileUrl` takes a FILESYSTEM path and owns its own encoding, so it is handed the native
      // spelling rather than one chosen for a reader. The URL would not in fact break either way —
      // `pathToFileURL` resolves through `path.win32.resolve` first, so on Windows `C:\a\b\x.pdf`
      // and `C:/a/b/x.pdf` produce the identical, valid `file:///C:/a/b/x.pdf` (UNC included:
      // `\\server\share\x.pdf` and `//server/share/x.pdf` both give `file://server/share/x.pdf`).
      // Do not "fix" this test on the strength of a claim that the link breaks; it never did. See
      // `toPosixOut`'s doc comment in `src/lib/paths.ts`, which says the same thing.
      //
      // POSIX-only by necessity, and this is the one test that is. Its discriminating assertions
      // work only under the stubbed harness, where the backslash is part of the FILENAME and so
      // survives into the URL as `%5C`. On Windows the backslash is a separator, both spellings
      // give the same URL, and both assertions below would be false — which is precisely why this
      // test alone keeps its skip while the rest of the file now runs on all three legs.
      const { client, nativePdfPath } = await setupCompile();

      const res = await withWindowsSep(() =>
        client.callTool({ name: 'compile', arguments: { project: 'doc' } }),
      );

      const out = compileOut(res);
      expect(out.pdfUrl).toBe(toFileUrl(nativePdfPath));
      // Spelled out so the failure is legible: the separator survives as a percent-encoded
      // backslash in the URL, and must NOT have become a `/` path segment.
      expect(out.pdfUrl).toContain('%5C');
      expect(out.pdfUrl).not.toContain(posixOf(nativePdfPath));
    },
  );

  it('returns logPath with POSIX separators', async () => {
    const { client, nativeLogPath } = await setupCompile();

    const res = await withWindowsSep(() =>
      client.callTool({ name: 'compile', arguments: { project: 'doc' } }),
    );

    const out = compileOut(res);
    expect(out.logPath).toBeTruthy();
    expect(out.logPath).toBe(posixOf(nativeLogPath));
    expect(out.logPath).not.toContain('\\');
  });

  it('renders the text channel from the same converted values as structuredContent', async () => {
    const { client, nativePdfPath, nativeLogPath } = await setupCompile();

    const res = await withWindowsSep(() =>
      client.callTool({ name: 'compile', arguments: { project: 'doc' } }),
    );

    const out = compileOut(res);
    const text = textOf(res);
    // Guard the harness itself: without the overflow line the text carries no absolute path at
    // all and the assertions below would be vacuous for a different reason than the fix.
    expect(text).toContain('more error(s)');
    expect(text).toContain(posixOf(nativeLogPath));
    expect(text).not.toContain(nativeLogPath);
    expect(text).not.toContain(nativePdfPath);
    // The one path the text is supposed to carry natively is the `file://` URL, and it must be
    // the very string structuredContent reports.
    expect(text).toContain(`PDF: ${out.pdfUrl ?? ''}`);
    expect(out.pdfUrl).toBe(toFileUrl(nativePdfPath));
  });
});

/* ------------------------------------------- render_pages / pdf_geometry harness */

interface LocalHarness {
  client: Client;
  userDir: string;
}

/**
 * A project whose directory BASENAME is `SEGMENT` (backslash-bearing on POSIX). `buildDir` is
 * `<tmp>/web-latex-mcp-build/<basename(projectDir)>-<sha1>`, so that one segment propagates into
 * `buildPdfPath`, into `render_pages`' `outDir` (`<buildDir>/render`) and into every `pngPath`
 * under it — every path these two tools return.
 */
async function setupLocal(prefix: string): Promise<LocalHarness> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), `ovl-${prefix}ws-`));
  const parent = await mkdtemp(path.join(os.tmpdir(), `ovl-${prefix}dir-`));
  const userDir = path.join(parent, SEGMENT);
  await mkdir(userDir, { recursive: true });
  cleanups.push(
    () => rm(workspace, { recursive: true, force: true }),
    () => rm(parent, { recursive: true, force: true }),
    () => rm(buildDir(userDir), { recursive: true, force: true }),
  );
  await writeFile(path.join(userDir, 'main.tex'), MAIN_TEX, 'utf8');

  const config: ServerConfig = { workspaceRoot: workspace, sessionId: 'test', projects: [] };
  const ctx = createContext(
    config,
    new CredentialResolver({}),
    { name: 'Test', email: 'test@example.com' },
    new ProjectRegistry(workspace),
  );
  const client = await connect(ctx);
  await client.callTool({
    name: 'register_project',
    arguments: { project: 'poster', path: userDir },
  });
  return { client, userDir };
}

/** Stage a "compiled" PDF where `compile` would have left one, without running latexmk. */
async function stagePdf(userDir: string, pages: number): Promise<void> {
  const pdfPath = buildPdfPath(userDir, 'main.tex');
  await mkdir(path.dirname(pdfPath), { recursive: true });
  await writeFile(pdfPath, minimalPdf(pages));
}

/* ------------------------------------------------------------- render_pages */

interface RenderPagesOut {
  pdfPath: string;
  outDir: string;
  pages: Array<{ page: number; pngPath: string }>;
}

function renderOut(res: unknown): RenderPagesOut {
  return (res as { structuredContent: RenderPagesOut }).structuredContent;
}

describe('render_pages: paths at the response boundary', () => {
  it('returns pdfPath, outDir and every pngPath with POSIX separators', async () => {
    const { client, userDir } = await setupLocal('rpx');
    await stagePdf(userDir, 2);
    const nativePdfPath = buildPdfPath(userDir, 'main.tex');
    const nativeOutDir = path.join(buildDir(userDir), 'render');

    const res = await withWindowsSep(() =>
      client.callTool({
        name: 'render_pages',
        arguments: { project: 'poster', inline: false },
      }),
    );
    expect(res.isError ?? false).toBe(false);

    const out = renderOut(res);
    expect(out.pdfPath).toBe(posixOf(nativePdfPath));
    expect(out.outDir).toBe(posixOf(nativeOutDir));
    expect(out.pdfPath).not.toContain('\\');
    expect(out.outDir).not.toContain('\\');

    expect(out.pages).toHaveLength(2);
    for (const p of out.pages) {
      expect(p.pngPath).toBeTruthy();
      expect(p.pngPath).toBe(posixOf(path.join(nativeOutDir, `page-${p.page}.png`)));
      expect(p.pngPath).not.toContain('\\');
      // `toBe(posixOf(...))` alone cannot tell "the tool reported where it wrote" from "the
      // tool wrote somewhere else and reported a string that happens to match". Converting
      // `outDir` before `ctx.pdfRenderer.render(...)` produces exactly the second: the renderer
      // mkdir's the converted spelling and writes the PNGs into a DIFFERENT directory, while
      // the reported `pngPath` — already POSIX, so unchanged by the boundary — still equals
      // `posixOf(native)`. Only a stat at the host's own spelling catches it.
      await stat(path.join(nativeOutDir, `page-${p.page}.png`));
    }
  });

  it('renders the text channel from the same converted values as structuredContent', async () => {
    const { client, userDir } = await setupLocal('rpt');
    await stagePdf(userDir, 2);
    const nativePdfPath = buildPdfPath(userDir, 'main.tex');

    const res = await withWindowsSep(() =>
      client.callTool({
        name: 'render_pages',
        arguments: { project: 'poster', inline: false },
      }),
    );
    expect(res.isError ?? false).toBe(false);

    const out = renderOut(res);
    const text = textOf(res);
    expect(text).toContain(out.pdfPath);
    expect(text).not.toContain(nativePdfPath);
    for (const p of out.pages) {
      expect(text).toContain(p.pngPath);
    }
    // Nothing this tool prints is LaTeX source, so a backslash anywhere in the text is a path
    // that escaped the boundary conversion.
    expect(text).not.toContain('\\');
  });
});

/* -------------------------------------------------------------- pdf_geometry */

interface GeometryOut {
  pdfPath?: string;
}

function geometryOut(res: unknown): GeometryOut {
  return (res as { structuredContent: GeometryOut }).structuredContent;
}

describe('pdf_geometry: paths at the response boundary', () => {
  it('returns pdfPath with POSIX separators and names that same string in the header', async () => {
    const { client, userDir } = await setupLocal('geo');
    await stagePdf(userDir, 1);
    const nativePdfPath = buildPdfPath(userDir, 'main.tex');

    const res = await withWindowsSep(() =>
      client.callTool({ name: 'pdf_geometry', arguments: { project: 'poster' } }),
    );
    expect(res.isError ?? false).toBe(false);

    const out = geometryOut(res);
    expect(out.pdfPath).toBeTruthy();
    expect(out.pdfPath).toBe(posixOf(nativePdfPath));
    expect(out.pdfPath).not.toContain('\\');

    const text = textOf(res);
    expect(text).toContain(out.pdfPath ?? '');
    expect(text).not.toContain(nativePdfPath);
    expect(text).not.toContain('\\');
  });
});

/* ------------------------------------------------------------------ add_asset */

/** Twelve bytes with a PNG magic number: enough to be a distinct, hashable payload. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0xfd]);

/**
 * A source file OUTSIDE every project sandbox — which is what `add_asset` reads, by design — in a
 * directory whose own name carries the backslash segment, and canonicalized, because the reported
 * `source` is the realpath'd path (macOS `/var` -> `/private/var`, Windows `RUNNER~1`).
 */
async function assetSourceFile(): Promise<string> {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'ovl-posixsrc-'));
  cleanups.push(() => rm(parent, { recursive: true, force: true }));
  const dir = path.join(parent, SEGMENT);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'plot.png');
  await writeFile(file, PNG);
  return realpath(file);
}

interface AddAssetOut {
  path: string;
  bytesWritten: number;
  created: boolean;
  source: string;
  sha256: string;
}

function assetOut(res: unknown): AddAssetOut {
  return (res as { structuredContent: AddAssetOut }).structuredContent;
}

describe('add_asset: paths at the response boundary', () => {
  it('returns the resolved source with POSIX separators, in both channels', async () => {
    const { client, userDir } = await setupLocal('asx');
    const nativeSource = await assetSourceFile();

    const res = await withWindowsSep(() =>
      client.callTool({
        name: 'add_asset',
        arguments: { project: 'poster', path: 'figures/plot.png', sourcePath: nativeSource },
      }),
    );
    expect(res.isError ?? false).toBe(false);

    const out = assetOut(res);
    expect(out.source).toBe(posixOf(nativeSource));
    expect(out.source).not.toContain('\\');
    const text = textOf(res);
    expect(text).toContain(`from ${posixOf(nativeSource)}`);
    expect(text).not.toContain(nativeSource);

    // The consumer proof, and the reason the conversion sits at the emission point and not one
    // line earlier. `source` is the realpath'd path `resolveAssetSource` opened: realpath, stat,
    // the extension check on the resolved target and the read all take the host's own spelling.
    // Converted any earlier, `realpath` would be handed `…/out/dir/plot.png` — nothing is there
    // on this host — and the call would fail outright instead of copying anything. So assert the
    // bytes landed, byte-identically, at the NATIVE destination: a `source` string that merely
    // looks right proves nothing about what was copied, and "proves what was copied without
    // echoing bytes back" is this field's whole job.
    expect(out.bytesWritten).toBe(PNG.length);
    expect(out.created).toBe(true);
    expect(Buffer.compare(await readFile(path.join(userDir, 'figures', 'plot.png')), PNG)).toBe(0);
    expect(out.sha256).toBe(createHash('sha256').update(PNG).digest('hex'));
  });

  it('declares source in the outputSchema it advertises', async () => {
    // `source` is a documented field, not an incidental one — which is exactly why a native path
    // in it is a contract violation rather than cosmetic. Asserted off `tools/list`, since the
    // SDK discards its own parse result and `structuredContent` alone pins only the handler.
    const { client } = await setupLocal('asd');
    await expectDeclaredField(client, 'add_asset', 'source', { required: true });
  });
});

/* ------------------------------------------------------------------ read_file */

interface ReadFileOut {
  content: string;
  truncated: boolean;
  note?: string;
}

function readOut(res: unknown): ReadFileOut {
  return (res as { structuredContent: ReadFileOut }).structuredContent;
}

describe('read_file: paths at the response boundary', () => {
  it('returns the binary/large-file note with POSIX separators, in both channels', async () => {
    const { client, userDir } = await setupLocal('rfn');
    await mkdir(path.join(userDir, 'figures'), { recursive: true });
    const nativeAbs = path.join(userDir, 'figures', 'plot.png');
    await writeFile(nativeAbs, PNG);

    const res = await withWindowsSep(() =>
      client.callTool({
        name: 'read_file',
        arguments: { project: 'poster', path: 'figures/plot.png' },
      }),
    );
    expect(res.isError ?? false).toBe(false);

    const out = readOut(res);
    expect(out.truncated).toBe(true);
    // The documented branch: an asset extension (or a file over the text cap) is not returned
    // inline, and the note hands the caller a path instead — so that path is the one thing this
    // result is FOR, and it is spelled the way every other path this server returns is.
    expect(out.note).toBe(
      `Binary or large file (${PNG.length} bytes); content not returned. ` +
        `Open directly at ${posixOf(nativeAbs)}`,
    );
    expect(out.note).not.toContain('\\');
    // `read_file` renders `result.note ?? result.content`, so the two channels are the same
    // string by construction — assert it, so a future split cannot quietly disagree.
    expect(textOf(res)).toBe(out.note);

    // Two consumer proofs that the converted string is the note and nothing else. First: the
    // byte count in that very sentence comes from `stat(abs)`, so a conversion applied to `abs`
    // rather than to the interpolation would have thrown ENOENT before the note existed.
    // Second, and the one the revision tracker depends on — `abs` is also the key
    // `this.revisions.record` files a baseline under, and the text branch below reads through
    // it — so a plain read on the same backslash-bearing project must still return its content.
    const tex = await withWindowsSep(() =>
      client.callTool({
        name: 'read_file',
        arguments: { project: 'poster', path: 'main.tex' },
      }),
    );
    expect(tex.isError ?? false).toBe(false);
    const texOut = readOut(tex);
    expect(texOut.content).toBe(MAIN_TEX);
    expect(texOut.note).toBeUndefined();
  });
});
