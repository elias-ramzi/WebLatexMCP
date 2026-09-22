import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, chmod, writeFile } from 'node:fs/promises';
import { platform } from 'node:process';
import {
  parseAuxLabels,
  measureAuxScanWork,
  readAuxFloats,
  DEFAULT_MAX_FLOATS,
  PARSE_BOUND,
  MAX_GROUP_SCAN,
  GROUP_SKIP_SCAN,
} from '../../src/lib/auxFloats.js';
import { buildAuxPath } from '../../src/services/compiler.js';

/**
 * The ceiling every linearity test below asserts its growth ratio against: doubling the input
 * must not much more than double the work. Three of those tests used to measure WALL CLOCK, and
 * the ratio of two wall-clock samples is machine-speed independent but NOT load independent — at
 * the input sizes this module's own scan bounds make cheap, each sample is single-digit
 * milliseconds, so scheduler jitter and GC from the other 180 files of a parallel suite dominate
 * it. One read 3.21x on genuinely linear code against a 3.0 threshold while passing 12/12 in
 * isolation (#173). Raising the threshold would have bought green runs by giving up the only
 * thing these tests do — telling linear (~2x) from quadratic (~4x) apart.
 *
 * So they measure SCAN STEPS instead (`measureAuxScanWork` — characters of the .aux the scan
 * looked at, which is exactly the quantity MAX_GROUP_SCAN/GROUP_SKIP_SCAN/PARSE_BOUND bound).
 * That is deterministic: identical on every machine, under any load, run to run. Measured on this
 * implementation: 1.82x, 1.99x, 2.09x. Measured against references carrying the specific mistake
 * each test guards (a span check that re-walks its group from the start for every marker; an
 * unbounded outer-group read): 3.75x, 4.07x, 4.10x. 2.5 sits between them with 20% headroom over
 * the worst linear reading and 33% under the best quadratic one — tighter than the 3.0 the
 * wall-clock versions needed, and affordable precisely because there is no longer any noise to
 * leave room for.
 */
const LINEAR_GROWTH_MAX = 2.5;

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

  it('#139: a \\newlabel truncated mid-brace does not throw, keeps what precedes it, and refuses what follows', () => {
    // CONTRACT REVERSED in #139 §1 (wave 8), deliberately and by the repository owner's call.
    // This test used to assert `[{fig:ok}]` — that a marker after an unclosed group is still a
    // real entry. It is not: `broken`'s outer group opens and closes NOWHERE in the file, which
    // PROVES (see scanBalance — a depth reaching 0 returns 'closed') that every byte after it is
    // inside that group. So `fig:ok` is \newlabel-shaped text in another entry's argument, and
    // reporting it hands render_pages/extract_text a label->page row invented by a
    // document-controlled .aux, which they then render with confidence. #119 kept it reportable
    // as a RECALL bet on corrupt tails; #139 reversed the bet and fails closed instead.
    //
    // What the reversal does NOT cost is the recall that actually matters on a truncated file:
    // everything BEFORE the damage is still reported, which is what `fig:before` pins here.
    const aux = [
      '\\newlabel{fig:before}{{1}{3}}',
      '\\newlabel{broken}{{1}{2}', // no closing brace for the outer group
      '\\newlabel{fig:ok}{{4}{8}}',
    ].join('\n');
    expect(() => parseAuxLabels(aux)).not.toThrow();
    expect(parseAuxLabels(aux)).toEqual([{ label: 'fig:before', number: '1', page: '3' }]);
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

  it('#139: the truncated outcome no longer lets later markers through — a group unbalanced to the TRUE end of the file refuses them', () => {
    // THE BET THIS TEST PINS WAS REVERSED. Wave 7 (PR #133) wrote this test to pin #119's recall
    // contract — "a group unbalanced to the TRUE end of the file still lets later markers
    // through" — precisely so the bet could not be lost silently. Wave 8 (#139 §1) reverses it
    // on the owner's call, so the test is rewritten to the new contract rather than deleted: the
    // reversal now cannot be lost silently either.
    //
    // Why reversed: the outer group blows the MAX_GROUP_SCAN budget and the GROUP_SKIP_SCAN
    // retry reaches the real end of the string without ever balancing (readGroupOrSkip's
    // 'exhausted' + reason 'truncated'), which PROVES no closing brace exists anywhere — so
    // fig:ok is provably inside fig:broken's group. Establishing that costs nothing (the walk is
    // already paid for; the old "no cheap check left to make" justification was false and was
    // corrected in #133). Reporting it anyway is a fabricated label->page row off a
    // document-controlled .aux, which render_pages resolves and renders with confidence.
    const pad = 'x'.repeat(MAX_GROUP_SCAN + 2000);
    const aux = `\\newlabel{fig:broken}{{1}{7}{${pad}\n\\newlabel{fig:ok}{{4}{8}}`;
    expect(pad.length + 80).toBeLessThan(GROUP_SKIP_SCAN); // the retry really does reach EOF

    // Was [{ label: 'fig:ok', number: '4', page: '8' }] on dev, before #139.
    expect(parseAuxLabels(aux)).toEqual([]);
  });

  it('stays linear on a file of markers buried in ONE unclosed group (the #80 §3 open-span path)', () => {
    // The span bookkeeping added for #80 §3 is the obvious place to walk straight back into the
    // 27-second blowup: "is this marker inside the unclosed group?" is a question whose naive
    // answer re-walks the group from its start for every marker, i.e. O(n) per marker over
    // O(n) markers. It is answered instead by a cursor that only moves forward, so every
    // character of the file is walked at most once across all the continuations.
    //
    // Measured in SCAN STEPS, not milliseconds — see LINEAR_GROWTH_MAX above for why, and for
    // the numbers. On this path: 1.99x as written, 3.75x against a reference whose span check
    // re-walks the group from its own start for every marker.
    function build(n: number): string {
      // One group that never closes, holding n well-formed \newlabel markers. Every one of them
      // is inside it, so every one is refused — and each refusal must cost only the characters
      // between it and the marker before it.
      const buried = Array.from({ length: n }, (_, i) => `\\newlabel{l${i}}{{${i}}{${i}}}`).join(
        '\n',
      );
      return `\\newlabel{fig:real}{{1}{7}{${'x'.repeat(GROUP_SKIP_SCAN + 100)}\n${buried}`;
    }

    function scanSteps(n: number): number {
      const aux = build(n);
      const { labels, steps } = measureAuxScanWork(aux, { maxLabels: n });
      // Nothing is reported: fig:real's group is over budget, and every buried marker is inside
      // it. Pre-fix every one of them came back as a fabricated row instead.
      expect(labels).toEqual([]);
      // Non-vacuity, in the one direction a work counter can go quietly wrong: a scan that
      // stopped early (a bound tripping, a marker wedging it) would report a flattering ratio
      // off work it never did. Every character of the file is looked at at least once by the
      // marker search alone, so anything below this means the scan did not traverse the input.
      expect(steps).toBeGreaterThanOrEqual(aux.length);
      return steps;
    }

    const n = 6_000;
    const small = scanSteps(n);
    const large = scanSteps(n * 2);
    expect(large / small).toBeLessThan(LINEAR_GROWTH_MAX);
  });

  it('#139: stays linear on markers following a group that closes NOWHERE (the branch #139 added a span to)', () => {
    // #139 §1 opens an OpenSpan on the 'truncated'/'unbalanced' branches, where none was opened
    // before, so this is new work on a path that had none. The obvious wrong way to answer "is
    // this marker inside that group?" is to re-walk the group from its own start for every
    // marker: O(n) per marker over O(n) markers, i.e. the 27-second blowup the scan bounds exist
    // to prevent. It is answered instead by the same forward-only cursor the 'tooLong' branch
    // uses — and on THIS branch the cursor already sits at end-of-file, so each continuation is
    // a no-op and the per-marker cost is O(1) outright, not merely amortized.
    //
    // Measured in SCAN STEPS, not milliseconds — see LINEAR_GROWTH_MAX above. On this path:
    // 1.82x as written (the constant GROUP_SKIP_SCAN retry is a fixed overhead both halves pay,
    // which is why it sits under 2x), 4.10x against the re-walking reference.
    function build(markers: number): string {
      // One group that opens and never closes, with `markers` well-formed \newlabel markers
      // after it. Every one of them is inside it, so every one must be refused.
      const tail = Array.from(
        { length: markers },
        (_, i) => `\\newlabel{l${i}}{{${i}}{${i}}}`,
      ).join('\n');
      return `\\newlabel{fig:real}{{1}{7}{${tail}`;
    }

    const SMALL = 275;
    const LARGE = SMALL * 2;
    // The branch under test is reachable ONLY while the whole file is within the retry's reach:
    // past GROUP_SKIP_SCAN the retry is budget-exhausted and this silently measures the OLD
    // 'tooLong' path instead. Asserted rather than assumed, so the input cannot drift off it.
    expect(build(LARGE).length).toBeLessThan(GROUP_SKIP_SCAN);
    // Nothing is reported. Pre-#139 every buried marker came back as a fabricated row, which is
    // also why this is the cheapest possible correctness check to pair with the timing.
    expect(parseAuxLabels(build(LARGE), { maxLabels: LARGE })).toEqual([]);

    function scanSteps(markers: number): number {
      const aux = build(markers);
      const { labels, steps } = measureAuxScanWork(aux, { maxLabels: markers });
      expect(labels).toEqual([]);
      // Same non-vacuity floor as the sibling test above, and it matters more here: the input is
      // deliberately kept small enough to stay on this branch, so a scan that bailed out early
      // would still look plausible.
      expect(steps).toBeGreaterThanOrEqual(aux.length);
      return steps;
    }

    const small = scanSteps(SMALL);
    const large = scanSteps(LARGE);
    expect(large / small).toBeLessThan(LINEAR_GROWTH_MAX);
  });

  it('stays linear (not quadratic) on a large file of unbalanced \\newlabel markers', () => {
    // Each marker opens a brace that never closes, so an unbounded reader would scan to
    // end-of-string on every single one of them: O(n) work per marker * O(n) markers = O(n^2).
    //
    // This asserted an absolute wall-clock budget (elapsedMs < 5000) once, then a wall-clock
    // GROWTH RATIO, and now a growth ratio over SCAN STEPS. The absolute budget barely
    // discriminated (measured pre-fix, 20,000 markers took 6539ms against a 5000ms budget — 1.3x
    // margin, so a CI box 1.4x faster passed genuinely quadratic code); the wall-clock ratio was
    // machine-speed independent but not LOAD independent, and flaked at 3.21x inside a full
    // suite (#173). See LINEAR_GROWTH_MAX above. On this path: 2.09x as written, 4.07x against a
    // reference with the outer-group read left UNBOUNDED — the exact mistake MAX_GROUP_SCAN
    // exists to prevent.
    function build(n: number): string {
      return Array.from({ length: n }, (_, i) => `\\newlabel{l${i}}{`).join('\n');
    }

    function scanSteps(n: number): number {
      const aux = build(n);
      const { labels, steps } = measureAuxScanWork(aux, { maxLabels: n });
      expect(labels).toEqual([]); // every marker is unbalanced — none of them parse
      // Non-vacuity floor, as in the two tests above.
      expect(steps).toBeGreaterThanOrEqual(aux.length);
      return steps;
    }

    const n = 6_000;
    const small = scanSteps(n);
    const large = scanSteps(n * 2);
    expect(large / small).toBeLessThan(LINEAR_GROWTH_MAX);
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
      indeterminate: 0,
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

  it('#139 §1: a fake inside a group that closes NOWHERE is refused too — the last #80 §3 fabrication path', async () => {
    // The sub-case #119 left open, and the exact input wave 7 pinned as a characterization of
    // it. Pre-#139 this returned floats: [{fig:fake, 9, 999}] with refused: 0 — a row invented
    // by the .aux's own bytes, indistinguishable in the payload from a real one, which
    // render_pages and extract_text resolve to a page and render with confidence.
    //
    // The group closes nowhere at all, so readGroupOrSkip answers 'exhausted' + reason
    // 'truncated'. That answer is a PROOF the group is open from `start` to end-of-file, so an
    // OpenSpan is opened on that branch now (searchFrom is still not advanced — nothing was
    // located to advance to, and "never advance on a guess" is untouched).
    dir = await mkdtemp(path.join(os.tmpdir(), 'auxfloats-'));
    const auxPath = buildAuxPath(dir, 'main.tex');
    await mkdir(path.dirname(auxPath), { recursive: true });
    const pad = 'x'.repeat(MAX_GROUP_SCAN + 100);
    await writeFile(auxPath, `\\newlabel{fig:real}{{1}{7}{${pad}\\newlabel{fig:fake}{{9}{999}}`);
    // The whole file is shorter than the retry's reach, which is what makes the outcome
    // 'truncated' rather than the 'tooLong' the sibling test exercises.
    expect(pad.length + 100).toBeLessThan(GROUP_SKIP_SCAN);

    const result = await readAuxFloats(dir, 'main.tex');
    expect(result.floats).toEqual([]);
    expect(result.total).toBe(0);
    // fig:real is a real entry the caller does not get (dropped); fig:fake is a fabrication
    // declined (refused). The counts stay apart, exactly as on the 'tooLong' sibling — which is
    // the point: the two branches now answer the same question the same way, and the asymmetry
    // #119 documented is gone.
    expect(result.dropped).toBe(1);
    expect(result.refused).toBe(1);
    // Nothing here is indeterminate: fig:real's KEY parsed fine, only its outer group did not.
    expect(result.indeterminate).toBe(0);
  });

  it('#139 §2: a \\newlabel whose KEY group never closes is counted as indeterminate, not dropped and not refused', async () => {
    // Issue #139 §2, the key-side remainder of #76's FINDING 2. The KEY group exceeds even the
    // GROUP_SKIP_SCAN retry without closing while the file continues past it (readGroupOrSkip's
    // 'exhausted' + reason 'tooLong'), so nothing at all about the marker could be read.
    //
    // Watched failing pre-fix on dev: {"total":1,"dropped":0,"refused":0} with no third count at
    // all — the marker simply vanished and nothing said it had been there.
    //
    // It must be its OWN count, not folded into either neighbour. `dropped` means "a real entry
    // is missing"; there is no key text here, so there is nothing to test isCleverefShadow
    // against and a cleveref shadow record (excluded from the index by design) would be reported
    // as a lost float. `refused` means the opposite — "nothing is missing, a fake was declined"
    // — which is a claim about the bytes that nothing here supports either.
    dir = await mkdtemp(path.join(os.tmpdir(), 'auxfloats-'));
    const auxPath = buildAuxPath(dir, 'main.tex');
    await mkdir(path.dirname(auxPath), { recursive: true });
    // >16 KB of key with no closing brace, and ordinary .aux text after it so the retry is
    // BUDGET-exhausted rather than running off the end of the file.
    const hugeKey = 'k'.repeat(GROUP_SKIP_SCAN + 100);
    const trailer = ' and the file continues well past the retry budget with ordinary text.';
    await writeFile(auxPath, `\\newlabel{fig:a}{{1}{3}}\n\\newlabel{${hugeKey}${trailer}`);
    expect(hugeKey.length).toBeGreaterThan(GROUP_SKIP_SCAN); // the shape this test is about

    const result = await readAuxFloats(dir, 'main.tex');
    // The real entry before it is untouched.
    expect(result.floats).toEqual([{ label: 'fig:a', number: '1', page: '3' }]);
    expect(result.total).toBe(1);
    expect(result.indeterminate).toBe(1);
    // Neither of the other two fires, and the new count is added to neither of them.
    expect(result.dropped).toBe(0);
    expect(result.refused).toBe(0);
  });

  it('#139 §2: an unclosed KEY is indeterminate whether the retry runs out of budget or out of file', async () => {
    // Length must not be the line. The same "key opened, never closed" state reaches
    // readGroupOrSkip as three different outcomes depending only on how far the file happens to
    // extend past it — 'exhausted'/'tooLong' (above), 'exhausted'/'truncated' (>MAX_GROUP_SCAN,
    // running off the end), and plain 'unbalanced' (a short key running off the end). A counter
    // that fired on only some of them would be drawing a 4096-character distinction no caller
    // could act on, so all three are counted and this pins it.
    for (const key of ['k'.repeat(MAX_GROUP_SCAN + 100), 'fig:b']) {
      dir = await mkdtemp(path.join(os.tmpdir(), 'auxfloats-'));
      const auxPath = buildAuxPath(dir, 'main.tex');
      await mkdir(path.dirname(auxPath), { recursive: true });
      // Nothing after the key at all, so the walk runs off the TRUE end of the file.
      await writeFile(auxPath, `\\newlabel{fig:a}{{1}{3}}\n\\newlabel{${key}`);

      const result = await readAuxFloats(dir, 'main.tex');
      expect(result.floats).toEqual([{ label: 'fig:a', number: '1', page: '3' }]);
      expect(result.indeterminate).toBe(1);
      expect(result.dropped).toBe(0);
      expect(result.refused).toBe(0);
    }
  });

  it('#139 §2: a \\newlabel not followed by a brace at all is NOT indeterminate — nothing was opened', async () => {
    // The one key-side failure that stays a silent skip, and the boundary is deliberate: with no
    // `{` there is no evidence a \\newlabel INVOCATION was ever there (the bytes may be prose, or
    // \\newlabelfoo), so counting it would put a number on text rather than on a marker. It also
    // must not open a span, or arbitrary prose containing the word \\newlabel would start
    // refusing every real entry after it — which fig:ok pins.
    dir = await mkdtemp(path.join(os.tmpdir(), 'auxfloats-'));
    const auxPath = buildAuxPath(dir, 'main.tex');
    await mkdir(path.dirname(auxPath), { recursive: true });
    await writeFile(auxPath, '\\newlabel not-a-brace at all\n\\newlabel{fig:ok}{{4}{8}}');

    const result = await readAuxFloats(dir, 'main.tex');
    expect(result.floats).toEqual([{ label: 'fig:ok', number: '4', page: '8' }]);
    expect(result.indeterminate).toBe(0);
    expect(result.dropped).toBe(0);
    expect(result.refused).toBe(0);
  });

  it('#139: an unclosed KEY opens a span too — a marker after it is refused, never fabricated', async () => {
    // The two halves of #139 meeting: the unreadable key is counted (indeterminate), and because
    // its `{` is provably still open, the \\newlabel-shaped text after it is refused rather than
    // believed. The counts stay distinct: one marker we can say nothing about, one string we
    // declined to read as an entry.
    dir = await mkdtemp(path.join(os.tmpdir(), 'auxfloats-'));
    const auxPath = buildAuxPath(dir, 'main.tex');
    await mkdir(path.dirname(auxPath), { recursive: true });
    const hugeKey = 'k'.repeat(GROUP_SKIP_SCAN + 100);
    const trailer = ' and the file continues well past the retry budget with ordinary text.';
    await writeFile(auxPath, `\\newlabel{${hugeKey}${trailer}\n\\newlabel{fig:after}{{4}{8}}`);

    const result = await readAuxFloats(dir, 'main.tex');
    expect(result.floats).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.indeterminate).toBe(1);
    expect(result.refused).toBe(1);
    expect(result.dropped).toBe(0);
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
