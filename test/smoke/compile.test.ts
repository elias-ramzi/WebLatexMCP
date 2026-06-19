import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { LatexmkCompiler } from '../../src/services/compiler.js';
import { parseLog } from '../../src/services/logParser.js';

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

  it('reports failure and a structured error for a broken file', async () => {
    const outcome = await compiler.compile({ projectDir: dir, rootFile: 'main-broken.tex' });
    expect(outcome.success).toBe(false);
    const { errors } = parseLog(outcome.log);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => /undefined control sequence/i.test(e.message))).toBe(true);
  }, 60_000);
});
