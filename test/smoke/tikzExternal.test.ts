import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { LatexmkCompiler } from '../../src/services/compiler.js';
import { parseLog, needsShellEscape } from '../../src/services/logParser.js';

// Gated on latexmk, like the other smokes: skips in the fast CI job and on TeX-less machines,
// runs in the dedicated tex-smoke job.
const compiler = new LatexmkCompiler();
const available = await compiler.isAvailable();

const FIXTURE = fileURLToPath(new URL('../fixtures/tikz-external', import.meta.url));

describe.skipIf(!available)('TikZ externalization compile smoke', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-tikz-'));
    await cp(FIXTURE, dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('root cause A: does not hard-fail on the missing imgs/ dir; advises shell escape', async () => {
    // No shellEscape: the output-dir subdirectories are mirrored (so no "can't write on file"
    // emergency stop from root cause A), externalization then fails for lack of system calls, and
    // the two per-figure errors collapse into a single shell-escape diagnostic (not a flood).
    const outcome = await compiler.compile({ projectDir: dir, rootFile: 'main.tex' });
    expect(outcome.log).not.toMatch(/I can't write on file/);
    expect(outcome.log).not.toMatch(/Emergency stop/);
    expect(needsShellEscape(outcome.log)).toBe(true);
    const { errors } = parseLog(outcome.log);
    expect(errors.filter((e) => e.rule === 'shell escape disabled')).toHaveLength(1);
  }, 60_000);

  it('root cause B: compiles to a PDF with zero errors when shellEscape is enabled', async () => {
    const outcome = await compiler.compile({
      projectDir: dir,
      rootFile: 'main.tex',
      shellEscape: true,
    });
    expect(outcome.success).toBe(true);
    expect(outcome.pdfPath).toBeDefined();
    expect(parseLog(outcome.log).errors).toHaveLength(0);
    expect(needsShellEscape(outcome.log)).toBe(false);
  }, 90_000);
});
