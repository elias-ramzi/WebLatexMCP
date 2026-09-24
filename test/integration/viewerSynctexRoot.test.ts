import { describe, it, expect, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createContext, type AppContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import { buildDir, buildPdfPath } from '../../src/services/compiler.js';
import { minimalPdf } from '../helpers/minimalPdf.js';
import type { ServerConfig } from '../../src/types.js';

/*
 * The viewer shows one PDF and maps a click on it back to source through synctex. Both halves
 * must name the SAME root's build.
 *
 * In workspace-local mode `compile` copies whatever root it just built to `<workspace>/<id>.pdf`
 * — one file per project, holding whichever root compiled LAST — while a comment's click was
 * resolved through the DETECTED root's build-dir synctex. After compiling a non-default root
 * (a supplement), the user clicked on the supplement's page and the comment was filed against
 * main.tex's file/line, silently; `list_comments` then showed the wrong snippet.
 */

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  vi.restoreAllMocks();
});

interface Harness {
  ctx: AppContext;
  base: string;
  mainPdf: string;
  surfaced: string;
  synctexPdfs: string[];
}

async function setup(opts: { stageMainBuild: boolean }): Promise<Harness> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-viewsync-ws-'));
  const userDir = await mkdtemp(path.join(os.tmpdir(), 'ovl-viewsync-dir-'));
  cleanups.push(
    () => rm(workspace, { recursive: true, force: true }),
    () => rm(userDir, { recursive: true, force: true }),
    () => rm(buildDir(userDir), { recursive: true, force: true }),
  );
  // main.tex is the detected (default) root; supp.tex is a second root the user compiled last.
  await writeFile(
    path.join(userDir, 'main.tex'),
    '\\documentclass{article}\n\\begin{document}\nMain\n\\end{document}\n',
  );
  await writeFile(
    path.join(userDir, 'supp.tex'),
    '\\documentclass{article}\n\\begin{document}\nSupp\n\\end{document}\n',
  );

  const mainPdf = buildPdfPath(userDir, 'main.tex');
  const suppPdf = buildPdfPath(userDir, 'supp.tex');
  await mkdir(path.dirname(mainPdf), { recursive: true });
  if (opts.stageMainBuild) {
    await writeFile(mainPdf, minimalPdf(3, 300, 200, { text: (n) => `MAIN page ${n}` }));
  }
  const suppBytes = minimalPdf(5, 300, 200, { text: (n) => `SUPP page ${n}` });
  await writeFile(suppPdf, suppBytes);
  // The surfaced copy, left by the later compile of supp.tex.
  const surfaced = path.join(workspace, 'poster.pdf');
  await writeFile(surfaced, suppBytes);

  const config: ServerConfig = {
    workspaceRoot: workspace,
    workspaceIsLocal: true,
    sessionId: 'test',
    projects: [{ id: 'poster', mode: 'local', path: userDir }],
  };
  const ctx = createContext(
    config,
    new CredentialResolver({}),
    { name: 'Test', email: 'test@example.com' },
    new ProjectRegistry(workspace),
  );
  // Stand in for the synctex CLI (not installed on CI's fast legs): record which PDF the click
  // was resolved through, and answer with a location as a real synctex record would.
  const synctexPdfs: string[] = [];
  vi.spyOn(ctx.synctex, 'resolve').mockImplementation(async (pdf) => {
    synctexPdfs.push(pdf);
    return { file: 'main.tex', line: 3 };
  });
  const url = await ctx.viewer.start(0);
  if (!url) throw new Error('viewer did not start');
  cleanups.push(() => ctx.viewer.close());
  return { ctx, base: url, mainPdf, surfaced, synctexPdfs };
}

async function postComment(base: string): Promise<{ file?: string; line?: number }> {
  const res = await fetch(`${base}/p/poster/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ page: 1, x: 100, y: 100, quote: 'Hi', note: 'fix this' }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { file?: string; line?: number };
}

describe('viewer: the displayed PDF and its synctex source are the same root', () => {
  it('maps a click through the synctex of the very PDF the viewer serves', async () => {
    const { base, synctexPdfs } = await setup({ stageMainBuild: true });
    const served = Buffer.from(await (await fetch(`${base}/p/poster/pdf`)).arrayBuffer());

    const comment = await postComment(base);
    expect(synctexPdfs).toHaveLength(1);
    // Whatever root the viewer shows, the synctex it resolved through sits beside those bytes.
    const resolvedThrough = await readFile(synctexPdfs[0]!);
    expect(resolvedThrough.equals(served)).toBe(true);
    expect(comment).toMatchObject({ file: 'main.tex', line: 3 });
  });

  it('falls back to the surfaced copy when the build is gone, and then maps nothing', async () => {
    const { base, surfaced, synctexPdfs } = await setup({ stageMainBuild: false });
    // The detected root's build PDF was wiped: the viewer still has something to show…
    const res = await fetch(`${base}/p/poster/pdf`);
    expect(res.status).toBe(200);
    const served = Buffer.from(await res.arrayBuffer());
    expect(served.equals(await readFile(surfaced))).toBe(true);

    // …but that copy may be any root's, so a click on it is kept without a source location
    // rather than resolved through a synctex that may belong to a different document.
    const comment = await postComment(base);
    expect(synctexPdfs).toEqual([]);
    expect(comment.file).toBeUndefined();
    expect(comment.line).toBeUndefined();
  });
});
