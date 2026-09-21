import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, chmod, writeFile } from 'node:fs/promises';
import { platform } from 'node:process';
import {
  parseAuxLabels,
  readAuxFloats,
  DEFAULT_MAX_FLOATS,
  PARSE_BOUND,
  MAX_GROUP_SCAN,
  GROUP_SKIP_SCAN,
} from '../../src/lib/auxFloats.js';
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

  it("does not parse a \\newlabel nested inside another entry's argument as a second entry", () => {
    // hyperref's third group is caption text; a caption that happens to CONTAIN the literal
    // string "\newlabel{...}" must not be re-entered as its own record once the outer group has
    // already been consumed. Exact repro from the finding.
    const aux =
      '\\newlabel{fig:real}{{1}{7}{A caption saying \\newlabel{fig:fake}{{9}{999}} here\\relax }{figure.1}{}}';
    expect(parseAuxLabels(aux)).toEqual([{ label: 'fig:real', number: '1', page: '7' }]);
  });

  it("does not fabricate a \\newlabel found embedded inside another entry's over-budget outer group", () => {
    // Exact repro from the finding: a ~4200-character caption pushes fig:real's outer group just
    // past MAX_GROUP_SCAN, and the caption happens to contain literal \newlabel-shaped text later
    // inside it. Advancing only to MAX_GROUP_SCAN's own limit (rather than the group's true end)
    // left that text in reach of the next scan, which parsed it as a second, fabricated entry —
    // losing the real fig:real in the process.
    const xs = 'x'.repeat(4200);
    const aux = `\\newlabel{fig:real}{{1}{7}{A caption ${xs} saying \\newlabel{fig:fake}{{9}{999}} here\\relax }{figure.1}{}}`;
    const result = parseAuxLabels(aux);
    expect(result.some((r) => r.label === 'fig:fake')).toBe(false);
    expect(result).toEqual([]); // fig:real is over budget too, so it is dropped, not parsed
  });

  it('FINDING 1: an over-long KEY group does not fabricate a row from a \\newlabel-shaped string in its own outer group', () => {
    // Exact repro from the finding: the KEY (not the outer group) is the part that blows
    // MAX_GROUP_SCAN. Before the fix, the 'tooLong' key branch advanced searchFrom to only the
    // KEY's own end and never read/skipped the outer group at all — so the outer group (which
    // starts right where the scan resumed) was re-entered as ordinary text, and a
    // \newlabel-shaped string inside its caption was parsed as a second, fabricated, REAL entry
    // (counted in `total`, not `dropped`).
    const hugeKey = 'k'.repeat(4146);
    const aux = [
      `\\newlabel{${hugeKey}}{{1}{7}{A caption saying \\newlabel{fig:fake}{{9}{999}} here\\relax }{figure.1}{}}`,
      '\\newlabel{fig:next}{{2}{8}}',
    ].join('\n');
    const result = parseAuxLabels(aux);
    expect(result.some((r) => r.label === 'fig:fake')).toBe(false);
    // fig:next is the only genuinely parseable entry; the huge-key entry has no usable label.
    expect(result).toEqual([{ label: 'fig:next', number: '2', page: '8' }]);
  });

  it('#80 §3: refuses a \\newlabel more than GROUP_SKIP_SCAN chars inside an unclosed group, and still parses a real one after it', () => {
    // The residual #76 left open and #80 §3 filed. The outer group is longer than even the
    // GROUP_SKIP_SCAN retry will scan, so its true end is never located and searchFrom advances
    // only as far as that retry read. Everything past that point is still INSIDE the group — and
    // the fake sits there, so the next indexOf found it and it came back as a real label off a
    // document-controlled .aux, which render_pages would resolve to a page and render.
    //
    // Both directions in one input, because either alone is passable by a wrong fix: refusing
    // everything after an unclosed group would "pass" the first assertion while destroying the
    // index, and the old behaviour passes the second while fabricating.
    const pad = 'x'.repeat(GROUP_SKIP_SCAN + 2000);
    const aux = [
      `\\newlabel{fig:real}{{1}{7}{${pad}\\newlabel{fig:fake}{{9}{999}} tail}{figure.1}{}}`,
      '\\newlabel{fig:after}{{4}{8}}',
    ].join('\n');

    const result = parseAuxLabels(aux);
    // Watched failing pre-fix: [{"label":"fig:fake","number":"9","page":"999"},
    // {"label":"fig:after","number":"4","page":"8"}] — the fake fabricated as a real row.
    expect(result.some((r) => r.label === 'fig:fake')).toBe(false);
    // fig:real's own group is past the accept budget, so it is dropped (counted in readAuxFloats'
    // `dropped`); fig:after sits after the group's true close and is an ordinary entry.
    expect(result).toEqual([{ label: 'fig:after', number: '4', page: '8' }]);
  });

  it('#80 §3: keeps the truncated outcome distinct — a group unbalanced to the TRUE end of the file still lets later markers through', () => {
    // The three outcomes must not collapse into one policy. Here the outer group blows the
    // MAX_GROUP_SCAN budget but the GROUP_SKIP_SCAN retry reaches the real end of the string
    // without ever balancing (readGroupOrSkip's 'exhausted' + reason 'truncated'), which PROVES
    // no closing brace exists anywhere. There is no cheap check left to make and nothing to walk
    // forward over, so parseAuxLabels' long-standing recall contract for a corrupt tail stands:
    // the markers that follow are treated as entries of their own, exactly as before this fix.
    // Contrast the test above, where the file continues past the budget and the walk can go on.
    const pad = 'x'.repeat(MAX_GROUP_SCAN + 2000);
    const aux = `\\newlabel{fig:broken}{{1}{7}{${pad}\n\\newlabel{fig:ok}{{4}{8}}`;
    expect(pad.length + 80).toBeLessThan(GROUP_SKIP_SCAN); // the retry really does reach EOF

    expect(parseAuxLabels(aux)).toEqual([{ label: 'fig:ok', number: '4', page: '8' }]);
  });

  it('stays linear on a file of markers buried in ONE unclosed group (the #80 §3 open-span path)', () => {
    // The span bookkeeping added for #80 §3 is the obvious place to walk straight back into the
    // 27-second blowup: "is this marker inside the unclosed group?" is a question whose naive
    // answer re-walks the group from its start for every marker, i.e. O(n) per marker over
    // O(n) markers. It is answered instead by a cursor that only moves forward, so every
    // character of the file is walked at most once across all the continuations.
    //
    // Same growth-ratio shape as the test above, and for the same reason: an absolute wall-clock
    // budget is machine-speed dependent and flakes (see the note there), while "doubling the
    // input roughly doubles the time" is not.
    function parseTimeMs(n: number): number {
      // One group that never closes, holding n well-formed \newlabel markers. Every one of them
      // is inside it, so every one is refused — and each refusal must cost only the characters
      // between it and the marker before it.
      const buried = Array.from({ length: n }, (_, i) => `\\newlabel{l${i}}{{${i}}{${i}}}`).join(
        '\n',
      );
      const aux = `\\newlabel{fig:real}{{1}{7}{${'x'.repeat(GROUP_SKIP_SCAN + 100)}\n${buried}`;
      const start = Date.now();
      const result = parseAuxLabels(aux, { maxLabels: n });
      const elapsedMs = Date.now() - start;
      // Nothing is reported: fig:real's group is over budget, and every buried marker is inside
      // it. Pre-fix every one of them came back as a fabricated row instead.
      expect(result).toEqual([]);
      return elapsedMs;
    }

    const TIMER_FLOOR_MS = 5;
    function medianOf3Ms(n: number): number {
      const samples = [parseTimeMs(n), parseTimeMs(n), parseTimeMs(n)]
        .map((ms) => Math.max(ms, TIMER_FLOOR_MS))
        .sort((a, b) => a - b);
      const median = samples[1];
      if (median === undefined) {
        throw new Error('unreachable: samples always has exactly 3 elements');
      }
      return median;
    }

    const n = 6_000;
    const tSmall = medianOf3Ms(n);
    const tLarge = medianOf3Ms(n * 2);
    expect(tLarge / tSmall).toBeLessThan(3.0);
  });

  it('stays linear (not quadratic) on a large file of unbalanced \\newlabel markers', () => {
    // Each marker opens a brace that never closes, so an unbounded reader would scan to
    // end-of-string on every single one of them: O(n) work per marker * O(n) markers = O(n^2).
    //
    // This used to assert an absolute wall-clock budget (elapsedMs < 5000). That is exactly the
    // flake shape this project has already hit on windows-latest (see MEMORY.md), and it barely
    // discriminated: measured pre-fix (i.e. against the code this test is supposed to catch a
    // regression back to) on the machine that wrote that budget, 20,000 markers took 6539ms —
    // against a 5000ms budget, only 1.3x margin. A CI box 1.4x faster than that machine would pass
    // the absolute assertion against genuinely quadratic code.
    //
    // "not quadratic" is actually a claim about the GROWTH RATE, which is machine-speed
    // independent: doubling the input should roughly double the time (allow real margin either
    // side of 2x), not quadruple it. n is kept small so the test stays fast even though it now
    // times two parses instead of one.
    function parseTimeMs(n: number): number {
      const aux = Array.from({ length: n }, (_, i) => `\\newlabel{l${i}}{`).join('\n');
      const start = Date.now();
      const result = parseAuxLabels(aux, { maxLabels: n });
      const elapsedMs = Date.now() - start;
      expect(result).toEqual([]); // every marker is unbalanced — none of them parse
      return elapsedMs;
    }

    // A floor under each raw measurement guards against sub-millisecond timer resolution
    // producing a garbage ratio (e.g. 0ms vs 1ms reading as "infinitely worse").
    const TIMER_FLOOR_MS = 5;

    // Median of 3 samples, not a single one: this file runs inside a parallel vitest worker
    // pool, so contention can land on one timed half and not the other. Measured spreads:
    // cold fresh-process runs (no other work sharing the process) gave 1.685-2.138x; warm
    // in-process runs — as this file actually executes, back-to-back inside one worker — gave
    // up to 2.44x, only 2.4% under the old 2.5 threshold. That is thin enough to flake exactly
    // the way this project has already seen on windows-latest (see MEMORY.md's recorded
    // pushConflictBudget flake) even though the code is genuinely linear. A median-of-3 absorbs
    // a single contention-skewed sample rather than asserting on it directly.
    function medianOf3Ms(n: number): number {
      const samples = [parseTimeMs(n), parseTimeMs(n), parseTimeMs(n)]
        .map((ms) => Math.max(ms, TIMER_FLOOR_MS))
        .sort((a, b) => a - b);
      const median = samples[1];
      if (median === undefined) {
        throw new Error('unreachable: samples always has exactly 3 elements');
      }
      return median;
    }

    const n = 6_000;
    const tSmall = medianOf3Ms(n);
    const tLarge = medianOf3Ms(n * 2);

    // A quadratic scan would give ~4x here — confirmed against a standalone reference
    // implementation with the outer-group read left UNBOUNDED (same input shape as this test:
    // the KEY group always closes cleanly, only the trailing outer `{` is unbalanced and scans to
    // end-of-string every time). Repeated runs on a loaded dev machine gave a 3.07-5.42x spread —
    // noisy, but never below 3.0 — while the bounded (real) implementation is fast enough at this
    // `n` that its ratio is dominated by `TIMER_FLOOR_MS` noise around 1x, nowhere near 3.0. 3.0
    // is comfortably below the quadratic floor actually observed (still genuinely falsifiable —
    // an unbounded scan fails this test) while giving real margin over the ~2x a linear scan
    // gives and the up-to-2.44x observed for linear code under worker-pool contention, unlike the
    // previous 2.5 threshold's 2.4% headroom.
    expect(tLarge / tSmall).toBeLessThan(3.0);
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
      total: 2,
      dropped: 0,
      refused: 0,
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

  it('reports omitted/total honestly at the PARSE_BOUND scan boundary, not against an earlier cutoff', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'auxfloats-'));
    const auxPath = buildAuxPath(dir, 'main.tex');
    await mkdir(path.dirname(auxPath), { recursive: true });
    // PARSE_BOUND + 1 real, well-formed labels: one more marker than the scan will ever inspect.
    // The true total is PARSE_BOUND + 1, but this exercises the documented saturation point —
    // readAuxFloats must report exactly PARSE_BOUND (never silently claim the true, larger
    // count, and never silently truncate below PARSE_BOUND either).
    const count = PARSE_BOUND + 1;
    const many = Array.from({ length: count }, (_, i) => `\\newlabel{l${i}}{{${i}}{${i}}}`).join(
      '\n',
    );
    await writeFile(auxPath, many);

    const result = await readAuxFloats(dir, 'main.tex');
    expect(result.total).toBe(PARSE_BOUND);
    expect(result.floats).toHaveLength(DEFAULT_MAX_FLOATS);
    expect(result.omitted).toBe(PARSE_BOUND - DEFAULT_MAX_FLOATS);
  }, 20_000);

  it('counts (rather than silently dropping) a real entry lost to the per-field length cap', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'auxfloats-'));
    const auxPath = buildAuxPath(dir, 'main.tex');
    await mkdir(path.dirname(auxPath), { recursive: true });
    const hugeKey = 'k'.repeat(300);
    await writeFile(
      auxPath,
      [`\\newlabel{${hugeKey}}{{1}{2}}`, '\\newlabel{fig:ok}{{4}{8}}'].join('\n'),
    );

    const result = await readAuxFloats(dir, 'main.tex');
    expect(result.floats).toEqual([{ label: 'fig:ok', number: '4', page: '8' }]);
    // The dropped entry is never silently absorbed into `total`/`omitted` (there is no valid
    // AuxLabel for it to represent) — it is surfaced through its own count instead.
    expect(result.total).toBe(1);
    expect(result.omitted).toBe(0);
    expect(result.dropped).toBe(1);
  });

  it('counts (rather than silently dropping) a well-formed \\newlabel whose outer group exceeds MAX_GROUP_SCAN', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'auxfloats-'));
    const auxPath = buildAuxPath(dir, 'main.tex');
    await mkdir(path.dirname(auxPath), { recursive: true });
    const xs = 'x'.repeat(MAX_GROUP_SCAN + 200);
    await writeFile(
      auxPath,
      [`\\newlabel{fig:long}{{1}{7}{${xs}}{figure.1}{}}`, '\\newlabel{fig:ok}{{4}{8}}'].join('\n'),
    );

    const result = await readAuxFloats(dir, 'main.tex');
    // Watched failing pre-fix: the over-budget entry vanished with total/omitted/dropped all 0
    // instead of being reported here.
    expect(result.floats).toEqual([{ label: 'fig:ok', number: '4', page: '8' }]);
    expect(result.total).toBe(1);
    expect(result.omitted).toBe(0);
    expect(result.dropped).toBe(1);
  });

  it('does not fabricate a float from \\newlabel-shaped text embedded in an abandoned over-budget group', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'auxfloats-'));
    const auxPath = buildAuxPath(dir, 'main.tex');
    await mkdir(path.dirname(auxPath), { recursive: true });
    const xs = 'x'.repeat(4200);
    await writeFile(
      auxPath,
      `\\newlabel{fig:real}{{1}{7}{A caption ${xs} saying \\newlabel{fig:fake}{{9}{999}} here\\relax }{figure.1}{}}`,
    );

    const result = await readAuxFloats(dir, 'main.tex');
    // Watched failing pre-fix: floats came back as [{"label":"fig:fake","number":"9","page":"999"}]
    // — the real fig:real entry lost, a fabricated fig:fake returned in its place.
    expect(result.floats.some((f) => f.label === 'fig:fake')).toBe(false);
    expect(result.floats).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.dropped).toBe(1); // fig:real itself — counted, not vanished
  });

  it('FINDING 1: an over-long KEY group is counted as dropped, and does not fabricate a row from its own outer group', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'auxfloats-'));
    const auxPath = buildAuxPath(dir, 'main.tex');
    await mkdir(path.dirname(auxPath), { recursive: true });
    const hugeKey = 'k'.repeat(4146);
    await writeFile(
      auxPath,
      [
        `\\newlabel{${hugeKey}}{{1}{7}{A caption saying \\newlabel{fig:fake}{{9}{999}} here\\relax }{figure.1}{}}`,
        '\\newlabel{fig:next}{{2}{8}}',
      ].join('\n'),
    );

    const result = await readAuxFloats(dir, 'main.tex');
    // Watched failing pre-fix: floats came back as
    // [{"label":"fig:fake",...},{"label":"fig:next",...}], total: 2, dropped: 0 — the outer group
    // following the over-long key was never consumed, so the \newlabel-shaped text in its own
    // caption was re-scanned as a second, fabricated, REAL entry.
    expect(result.floats.some((f) => f.label === 'fig:fake')).toBe(false);
    expect(result.floats).toEqual([{ label: 'fig:next', number: '2', page: '8' }]);
    expect(result.total).toBe(1);
    expect(result.dropped).toBe(1); // the huge-key entry itself — counted, not fabricated from
  });

  it('FINDING 2: an outer group beyond even GROUP_SKIP_SCAN is counted as dropped, not silently lost (exhausted boundary)', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'auxfloats-'));
    const auxPath = buildAuxPath(dir, 'main.tex');
    await mkdir(path.dirname(auxPath), { recursive: true });
    // A ~19KB caption — reachable from an honest latexmk run (a "Dimension too large" overflow
    // still produces both a PDF and an .aux) — pushes the outer group's TRUE end beyond even the
    // GROUP_SKIP_SCAN retry, landing on readGroupOrSkip's 'exhausted' outcome.
    const xs = 'x'.repeat(19_000);
    await writeFile(
      auxPath,
      [`\\newlabel{fig:hugecap}{{1}{7}{${xs}}{figure.1}{}}`, '\\newlabel{fig:ok}{{4}{8}}'].join(
        '\n',
      ),
    );

    const result = await readAuxFloats(dir, 'main.tex');
    // Watched failing pre-fix: {"total":1,"omitted":0,"dropped":0,"floats":["fig:ok"]} — fig:hugecap
    // vanished with every counter at zero, instead of being counted here.
    expect(result.floats).toEqual([{ label: 'fig:ok', number: '4', page: '8' }]);
    expect(result.total).toBe(1);
    expect(result.dropped).toBe(1); // fig:hugecap itself — counted, not vanished
  });

  it('FINDING 2: a fake \\newlabel anywhere within an exhausted group is never fabricated, regardless of its position', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'auxfloats-'));
    const auxPath = buildAuxPath(dir, 'main.tex');
    await mkdir(path.dirname(auxPath), { recursive: true });
    // Same ~19KB-caption shape as above, but this time the \newlabel-shaped fake sits right near
    // the START of the caption rather than after it. Pre-fix, the exhausted branch never advanced
    // searchFrom at all, so the very next scan started essentially where it always had and picked
    // up whichever "\newlabel" text it hit first — the position of the fake inside the abandoned
    // group was the only thing that mattered, not the group's total length.
    const xs = 'x'.repeat(18_900);
    await writeFile(
      auxPath,
      `\\newlabel{fig:real}{{1}{7}{\\newlabel{fig:fake}{{9}{999}} ${xs}}{figure.1}{}}`,
    );

    const result = await readAuxFloats(dir, 'main.tex');
    // Watched failing pre-fix: floats came back as [{"label":"fig:fake","number":"9","page":"999"}]
    // — a fabricated entry, regardless of the fake sitting near the very start of the group.
    expect(result.floats.some((f) => f.label === 'fig:fake')).toBe(false);
    expect(result.floats).toEqual([]);
    expect(result.dropped).toBe(1); // fig:real itself — counted, not fabricated from
  });

  it('#80 §3: counts a refused marker apart from a dropped entry, and never as one', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'auxfloats-'));
    const auxPath = buildAuxPath(dir, 'main.tex');
    await mkdir(path.dirname(auxPath), { recursive: true });
    // Same hostile shape as the parseAuxLabels test: the fake sits past the GROUP_SKIP_SCAN
    // retry's reach, inside a group whose end is never located.
    const pad = 'x'.repeat(GROUP_SKIP_SCAN + 2000);
    await writeFile(
      auxPath,
      [
        `\\newlabel{fig:real}{{1}{7}{${pad}\\newlabel{fig:fake}{{9}{999}} tail}{figure.1}{}}`,
        '\\newlabel{fig:after}{{4}{8}}',
      ].join('\n'),
    );

    const result = await readAuxFloats(dir, 'main.tex');
    // Watched failing pre-fix: floats came back as [fig:fake, fig:after] with refused undefined
    // — the fabricated row indistinguishable from the real one.
    expect(result.floats).toEqual([{ label: 'fig:after', number: '4', page: '8' }]);
    expect(result.total).toBe(1);
    // The two counters say different things and must not be merged: `dropped` is fig:real, a real
    // entry the caller is not getting; `refused` is fig:fake, a fabrication declined. Calling the
    // refusal a drop would claim an entry was lost that never existed.
    expect(result.dropped).toBe(1);
    expect(result.refused).toBe(1);
  });

  it('#80 §3 RESIDUAL (characterization, not an endorsement): a fake inside a group that closes NOWHERE is still reported', async () => {
    // What is closed and what is not, measured rather than reasoned about. The sibling test
    // above covers the sub-case issue #80 §3 actually names — a fake more than GROUP_SKIP_SCAN
    // characters into a group the file continues past — and it is refused. THIS is the sub-case
    // that is left: the group closes nowhere at all, so `readGroupOrSkip` answers 'exhausted' +
    // reason 'truncated' (or plain 'unbalanced'), no OpenSpan is opened, and the next indexOf
    // picks the fake up as a real entry.
    //
    // It is pinned here deliberately, ugly result and all, for two reasons. It is the only
    // fabrication path left in this file and a report is easy to lose, whereas a test is not.
    // And closing it is a one-line change (open a span on those branches too, leaving searchFrom
    // exactly where it is — the walk has already proven the group is open at every position to
    // end-of-file, so the check costs nothing) which would REVERSE the recall contract the test
    // 'keeps the truncated outcome distinct' pins, so whoever closes it has to change that test
    // in the same breath. Failing here is the intended way to find that out.
    dir = await mkdtemp(path.join(os.tmpdir(), 'auxfloats-'));
    const auxPath = buildAuxPath(dir, 'main.tex');
    await mkdir(path.dirname(auxPath), { recursive: true });
    const pad = 'x'.repeat(MAX_GROUP_SCAN + 100);
    await writeFile(auxPath, `\\newlabel{fig:real}{{1}{7}{${pad}\\newlabel{fig:fake}{{9}{999}}`);
    // The whole file is shorter than the retry's reach, which is what makes the outcome
    // 'truncated' rather than the 'tooLong' the sibling test exercises.
    expect(pad.length + 100).toBeLessThan(GROUP_SKIP_SCAN);

    const result = await readAuxFloats(dir, 'main.tex');
    // Reported as an ordinary float, indistinguishable from a real one, with refused at 0 — so
    // nothing in the payload tells a caller this row was invented by the .aux's own bytes.
    expect(result.floats).toEqual([{ label: 'fig:fake', number: '9', page: '999' }]);
    expect(result.total).toBe(1);
    expect(result.refused).toBe(0);
    // fig:real itself is still counted, so the loss half of #80 §3 is closed even here.
    expect(result.dropped).toBe(1);
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
