import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileService } from '../../src/services/fileService.js';
import { parseLog } from '../../src/services/logParser.js';
import {
  attachErrorSnippets,
  MAX_SNIPPET_FILE_READS,
  MAX_SNIPPET_LOCATIONS,
} from '../../src/lib/errorSnippets.js';
import { formatSnippet, MAX_SNIPPET_LINE_CHARS } from '../../src/lib/sourceSnippet.js';
import type { ParsedDiagnostic } from '../../src/services/logParser.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/sample-latex', import.meta.url));

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A project dir holding the given files, so the real (sandboxed) FileService can read it. */
async function projectWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'snippets-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }
  return dir;
}

/** An error located the way `-file-line-error` locates one: file and line off the same log line. */
function at(file: string, line: number, extra: Partial<ParsedDiagnostic> = {}): ParsedDiagnostic {
  return { severity: 'error', file, line, message: 'boom', locatedPair: true, ...extra };
}

describe('attachErrorSnippets', () => {
  it('lines the snippet up with the reported line of a real failing compile', async () => {
    const source = await readFile(path.join(FIXTURE, 'main-broken.tex'), 'utf8');
    const dir = await projectWith({ 'main.tex': source });
    // The log pdflatex actually emits for this fixture, in -file-line-error form.
    const log = [
      'This is pdfTeX, Version 3.141592653',
      '(./main.tex',
      './main.tex:3: Undefined control sequence.',
      'l.3 This line uses an undefined macro: \\thismacrodoesnotexist',
      '?',
    ].join('\n');
    const { errors, omittedLocations } = await attachErrorSnippets(
      new FileService(),
      dir,
      parseLog(log).errors,
    );

    expect(omittedLocations).toBe(0);
    expect(errors).toHaveLength(1);
    const err = errors[0]!;
    expect(err.line).toBe(3);
    expect(err.snippetStartLine).toBe(1);
    // The fixture is 4 lines and ends with a newline: the phantom line after it is not a line.
    const lines = err.snippet!.split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[err.line! - err.snippetStartLine!]).toContain('\\thismacrodoesnotexist');
    expect(lines[0]).toBe('\\documentclass{article}');
    // Parser provenance stays inside the server.
    expect(err).not.toHaveProperty('echo');
    expect(err).not.toHaveProperty('locatedPair');
  });

  it('takes 2 lines either side, clamped at the file bounds', async () => {
    const dir = await projectWith({
      'main.tex': Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n'),
    });
    const snippetAt = async (line: number) =>
      (await attachErrorSnippets(new FileService(), dir, [at('main.tex', line)])).errors[0]!;

    const middle = await snippetAt(10);
    expect(middle.snippetStartLine).toBe(8);
    expect(middle.snippet!.split('\n')).toEqual([
      'line 8',
      'line 9',
      'line 10',
      'line 11',
      'line 12',
    ]);

    const top = await snippetAt(1);
    expect(top.snippetStartLine).toBe(1);
    expect(top.snippet!.split('\n')).toEqual(['line 1', 'line 2', 'line 3']);

    const bottom = await snippetAt(20);
    expect(bottom.snippetStartLine).toBe(18);
    expect(bottom.snippet!.split('\n')).toEqual(['line 18', 'line 19', 'line 20']);
  });

  it('carries the snippet once per location, and reads each file once', async () => {
    const dir = await projectWith({ 'main.tex': 'a\nb\nc\nd\ne', 'other.tex': 'x\ny\nz' });
    const reads: string[] = [];
    const files = new FileService();
    const spy = {
      read: (projectDir: string, opts: { path: string; recordBaseline?: boolean }) => {
        reads.push(opts.path);
        return files.read(projectDir, opts);
      },
      leavesProjectThroughLink: (projectDir: string, rel: string) =>
        files.leavesProjectThroughLink(projectDir, rel),
    };
    const { errors } = await attachErrorSnippets(spy, dir, [
      at('main.tex', 3, { message: 'first' }),
      at('main.tex', 3, { message: 'second' }),
      at('main.tex', 4, { message: 'third' }),
      at('other.tex', 2, { message: 'fourth' }),
    ]);

    // Two files, four diagnostics across three locations: one read per file, not one per line.
    expect(reads.sort()).toEqual(['main.tex', 'other.tex']);
    expect(errors[0]!.snippet).toBeDefined();
    // The duplicate does not repeat the text — repeating it is what bloats structuredContent.
    expect(errors[1]!.snippet).toBeUndefined();
    expect(errors[2]!.snippet).toBeDefined();
    expect(errors[3]!.snippet).toBeDefined();
  });

  it('leaves an unattributed diagnostic without a guessed snippet', async () => {
    const dir = await projectWith({ 'main.tex': 'a\nb\nc' });
    const { errors, omittedLocations } = await attachErrorSnippets(new FileService(), dir, [
      { severity: 'error', line: 2, message: 'no file' },
      { severity: 'error', file: 'main.tex', message: 'no line' },
    ]);
    expect(errors[0]!.snippet).toBeUndefined();
    expect(errors[1]!.snippet).toBeUndefined();
    // Neither points anywhere, so neither is a location we failed to show.
    expect(omittedLocations).toBe(0);
  });

  it('counts a nonsensical line rather than treating it as unattributed', async () => {
    const dir = await projectWith({ 'main.tex': 'a\nb\nc' });
    const { errors, omittedLocations } = await attachErrorSnippets(new FileService(), dir, [
      at('main.tex', 0, { message: 'line 0 is not a line' }),
    ]);
    expect(errors[0]!.snippet).toBeUndefined();
    expect(omittedLocations).toBe(1);
  });

  it('skips — and counts — a location it cannot read', async () => {
    const dir = await projectWith({ 'main.tex': 'a\nb\nc' });
    const { errors, omittedLocations } = await attachErrorSnippets(new FileService(), dir, [
      at('gone.tex', 2, { message: 'deleted since' }),
      at('/usr/share/texmf/tex/latex/foo.sty', 9, { message: 'outside the project' }),
      at('../../etc/passwd.tex', 1, { message: 'escapes the project' }),
    ]);
    expect(errors.map((e) => e.snippet)).toEqual([undefined, undefined, undefined]);
    expect(omittedLocations).toBe(3);
  });

  it('does not read a file just because the document named it', async () => {
    // The log is document-controlled: \typeout{...} prints a line the parser cannot tell from a
    // real diagnostic. Reading that file would echo it straight back to the caller.
    const dir = await projectWith({ 'creds.txt': 'SECRET\nSECRET\nSECRET', 'main.tex': 'a\nb\nc' });
    const { errors, omittedLocations } = await attachErrorSnippets(
      new FileService(),
      dir,
      parseLog('./creds.txt:2: Undefined control sequence.').errors,
    );
    expect(errors[0]!.file).toBe('creds.txt');
    expect(errors[0]!.snippet).toBeUndefined();
    expect(omittedLocations).toBe(1);
  });

  it('does not follow a symlink out of the project', async () => {
    const outside = await projectWith({ id_rsa: 'BEGIN PRIVATE KEY\nsecret\nEND' });
    const dir = await projectWith({ 'main.tex': 'a\nb\nc' });
    await symlink(path.join(outside, 'id_rsa'), path.join(dir, 'notes.tex'));

    const { errors } = await attachErrorSnippets(new FileService(), dir, [at('notes.tex', 2)]);
    expect(errors[0]!.snippet).toBeUndefined();
  });

  describe('locations it cannot vouch for', () => {
    it('refuses a line past the end of the file rather than showing the last few', async () => {
      const dir = await projectWith({ 'main.tex': 'a\nb\nc' });
      const { errors, omittedLocations } = await attachErrorSnippets(new FileService(), dir, [
        at('main.tex', 4, { message: 'one past the end' }),
        at('main.tex', 5, { message: 'two past the end' }),
      ]);
      expect(errors.map((e) => e.snippet)).toEqual([undefined, undefined]);
      expect(omittedLocations).toBe(2);
    });

    it('never shows a location the log did not name outright', async () => {
      // The paren-stack + l.<n> pairing is what tectonic's logs (no -file-line-error) always give,
      // and what latexmk gives for a bare "! ". TeX eliding a long line can drop an opening `(`,
      // pop the stack, and land on a file whose line 4 is `\\end{itemize}` too — boilerplate
      // corroborates a wrong file, so an inferred location is counted rather than illustrated.
      const dir = await projectWith({
        'main.tex': 'a\n\\begin{itemize}\n\\item x\n\\end{itemize}',
      });
      const inferred: ParsedDiagnostic = {
        severity: 'error',
        file: 'main.tex',
        line: 4,
        message: 'Undefined control sequence.',
        echo: '\\end{itemize}',
      };
      const { errors, omittedLocations } = await attachErrorSnippets(new FileService(), dir, [
        inferred,
      ]);
      expect(errors[0]!.snippet).toBeUndefined();
      expect(omittedLocations).toBe(1);
    });

    it('vetoes a named location whose file contradicts the echo', async () => {
      const dir = await projectWith({ 'main.tex': 'one\ntwo\nthree' });
      const { errors, omittedLocations } = await attachErrorSnippets(new FileService(), dir, [
        at('main.tex', 2, { echo: 'nothing like line two' }),
      ]);
      expect(errors[0]!.snippet).toBeUndefined();
      expect(omittedLocations).toBe(1);
    });

    it('keeps a veto once earned, whatever a co-located diagnostic says', async () => {
      // parseLog emits no echo whenever the l.<n> it found was for another line, so a
      // contradicted location routinely sits beside a silent one. The contradiction is about the
      // location, so it stands — the analogue of a shadow-store collision staying flagged.
      const dir = await projectWith({ 'main.tex': 'one\ntwo\nthree' });
      const { errors, omittedLocations } = await attachErrorSnippets(new FileService(), dir, [
        at('main.tex', 2, { message: 'contradicted', echo: 'nothing like line two' }),
        at('main.tex', 2, { message: 'silent' }),
      ]);
      expect(errors.map((e) => e.snippet)).toEqual([undefined, undefined]);
      expect(omittedLocations).toBe(1);
    });

    it('accepts an elided echo the cut left half a character in', async () => {
      // pdfTeX elides at a byte offset, so a long line of French prose is cut inside `é`: the log
      // is read as utf8 and the orphan byte arrives as U+FFFD. This is the exact echo a real
      // pdflatex compile prints for the source line below. Comparing the whole fragment vetoed
      // it, and the caller was told its source was unreadable when the file was perfectly fine.
      const line =
        'Nous considérons une méthode qui améliore nettement la précision pour la tache ' +
        'etudiee ici \\undefmac3 fin.';
      const dir = await projectWith({ 'main.tex': `un\ndeux\n${line}\nquatre` });
      const { errors, omittedLocations } = await attachErrorSnippets(new FileService(), dir, [
        at('main.tex', 3, { echo: '...\uFFFDcision pour la tache etudiee ici \\undefmac' }),
      ]);
      expect(errors[0]!.snippet).toContain('undefmac');
      expect(omittedLocations).toBe(0);
    });

    it('still vetoes an elided echo whose intact tail is nowhere in the line', async () => {
      const dir = await projectWith({
        'main.tex': 'un\ndeux\nune ligne tout à fait autre\nquatre',
      });
      const { errors, omittedLocations } = await attachErrorSnippets(new FileService(), dir, [
        at('main.tex', 3, { echo: '...\uFFFDcision pour la tache etudiee ici \\undefmac' }),
      ]);
      expect(errors[0]!.snippet).toBeUndefined();
      expect(omittedLocations).toBe(1);
    });

    it('vetoes an echo whose only intact text is before a trailing replacement character', async () => {
      // `slice(lastIndexOf('\uFFFD') + 1)` threw away everything before the *last* unreadable
      // byte, so one at the right-hand end left an empty tail and the check passed by default.
      // A latin-1 encoded .tex reaches this: the log echoes the 8-bit byte, and reading the log as
      // utf8 turns it into U+FFFD wherever it fell. A veto that fails open is not a veto.
      const dir = await projectWith({ 'main.tex': 'un\ndeux\ntrois' });
      const { errors, omittedLocations } = await attachErrorSnippets(new FileService(), dir, [
        at('main.tex', 2, { echo: '...nothing like line two at all here\uFFFD' }),
      ]);
      expect(errors[0]!.snippet).toBeUndefined();
      expect(omittedLocations).toBe(1);
    });

    it('still accepts a good line whose echo has a replacement character at either end', async () => {
      // The other half of the same change: taking the longest intact run must not turn the veto
      // into one that fires on a location the file agrees with.
      const line = 'la précision pour la tache etudiee ici \\undefmac';
      const dir = await projectWith({ 'main.tex': `un\ndeux\n${line}\nquatre` });
      const { errors, omittedLocations } = await attachErrorSnippets(new FileService(), dir, [
        at('main.tex', 3, { echo: '...\uFFFDcision pour la tache etudiee ici \\undefmac\uFFFD' }),
      ]);
      expect(errors[0]!.snippet).toContain('undefmac');
      expect(omittedLocations).toBe(0);
    });

    it('accepts the left-elided echo TeX actually prints for a long line', async () => {
      // Real pdfTeX output for the sample fixture: "l.3 ... an undefined macro: \\thismacro…".
      const dir = await projectWith({
        'main.tex': 'a\nThis line uses an undefined macro: \\thismacrodoesnotexist\nc',
      });
      const { errors } = await attachErrorSnippets(new FileService(), dir, [
        at('main.tex', 2, { echo: '... an undefined macro: \\thismacrodoesnotexist' }),
      ]);
      expect(errors[0]!.snippet).toContain('\\thismacrodoesnotexist');
    });

    it('does not veto a context line glued to its padded continuation by the 79-column unwrap', () => {
      return (async () => {
        const dir = await projectWith({ 'main.tex': 'a\n\\foo bar baz qux\nc' });
        const { errors } = await attachErrorSnippets(new FileService(), dir, [
          // unwrapLines joined "l.2 \\foo bar" with TeX's padded remainder "  baz qux".
          at('main.tex', 2, { echo: '\\foo bar          baz qux' }),
        ]);
        expect(errors[0]!.snippet).toContain('\\foo bar baz qux');
      })();
    });
  });

  it('caps the number of distinct locations and reports how many were left out', async () => {
    const dir = await projectWith({
      'main.tex': Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n'),
    });
    const many = Array.from({ length: MAX_SNIPPET_LOCATIONS + 3 }, (_, i) =>
      at('main.tex', i + 1, { message: `err ${i}` }),
    );
    const { errors, omittedLocations } = await attachErrorSnippets(new FileService(), dir, many);

    expect(omittedLocations).toBe(3);
    expect(errors.filter((e) => e.snippet !== undefined)).toHaveLength(MAX_SNIPPET_LOCATIONS);
    expect(errors[MAX_SNIPPET_LOCATIONS]!.snippet).toBeUndefined();
  });

  it('does not let unshowable locations eat the cap', async () => {
    // A real log lists TeX-tree .sty paths freely — an \\usepackage[nosuchoption]{hyperref}
    // compile emits /usr/share/texlive/…/hyperref.sty:4421: — and they are .sty, so they used to
    // be selected, then die at the sandbox, having spent the whole quota before the real error.
    const dir = await projectWith({ 'main.tex': 'one\ntwo\nthree\nfour\nfive' });
    const junk = Array.from({ length: MAX_SNIPPET_LOCATIONS }, (_, i) =>
      at(`/usr/share/texlive/texmf-dist/tex/latex/hyperref/hyperref.sty`, 4000 + i, {
        message: 'package internals',
      }),
    );
    const { errors, omittedLocations } = await attachErrorSnippets(new FileService(), dir, [
      ...junk,
      at('main.tex', 3, { message: 'the one that matters', echo: 'three' }),
    ]);

    expect(errors.at(-1)!.snippet).toContain('three');
    expect(omittedLocations).toBe(MAX_SNIPPET_LOCATIONS);
  });

  it('bounds how many files it will open looking for showable locations', async () => {
    const dir = await projectWith({ 'main.tex': 'a\nb\nc' });
    const reads: string[] = [];
    const real = new FileService();
    const spy = {
      read: (projectDir: string, opts: { path: string; recordBaseline?: boolean }) => {
        reads.push(opts.path);
        return real.read(projectDir, opts);
      },
      leavesProjectThroughLink: (projectDir: string, rel: string) =>
        real.leavesProjectThroughLink(projectDir, rel),
    };
    // 200 distinct files that do not exist: none yields a snippet, and the search must stop.
    const missing = Array.from({ length: 200 }, (_, i) => at(`gone-${i}.tex`, 1));
    const { omittedLocations } = await attachErrorSnippets(spy, dir, missing);
    expect(reads.length).toBeLessThanOrEqual(MAX_SNIPPET_FILE_READS);
    expect(omittedLocations).toBe(200);
  });

  it('bounds a snippet taken from a document written on one enormous line', async () => {
    const huge = 'x'.repeat(150_000);
    const dir = await projectWith({ 'main.tex': `a\n${huge}\nc` });
    const { errors } = await attachErrorSnippets(new FileService(), dir, [at('main.tex', 2)]);
    const snippet = errors[0]!.snippet!;
    expect(snippet.length).toBeLessThan(MAX_SNIPPET_LINE_CHARS * 5);
    expect(snippet).toContain('…');
  });

  it('reports the omission when the file is too large to read', async () => {
    // Over MAX_READ_BYTES: FileService returns a note instead of content, and a snippet built from
    // that '' would be a confident blank.
    const dir = await projectWith({ 'main.tex': 'y'.repeat(3 * 1024 * 1024) });
    const { errors, omittedLocations } = await attachErrorSnippets(new FileService(), dir, [
      at('main.tex', 1),
    ]);
    expect(errors[0]!.snippet).toBeUndefined();
    expect(omittedLocations).toBe(1);
  });

  it('handles CRLF and CR-only files without dragging line endings into the snippet', async () => {
    const crlf = await projectWith({ 'main.tex': 'one\r\ntwo\r\nthree\r\nfour\r\n' });
    const crlfRes = await attachErrorSnippets(new FileService(), crlf, [at('main.tex', 2)]);
    expect(crlfRes.errors[0]!.snippet!.split('\n')).toEqual(['one', 'two', 'three', 'four']);
    expect(crlfRes.errors[0]!.snippet).not.toContain('\r');

    const cr = await projectWith({ 'main.tex': 'one\rtwo\rthree\rfour\rfive' });
    const crRes = await attachErrorSnippets(new FileService(), cr, [at('main.tex', 5)]);
    expect(crRes.errors[0]!.snippetStartLine).toBe(3);
    expect(crRes.errors[0]!.snippet!.split('\n')).toEqual(['three', 'four', 'five']);
  });

  it('marks the reported line even when the error is on the file’s last line', async () => {
    const dir = await projectWith({ 'main.tex': 'a\nb\nc\nd\n' });
    const { errors } = await attachErrorSnippets(new FileService(), dir, [at('main.tex', 4)]);
    const text = formatSnippet(errors[0]!, errors[0]!.line);
    expect(text).toContain('> 4 | d');
    // No sixth, empty line borrowed from the file's trailing newline.
    expect(text.split('\n').at(-1)).toContain('d');
  });

  it('checks a location once, not once per diagnostic sitting on it', async () => {
    // A generated or converted .tex puts the whole body on line 1, so every error is co-located on
    // a line that can be megabytes. Verifying the echo per *error* re-normalized that line each
    // time — 1.6s for a 500KB line and 1000 errors, inside the per-project lock. The echo below
    // never matches, which is the case that used to re-run the check every time.
    const huge = 'the quick brown fox jumps over the lazy dog. '.repeat(12_000); // ~500KB
    const dir = await projectWith({ 'main.tex': `${huge}\nsecond line` });
    const many = Array.from({ length: 1000 }, (_, i) =>
      at('main.tex', 1, { message: `err ${i}`, echo: 'nothing like the line' }),
    );

    const started = process.hrtime.bigint();
    const { errors, omittedLocations } = await attachErrorSnippets(new FileService(), dir, many);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;

    expect(errors.every((e) => e.snippet === undefined)).toBe(true); // contradicted, so counted
    expect(omittedLocations).toBe(1);
    expect(ms).toBeLessThan(500);
  });

  it('does not go quadratic on a document that fails with thousands of errors', async () => {
    // Distinct *locations* are what the dedup scans, so co-located errors would not exercise it.
    // Measured on this machine: a linear scan over 20k of them costs ~5ms, the `includes` it
    // replaced ~2.8s — the bound below sits two orders of magnitude clear of the first and well
    // under the second. All of this runs inside the per-project lock, where a peer session waits.
    const dir = await projectWith({
      'main.tex': Array.from({ length: 20_000 }, (_, i) => `line ${i + 1}`).join('\n'),
    });
    const many = Array.from({ length: 20_000 }, (_, i) => at('main.tex', i + 1));

    const started = process.hrtime.bigint();
    const { errors, omittedLocations } = await attachErrorSnippets(new FileService(), dir, many);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;

    expect(errors).toHaveLength(20_000);
    expect(errors.filter((e) => e.snippet !== undefined)).toHaveLength(MAX_SNIPPET_LOCATIONS);
    expect(omittedLocations).toBe(20_000 - MAX_SNIPPET_LOCATIONS);
    expect(ms).toBeLessThan(1000);
  });
});

describe('formatSnippet', () => {
  it('numbers the lines and marks the reported one', () => {
    const text = formatSnippet(
      { snippet: 'eight\nnine\nten\neleven\ntwelve', snippetStartLine: 8 },
      10,
    );
    expect(text.split('\n')).toEqual([
      '       8 | eight',
      '       9 | nine',
      '    > 10 | ten',
      '      11 | eleven',
      '      12 | twelve',
    ]);
  });

  it('returns nothing when there is no snippet', () => {
    expect(formatSnippet({}, 3)).toBe('');
  });
});
