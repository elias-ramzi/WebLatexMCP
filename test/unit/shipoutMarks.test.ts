import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { constants, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, open, rm, symlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  MAX_SHIPOUT_LOG_BYTES,
  parseShipoutMarks,
  readAuxFloats,
  readPgfpagesEvidence,
  readShipoutMarks,
} from '../../src/lib/auxFloats.js';
import { buildAuxPath, buildDir } from '../../src/services/compiler.js';

/**
 * The shipout marks TeX writes into the `.log` — `[` + `\count0` (`.`-separated `\count1`..`\count9`
 * up to the last nonzero one) + `]`, once per page shipped out — read off REAL logs. Every fixture
 * under `fixtures/label-folio/shipouts/` is the `.log` of a latexmk build made with the server's own
 * arguments (`-interaction=nonstopmode -file-line-error -cd -synctex=1 -outdir=…`) on TeX Live
 * 2023, edited in one way only: personal path segments were anonymised with replacements of the
 * SAME length (`/Users/<name>/` → `/Users/tex01/`, the scratch directory's name → `scratch001`),
 * so every physical line keeps its length and TeX's 79-column wrap is exactly as the engine wrote
 * it. `pageCount` is what the PDF beside it reported, never the parser.
 *
 *  - `article` — a plain 5-page article.
 *  - `reporttitle` — `\documentclass[titlepage]{report}` + `\maketitle`: the title page is shipped
 *    with counter 1 and the counter is reset, so the first body page ships with 1 again.
 *  - `setcounter` — `\setcounter{page}{5}` on the first page.
 *  - `include` — a `book` of two `\include`d chapters (`\openout` lines between the marks).
 *  - `images` — `\includegraphics` of PNG and PDF images: the image path sits INSIDE the mark
 *    (`[2 </…/example-image-a.pdf>]`, lualatex `[2</…>]`), and on page 1 the PNG's path is cut by
 *    TeX's 79-column wrap.
 *  - `long` — 130 pages: runs of marks across many lines.
 *  - `count1` — `\count1=2` (`[1.2]`), then `\count1=-3 \count5=7` (`[4.-3.0.0.0.7]`); pdflatex
 *    and lualatex cut `[3]` across the 79-column wrap as `[` / `3]`.
 *  - `overfull` — overfull boxes whose text is `see [1] and [2]`, `[3] [4]`, `[10]`: TeX's box
 *    display puts document text in the log.
 *  - `beamer` — a `\pause` deck with 7 slides.
 *  - `resizeto` — the `articleResizeTo.tex` fixture (`\pgfpagesuselayout{resize to}`): a 4-page
 *    PDF whose pages were shipped with counters 2..5.
 *  - `hyperref` — the plain article with hyperref loaded.
 *  - `frontmatter` — a `book` with `\frontmatter` (roman, 6 pages) and `\mainmatter`, hyperref.
 *  - `nonascii` — `\input` of a file with a long non-ASCII name, cut by the wrap mid-name.
 *  - `forged` — `\message{[7]}` and `\message{see [8] here}`: the document adds mark-shaped text.
 *  - `tableBottomShifted` — the `tableBottomShifted.tex` fixture (`[titlepage]`, empty page style).
 *  - `appendixAlph`, `suppPrefixed`, `restartUnlabelled` — the fixtures of those names: a
 *    counter reset under `\pagenumbering{alph}`, under `S\arabic{page}`, and under arabic.
 *  - `boxstart` — overfull boxes whose display starts with `$` (a math node) or a space (glue),
 *    quoting `see [12] and [13]`, `see [14]`, `[15]`.
 *  - `boxshipout` — pages shipped right after box warnings, including `Overfull \vbox … has
 *    occurred while \output is active []`: every genuine mark lands AFTER the display's blank
 *    line, never inside it.
 *  - `outputhbox` — `fancyhdr` with a header and a footer `\hbox to` too narrow for its text
 *    (`see [3] and [4]`, `pg [9]`), so every page raises `Overfull \hbox … has occurred while
 *    \output is active`, whose display, unlike the `\vbox` form's, runs over the lines after it
 *    to an empty line. The one fixture from TeX Live 2019 (pdfTeX 1.40.20, run in place rather
 *    than under latexmk); its one personal path segment became `/home/tex001/`, same length.
 *  - `errcontext` — undefined control sequences and missing `$`/`{` whose error context
 *    (`l.3 Text \foo` / `see [12] here and [13]`, `<inserted text>`) quotes mark-shaped text.
 *  - `hyperrefdest` — `report` + hyperref + `\maketitle`: pdfTeX's duplicate-destination warning
 *    prints a context whose second line the next page's mark is written onto (`   [1`).
 */
const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/label-folio/shipouts',
);

function fixtureLog(name: string): string {
  // latin1, as the reader decodes it: pdfTeX wraps at 79 BYTES, so one byte must be one char.
  return readFileSync(path.join(FIXTURES, `${name}.log.txt`), 'latin1');
}

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

const REAL: Array<[name: string, pageCount: number, marks: number[]]> = [
  ['article-pdflatex', 5, range(1, 5)],
  ['reporttitle-pdflatex', 5, [1, 1, 2, 3, 4]],
  ['reporttitle-xelatex', 5, [1, 1, 2, 3, 4]],
  ['reporttitle-lualatex', 5, [1, 1, 2, 3, 4]],
  ['setcounter-pdflatex', 3, [5, 6, 7]],
  ['include-pdflatex', 8, range(1, 8)],
  ['images-pdflatex', 4, range(1, 4)],
  ['images-xelatex', 4, range(1, 4)],
  ['images-lualatex', 4, range(1, 4)],
  ['long-pdflatex', 130, range(1, 130)],
  ['long-lualatex', 130, range(1, 130)],
  ['count1-pdflatex', 5, range(1, 5)],
  ['count1-xelatex', 5, range(1, 5)],
  ['count1-lualatex', 5, range(1, 5)],
  ['overfull-pdflatex', 3, range(1, 3)],
  ['overfull-lualatex', 3, range(1, 3)],
  ['beamer-pdflatex', 7, range(1, 7)],
  ['resizeto-pdflatex', 4, [2, 3, 4, 5]],
  ['hyperref-pdflatex', 5, range(1, 5)],
  ['frontmatter-pdflatex', 11, [...range(1, 6), ...range(1, 5)]],
  ['nonascii-pdflatex', 8, range(1, 8)],
  ['nonascii-lualatex', 8, range(1, 8)],
  ['tableBottomShifted-pdflatex', 5, [1, 1, 2, 3, 4]],
  ['appendixAlph-pdflatex', 6, [1, 2, 3, 4, 1, 2]],
  ['appendixAlph-lualatex', 6, [1, 2, 3, 4, 1, 2]],
  ['suppPrefixed-pdflatex', 6, [1, 2, 3, 4, 1, 2]],
  ['suppPrefixed-xelatex', 6, [1, 2, 3, 4, 1, 2]],
  ['restartUnlabelled-pdflatex', 7, [1, 2, 3, 4, 1, 2, 3]],
  ['boxstart-pdflatex', 2, [1, 2]],
  ['boxstart-xelatex', 2, [1, 2]],
  ['boxshipout-pdflatex', 7, range(1, 7)],
  ['boxshipout-lualatex', 7, range(1, 7)],
  ['errcontext-pdflatex', 3, [1, 2, 3]],
  ['errcontext-lualatex', 3, [1, 2, 3]],
  ['hyperrefdest-pdflatex', 2, [1, 1]],
  ['outputhbox-pdflatex', 3, [1, 2, 3]],
];

describe('parseShipoutMarks over real logs', () => {
  it.each(REAL)('%s: one mark per PDF page, in order', (name, pageCount, marks) => {
    const parsed = parseShipoutMarks(fixtureLog(name));
    expect(parsed).toEqual(marks);
    expect(parsed).toHaveLength(pageCount);
  });

  it('reads the same marks from a CRLF log (pdfTeX on Windows writes its .log in text mode)', () => {
    for (const [name, , marks] of REAL) {
      expect(parseShipoutMarks(fixtureLog(name).replace(/\n/g, '\r\n')), name).toEqual(marks);
    }
  });

  it('keeps the marks a document forges, so their count no longer matches the PDF', () => {
    // \message{[7]} and \message{see [8] here} on a 3-page document: 5 marks. The count is what
    // the label check compares with the PDF's page count, and a mismatch disables the check.
    expect(parseShipoutMarks(fixtureLog('forged-pdflatex'))).toEqual([7, 1, 8, 2, 3]);
  });

  it('ignores the text of an overfull/underfull box display, in either form TeX writes it', () => {
    // TeX Live 2023 starts the display with the font (`\OT1/…`); older releases with the
    // paragraph indent box `[]`. Either can carry document text such as "see [1]".
    const log = [
      'Overfull \\hbox (163.8pt too wide) in paragraph at lines 3--3',
      '[]\\OT1/cmr/m/n/10 see [1] and [2] and more',
      '',
      'Overfull \\hbox (28.8pt too wide) detected at line 5',
      '\\OT1/cmr/m/n/10 [3] [4] at start',
      ' []',
      '',
      '[1] [2]',
    ].join('\n');
    expect(parseShipoutMarks(log)).toEqual([1, 2]);
  });

  it('ignores a whole box display, whatever its lines start with', () => {
    // A display starts with `$` when the box begins with a math node and with a space when it
    // begins with glue (real TeX Live 2023 output, fixture `boxstart`); the block runs from the
    // `Overfull`/`Underfull` line to the next empty line.
    const log = [
      'Overfull \\hbox (131.88203pt too wide) in paragraph at lines 3--3',
      '$\\OML/cmm/m/it/10 x$ \\OT1/cmr/m/n/10 see [12] and [13] [] ',
      ' []',
      '',
      '',
      'Overfull \\hbox (88.83336pt too wide) in paragraph at lines 4--4',
      ' \\OT1/cmr/m/n/10 see [14] [] ',
      ' []',
      '',
      'Underfull \\vbox (badness 10000) detected at line 9',
      ' [15]',
      '',
      '[1] [2]',
    ].join('\n');
    expect(parseShipoutMarks(log)).toEqual([1, 2]);
  });

  it('reads the mark after an output-routine box warning, even when its line is 79 columns', () => {
    // `… has occurred while \output is active []` carries its display on the same line and is
    // followed by ONE blank line, then the page's mark. At exactly 79 columns the rejoin glues
    // that blank line on, so the block must end with the line itself or the mark is lost.
    const head =
      'Overfull \\vbox (12345.56789pt too high) has occurred while \\output is active []';
    expect(head).toHaveLength(79);
    expect(parseShipoutMarks(`[1]\n${head}\n\n [2]\n[3]\n`)).toEqual([1, 2, 3]);
    const short = 'Overfull \\vbox (32.0pt too high) has occurred while \\output is active []';
    expect(parseShipoutMarks(`[1]\n${short}\n\n [2]\n`)).toEqual([1, 2]);
  });

  it('ignores the display lines of an output-routine \\hbox warning, unlike the \\vbox one', () => {
    // For an \hbox, TeX writes the display on the lines AFTER `… has occurred while \output is
    // active`, then ` []`, then an empty line (real pdflatex + fancyhdr, fixture `outputhbox`).
    const log = [
      'Overfull \\hbox (93.84138pt too wide) has occurred while \\output is active',
      ' \\OT1/cmr/m/n/10 see [3] and [4] too long header text here',
      ' []',
      '',
      '[1]',
      'Underfull \\hbox (badness 10000) has occurred while \\output is active',
      ' \\OT1/cmr/m/n/10 pg [9] 2',
      ' []',
      '',
      '[2]',
    ].join('\n');
    expect(parseShipoutMarks(log)).toEqual([1, 2]);
  });

  it("ignores an error's context lines, which quote the document", () => {
    const log = [
      './main.tex:3: Undefined control sequence.',
      'l.3 Text \\foo',
      '              see [12] here and [13]\\par',
      'The control sequence at the end of the top line',
      '',
      '[1]',
      './main.tex:5: Missing { inserted.',
      '<to be read again> ',
      '                   [14] \\par',
      'l.5 More \\bar\\newpage',
      '                      [14] after\\par',
      '',
      '[2]',
      '! Undefined control sequence.',
      '<argument> see [15]',
      '           [16] more',
      '',
      '[3]',
    ].join('\n');
    expect(parseShipoutMarks(log)).toEqual([1, 2, 3]);
  });

  it('reads a mark written onto the second line of a warning context', () => {
    // pdfTeX's duplicate-destination warning shows the context and ends no line after it, so the
    // next page's mark lands on the context's second line (real pdflatex + hyperref, fixture
    // `hyperrefdest`). Only the first line of the pair is skipped outside an error.
    const log = [
      ' [1',
      '',
      '{/usr/pdftex.map}]',
      'pdfTeX warning (ext4): destination with the same identifier (name{page.1}) has ',
      'been already used, duplicate ignored',
      '<to be read again> ',
      '                   \\relax ',
      'l.8 \\end{document}',
      '                   [1',
      '',
      '] (out/main.aux)',
    ].join('\n');
    expect(parseShipoutMarks(log)).toEqual([1, 1]);
  });

  it('ignores a box display whose text the 79-column wrap carried onto a second line', () => {
    const first = '[]\\OT1/cmr/m/n/10 ' + 'x'.repeat(79 - '[]\\OT1/cmr/m/n/10 '.length);
    expect(first).toHaveLength(79);
    expect(parseShipoutMarks(`${first}\nsee [5] and more\n\n[1]\n`)).toEqual([1]);
  });

  it('rejoins a mark the 79-column wrap cut in two', () => {
    const head = 'y'.repeat(75) + ' [12';
    expect(head).toHaveLength(79);
    expect(parseShipoutMarks(`[10] [11]\n${head}\n3] [124]\n`)).toEqual([10, 11, 123, 124]);
  });

  it('gives up rather than read a cut mark whose line was not rejoined', () => {
    // A wrap TeX made at a column the log's line length does not show (an uncounted string, a
    // multi-byte name under LuaTeX): `[12` / `3]` would read as 12, a wrong value in a list of
    // the right length.
    expect(parseShipoutMarks('[10] [11] [12\n3] [124]\n')).toBeUndefined();
    expect(parseShipoutMarks('[10] [11] [12\n.2] [124]\n')).toBeUndefined();
  });

  it('keeps a mark whose line ends before the map file or a blank line (a real first page)', () => {
    expect(parseShipoutMarks('[1\n\n{/usr/pdftex.map}] [2\n]\n')).toEqual([1, 2]);
  });

  it('reads \\count0 alone from a mark carrying \\count1..\\count9', () => {
    expect(parseShipoutMarks(' [3.2] [4.-3.0.0.0.7] [-2]')).toEqual([3, 4, -2]);
  });

  it('takes nothing that is not a whole mark', () => {
    // No space before `[`, a non-digit after it, trailing text inside the bracket.
    const log = 'a[1] \\cite[2] [Loading MPS] [3x] [4,5] [] [\n[6]';
    expect(parseShipoutMarks(log)).toEqual([6]);
  });
});

describe('readShipoutMarks (the .log beside the .aux)', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  async function tmp(): Promise<string> {
    dir = await mkdtemp(path.join(os.tmpdir(), 'shipouts-'));
    return dir;
  }

  it('reads the log named after the .aux', async () => {
    const d = await tmp();
    await writeFile(
      path.join(d, 'main.log'),
      readFileSync(path.join(FIXTURES, 'reporttitle-pdflatex.log.txt')),
    );
    expect(await readShipoutMarks(path.join(d, 'main.aux'))).toEqual([1, 1, 2, 3, 4]);
  });

  it('reads the WHOLE log, not only its head: marks past the first 2 MiB count', async () => {
    const d = await tmp();
    const filler = 'Package foo Info: filler line.\n'.repeat(100_000);
    expect(filler.length).toBeGreaterThan(2 * 1024 * 1024);
    await writeFile(path.join(d, 'main.log'), `${filler}[1] [2] [3]\n`);
    expect(await readShipoutMarks(path.join(d, 'main.aux'))).toEqual([1, 2, 3]);
  });

  it('reads nothing from a log over the cap — never a partial list', async () => {
    const d = await tmp();
    const body = Buffer.alloc(MAX_SHIPOUT_LOG_BYTES + 1, 0x20);
    body.write('[1] [2]\n', 0);
    await writeFile(path.join(d, 'main.log'), body);
    expect(await readShipoutMarks(path.join(d, 'main.aux'))).toBeUndefined();
  });

  it('reads nothing when there is no log', async () => {
    const d = await tmp();
    expect(await readShipoutMarks(path.join(d, 'main.aux'))).toBeUndefined();
  });

  it('reads nothing from a log that is not a regular file', async () => {
    const d = await tmp();
    await mkdir(path.join(d, 'main.log'));
    expect(await readShipoutMarks(path.join(d, 'main.aux'))).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reads nothing from a log it may not read',
    async () => {
      const d = await tmp();
      const log = path.join(d, 'main.log');
      await writeFile(log, '[1] [2]\n');
      await chmod(log, 0o000);
      try {
        expect(await readShipoutMarks(path.join(d, 'main.aux'))).toBeUndefined();
      } finally {
        await chmod(log, 0o600);
      }
    },
  );

  it('never follows a symbolic link at the log', async (t) => {
    const d = await tmp();
    const target = path.join(d, 'elsewhere.txt');
    await writeFile(target, '[1] [2]\n');
    try {
      await symlink(target, path.join(d, 'main.log'));
    } catch {
      t.skip(); // symlink creation needs privileges on some Windows setups
      return;
    }
    expect(await readShipoutMarks(path.join(d, 'main.aux'))).toBeUndefined();
  });
});

describe('readAuxFloats reads the shipout marks only when asked', () => {
  let proj: string | undefined;
  afterEach(async () => {
    if (proj) {
      await rm(buildDir(proj), { recursive: true, force: true });
      await rm(proj, { recursive: true, force: true });
      proj = undefined;
    }
  });

  it('fills `shipouts` for { shipouts: true } and leaves it absent otherwise', async () => {
    proj = await mkdtemp(path.join(os.tmpdir(), 'shipouts-proj-'));
    await mkdir(buildDir(proj), { recursive: true });
    await writeFile(buildAuxPath(proj, 'main.tex'), '\\relax\n\\newlabel{a}{{1}{2}}\n');
    await writeFile(path.join(buildDir(proj), 'main.log'), 'This is pdfTeX\n [1] [2] [3]\n');
    expect((await readAuxFloats(proj, 'main.tex', { shipouts: true })).shipouts).toEqual([1, 2, 3]);
    expect((await readAuxFloats(proj, 'main.tex')).shipouts).toBeUndefined();
    // The pgfpages evidence is untouched by the new read.
    expect((await readAuxFloats(proj, 'main.tex', { shipouts: true })).pgfpages).toBe(false);
  });
});

describe('readPgfpagesEvidence: a zero-byte .fls or .log is no record', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  /** The evidence for `main.aux` in a temp dir holding `files`. */
  async function evidenceOf(files: Record<string, string>): Promise<boolean | undefined> {
    dir = await mkdtemp(path.join(os.tmpdir(), 'pgfevidence-'));
    for (const [name, content] of Object.entries(files)) {
      await writeFile(path.join(dir, name), content);
    }
    return readPgfpagesEvidence(path.join(dir, 'main.aux'));
  }

  const NAMING_FLS = 'PWD /build\nINPUT /texmf/tex/latex/pgf/utilities/pgfpages.sty\n';
  const PLAIN = 'This is pdfTeX, Version 3.141592653\n';

  it('an empty .log and no .fls: undefined', async () => {
    expect(await evidenceOf({ 'main.log': '' })).toBeUndefined();
  });

  it('an empty .fls and no .log: undefined', async () => {
    expect(await evidenceOf({ 'main.fls': '' })).toBeUndefined();
  });

  it('both empty: undefined', async () => {
    expect(await evidenceOf({ 'main.fls': '', 'main.log': '' })).toBeUndefined();
  });

  it('an empty .fls beside a .log that names nothing: false', async () => {
    expect(await evidenceOf({ 'main.fls': '', 'main.log': PLAIN })).toBe(false);
  });

  it('an empty .log beside a .fls that names pgfpages.sty: true', async () => {
    expect(await evidenceOf({ 'main.fls': NAMING_FLS, 'main.log': '' })).toBe(true);
  });

  it('a whitespace-only .log is still a record that names nothing: false', async () => {
    // Only zero bytes counts as unread; anything the engine wrote is a record.
    expect(await evidenceOf({ 'main.log': '\n' })).toBe(false);
  });
});

/**
 * A FIFO at a build file blocks a plain `open` until a writer appears — forever, while the project
 * lock is held. Both readers open with `O_NONBLOCK` and refuse the non-regular file on the handle.
 * POSIX only: Windows has no `mkfifo`. The timeout turns a regression into a failure rather than a
 * hung suite, and `afterEach` opens the FIFO for writing so a reader stuck in `open` is released.
 */
describe.skipIf(process.platform === 'win32')(
  'a FIFO at the .log is refused, not waited on',
  () => {
    let dir: string | undefined;
    afterEach(async () => {
      if (!dir) return;
      for (const name of ['main.log', 'main.fls']) {
        try {
          const h = await open(path.join(dir, name), constants.O_WRONLY | constants.O_NONBLOCK);
          await h.close();
        } catch {
          // No FIFO there, or no reader waiting on it: nothing to release.
        }
      }
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    });

    async function fifoAtLog(t: { skip: () => void }): Promise<string | undefined> {
      dir = await mkdtemp(path.join(os.tmpdir(), 'shipouts-fifo-'));
      try {
        execFileSync('mkfifo', [path.join(dir, 'main.log')], { stdio: 'ignore' });
      } catch {
        t.skip(); // no mkfifo on this machine
        return undefined;
      }
      return path.join(dir, 'main.aux');
    }

    it(
      'readShipoutMarks: a FIFO already at the path is refused by the lstat check',
      { timeout: 3000 },
      async (t) => {
        // Refused by lstat before any open; O_NONBLOCK is covered by the lstat-swap test in
        // shipoutMarksNoFollow.test.ts ('a FIFO swapped in after the lstat is refused').
        const aux = await fifoAtLog(t);
        if (aux) expect(await readShipoutMarks(aux)).toBeUndefined();
      },
    );

    it(
      'readPgfpagesEvidence: with no .fls either, nothing is known',
      { timeout: 3000 },
      async (t) => {
        const aux = await fifoAtLog(t);
        if (aux) expect(await readPgfpagesEvidence(aux)).toBeUndefined();
      },
    );
  },
);
