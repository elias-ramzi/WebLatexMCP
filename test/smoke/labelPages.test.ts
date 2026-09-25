import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { LatexmkCompiler, buildDir, buildPdfPath } from '../../src/services/compiler.js';
import { readAuxFloats } from '../../src/lib/auxFloats.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * Label -> page resolution against REAL pdflatex output, where it matters most: a document with
 * no /PageLabels tree (no hyperref) whose pages are silently renumbered. `report`'s `\maketitle`
 * puts the title on its own page and resets the counter, so the figure printed on page "1" is PDF
 * page 2 — and PDF page 1 is the title page, the most plausible wrong answer there is. Gated on
 * latexmk like every smoke (runs in the tex-smoke CI job).
 */
const compiler = new LatexmkCompiler();
const available = await compiler.isAvailable();

function reportTex(hyperref: boolean): string {
  return [
    '\\documentclass{report}',
    hyperref ? '\\usepackage{hyperref}' : '',
    '\\title{T}\\author{A}',
    '\\begin{document}',
    '\\maketitle',
    '\\chapter{One}',
    '\\begin{figure}[h]\\centering FIGURE-BODY\\caption{Cap}\\label{fig:a}\\end{figure}',
    '\\end{document}',
    '',
  ].join('\n');
}

const ARTICLE_TEX = [
  '\\documentclass{article}',
  '\\begin{document}',
  'Body.',
  '\\begin{figure}[h]\\centering FIGURE-BODY\\caption{Cap}\\label{fig:a}\\end{figure}',
  '\\end{document}',
  '',
].join('\n');

/**
 * An `article` whose body is full of small numbers — every paragraph cites "[1, 2]" and counts
 * "3 runs" — with two figures, and no hyperref. With `[titlepage]` the unnumbered title page
 * resets the counter, so each figure's printed page is one less than its PDF page; without it,
 * printed page and PDF page agree. No packages, so the smoke needs nothing past a base install.
 */
function citingArticleTex(titlepage: boolean): string {
  const para =
    'Filler text that stands in for a paragraph of an ordinary paper, long enough to wrap over ' +
    'several lines and fill the page in a handful of repetitions. Prior work [1, 2] reports 3 ' +
    'runs, and 4 of 5 settings agree.\\par';
  const paras = (n: number): string => Array.from({ length: n }, () => para).join('\n');
  return [
    `\\documentclass${titlepage ? '[titlepage]' : ''}{article}`,
    '\\title{T}\\author{A}',
    '\\begin{document}',
    '\\maketitle',
    '\\section{Intro}',
    paras(18),
    '\\begin{figure}[t]\\centering FIGURE-A\\caption{First}\\label{fig:a}\\end{figure}',
    paras(18),
    '\\begin{figure}[t]\\centering FIGURE-B\\caption{Second}\\label{fig:b}\\end{figure}',
    paras(18),
    '\\end{document}',
    '',
  ].join('\n');
}

/**
 * A `[titlepage]` article under fancyhdr with `\cfoot{Page \thepage}` — the folio is never a bare
 * number, so only the running head (fancyhdr's default `\rightmark`, the SECTION number) reads as
 * one. Believing one page's reading on its own resolved fig:s4 (printed page 4) to PDF page 4,
 * whose head reads section "4", while the figure is on PDF page 5. Each float body carries `MK` + its label's alphanumerics, so
 * the page a label really sits on is read off the result itself. The source is the unit fixture
 * whose real text layer `labelPagesVerify.test.ts` checks, so the two tiers test one document.
 */
const FANCY_PAGE_N_TEX = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../fixtures/label-folio/fancyPageFoot.tex',
  ),
  'utf8',
);

/** Whether `beamer.cls` is installed — a base TeX install may lack it, so its smokes gate on it. */
function hasBeamer(): boolean {
  try {
    return execFileSync('kpsewhich', ['beamer.cls'], { encoding: 'utf8' }).trim() !== '';
  } catch {
    return false;
  }
}
const beamerAvailable = available && hasBeamer();

/** Whether an engine binary answers on PATH. latexmk being installed says nothing about which
 *  engines are, and a missing one fails the compile rather than skipping the test. */
function hasEngine(engine: 'xelatex' | 'lualatex'): boolean {
  try {
    execFileSync(engine, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const xelatexAvailable = available && hasEngine('xelatex');
const lualatexAvailable = available && hasEngine('lualatex');

/**
 * A plain `\documentclass{beamer}` deck (hyperref by default) whose first frame has three
 * `\pause` slides: beamer's /PageLabels number FRAMES ("1","1","1","2",...) while the .aux
 * records the SLIDE, so fig:r (slide 4) looked up as "4" landed on PDF page 7. `footline` is
 * spliced in as the preamble's footline template (empty = beamer's default, no page number).
 */
function beamerPauseTex(footline: string): string {
  return [
    '\\documentclass{beamer}',
    footline,
    '\\begin{document}',
    '\\begin{frame}{Intro}First\\pause Second\\pause Third\\end{frame}',
    '\\begin{frame}{Results}\\begin{figure}\\centering MKfigr BODY\\caption{Cap}\\label{fig:r}\\end{figure}\\end{frame}',
    '\\begin{frame}{More}A\\pause B\\end{frame}',
    '\\begin{frame}{Tab}\\begin{table}\\centering MKtabt\\caption{T}\\label{tab:t}\\end{table}\\end{frame}',
    '\\end{document}',
    '',
  ].join('\n');
}

/** The fixture source beside pages.json, so the smoke and the unit tier test one document. */
function fixtureTex(name: string): string {
  return readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), `../fixtures/label-folio/${name}.tex`),
    'utf8',
  );
}

interface Out {
  pages: Array<{ page: number; lines?: string[] }>;
  resolvedLabels?: Array<{ label: string; printedPage: string; page: number }>;
}

function textOf(res: unknown): string {
  return ((res as { content?: Array<{ text?: string }> }).content ?? [])
    .map((b) => b.text ?? '')
    .join('\n');
}

describe.skipIf(!available)('label -> page against a real compile', () => {
  const cleanups: Array<() => Promise<unknown>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  async function compiled(tex: string, engine?: 'xelatex' | 'lualatex'): Promise<Client> {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-labelsmoke-ws-'));
    const userDir = await mkdtemp(path.join(os.tmpdir(), 'ovl-labelsmoke-src-'));
    cleanups.push(
      () => rm(workspace, { recursive: true, force: true }),
      () => rm(userDir, { recursive: true, force: true }),
      () => rm(buildDir(userDir), { recursive: true, force: true }),
    );
    await writeFile(path.join(userDir, 'main.tex'), tex);
    const config: ServerConfig = {
      workspaceRoot: workspace,
      sessionId: 'test',
      projects: [{ id: 'doc', mode: 'local', path: userDir, rootFile: 'main.tex' }],
      defaultProject: 'doc',
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

    const res = await client.callTool({
      name: 'compile',
      arguments: { project: 'doc', ...(engine ? { engine } : {}) },
    });
    const structured = res.structuredContent as Record<string, unknown>;
    expect(structured.success, JSON.stringify(res.content)).toBe(true);
    // Every real build here is ordinary TeX output, so its .log's shipout marks must number
    // exactly the PDF's pages: a shorter or longer parse would silently skip the shipout check
    // (and a wrong sequence of the right length would refuse labels it should not).
    const aux = await readAuxFloats(userDir, 'main.tex', { max: 20_000, shipouts: true });
    const pageCount = await ctx.pdfRenderer.pageCount(buildPdfPath(userDir, 'main.tex'));
    expect(aux.shipouts, 'shipout marks read').toBeDefined();
    expect(aux.shipouts, 'one shipout mark per PDF page').toHaveLength(pageCount);
    return client;
  }

  it('refuses a \\maketitle report without hyperref instead of returning the title page', async () => {
    const client = await compiled(reportTex(false));

    const text = await client.callTool({
      name: 'extract_text',
      arguments: { project: 'doc', labels: ['fig:a'] },
    });
    // Before the page-text check this resolved fig:a (printed page "1") to PDF page 1 and
    // returned the title page's text as the figure's page.
    expect(text.isError, textOf(text)).toBe(true);
    expect(textOf(text)).toContain('"1.1"');
    expect(textOf(text)).toContain('hyperref');
    expect(textOf(text)).not.toMatch(/September/);

    const render = await client.callTool({
      name: 'render_pages',
      arguments: { project: 'doc', labels: ['fig:a'], inline: false },
    });
    expect(render.isError, textOf(render)).toBe(true);
    expect(textOf(render)).toContain('fig:a');
  }, 120_000);

  it('with hyperref, still never the title page: /PageLabels prints "1" on it too', async () => {
    // A real finding, pinned: hyperref's /PageLabels labels the unnumbered title page "1" as
    // well, so the exact lookup sees two candidates and refuses as ambiguous. The point is the
    // same as above — PDF page 1 is never returned for fig:a.
    const client = await compiled(reportTex(true));
    const res = await client.callTool({
      name: 'extract_text',
      arguments: { project: 'doc', labels: ['fig:a'] },
    });
    expect(res.isError, textOf(res)).toBe(true);
    expect(textOf(res)).toContain('PDF pages 1, 2');
  }, 120_000);

  it('still resolves a plain article without hyperref, whose page shows the figure number', async () => {
    const client = await compiled(ARTICLE_TEX);
    const res = await client.callTool({
      name: 'extract_text',
      arguments: { project: 'doc', labels: ['fig:a'] },
    });
    expect(res.isError ?? false, textOf(res)).toBe(false);
    const out = res.structuredContent as unknown as Out;
    expect(out.resolvedLabels).toEqual([{ label: 'fig:a', printedPage: '1', page: 1 }]);
    expect(out.pages[0]?.lines).toContain('Figure 1: Cap');
  }, 120_000);

  it('refuses a [titlepage] article whose pages are full of small numbers (no hyperref)', async () => {
    // Checking the label's number instead of the folio accepted this: "[1, 2]" and "3 runs" put
    // the label numbers on every page, so the page BEFORE each figure "showed" its number. Only the folio says which page is which.
    const client = await compiled(citingArticleTex(true));
    const res = await client.callTool({
      name: 'extract_text',
      arguments: { project: 'doc', labels: ['fig:a', 'fig:b'] },
    });
    expect(res.isError, textOf(res)).toBe(true);
    expect(textOf(res)).toMatch(/PDF page \d+ reads as page number "\d+", not "\d+"/);
    expect(textOf(res)).toContain('hyperref');
  }, 120_000);

  it('resolves the same article without [titlepage] to the pages the figures are on', async () => {
    const client = await compiled(citingArticleTex(false));
    const res = await client.callTool({
      name: 'extract_text',
      arguments: { project: 'doc', labels: ['fig:a', 'fig:b'] },
    });
    expect(res.isError ?? false, textOf(res)).toBe(false);
    const out = res.structuredContent as unknown as Out;
    const byLabel = new Map((out.resolvedLabels ?? []).map((r) => [r.label, r.page]));
    const pageOf = (caption: string): number | undefined =>
      out.pages.find((p) => p.lines?.includes(caption))?.page;
    expect(pageOf('Figure 1: First')).toBe(byLabel.get('fig:a'));
    expect(pageOf('Figure 2: Second')).toBe(byLabel.get('fig:b'));
    expect(byLabel.get('fig:a')).not.toBe(byLabel.get('fig:b'));
  }, 120_000);

  it('never resolves a fancyhdr "Page N" [titlepage] label to a page its float is not on', async () => {
    // Refusal or the right page, label by label — never a wrong page. Asked one label per call,
    // because one refused label refuses the whole call and would hide a wrong neighbour.
    const client = await compiled(FANCY_PAGE_N_TEX);
    for (let s = 1; s <= 8; s++) {
      const label = `fig:s${s}`;
      const res = await client.callTool({
        name: 'extract_text',
        arguments: { project: 'doc', labels: [label] },
      });
      if (res.isError) {
        // A refusal is allowed — but it must be the label refusal, not some other failure.
        expect(textOf(res)).toContain('Could not resolve 1 label(s)');
        continue;
      }
      const out = res.structuredContent as unknown as Out;
      const page = out.resolvedLabels?.[0]?.page;
      const shown = out.pages.find((p) => p.page === page);
      expect(
        shown?.lines?.some((l) => l.includes(`MKfigs${s}`)),
        `${label} -> ${page}`,
      ).toBe(true);
    }
  }, 240_000);
  /** One label per call (one refusal refuses the whole call and would hide a wrong neighbour):
   *  the page each resolved label landed on, or `undefined` for a label refusal. */
  async function landed(client: Client, label: string): Promise<{ page?: number; text: string }> {
    const res = await client.callTool({
      name: 'extract_text',
      arguments: { project: 'doc', labels: [label] },
    });
    if (res.isError) {
      expect(textOf(res)).toContain('Could not resolve 1 label(s)');
      return { text: textOf(res) };
    }
    const out = res.structuredContent as unknown as Out;
    const page = out.resolvedLabels?.[0]?.page;
    const mark = 'MK' + label.replace(/[^A-Za-z0-9]/g, '');
    const shown = out.pages.find((p) => p.page === page);
    expect(
      shown?.lines?.some((l) => l.includes(mark)),
      `${label} -> ${page}`,
    ).toBe(true);
    return { page, text: textOf(res) };
  }

  it.skipIf(!beamerAvailable)(
    'never resolves a beamer \\pause deck through its frame-numbered /PageLabels',
    async () => {
      const client = await compiled(beamerPauseTex(''));
      for (const label of ['fig:r', 'tab:t']) {
        const got = await landed(client, label);
        // No footline, so no folio: refused, and the refusal says why the tree was not used.
        expect(got.page, label).toBeUndefined();
        expect(got.text).toMatch(/beamer/);
      }
    },
    240_000,
  );

  it.skipIf(!beamerAvailable)(
    'resolves that deck by slide once the footline prints the slide number',
    async () => {
      const client = await compiled(
        beamerPauseTex('\\setbeamertemplate{footline}{\\hfill\\insertpagenumber\\hspace{1em}}'),
      );
      expect((await landed(client, 'fig:r')).page).toBe(4);
      expect((await landed(client, 'tab:t')).page).toBe(7);
    },
    240_000,
  );

  it('refuses every label of a document that restarts arabic numbering for a supplement', async () => {
    const client = await compiled(fixtureTex('restartSupp'));
    for (const label of ['fig:m1', 'fig:m2', 'fig:m3', 'fig:s1', 'fig:s2', 'fig:s3']) {
      const got = await landed(client, label);
      expect(got.page, label).toBeUndefined();
      expect(got.text).toMatch(/restart/);
    }
  }, 240_000);

  it('refuses a supplement restart whose printed pages never go down in the .aux', async () => {
    // Main labels on printed 1-2, then \setcounter{page}{1} and supplement labels on printed
    // 2-4: no decrease, so only the last page (printing "4" of 10) gives the restart away.
    // Without the last-page check fig:s1..s3 resolve to the MAIN paper's pages 2-4.
    const client = await compiled(fixtureTex('restartNoDecrease'));
    for (const label of ['fig:s1', 'fig:s2', 'fig:s3', 'fig:m1', 'fig:m2']) {
      const got = await landed(client, label);
      expect(got.page, label).toBeUndefined();
      expect(got.text).toMatch(/the last PDF page, \d+, reads as page number "4"/);
    }
  }, 240_000);

  it.skipIf(!beamerAvailable)(
    'never resolves a pgfpages 2-on-1 deck through its identity /PageLabels tree',
    async () => {
      // A pin, not a regression test: an identity tree is "1".."4" on a 4-sheet PDF of 8
      // slides, and fig:f1 records "3" while it sits on sheet 1.
      const client = await compiled(fixtureTex('beamerPgfpages'));
      for (const label of ['fig:f1', 'fig:f2', 'fig:f3']) {
        expect((await landed(client, label)).page, label).toBeUndefined();
      }
    },
    240_000,
  );

  it.skipIf(!beamerAvailable)(
    'refuses a non-overlay default-theme deck: its identity /PageLabels tree is not used',
    async () => {
      // Six one-slide frames, no slide number in the footline. The tree "1".."6" happens to be
      // the slide numbering here, but a pgfpages layout gives a deck an identity tree whose
      // numbers the labels do not share (below), so a deck's tree is never used — and no footline
      // prints a slide number to confirm one. The source is the unit fixture.
      const client = await compiled(fixtureTex('beamerPlain'));
      for (const label of ['fig:r', 'tab:t']) {
        const got = await landed(client, label);
        expect(got.page, label).toBeUndefined();
        expect(got.text).toMatch(/beamer/);
      }
    },
    240_000,
  );

  it.skipIf(!beamerAvailable)(
    'never resolves a pgfpages "resize to" deck to a wrong slide through its identity tree',
    async () => {
      // One slide per sheet, so the tree is "1".."4" and the .aux counts 4 slides — but pgfpages
      // defers each shipout a page, so fig:f1 (sheet 1) records "2". Trusting the identity tree
      // rendered the NEXT slide for every label; `landed` also fails on any page that does not show the label.
      const client = await compiled(fixtureTex('beamerResizeTo'));
      for (const label of ['fig:f1', 'fig:f2', 'fig:f3']) {
        expect((await landed(client, label)).page, label).toBeUndefined();
      }
    },
    240_000,
  );

  it.skipIf(!beamerAvailable)(
    'never resolves that "resize to" deck wrongly when its footline prints the slide number',
    async () => {
      // Each sheet prints its true slide number, so the folio route used to confirm the page the
      // shifted \newlabel names — one slide late for every label. beamer's own \beamer@slide
      // record in the .aux disagrees with that page, and that refuses it.
      const client = await compiled(fixtureTex('beamerResizeToPageNumber'));
      for (const label of ['fig:f1', 'fig:f2', 'fig:f3']) {
        const got = await landed(client, label);
        expect(got.page, label).toBeUndefined();
        expect(got.text, label).toMatch(/pgfpages/);
      }
    },
    240_000,
  );

  it('refuses every label of a pgfpages "resize to" article, with or without hyperref', async () => {
    // Not a deck, so no beamer slide record to check against: every \newlabel records the page
    // after its own, each page prints its own true folio, and the folio route (and, under
    // hyperref, the shifted /PageLabels tree) rendered the NEXT figure for every label. The build's
    // recorder file names pgfpages.sty, and that refuses them. The source is the unit fixture.
    const tex = fixtureTex('articleResizeTo');
    for (const variant of [
      tex,
      tex.replace('\\documentclass{article}', '$&\n\\usepackage{hyperref}'),
    ]) {
      const client = await compiled(variant);
      for (const label of ['fig:a', 'fig:b', 'fig:c']) {
        const got = await landed(client, label);
        expect(got.page, label).toBeUndefined();
        expect(got.text, label).toMatch(
          /this build's records \(its recorder file or log\) name pgfpages\.sty/,
        );
      }
    }
  }, 240_000);

  it.skipIf(!beamerAvailable)(
    'never resolves a "resize to" deck label whose key holds a brace group to a wrong slide',
    async () => {
      // `\label{fig:{a}}`: the key the slide record is read under used to stop at the brace, so
      // the label had no record and the folio route confirmed the late page. Refused now — by the
      // build's pgfpages evidence first, and by the slide record where that evidence is missing.
      const client = await compiled(fixtureTex('beamerResizeToBraces'));
      for (const label of ['fig:{a}', 'fig:b', 'fig:{c}']) {
        expect((await landed(client, label)).page, label).toBeUndefined();
      }
    },
    240_000,
  );

  it("refuses the shifted table-bottom residual through the log's shipout record", async () => {
    // `[titlepage]`, `\pagestyle{empty}`, and a tabular ending in a bare cell at each page foot
    // that reads as the PDF page index. The folio route accepted figb, figc and figd one page early
    // (each candidate's last line reads its printed page, and the next page's reads the next
    // number); the .log shipped the pages as [1] [1] [2] [3] [4], which refuses them.
    const client = await compiled(fixtureTex('tableBottomShifted'));
    for (const label of ['figa', 'figb', 'figc', 'figd']) {
      const got = await landed(client, label);
      expect(got.page, label).toBeUndefined();
    }
    for (const label of ['figb', 'figc', 'figd']) {
      const got = await landed(client, label);
      expect(got.text, label).toMatch(/the log's shipout record says PDF page \d was shipped out/);
    }
  }, 240_000);

  /** Compile each doc and check every body label resolves to its own page, by its marker. */
  async function expectBodyResolves(
    docs: Array<[string, string, 'xelatex' | 'lualatex' | undefined]>,
  ): Promise<void> {
    for (const [name, tex, engine] of docs) {
      const client = await compiled(tex, engine);
      const res = await client.callTool({
        name: 'extract_text',
        arguments: { project: 'doc', labels: ['figa', 'figb', 'figc', 'figd'] },
      });
      expect(res.isError ?? false, `${name}: ${textOf(res)}`).toBe(false);
      const out = res.structuredContent as unknown as Out;
      expect(
        out.resolvedLabels?.map((r) => r.page),
        name,
      ).toEqual([1, 2, 3, 4]);
      for (const r of out.resolvedLabels ?? []) {
        const mark = 'MK' + r.label;
        const shown = out.pages.find((p) => p.page === r.page);
        expect(
          shown?.lines?.some((l) => l.includes(mark)),
          `${name}: ${r.label} -> ${r.page}`,
        ).toBe(true);
      }
    }
  }

  it('resolves the body of a document whose appendix resets the counter under alph, S or Roman', async () => {
    // No hyperref. The body prints 1-4; the appendix resets the page counter under
    // \pagenumbering{alph}, `S\arabic{page}` or \pagenumbering{Roman}, so the log ships
    // [1] [2] [3] [4] [1] [2]. The appendix pages print "a", "S1", "I" — no second "1" — so
    // every body label resolves to its own page, as it did before the log was read.
    // The Roman variant drops the appendix label: a label printing "I" refuses every label of the
    // document as renumbered, with or without the log.
    const roman = fixtureTex('appendixAlph')
      .replace('\\pagenumbering{alph}', '\\pagenumbering{Roman}')
      .replace('\\fig{appa}', '');
    await expectBodyResolves([
      ['appendixAlph', fixtureTex('appendixAlph'), undefined],
      ['suppPrefixed', fixtureTex('suppPrefixed'), undefined],
      ['appendixRoman', roman, undefined],
    ]);
  }, 480_000);

  it.skipIf(!lualatexAvailable)(
    'resolves the body of a document whose appendix resets the counter, under lualatex',
    async () => {
      await expectBodyResolves([
        ['appendixAlph (lualatex)', fixtureTex('appendixAlph'), 'lualatex'],
      ]);
    },
    240_000,
  );

  it.skipIf(!xelatexAvailable)(
    'resolves the body of a document whose supplement prints S-prefixed pages, under xelatex',
    async () => {
      await expectBodyResolves([['suppPrefixed (xelatex)', fixtureTex('suppPrefixed'), 'xelatex']]);
    },
    240_000,
  );

  async function expectRestartRefused(engine?: 'lualatex'): Promise<void> {
    const client = await compiled(fixtureTex('restartUnlabelled'), engine);
    for (const label of ['suppb', 'figa']) {
      const got = await landed(client, label);
      expect(got.page, `${engine ?? 'pdflatex'} ${label}`).toBeUndefined();
      expect(got.text).toMatch(/the log's shipout record shows page counter \d on PDF page \d/);
    }
  }

  it('still refuses an arabic restart with no label before it, by its shipout record', async () => {
    // Main paper 1-4, then \setcounter{page}{1} (arabic) and a supplement whose label suppb is
    // on its printed page 2 (PDF page 6); the last page prints no number. The .aux reads 1, 2 and
    // the last page is silent, so the folio route alone resolves suppb to the main paper's page
    // 2; the log ships [1] [2] [3] [4] [1] [2] [3] and PDF page 6 prints "2" too.
    await expectRestartRefused();
  }, 240_000);

  it.skipIf(!lualatexAvailable)(
    'still refuses an arabic restart with no label before it, under lualatex',
    async () => {
      await expectRestartRefused('lualatex');
    },
    240_000,
  );

  it('never resolves a section-per-page "Page N" / "N/M" / "– N –" document wrongly', async () => {
    for (const doc of ['secpagePageN', 'secpageSlashOf', 'secpageDash']) {
      const client = await compiled(fixtureTex(doc));
      for (let s = 2; s <= 8; s++) await landed(client, `fig:s${s}`);
    }
  }, 480_000);
});
