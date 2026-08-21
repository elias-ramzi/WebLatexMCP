import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, cp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LatexmkCompiler } from '../../src/services/compiler.js';
import { parseLog, filterLog, logTail, findMissingPackages } from '../../src/services/logParser.js';
import { attachErrorSnippets } from '../../src/lib/errorSnippets.js';
import { formatSnippet } from '../../src/lib/sourceSnippet.js';
import { FileService } from '../../src/services/fileService.js';

// Gate the real compile on latexmk being installed, so this auto-skips in the fast
// CI job and on dev machines without TeX, but runs in the dedicated tex-smoke job.
const compiler = new LatexmkCompiler();
const available = await compiler.isAvailable();

const execFileAsync = promisify(execFile);

const FIXTURE = fileURLToPath(new URL('../fixtures/sample-latex', import.meta.url));

describe.skipIf(!available)('latexmk compile smoke', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-compile-'));
    await cp(FIXTURE, dir, { recursive: true });
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('compiles the sample project to a PDF with no errors', async () => {
    const outcome = await compiler.compile({ projectDir: dir, rootFile: 'main.tex' });
    expect(outcome.success).toBe(true);
    expect(outcome.pdfPath).toBeDefined();
    expect(parseLog(outcome.log).errors).toHaveLength(0);
  }, 60_000);

  it('de-noises a real compile log yet keeps the output summary (rawLog restores the rest)', async () => {
    const outcome = await compiler.compile({ projectDir: dir, rootFile: 'main.tex' });
    const filtered = filterLog(outcome.log); // what compile returns by default
    expect(filtered).not.toMatch(/\.pfb>/);
    expect(filtered).not.toMatch(/\.enc}/);
    expect(filtered).not.toMatch(/TeX's memory/);
    expect(filtered).toMatch(/Output written on /);
    expect(filtered).toMatch(/\d+ page/);
    // The raw tail (compile's rawLog: true) still carries the noise the filter dropped.
    expect(logTail(outcome.log, 400)).toMatch(/TeX's memory/);
  }, 60_000);

  it('reports failure and a structured error for a broken file', async () => {
    const outcome = await compiler.compile({ projectDir: dir, rootFile: 'main-broken.tex' });
    expect(outcome.success).toBe(false);
    const { errors } = parseLog(outcome.log);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => /undefined control sequence/i.test(e.message))).toBe(true);
  }, 60_000);

  it('attaches the source around a real error, lined up with the reported line', async () => {
    const outcome = await compiler.compile({ projectDir: dir, rootFile: 'main-broken.tex' });
    const { errors, omittedLocations } = await attachErrorSnippets(
      new FileService(),
      dir,
      parseLog(outcome.log, { baseDir: outcome.logBaseDir }).errors,
    );
    const undefinedMacro = errors.find((e) => /undefined control sequence/i.test(e.message));
    expect(undefinedMacro?.file).toBe('main-broken.tex');
    expect(undefinedMacro?.snippet).toBeDefined();
    expect(omittedLocations).toBe(0);
    // The line TeX reported is the line the snippet shows at that offset — the whole guarantee.
    const lines = undefinedMacro!.snippet!.split('\n');
    const offset = undefinedMacro!.line! - undefinedMacro!.snippetStartLine!;
    expect(lines[offset]).toContain('\\thismacrodoesnotexist');
    expect(formatSnippet(undefinedMacro!, undefinedMacro!.line)).toContain(
      `> ${undefinedMacro!.line} |`,
    );
  }, 60_000);

  it('resolves a root file in a subdirectory, where latexmk -cd moves the log’s paths', async () => {
    // latexmk chdirs into the root file's directory, so this document's errors print as
    // "./main.tex:3" — and an unrelated main.tex at the project root is a decoy the snippet layer
    // must not fall for.
    const sub = await mkdtemp(path.join(os.tmpdir(), 'ovl-subdir-'));
    try {
      await mkdir(path.join(sub, 'paper'), { recursive: true });
      await writeFile(
        path.join(sub, 'paper', 'main.tex'),
        '\\documentclass{article}\n\\begin{document}\nreal \\thismacrodoesnotexist\n\\end{document}\n',
        'utf8',
      );
      await writeFile(
        path.join(sub, 'main.tex'),
        'DECOY 1\nDECOY 2\nDECOY LINE 3\nDECOY 4\n',
        'utf8',
      );

      const outcome = await compiler.compile({ projectDir: sub, rootFile: 'paper/main.tex' });
      const { errors } = await attachErrorSnippets(
        new FileService(),
        sub,
        parseLog(outcome.log, { baseDir: outcome.logBaseDir }).errors,
      );
      const err = errors.find((e) => /undefined control sequence/i.test(e.message));
      expect(err?.file).toBe('paper/main.tex');
      expect(err?.snippet).toContain('real \\thismacrodoesnotexist');
      expect(err?.snippet).not.toContain('DECOY');
    } finally {
      await rm(sub, { recursive: true, force: true });
    }
  }, 60_000);

  it('still finds the source when the log has no -file-line-error (tectonic’s shape)', async () => {
    // Tectonic passes no -file-line-error, so every diagnostic takes the bare "! " branch: the file
    // comes from the paren stack and the line from the l.<n> below it. The echo is what confirms
    // the two agree before any source is shown.
    const plain = await mkdtemp(path.join(os.tmpdir(), 'ovl-plain-'));
    try {
      await cp(FIXTURE, plain, { recursive: true });
      const res = await execFileAsync(
        'latexmk',
        [
          '-pdf',
          '-interaction=nonstopmode',
          `-outdir=${path.join(plain, 'build')}`,
          'main-broken.tex',
        ],
        { cwd: plain },
      ).catch((e: unknown) => e as { stdout?: string });
      void res;
      const log = await readFile(path.join(plain, 'build', 'main-broken.log'), 'utf8');
      const parsed = parseLog(log);
      const bare = parsed.errors.find((e) => /undefined control sequence/i.test(e.message));
      expect(bare?.locatedPair).toBeUndefined(); // inferred, not read off one line
      expect(bare?.line).toBe(3);

      const { errors } = await attachErrorSnippets(new FileService(), plain, parsed.errors);
      const shown = errors.find((e) => /undefined control sequence/i.test(e.message));
      expect(shown?.snippet).toContain('\\thismacrodoesnotexist');
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  }, 60_000);

  it('names the package a real TeX installation is missing', async () => {
    const outcome = await compiler.compile({
      projectDir: dir,
      rootFile: 'main-missing-package.tex',
    });
    expect(outcome.success).toBe(false);
    // The whole point: the caller gets the name without regexing the log itself.
    expect(findMissingPackages(outcome.log)).toEqual(['weblatexmcpnosuchpkg']);
  }, 60_000);
});
