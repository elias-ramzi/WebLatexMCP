import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { surfaceCompiledPdf } from '../../src/lib/pdfSurface.js';

describe('surfaceCompiledPdf', () => {
  let root: string;
  let buildDir: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'wlm-ws-'));
    buildDir = await mkdtemp(path.join(os.tmpdir(), 'wlm-build-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(buildDir, { recursive: true, force: true });
  });

  it('copies the PDF to <workspaceRoot>/<id>.pdf and returns that path', async () => {
    const src = path.join(buildDir, 'main.pdf');
    await writeFile(src, 'PDFDATA', 'utf8');

    const dest = await surfaceCompiledPdf(root, 'thesis', src);

    expect(dest).toBe(path.join(root, 'thesis.pdf'));
    expect(await readFile(dest, 'utf8')).toBe('PDFDATA');
  });

  it('creates the workspace root if missing', async () => {
    const nested = path.join(root, 'made', 'on', 'demand');
    const src = path.join(buildDir, 'main.pdf');
    await writeFile(src, 'X', 'utf8');

    const dest = await surfaceCompiledPdf(nested, 'paper', src);
    expect(await readFile(dest, 'utf8')).toBe('X');
  });

  it('overwrites a previous surfaced PDF', async () => {
    const src = path.join(buildDir, 'main.pdf');
    await writeFile(path.join(root, 'thesis.pdf'), 'OLD', 'utf8');
    await writeFile(src, 'NEW', 'utf8');

    const dest = await surfaceCompiledPdf(root, 'thesis', src);
    expect(await readFile(dest, 'utf8')).toBe('NEW');
  });

  it('is a no-op when source and destination are the same path', async () => {
    await mkdir(root, { recursive: true });
    const src = path.join(root, 'thesis.pdf');
    await writeFile(src, 'SAME', 'utf8');

    const dest = await surfaceCompiledPdf(root, 'thesis', src);
    expect(dest).toBe(src);
    expect(await readFile(dest, 'utf8')).toBe('SAME');
  });
});
