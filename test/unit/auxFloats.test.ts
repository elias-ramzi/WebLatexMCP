import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, chmod, writeFile } from 'node:fs/promises';
import { platform } from 'node:process';
import { parseAuxLabels, readAuxFloats, DEFAULT_MAX_FLOATS } from '../../src/lib/auxFloats.js';
import { buildAuxPath } from '../../src/services/compiler.js';

describe('parseAuxLabels', () => {
  it('parses the plain LaTeX form', () => {
    const aux = '\\newlabel{fig:x}{{3}{7}}\n';
    expect(parseAuxLabels(aux)).toEqual([{ label: 'fig:x', number: '3', page: '7' }]);
  });

  it('parses the hyperref form with five groups, taking only the first two', () => {
    const aux = '\\newlabel{fig:x}{{3}{7}{\\relax }{figure.3}{}}\n';
    expect(parseAuxLabels(aux)).toEqual([{ label: 'fig:x', number: '3', page: '7' }]);
  });

  it('handles nested braces inside a group', () => {
    const aux = '\\newlabel{sec:intro}{{1}{2}{\\relax {Introduction}}{section.1}{}}\n';
    expect(parseAuxLabels(aux)).toEqual([{ label: 'sec:intro', number: '1', page: '2' }]);
  });

  it('parses multiple labels in document order', () => {
    const aux = [
      '\\newlabel{fig:a}{{1}{2}}',
      '\\newlabel{tab:b}{{2}{5}}',
      '\\newlabel{fig:c}{{3}{9}}',
    ].join('\n');
    expect(parseAuxLabels(aux)).toEqual([
      { label: 'fig:a', number: '1', page: '2' },
      { label: 'tab:b', number: '2', page: '5' },
      { label: 'fig:c', number: '3', page: '9' },
    ]);
  });

  it('skips a \\newlabel truncated mid-brace without throwing, and keeps scanning', () => {
    const aux = [
      '\\newlabel{broken}{{1}{2}', // no closing brace for the outer group
      '\\newlabel{fig:ok}{{4}{8}}',
    ].join('\n');
    expect(() => parseAuxLabels(aux)).not.toThrow();
    expect(parseAuxLabels(aux)).toEqual([{ label: 'fig:ok', number: '4', page: '8' }]);
  });

  it('skips a \\newlabel with a missing key group without throwing', () => {
    const aux = '\\newlabel not-a-brace at all\n\\newlabel{fig:ok}{{4}{8}}';
    expect(() => parseAuxLabels(aux)).not.toThrow();
    expect(parseAuxLabels(aux)).toEqual([{ label: 'fig:ok', number: '4', page: '8' }]);
  });

  it('skips a \\newlabel whose outer group has no page group without throwing', () => {
    const aux = '\\newlabel{fig:onlynumber}{{1}}\n\\newlabel{fig:ok}{{4}{8}}';
    expect(() => parseAuxLabels(aux)).not.toThrow();
    expect(parseAuxLabels(aux)).toEqual([{ label: 'fig:ok', number: '4', page: '8' }]);
  });

  it('handles a \\newlabel split across lines', () => {
    const aux = '\\newlabel{fig:x}\n  {{3}\n   {7}}\n';
    expect(parseAuxLabels(aux)).toEqual([{ label: 'fig:x', number: '3', page: '7' }]);
  });

  it('returns [] for a file with no \\newlabel', () => {
    expect(parseAuxLabels('\\relax\n\\@writefile{toc}{...}\n')).toEqual([]);
  });

  it('returns [] for an empty string', () => {
    expect(parseAuxLabels('')).toEqual([]);
  });

  it('enforces maxLabels and stops scanning past it', () => {
    const many = Array.from({ length: 10 }, (_, i) => `\\newlabel{l${i}}{{${i}}{${i}}}`).join('\n');
    const result = parseAuxLabels(many, { maxLabels: 3 });
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.label)).toEqual(['l0', 'l1', 'l2']);
  });

  it('drops a label whose field exceeds the length cap', () => {
    const hugeKey = 'k'.repeat(300);
    const aux = `\\newlabel{${hugeKey}}{{1}{2}}\n\\newlabel{fig:ok}{{4}{8}}`;
    expect(parseAuxLabels(aux)).toEqual([{ label: 'fig:ok', number: '4', page: '8' }]);
  });

  it('parses a label key containing : and _', () => {
    const aux = '\\newlabel{sec:my_section-1}{{2}{3}}\n';
    expect(parseAuxLabels(aux)).toEqual([{ label: 'sec:my_section-1', number: '2', page: '3' }]);
  });

  it('stays faithful to the file: cleveref shadow (@cref) entries are returned verbatim, not filtered', () => {
    // Real values from this repo's own TeX install (pdflatex + cleveref 6.1.200-era .sty),
    // captured with `\cref{fig:a}`/`\cref{sec:intro}` in a probe document. Filtering these belongs
    // one layer up in readAuxFloats — the pure parser must report exactly what \newlabel says.
    const aux = [
      '\\newlabel{fig:a}{{1}{1}}',
      '\\newlabel{fig:a@cref}{{[figure][1][]1}{[1][1][]1}}',
    ].join('\n');
    expect(parseAuxLabels(aux)).toEqual([
      { label: 'fig:a', number: '1', page: '1' },
      { label: 'fig:a@cref', number: '[figure][1][]1', page: '[1][1][]1' },
    ]);
  });
});

describe('readAuxFloats', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) {
      // Undo any chmod 000 from the "unreadable" test before rm, or cleanup itself can fail.
      await chmod(dir, 0o700).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reads and parses a present .aux, relative to the build dir for the project/root file', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'auxfloats-'));
    const auxPath = buildAuxPath(dir, 'main.tex');
    await mkdir(path.dirname(auxPath), { recursive: true });
    await writeFile(auxPath, '\\newlabel{fig:one}{{1}{3}}\n\\newlabel{tab:two}{{1}{4}}\n');

    const result = await readAuxFloats(dir, 'main.tex');
    expect(result).toEqual({
      floats: [
        { label: 'fig:one', number: '1', page: '3' },
        { label: 'tab:two', number: '1', page: '4' },
      ],
      omitted: 0,
    });
  });

  it('reports empty floats with a note, never an error, when no .aux exists (ENOENT)', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'auxfloats-'));
    // Deliberately no .aux written at all — nothing has been compiled with this root file yet.
    const result = await readAuxFloats(dir, 'main.tex');
    expect(result.floats).toEqual([]);
    expect(result.omitted).toBe(0);
    expect(result.note).toMatch(/\.aux/);
  });

  it('propagates a real read failure (unreadable .aux) rather than treating it as "not compiled yet"', async () => {
    if (platform === 'win32') {
      // chmod 0o000 does not reliably block reads for the owning user on Windows.
      return;
    }
    dir = await mkdtemp(path.join(os.tmpdir(), 'auxfloats-'));
    const auxPath = buildAuxPath(dir, 'main.tex');
    await mkdir(path.dirname(auxPath), { recursive: true });
    await writeFile(auxPath, '\\newlabel{fig:one}{{1}{3}}\n');
    await chmod(auxPath, 0o000);

    await expect(readAuxFloats(dir, 'main.tex')).rejects.toThrow();
  });

  it('excludes cleveref @cref shadow entries from floats and from the count they omit against', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'auxfloats-'));
    const auxPath = buildAuxPath(dir, 'main.tex');
    await mkdir(path.dirname(auxPath), { recursive: true });
    // Real shape captured from a pdflatex + cleveref run: every real \label gets a matching
    // "<label>@cref" shadow whose number/page are cross-reference codes, not printed pages.
    await writeFile(
      auxPath,
      [
        '\\newlabel{fig:a}{{1}{1}}',
        '\\newlabel{fig:a@cref}{{[figure][1][]1}{[1][1][]1}}',
        '\\newlabel{sec:intro}{{1}{1}}',
        '\\newlabel{sec:intro@cref}{{[section][1][]1}{[1][1][]1}}',
      ].join('\n'),
    );

    const result = await readAuxFloats(dir, 'main.tex');
    // Watched failing pre-fix: the tool reported all four entries (including the two @cref
    // shadows, doubling the count and reporting "[1][1][]1" as a printed page).
    expect(result.floats).toEqual([
      { label: 'fig:a', number: '1', page: '1' },
      { label: 'sec:intro', number: '1', page: '1' },
    ]);
    expect(result.omitted).toBe(0);
  });

  it('computes omitted against the TRUE total, not an earlier, smaller internal parse cutoff (FIX6 boundary)', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'auxfloats-'));
    const auxPath = buildAuxPath(dir, 'main.tex');
    await mkdir(path.dirname(auxPath), { recursive: true });
    // 2500 real \newlabel entries: past the OLD tool's implicit 2000-label parse cutoff
    // (parseAuxLabels's own DEFAULT_MAX_LABELS), but well under readAuxFloats's much higher
    // internal parse bound. The pre-fix tool computed `parseAuxLabels(aux).length - 200` — with
    // the default 2000-label parse cutoff in force, that capped at 2000, giving `omitted = 1800`,
    // silently undercounting the true 2300 omitted by 500.
    const count = 2500;
    const many = Array.from({ length: count }, (_, i) => `\\newlabel{l${i}}{{${i}}{${i}}}`).join(
      '\n',
    );
    await writeFile(auxPath, many);

    const result = await readAuxFloats(dir, 'main.tex');
    expect(result.floats).toHaveLength(DEFAULT_MAX_FLOATS);
    expect(result.omitted).toBe(count - DEFAULT_MAX_FLOATS);
    expect(result.omitted).not.toBe(2000 - DEFAULT_MAX_FLOATS); // the old, wrong undercount
  });

  it('respects an explicit max override', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'auxfloats-'));
    const auxPath = buildAuxPath(dir, 'main.tex');
    await mkdir(path.dirname(auxPath), { recursive: true });
    const many = Array.from({ length: 10 }, (_, i) => `\\newlabel{l${i}}{{${i}}{${i}}}`).join('\n');
    await writeFile(auxPath, many);

    const result = await readAuxFloats(dir, 'main.tex', { max: 3 });
    expect(result.floats).toHaveLength(3);
    expect(result.omitted).toBe(7);
  });
});
