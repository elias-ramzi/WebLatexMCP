import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import { buildDir, buildRoot } from '../../src/services/compiler.js';
import { locateViewerPdf } from '../../src/lib/pdfLocate.js';
import { minimalPdf } from '../helpers/minimalPdf.js';
import { ROUTES_ONLY_LOG } from '../helpers/stagedLog.js';
import type { ServerConfig } from '../../src/types.js';

/*
 * #215, the read side: the PDF tools read the build root's PDF, .aux and .log back and trust them
 * (label pages, float pages, the text a reviewer quotes), and `render_pages` writes its PNGs under
 * it. A build root planted as a link to another user's directory would hand them a forged build
 * to read and a place to receive every rendered page, so the readers judge the root exactly as a
 * compile does (`ensureBuildRoot`) before they stat, read or write anything under it — on the
 * main-build route (`locateRootPdf`) and the variant route (`resolveVariantBuild`) alike.
 *
 * `os.tmpdir()` reads TMPDIR on every call (POSIX), so the build root moves into a private temp
 * dir for this test only, as in compileOverlayBuildRoot.test.ts.
 */

const cleanups: Array<() => Promise<unknown>> = [];
const savedTmp = process.env.TMPDIR;
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  if (savedTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmp;
});

const MAIN_TEX = '\\documentclass{article}\n\\begin{document}\nHi.\n\\end{document}\n';
const HANDLE = 'v0123456789ab';

/** Every path under `dir` with its bytes, so "unchanged" covers additions and rewrites alike. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const rel = path.relative(dir, p);
      if (e.isDirectory()) {
        out[`${rel}/`] = '';
        await walk(p);
      } else {
        out[rel] = (await readFile(p)).toString('base64');
      }
    }
  };
  await walk(dir);
  return out;
}

describe.skipIf(process.platform === 'win32')('PDF readers: planted build root (#215)', () => {
  it('render_pages, pdf_geometry and extract_text refuse it, main build and variant alike, and leave it untouched', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'wlm-reader-root-'));
    cleanups.push(() => rm(tmp, { recursive: true, force: true }));
    process.env.TMPDIR = tmp;
    const workspace = await mkdtemp(path.join(tmp, 'ws-'));
    const userDir = await mkdtemp(path.join(tmp, 'paper-'));
    await writeFile(path.join(userDir, 'main.tex'), MAIN_TEX);

    const config: ServerConfig = {
      workspaceRoot: workspace,
      workspaceIsLocal: true,
      sessionId: 'test',
      projects: [],
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
    const reg = await client.callTool({
      name: 'register_project',
      arguments: { project: 'poster', path: userDir },
    });
    expect(reg.isError ?? false, JSON.stringify(reg.content)).toBe(false);

    // Another local user's directory, linked where this server's build root would be, holding a
    // plausible build of this very project: a PDF, an .aux and a .log where compile would have
    // left them, and a variant with its manifest and PDF.
    expect(path.dirname(buildRoot())).toBe(tmp);
    const theirs = path.join(tmp, 'theirs');
    await mkdir(theirs, { mode: 0o777 });
    const planted = path.join(theirs, path.basename(buildDir(userDir)));
    await mkdir(planted);
    await writeFile(path.join(planted, 'main.pdf'), minimalPdf(2));
    await writeFile(path.join(planted, 'main.aux'), '\\relax\n\\newlabel{sec:a}{{1}{1}}\n');
    await writeFile(path.join(planted, 'main.log'), ROUTES_ONLY_LOG);
    const variantRoot = path.join(planted, 'variants', HANDLE);
    await mkdir(path.join(variantRoot, 'out'), { recursive: true });
    await writeFile(path.join(variantRoot, 'out', 'main.pdf'), minimalPdf(1));
    const now = new Date().toISOString();
    await writeFile(
      path.join(variantRoot, 'variant.json'),
      JSON.stringify({
        rootFile: 'main.tex',
        createdAt: now,
        usedAt: now,
        seq: 0,
        files: ['main.tex'],
        compiler: 'latexmk',
        engine: 'pdflatex',
      }),
    );
    await symlink(theirs, buildRoot());
    const before = await snapshot(theirs);

    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    for (const name of ['render_pages', 'pdf_geometry', 'extract_text']) {
      calls.push({ name, arguments: { project: 'poster' } });
      calls.push({ name, arguments: { project: 'poster', variant: HANDLE } });
    }
    calls.push({ name: 'render_pages', arguments: { project: 'poster', labels: ['sec:a'] } });
    calls.push({ name: 'pdf_geometry', arguments: { project: 'poster', kinds: ['floats'] } });

    for (const call of calls) {
      const res = await client.callTool(call);
      const text = ((res.content ?? []) as Array<{ text?: string }>)
        .map((b) => b.text ?? '')
        .join('\n');
      const what = `${JSON.stringify(call)} -> ${text}`;
      // Soft, so one run shows every route that is not refused rather than only the first.
      expect.soft(res.isError, what).toBe(true);
      expect.soft(text, what).toContain(`Refusing to use build root ${buildRoot()}`);
      expect.soft(text, what).toContain('symbolic link');
    }
    // The viewer locates its PDF through the same check.
    await expect(locateViewerPdf(config, 'poster', userDir, 'main.tex')).rejects.toThrow(
      'Refusing to use build root',
    );

    // Nothing was written into their directory — no render/ PNGs — and nothing was rewritten.
    expect(await snapshot(theirs)).toEqual(before);
  });
});
