import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { LatexmkCompiler } from '../../src/services/compiler.js';
import { parseLog, filterLog, logTail, findMissingPackages } from '../../src/services/logParser.js';
import { attachErrorSnippets, formatSnippet } from '../../src/lib/errorSnippets.js';
import { FileService } from '../../src/services/fileService.js';

// Gate the real compile on latexmk being installed, so this auto-skips in the fast
// CI job and on dev machines without TeX, but runs in the dedicated tex-smoke job.
const compiler = new LatexmkCompiler();
const available = await compiler.isAvailable();

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
    const { errors } = await attachErrorSnippets(
      new FileService(),
      dir,
      parseLog(outcome.log).errors,
    );
    const undefinedMacro = errors.find((e) => /undefined control sequence/i.test(e.message));
    expect(undefinedMacro?.file).toBe('main-broken.tex');
    expect(undefinedMacro?.snippet).toBeDefined();
    // The line TeX reported is the line the snippet shows at that offset — the whole guarantee.
    const lines = undefinedMacro!.snippet!.split('\n');
    const offset = undefinedMacro!.line! - undefinedMacro!.snippetStartLine!;
    expect(lines[offset]).toContain('\\thismacrodoesnotexist');
    expect(formatSnippet(undefinedMacro!)).toContain(`> ${undefinedMacro!.line} |`);
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
