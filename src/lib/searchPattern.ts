/**
 * Turning a caller's `search_files` pattern into a matcher, and refusing the ones whose
 * backtracking would use up the search's time budget.
 *
 * **Why this module is a guard and not a convenience.** `RegExp.prototype.exec` is
 * uninterruptible: while V8 is inside the regex engine, nothing else on that thread runs. A
 * regex search therefore runs its scans on a worker thread (`searchWorker.ts`) that is
 * TERMINATED at the search deadline — that, and only that, is what bounds how long a regex
 * search can take, whatever its pattern. This module is the first line of defence in front of
 * it: it refuses, before anything runs, the pattern shapes whose backtracking blows up, so that
 * an accepted pattern normally finishes long before the deadline, and a search is not a
 * five-second partial answer merely because its pattern was unlucky. It is a static analysis
 * and an approximation; the worker is the bound, not this.
 *
 * The numbers below are measured on this codebase's own Node, not assumed. Against ONE
 * 2000-character line of `a`s: `a*b` (one unbounded repeat, nothing to trade input with) takes
 * a few milliseconds; `.*a.*b` (two repeats that can each match what follows them) takes **3-8
 * seconds**; `.*a.*a.*b` (three) takes **37 minutes**; and `[^x]*a[^x]*a[^x]*b` — no `.` in
 * sight, a negated class that happens to match the letter after it — takes **12 minutes**.
 * `(a+)+$` is worse again and needs only a few dozen characters, and so does its COUNTED form:
 * `(?:a|aa){0,40}b` took 29 seconds on forty `a`s. Nor does a count have to be large, or a
 * repeat unbounded, to multiply: `.*a{0,16}a{0,16}a{0,16}b` took 57 seconds. And a repeat need
 * not be ambiguous against another repeat at all: `[\s\S]*a{999}b` took 8 seconds, because
 * the fixed run `a{999}` is matched again at every place `[\s\S]*` can stop.
 *
 * **The cost model.** A backtracking engine's work at one start position is a product: every
 * CHOICE POINT — a repeat that can stop at more than one length, or an alternation more than one
 * of whose branches can match — re-runs everything after it once per option, but that re-run
 * only costs more than a step when what follows can actually go on matching the characters the
 * choice point gave back. `a*b` has one choice point with 2000 options and nothing after it that
 * accepts an `a`, so each option fails at once: 2000 steps. `.*a.*b` has two, and the second
 * runs in full for every option of the first: 2000 × 2000. `.*a{999}b` has one, and the run
 * after it costs up to 999 steps per option: 2000 × 999.
 *
 * Two things measured in V8 shape how that product is counted. **Steps differ in cost**: one
 * iteration of a counted loop (`a{19}`) is the dearest per character; a plain greedy `*` or `+`
 * over one atom costs a quarter to a third of that; and a run of WRITTEN-OUT letters (`\\label\{`,
 * `\w\s`) is compiled into one text node checked several characters per load that fails on its
 * first mismatching check, a tenth of a counted iteration per letter or less — `.*` then 400
 * written-out `a`s then `b` took 3ms on a line of `a`s, where `.*a{400}b` took 1.6s. And
 * **written-out text limits what follows it**: past a run that overlaps itself only at a shift
 * of `p` (7 for `\label{`, 1 for `aaa`), the engine arrives at most once per `p` characters.
 *
 * **What an accepted pattern satisfies.** Once a pattern is accepted here:
 *
 *  1. No group — nor backreference — is repeated more than once unless its body is RIGID: one
 *     fixed-width way to match, with no alternation, no variable repeat and no backreference
 *     inside. The nested ambiguity that makes backtracking EXPONENTIAL (`(a+)+`, `(a|a)*`,
 *     `(?:a|aa){0,40}`) cannot be expressed at all, bounded count or not. An UNBOUNDED repeat of
 *     any group is refused as well, rigid or not.
 *  2. No piece is entered more than {@link MAX_AMBIGUITY_PRODUCT} times per starting position —
 *     twice the line cap. A piece is re-entered once per option of every open choice point it
 *     can trade input with (it can match a character that choice point matches, past anything
 *     that need not consume), and the count is the product of those choice points' FACTORS. A
 *     factor is the RANGE (how many lengths it can stop at — {@link ANALYZED_LINE_CHARS} for an
 *     unbounded repeat, `m - n + 1` for `{n,m}`, 2 for `?`, the branch count for an alternation),
 *     lowered by written-out text in two cases, both for the repeat of one atom directly before
 *     the text: to the line over the text's period for whatever lies past it (`.*\\label\{`: 286),
 *     and, for a repeat of one atom right after the text when the text holds a letter that
 *     repeat cannot match, to its starts plus `w` lines of characters — `w` how far that letter
 *     sits from the text's end — shared out over its own run (`.*\\label\{fig:[a-z_]+`: `:` stops
 *     `[a-z_]+`, so its runs from different `\label{fig:`s never overlap — 2). A `\b`, `\B`,
 *     `^`, `$` or lookaround inside or before the text does not break it (it consumes nothing),
 *     and a repeat of one atom that can take neither the text's last letter nor the next text's
 *     first (`.*\}\s*\\cite\{`) carries the first text's limit on to the second. A fence carries
 *     through a fenced repeat: in `.*\\ref\{[a-z:_]+\}\s*`, `[a-z:_]+` is fenced from `.*` by the
 *     `{` and `\s*` from `[a-z:_]+` by the `}`, so `\s*`'s runs across `.*`'s stops overlap at most
 *     `w × (w2 + 1)` deep. And an optional piece that must consume and cannot begin with a
 *     character what follows it can (`(\[[^\]]*\])?\{` — `[` against `{`) is no choice at all:
 *     the next character rules one option out on its first check. `.*a` costs 2000;
 *     `[^}]*\}` is no chain (the class excludes the brace) and neither is `\w+\s+\w+`
 *     (chaining quantifiers is not the hazard, overlapping ones are). `a+a+b`, `.*a.*b` and
 *     `.*a\w+\s` all come to 2000 × 2000; a group says what its match can END in, so
 *     `(?:a*)a*b` does too; `.{0,100}.{0,100}b` is 101 × 101; twenty-four unrolled `(?:a|a)` are
 *     2^24. This is per starting position, so `^` does not relax it: `^.*a.*a.*b` is refused.
 *     And paths CONVERGE: a piece that must consume forces the edge of every open choice point
 *     it does not overlap, and when the item carrying one was re-entered by a BOUNDED choice
 *     point the piece closes too (`x*` once per stop of `x{0,30}`), every one of those runs ends
 *     at the same place and hands on — so that piece, and every one after it, is entered at
 *     least that many times, overlapping anything or not. Counted as entered once,
 *     `x{0,30}x*a+a{11}b` (`a+a{11}` run in full 31 times) took 1.1-2.7s and
 *     `x{0,30}x*\{y{0,30}y*\{a+a{4}b` 4.4-6.4s. Brackets do not hide it: the floor a group's
 *     body reaches carries past its `)`, and a bounded choice point before a group converges on
 *     a repeat inside it where the same items written out would: of 216000 bracketings of
 *     converging shapes checked, none is accepted where its flat spelling is refused (the
 *     reverse does happen: brackets can cost a pattern its acceptance, never earn it one there).
 *     While the floor stopped at the `)`, `(x{0,30}x*\{)(y{0,30}y*\{)a+a{4}b` was accepted at
 *     2.7-3.0s and `x{0,40}(?:x*\{)a+a{9}b` at 1.1-1.3s. A choice point the closing piece still
 *     overlaps sets no floor: its runs go on and end apart (`[A-Z]{2,5}.*\\cite`, well under
 *     20ms). Only a bounded choice point (a count, a `?`, an alternation) sets that floor. Runs
 *     converging from an UNBOUNDED repeat's stops share the
 *     line with what follows them and with the starting positions, and a floor counted for them
 *     refused a hundred ordinary searches like `\\cite\{[^}]*smith[^}]*\}.*$` (~1ms); they are
 *     left to the charge on the converging repeat itself, re-run once per stop, which is looser
 *     — `\\cite\{[^}]*smith[^}]*\}a+a{18}b` is accepted at 2.2-2.9 times the reference below.
 *  3. The estimated WEIGHTED steps per starting position are at most {@link MAX_CHAIN_WORK},
 *     scaled up by how few starting positions can be costly. The estimate is one pass over the
 *     line plus, for every re-entered piece, its cost times its entries (rule 2's count). A
 *     counted iteration, a backreference's character and a rigid group's iteration cost a full
 *     step, a capturing group one more on entry, a greedy repeat's character
 *     {@link GREEDY_STEP} and a written-out letter {@link TEXT_STEP} — except a greedy repeat
 *     inside a QUANTIFIED group that captures, holds a capture or can match nothing
 *     (`(\wx*)?`, `(?:x*)?`), whose every character costs a full step, since V8 saves and
 *     restores the group's registers (or runs its empty check) each time the repeat gives one
 *     back. And a piece that can match NOTHING is charged once per ARRIVAL, not once: it settles
 *     none of the choice points still open before it, so the engine stands at it once per stop
 *     of each — overlapping it or not — enters it, matches nothing and hands on. Each arrival
 *     beyond its re-entries costs its entry (a loop set up and one check, a full step and a
 *     quarter). Charged once, twenty-three `a*`, `b*`, … after `x{0,75}x*` took 8-10s. A
 *     piece that must consume and overlaps nothing open is arrived at as often, and fails on
 *     its first check at every arrival but the ones where the runs before it converge (rule 2),
 *     which are charged as re-entries. A pattern that begins with
 *     `^` is costly at one starting position (no `m` flag is ever set), and one that begins with
 *     written-out text at one per occurrence of it; anywhere else the attempt fails on its first
 *     letters. A trailing run of pieces that cannot fail (`.*`, `\s*`) is charged once — the
 *     first arrival there is the match — which is why `.*TODO.*` costs what `.*TODO` does.
 *     `$` is not such a piece, so neither is `.*$`: `.` does not match U+2028 or U+2029, which
 *     the search's lines can hold (it splits on `\n` and `\r` only), and on a line ending in one
 *     `.*TODO.*$` took 0.4s where `.*TODO.*` takes a millisecond.
 *     `.*a{999}b`, `a*(?:aa){700}b` and `.*(?:a{999})?b` fit rule 2 and are refused here;
 *     `[^a]*a{999}b` is not, because its run cannot start inside what the repeat matches.
 *  4. The product of every counted repeat's upper bound is capped ({@link MAX_REPEAT_PRODUCT}),
 *     and the pattern source is at most {@link MAX_PATTERN_CHARS} characters.
 *
 * **Lookbehinds are judged in the order V8 runs them.** A lookbehind's body is matched right to
 * left from the current position — last item first, greedy repeats growing leftwards — so its
 * items are judged reversed, and every rule above then applies as written: `(?<=b.*a.*)` is
 * `.*a.*b` run backwards, at every starting position, and is refused like it.
 *
 * **What that buys, measured rather than proved.** Rules 1-4 bound an ESTIMATE, and the
 * estimate is not a proof about V8: the weights are measured averages, and the overlap test,
 * the period and the step count are approximations. What was measured, on one adversarial
 * 2000-character line (the search caps a line's scan at `MAX_LINE_SCAN_CHARS`, 2000), against
 * `\w*\w{19}!` as the reference (~135ms on an idle machine): the costliest accepted member of
 * each family that grows with a count — `.*a{19}b`, `.*a?a{9}b`, `\w*\w{19}!`, `.*[ab]{0,19}c`,
 * `(?<=ba?a{18}.*)`, `.{0,62}.{0,62}b`, `x{0,18}(\wx*)?\}`, written-out runs after one or two
 * repeats and more, which a unit test re-derives from the rules and runs — takes 1 to 1.7 times
 * the reference, 0.13-0.3s. Random and targeted searches have found accepted patterns slower
 * than that, and they are the honest figure: `(?<=\{*?\01{15}[ab]*.{0,52})` at 2.2-3.2 times
 * the reference (0.3-0.45s) and `\\cite\{[^}]*smith[^}]*\}a+a{18}b` at 2.2-2.9 times — and over
 * a second while the machine ran five searches at once (load average ~10), so read every figure
 * here as a ratio to the reference, not a wall-clock promise. A search over some 60000
 * generated patterns once reported nothing slower than 2.6 times it while the converging-paths
 * family (rule 2) was still accepted at up to 54 times it (6.4s), so none of this is a bound —
 * the worker's deadline is. Ordinary LaTeX searches (`.*\\includegraphics\[width`, `^.*TODO.*$`,
 * `\\begin\{(figure|table)\}.*\\label\{[^}]*\}`, `.*\\label\{fig:[a-z_]+\}`,
 * `\\label\{.*\}\s*\\cite\{[^}]*\}`) measure under 10ms. The line is drawn by that budget,
 * not by how cost grows with the line: the cubic shapes tried at every position
 * (`.*\\label\{[^}]*\}`, a `[^}]*` run from every `\label{` `.*` can stop at, 0.2-0.6s) are
 * refused, but a cubic shape tried only where written-out text begins can fit it —
 * `\\section\{.*\\label\{[^}]*\}` and `\\cite\{[^}]*\}.*\\cite\{[^}]*\}` (~20ms at worst)
 * are accepted, while `\\ref\{[^}]*\}.*\\ref\{[^}]*\}` (~30ms) is refused, 2% over, for its
 * shorter lead text. The rest of what is refused (`.*foo.*bar`, the counted families past their
 * cap, everything exponential) takes seconds to minutes. A shape this analysis misjudges costs
 * at most the search's deadline, because the worker running it is terminated there; it cannot
 * hang the server.
 *
 * Rules 1–3 are deliberately CONSERVATIVE and refuse patterns that would have been fine
 * (`(foo|bar)+` and `(a|b)*x` are perfectly cheap; `(fig|tab){2}` is refused although its
 * branches cannot both match; alternatives' choice points are multiplied although only one
 * branch runs; written-out text is charged more than V8 spends on it; a converging-paths floor
 * multiplies rule 2's count although each converging run of `.*\\cite` is cheap, which refuses
 * `\d{1,4}\w*:.*\\cite` (~15ms) and `\s{0,2}\s*\\cite.*\\cite`; `\\hline.*&.*\\\\` is
 * refused although its worst line, forty `\hline`s then `&`s, took 70-100ms; and `.*a.*b` is only
 * slow on a long line). That is the right direction for a first line of defence — a refusal costs one
 * error message naming the construct and the way around it, a miss costs a search that runs
 * into its deadline — and it is how the rest of this codebase treats an input it cannot verify:
 * fail closed, say why, hand back the escape route. Here the escape route is `regex: false`,
 * which needs none of this because an escaped literal has no quantifiers at all.
 */

/** A pattern the server refuses to run. Distinct from a syntax error, which V8 raises itself. */
export class UnsafePatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafePatternError';
  }
}

/**
 * Longest accepted pattern source, in characters. Not a guess at "long enough": it bounds how
 * many quantifiers and alternatives one pattern can carry, which every cost estimate above is
 * stated in terms of. A search pattern that does not fit is a grammar, not a search pattern.
 */
export const MAX_PATTERN_CHARS = 500;

/**
 * Cap on the product of every counted repeat's upper bound (`a{3}` contributes 3, `a{2,50}`
 * contributes 50; `a*`/`a+`/`a{2,}` contribute nothing here — rules 1–3 govern those).
 *
 * The product, not the maximum: `(?:a{200}){100}` is two innocent-looking counts that together
 * demand twenty thousand character comparisons per start position, twice the cap.
 */
export const MAX_REPEAT_PRODUCT = 10_000;

/**
 * The line length the cost model assumes, which is the range it gives an unbounded repeat: no
 * repeat can stop at more lengths than the text it runs against has characters.
 *
 * Equal to `MAX_LINE_SCAN_CHARS` in `searchMatch.ts` — a unit test pins the two together — but
 * its own constant rather than an import, so this module's bound does not depend on the import
 * graph of the module that runs the matches.
 */
export const ANALYZED_LINE_CHARS = 2000;

/**
 * Cap on how many times any one piece may be entered per starting position (rule 2): the
 * product of the factors of the open choice points it can trade input with.
 *
 * Twice the line cap: one unbounded repeat that can trade input with what follows it (`.*a`,
 * `.+foo`, `\S*b` — 2000) is allowed, with room for a factor of two besides (`.*a?b`,
 * `.*(fig|figure):`), and nothing more. Two unbounded repeats on one chain are 2000 × 2000 and
 * refused — anchored with `^` or not, since this counts options at ONE starting position; so is
 * one unbounded repeat with an alternation of three beside it, and so are two counted repeats
 * of range 64. Written-out text between two repeats lowers the first one's factor (rule 2 in
 * the header): `.*\\label\{[^}]*` enters `[^}]*` 286 times, not 2000. This counts OPTIONS only
 * — what each costs is rule 3's {@link MAX_CHAIN_WORK}.
 */
export const MAX_AMBIGUITY_PRODUCT = 2 * ANALYZED_LINE_CHARS;

/**
 * Cap on the estimated weighted steps one starting position may cost (rule 3): a single pass
 * over the line, plus, for every piece re-entered by an open choice point, the piece's own cost
 * times the number of times it is entered. The unit is one iteration of a COUNTED loop
 * (`a{19}`), the costliest step V8 takes per character; see {@link GREEDY_STEP} and
 * {@link TEXT_STEP} for the cheaper ones.
 *
 * Twenty times the line cap: one unbounded repeat followed by a counted run of nineteen
 * characters it can also match (`.*a{19}b`), or by about seventy-six written-out letters
 * (`.*\\includegraphics\[width=` is twenty), or a choice of two and half that. It is a budget
 * per LINE, spread over the starting positions that can be costly: a pattern that begins with
 * `^` has one, and may spend the whole line's budget there; one that begins with written-out
 * text has one per place that text can occur. Where the figure lands in time is measured, not
 * derived: the costliest accepted families take 1 to 1.7 times what `\w*\w{19}!` does on one
 * adversarial 2000-character line (0.13-0.3s), and the slowest accepted patterns known about 2
 * to 3 times (0.3-0.45s, more under load) — see the header, which says why that is the worst
 * found rather than a bound.
 */
export const MAX_CHAIN_WORK = 20 * ANALYZED_LINE_CHARS;

/**
 * Rule 3's weight for one written-out letter — an unquantified character, class or escape.
 * V8 compiles a run of them into one text node it checks several characters per load, and a
 * mismatch at either end fails the whole run in one check: `.*` then 400 written-out `a`s then
 * `b` took 3ms on a line of `a`s where `.*a{400}b` took 1.6s. Measured per letter it is a tenth
 * of a counted iteration or less (a twenty-fifth for plain characters); a quarter is charged,
 * which keeps a run mismatching in its MIDDLE after a many-way chain (`.{0,62}.{0,62}` then
 * `\w{6}\s\w{29}`, 72ms) inside the measured worst case.
 */
export const TEXT_STEP = 1 / 4;

/**
 * Rule 3's weight for one character of a plain greedy repeat of one atom (`x*`, `[^}]+`), which
 * V8 runs as a tight loop with no counter. Measured at a quarter to a third of a counted
 * iteration per character stepped, forward or back (`.*a.*b` against `.*a.{0,1999}b`, and
 * against `.*a{19}b`'s cost per iteration). A repeat with a larger minimum (`x{5,}`) keeps a
 * count, measured as costly as `{n,m}`, and is charged a full step.
 */
export const GREEDY_STEP = 1 / 4;

export interface SearchMatcherOptions {
  /** Treat the pattern as a JS regular expression. Default false — the pattern is literal text. */
  regex?: boolean;
  /** Match without regard to case (the `i` flag). Default false. */
  caseInsensitive?: boolean;
}

/**
 * Escape every regex metacharacter, so a literal pattern matches itself and nothing else.
 *
 * This is why `regex: false` is the tool's DEFAULT: the patterns it exists for
 * (`\Cref{tab:sota}`, `\mymethod\xspace`, `50\%`) are backslash- and brace-dense, and each is
 * either a broken regex or — worse — a valid one that quietly means something else.
 */
export function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile a caller's pattern into the matcher `search_files` runs, or throw.
 *
 * The `g` flag is always set: the search walks every occurrence on a line itself, with its own
 * zero-length-match advance, so nothing downstream may depend on a sticky or one-shot regex.
 */
export function buildSearchMatcher(pattern: string, opts: SearchMatcherOptions = {}): RegExp {
  if (pattern === '') {
    throw new UnsafePatternError(
      'pattern must not be empty — an empty pattern matches every line of every file, which is ' +
        'list_files, not a search.',
    );
  }
  if (pattern.length > MAX_PATTERN_CHARS) {
    throw new UnsafePatternError(
      `pattern is ${pattern.length} characters, over the ${MAX_PATTERN_CHARS}-character limit. ` +
        'That limit is what bounds how much backtracking one pattern can ask for; split the ' +
        'search into several calls.',
    );
  }
  const source = opts.regex ? pattern : escapeLiteral(pattern);
  const flags = opts.caseInsensitive ? 'gi' : 'g';
  let matcher: RegExp;
  try {
    matcher = new RegExp(source, flags);
  } catch (err) {
    throw new UnsafePatternError(
      `"${pattern}" is not a valid regular expression ` +
        `(${err instanceof Error ? err.message : String(err)}). Pass regex: false (the default) ` +
        'to search for it as literal text.',
    );
  }
  // Run on every pattern, literal ones included, so there is exactly one path into the analyzer
  // and no "trusted" mode to drift out of step with it. An escaped literal carries no
  // quantifiers, so it always passes — a property of the input, not an exemption in the code.
  assertLinearishRegex(source, { ignoreCase: opts.caseInsensitive });
  return matcher;
}

/* ------------------------------------------------------------------ the analyzer */

/**
 * Verify a regex source against the rules above, throwing {@link UnsafePatternError} naming the
 * construct that failed. Exported for the unit tests, which pin each rule against a pattern that
 * really does explode.
 *
 * Call it only on a source `new RegExp` has already accepted: it reads the source structurally
 * and leaves "nothing to repeat", unclosed groups and the like to V8.
 */
export function assertLinearishRegex(source: string, opts: { ignoreCase?: boolean } = {}): void {
  new RegexSafetyScanner(source, opts.ignoreCase ?? false).run();
}

/**
 * A choice point: a variable repeat, or an alternation more than one of whose branches can
 * match at the same place.
 */
interface ChoicePoint {
  id: number;
  /** How many ways it can go: lengths it can stop at, or branches it can take. Always > 1. */
  range: number;
  /**
   * The single-character atom it repeats, for the overlap test — or null when that is not one
   * atom (a repeated group, an alternation), which the overlap test reads as "overlaps anything".
   */
  src: string | null;
  /** How the refusal names it. */
  label: string;
  /** Where it starts in the source, for a refusal that has to tell two same-looking ones apart. */
  at: number;
  /**
   * How many times, per attempt of the sequence that last judged it, the engine stands at one of
   * its stops — its own options times how often it was entered. Set by {@link
   * RegexSafetyScanner.chain} when a group body hands it outward, so the enclosing sequence can
   * scale it by how often it enters the group. Unset means "entered once": its range.
   */
  reach?: number;
  /**
   * How the item carrying it was entered, handed outward with {@link reach} so the enclosing
   * sequence can tell how many of those runs converge — see {@link Convergence} and the
   * converging-paths rule of {@link RegexSafetyScanner.chain}. Unset means entered once.
   */
  converge?: Convergence;
  /** Inside a lookaround, where a `.*` is part of what is asserted and cannot simply be dropped. */
  inLook: boolean;
}

/**
 * How a choice point's item came to be entered more than once, as far as converging paths go:
 * the floor it was entered under (`carried`, with the choice points that set it), and the
 * choice points that re-entered it with the factor each one contributed (`by`).
 */
interface Convergence {
  carried: number;
  carriedBy: ChoicePoint[];
  by: Array<[ChoicePoint, number]>;
}

/**
 * What a quantified atom, a sequence or a whole disjunction contributes to what surrounds it.
 * The same shape at every level, which is what lets a group be judged like any other atom.
 */
interface Piece {
  /**
   * Sources of the single-character atoms that can consume its FIRST character (through any
   * prefix that need not consume); null when that cannot be said (a backreference, a
   * lookbehind), which the overlap test reads as "overlaps anything".
   */
  first: string[] | null;
  /** Can match the empty string. */
  nullable: boolean;
  /**
   * Cannot fail wherever it is tried: every piece in it has a zero minimum (`x*`, `(?:ab)?`).
   * An assertion, a lookaround or a backreference can fail, so none of them is.
   */
  infallible: boolean;
  /**
   * The choice points still OPEN at its end: those whose overlapping chain nothing inside it
   * has cut — so they trade input with whatever follows the piece. This is what a group has to
   * report outward, or `(?:a*)a*b` reads as one repeat where it is two.
   */
  open: ChoicePoint[];
  /** Exactly one way to match, of one fixed width: what rule 1 lets be repeated. */
  rigid: boolean;
  /** The most characters one attempt of it can consume, at most {@link ANALYZED_LINE_CHARS}. */
  width: number;
  /**
   * Rule 3's first half: the weighted steps ONE attempt of it takes before anything backtracks
   * into it — at most {@link ANALYZED_LINE_CHARS}.
   */
  pass: number;
  /**
   * Rule 3's second half: the weighted steps spent re-running parts of it once per option of a
   * choice point inside it that they overlap. Unbounded by the line: this is the multiplied part.
   */
  retry: number;
  /**
   * Rule 2: the most times any one piece inside it is entered per attempt of it — the product of
   * the options of the choice points that re-run that piece. 1 when nothing inside is re-run.
   */
  peak: number;
  /** The choice points whose options multiply out to {@link peak}, for the refusal to name. */
  peakBy: ChoicePoint[];
  /**
   * Rule 3: the weighted steps ONE arrival at it costs when it can take none of what lies ahead
   * — it fails on its first check, or (when nullable) matches nothing and hands the arrival on.
   * A nullable piece is ARRIVED AT once per stop of every open choice point before it, whether or
   * not it overlaps them, and that is what this prices (see {@link RegexSafetyScanner.chain}).
   */
  entry: number;
  /**
   * The part of {@link pass} + {@link retry} spent in plain greedy loops charged at
   * {@link GREEDY_STEP}: what a quantified group that saves registers per iteration re-prices at
   * a full step (see {@link RegexSafetyScanner.quantified}).
   */
  greedy: number;
  /**
   * The converging-paths floor its END hands on (see {@link RegexSafetyScanner.chain}): how many
   * times, at least, whatever follows it is entered per attempt of it, and the bounded choice
   * points that set that. Only a group's body sets one — its runs converge inside it and hand on
   * past the `)` — and a lookaround's never leaves it, since the engine does not backtrack into
   * one. Unset means 1.
   */
  carried?: number;
  carriedBy?: ChoicePoint[];
  /**
   * A group body's items, one list per alternative, for the converging-paths test of the
   * sequence AROUND it: a bounded choice point before the group that re-enters it converges
   * inside it when a repeat in there can make up the difference and is closed there — and, when
   * every alternative forces that choice point's edge, it closes there as well. Set for every
   * group (one list for each of its alternatives, none left out); unset for a lookaround, which
   * the engine never backtracks into. See {@link AbsorbStep}.
   */
  absorb?: AbsorbStep[][];
}

/**
 * One item of a group body, as the sequence around the group sees it for converging paths: what
 * it can start with, whether it can match nothing, what each piece that closed one of the choice
 * points it opened (its own, or those a group inside it handed out) can start with, and — for a
 * group — its own body's items.
 */
interface AbsorbStep {
  first: string[] | null;
  nullable: boolean;
  closedBy: Array<string[] | null>;
  inner?: AbsorbStep[][];
}

/** One parsed atom before its quantifier: its piece, and what kind of thing it is. */
interface Atom {
  piece: Piece;
  /** A `( ... )` of any kind, lookarounds included. */
  group: boolean;
  /** A single-character atom (a character, class or escape) the overlap test can compile. */
  single: boolean;
  /** `^`: with no `m` flag (the search never sets one), the start of the line and nothing else. */
  anchor?: boolean;
  /** Consumes nothing: `^`, `$`, `\b`, `\B` or a lookaround. */
  zeroWidth?: boolean;
  /**
   * A group (not a lookaround) that captures, holds a capture, or can match nothing: quantified,
   * V8 saves and restores its registers — or runs its empty check — at every character a greedy
   * loop inside it gives back. See {@link RegexSafetyScanner.quantified}.
   */
  loopHeavy?: boolean;
}

/** One quantified atom in a sequence, as {@link RegexSafetyScanner.chain} judges it. */
interface Item {
  piece: Piece;
  /** As written, quantifier included. */
  label: string;
  /** The atom's source when it is an UNQUANTIFIED single-character atom: one letter of text. */
  text: string | null;
  /** The atom's source when it is a QUANTIFIED single-character atom (`x*`, `[a-z]{2,5}`). */
  repeated: string | null;
  /** The choice point its own quantifier makes, if the quantifier leaves more than one option. */
  own: ChoicePoint | null;
  /** The atom's piece when its quantifier is exactly `?` (`{0,1}`), for {@link RegexSafetyScanner.chain}. */
  optionalOf: Piece | null;
  /** An unquantified `^`. */
  anchor: boolean;
  /**
   * Consumes nothing (`^`, `$`, `\b`, `\B`, a lookaround), so it neither extends nor ends a run of
   * written-out letters: the letters either side of it still have to occur side by side.
   */
  zeroWidth: boolean;
  /** Where it starts in the source. */
  at: number;
}

interface Quantifier {
  min: number;
  /** `Infinity` for `*`, `+` and `{n,}`. */
  max: number;
}

/**
 * Every character `\s` matches (ECMAScript WhiteSpace and LineTerminator), and the four `.`
 * does NOT match. Class escapes are the one source of set boundaries a pattern's text does not
 * spell out, so their boundaries have to be supplied: without them `\s` and `[^\x00-\x7f]`
 * looked disjoint — every test character was ASCII or a letter — and `\s*[^\x00-\x7f]` chained
 * three times was accepted, an n^4 pattern (16.8s on 480 characters of U+00A0).
 */
const CLASS_ESCAPE_POINTS = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005,
  0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
];

/**
 * Characters every overlap test tries, before the pattern's own are added: EVERY code unit up to
 * U+0100 — all of ASCII (where `\w`, `\d` and their negations begin and end) and every character
 * an octal, `\xXX` or `\cX` escape can name, spelled however the pattern spells it (`\01`,
 * `[\c1]`, `\377`) — the class-escape points and one either side of each, the ends of the
 * code-unit range, and two non-ASCII letters. See {@link sample}.
 */
const BASE_SAMPLE: readonly number[] = (() => {
  const codes = new Set<number>([0xd800, 0xdfff, 0xffff]);
  for (let c = 0x00; c <= 0x100; c++) codes.add(c);
  for (const c of CLASS_ESCAPE_POINTS) for (const d of [c - 1, c, c + 1]) codes.add(d);
  codes.add('é'.charCodeAt(0));
  codes.add('中'.charCodeAt(0));
  return [...codes];
})();

/**
 * How many letters of a written-out run {@link RegexSafetyScanner.period} looks at. Occurrences
 * of a run are a subset of the occurrences of its first letters, so a period taken over a
 * prefix still bounds how often the whole run can occur — it only ever under-credits a longer
 * run, never over-credits it. Bounds the analyzer's own work (a quadratic scan per run).
 */
const MAX_PERIOD_LETTERS = 64;

/** Where a sequence's still-open choice points go when it ends. */
type SequenceEnd = 'top' | 'group' | 'lookaround';

/** The costliest single re-run rule 3 charged, kept so a refusal can name it. */
interface Charge {
  charge: number;
  /** The piece that is re-run, as written. */
  label: string;
  /** Where it starts in the source. */
  at: number;
  /** How many times it is entered: the product of its multipliers' factors. */
  entries: number;
  /** Weighted steps per entry. */
  each: number;
  multipliers: ChoicePoint[];
  /**
   * `rerun` when the piece runs in full at each entry (it can take what a multiplier gave back);
   * `arrival` when it is merely ARRIVED AT once per stop of the open choice points and fails, or
   * matches nothing, on its first check.
   */
  kind: 'rerun' | 'arrival';
}

/** A closed capturing group, as a backreference to it sees it. */
interface Capture {
  first: string[] | null;
  width: number;
}

class RegexSafetyScanner {
  private i = 0;
  private repeatProduct = 1;
  private nextId = 0;
  private readonly alphabet: string[];
  private heaviest: Charge | undefined;
  /**
   * The costliest piece that is NOT re-entered, for the refusal to name when no re-run is what
   * tipped the total (lookarounds and alternatives each run in full, and add up).
   */
  private largest: { cost: number; label: string } | undefined;
  private readonly matchSets = new Map<string, Uint32Array | null>();
  /** Capturing groups opened so far — the number the next one gets is this plus one. */
  private captureCount = 0;
  /** Capturing groups already CLOSED, by number and by name, for backreferences to them. */
  private readonly captures = new Map<number | string, Capture>();
  /** How many starting positions of a line can be costly, one entry per top-level alternative. */
  private readonly topStarts: number[] = [];
  /**
   * Capturing groups in the WHOLE pattern: without the `u` flag, `\N` is a backreference only
   * when N is at most this, and an octal escape or a digit otherwise.
   */
  private readonly totalCaptures: number;
  /**
   * Whether the sequence being parsed is matched RIGHT TO LEFT — the body of a lookbehind, which
   * V8 runs backwards from the current position, last item first. A nested lookahead runs
   * forwards again. See {@link alternative}.
   */
  private backward = false;
  /** How many lookarounds the scan is inside — what a refusal's advice has to know. */
  private lookDepth = 0;
  /**
   * Choice points that set a converging-paths floor somewhere (see {@link chain}): a refusal that
   * names one has to say why a repeat that overlaps nothing after it still multiplies it.
   */
  private readonly converged = new Set<number>();
  /** Which pairs of atoms {@link overlaps} has already decided. */
  private readonly overlapCache = new Map<string, Map<string, boolean>>();

  constructor(
    private readonly src: string,
    private readonly ignoreCase: boolean,
  ) {
    this.alphabet = sample(src, ignoreCase);
    this.totalCaptures = countCaptures(src);
  }

  run(): void {
    const { piece: top } = this.disjunction('top');
    if (this.i < this.src.length) {
      // Only reachable on a stray `)`, which `new RegExp` rejects — the fail-closed arm.
      this.refuse('it contains a group that could not be parsed');
    }
    if (top.peak > MAX_AMBIGUITY_PRODUCT) {
      const named = quoted(
        [...new Map(top.peakBy.map((c) => [c.id, c])).values()].sort((a, b) => a.id - b.id),
      );
      const shown = named.length > 4 ? [...named.slice(0, 4), '…'] : named;
      this.refuse(
        `its repeats can split one ${ANALYZED_LINE_CHARS}-character line about ` +
          `${formatCount(top.peak)} ways per starting position (${shown.join(', ')}), where at ` +
          `most ${MAX_AMBIGUITY_PRODUCT} are allowed — each repeat or alternation that can also ` +
          'match what follows it multiplies how many ways the engine must try, and `.*a.*b` ' +
          `already takes seconds on one line.${convergeGap(this.convergeNote(top.peakBy))} Anchor each ` +
          'repeat to something it cannot itself match (`[^}]*\\}` rather than `.*\\}`), or ' +
          `${dropAdvice(top.peakBy)}`,
      );
    }
    const n = ANALYZED_LINE_CHARS;
    // Rule 3 is a budget for the whole line: a pattern that can only be costly at a few
    // starting positions may spend more at each of them.
    const starts = this.topStarts.length === 1 ? (this.topStarts[0] ?? n) : n;
    const allowed = MAX_CHAIN_WORK * (n / starts);
    const work = top.pass + top.retry;
    if (work > allowed) {
      const h = this.heaviest;
      const names = h ? quoted([h, ...h.multipliers]) : [];
      const by = names.slice(1);
      const byShown = by.length > 4 ? [...by.slice(0, 4), '…'] : by;
      const why = !h
        ? `\`${this.largest?.label ?? this.src}\` and the pieces around it add up — each ` +
          'lookaround and each branch of an alternation runs in full where it is reached'
        : h.kind === 'arrival'
          ? `${names[0]} can match nothing, so it settles none of the repeats before it and is ` +
            `entered at each of the ${formatCount(h.entries)} places ${byShown.join(' and ')} ` +
            `can stop, at ${formatCount(h.each)} steps each time`
          : `${names[0]} is matched again at each of the ${formatCount(h.entries)} places ` +
            `${byShown.join(' and ')} can stop, and can take ` +
            `${formatCount(h.each)} steps each time`;
      const scope =
        starts < ANALYZED_LINE_CHARS
          ? ` (it can be costly at no more than ${formatCount(starts)} of them)`
          : '';
      const note = this.convergeNote(h?.multipliers ?? []);
      const advice =
        h?.kind === 'arrival'
          ? 'Every piece that can match nothing is entered once per way the repeats before it ' +
            'can split the line, and `x{0,75}x*a*b*c*d*\\}` takes seconds on one line. Split ' +
            'the line fewer ways before it: `x*` matches what `x{0,75}x*` does at a 76th of the ' +
            'splits. Making such a piece required (`\\d+` rather than `\\d*`, or dropping the ' +
            '`?`) or merging several into one class (`[\\s,;]*` rather than `\\s*,?;?`) helps ' +
            'less: that piece, or what follows it, is still entered once per split'
          : (note ? `${note} ` : '') +
            'A long run after a repeat that can also match it is re-matched once per place the ' +
            'repeat can stop, and `.*a{999}b` takes seconds on one line. Anchor the repeat to ' +
            `something the run cannot start with, shorten the run, or ${dropAdvice(h?.multipliers ?? [], 'leading')}`;
      this.refuse(
        `${why} — about ${formatCount(work)} steps per starting position on one ` +
          `${ANALYZED_LINE_CHARS}-character line${scope}, where at most ` +
          `${formatCount(allowed)} are allowed. ${advice}`,
      );
    }
  }

  /**
   * The sentence a refusal adds when a converging-paths floor is part of the count it reports:
   * without it, "`x{0,30}` can stop" reads as a claim that `x{0,30}` overlaps what follows.
   */
  private convergeNote(named: ReadonlyArray<ChoicePoint>): string {
    if (!named.some((c) => this.converged.has(c.id))) return '';
    return (
      'A repeat that cannot match what follows it still multiplies it when a longer repeat ' +
      'after it can make up the difference: in `x{0,30}x*a+`, `x*` runs to the same place from ' +
      'each of the 31 places `x{0,30}` stops, and `a+` runs in full after every one of them; ' +
      '`x*` alone matches the same text with one run.'
    );
  }

  /**
   * `a|b|c` — every alternative judged on its own, then merged. When more than one branch can
   * start at the same place (their first characters overlap, or one can match nothing), the
   * alternation is itself a choice point with one option per branch.
   */
  private disjunction(end: SequenceEnd): { piece: Piece; choice: ChoicePoint | null } {
    const alts: Piece[] = [];
    for (;;) {
      alts.push(this.alternative(end));
      if (this.src[this.i] === '|') {
        this.i++;
        continue;
      }
      break;
    }
    let first: string[] | null = [];
    for (const alt of alts) {
      first = first === null || alt.first === null ? null : [...first, ...alt.first];
    }
    // Every branch may be tried at one position, so all of their work counts; only the
    // longest one's consumption is a pass over the line, the others' is spent and given back.
    const longest = Math.max(...alts.map((a) => a.pass));
    const peakAlt = alts.reduce((best, a) => (a.peak > best.peak ? a : best));
    // Every branch's runs reach what follows the group, so the floor is at least the largest.
    const floorAlt = alts.reduce((best, a) => ((a.carried ?? 1) > (best.carried ?? 1) ? a : best));
    const piece: Piece = {
      first,
      nullable: alts.some((a) => a.nullable),
      // One branch that cannot fail is enough: the engine reaches it if the others fail.
      infallible: alts.some((a) => a.infallible),
      open: alts.flatMap((a) => a.open),
      rigid: alts.length === 1 && alts.every((a) => a.rigid),
      width: Math.max(...alts.map((a) => a.width)),
      pass: longest,
      retry: alts.reduce((n, a) => n + a.retry + a.pass, 0) - longest,
      peak: peakAlt.peak,
      peakBy: peakAlt.peakBy,
      // An arrival tries every branch in turn when each fails on its first check.
      entry: alts.reduce((n, a) => n + a.entry, 0),
      greedy: alts.reduce((n, a) => n + a.greedy, 0),
      carried: floorAlt.carried,
      carriedBy: floorAlt.carriedBy,
      absorb: alts.flatMap((a) => a.absorb ?? []),
    };
    let choice: ChoicePoint | null = null;
    if (alts.length > 1 && this.branchesOverlap(alts)) {
      choice = this.choicePoint(alts.length, null, 'an alternation', 0);
      piece.open.push(choice);
    }
    return { piece, choice };
  }

  /** Whether two branches can both start at one place — the alternation is then a choice. */
  private branchesOverlap(alts: Piece[]): boolean {
    for (const [k, a] of alts.entries()) {
      for (const b of alts.slice(k + 1)) {
        if (a.nullable || b.nullable) return true;
        if (this.setsOverlap(a.first, b.first)) return true;
      }
    }
    return false;
  }

  /**
   * One alternative: parse the quantified atoms between two `|`s, then judge them in the order
   * the engine MATCHES them.
   *
   * That is source order, except in a lookbehind: V8 runs a lookbehind's body right to left,
   * starting from the current position, so its LAST item is tried first and a greedy repeat
   * there grows leftwards. Judged in source order, `(?<=b.*a.*)` read as one repeat and a
   * trailing `.*` that cannot fail — where V8 runs it as `.*a.*b` backwards, at every starting
   * position (2s), and `(?<=b.*a.*.*)` for over a minute. Matching a body backwards against the
   * text is matching the reversed body forwards against the reversed text, step for step, so
   * reversing the items is all it takes for every rule below — choice points, what can follow
   * what, written-out runs, the trailing run that cannot fail — to follow V8's real order.
   */
  private alternative(end: SequenceEnd): Piece {
    const items: Item[] = [];
    while (this.i < this.src.length && this.src[this.i] !== '|' && this.src[this.i] !== ')') {
      const start = this.i;
      const atom = this.atom();
      const atomSrc = this.src.slice(start, this.i);
      const quant = this.quantifier();
      const label = this.src.slice(start, this.i);
      const { piece, own } = this.quantified(atom, atomSrc, quant, label, start);
      items.push({
        piece,
        label,
        text: atom.single && !quant ? atomSrc : null,
        repeated: atom.single && quant ? atomSrc : null,
        own,
        optionalOf: quant && quant.min === 0 && quant.max === 1 ? atom.piece : null,
        anchor: atom.anchor === true && !quant,
        zeroWidth: atom.zeroWidth === true,
        at: start,
      });
    }
    // The top level is never inside a lookbehind, so its items are always in source order.
    if (end === 'top') this.topStarts.push(this.costlyStarts(items));
    return this.chain(this.backward ? items.reverse() : items, end);
  }

  /**
   * How many starting positions of one line can cost a full attempt: one for a pattern that
   * begins with `^` (no `m` flag is ever set, so it can match only at the start, and V8 tries
   * nowhere else); at most one per occurrence of a written-out run the pattern begins with
   * (anywhere else the attempt fails on that run's letters); every position otherwise.
   *
   * A `\b`, `\B` or `$` inside that run is looked past: it consumes nothing and costs nothing,
   * so the attempt still fails on the run's letters wherever the run does not occur. A
   * lookaround is not looked past — its body runs BEFORE the letters after it are tried, at
   * every position.
   */
  private costlyStarts(items: Item[]): number {
    if (items[0]?.anchor) return 1;
    const lead: string[] = [];
    for (const item of items) {
      if (item.zeroWidth && item.own === null && item.piece.pass + item.piece.retry === 0) {
        continue;
      }
      if (item.text === null) break;
      lead.push(item.text);
    }
    if (lead.length === 0) return ANALYZED_LINE_CHARS;
    return Math.ceil(ANALYZED_LINE_CHARS / this.period(lead));
  }

  /**
   * One alternative's quantified atoms, judged for rules 2 and 3 in the order the engine
   * matches them — reversed inside a lookbehind (see {@link alternative}), so "before" and
   * "after" below mean before and after in MATCHING order.
   *
   * The scan keeps the choice points that are still OPEN — whose right edge nothing yet has
   * forced — and tests each new piece against them:
   *
   *  - **The piece can match a character an open choice point matches**: it is re-entered once
   *    per option of that choice point, which stays open, because the piece consumed characters
   *    it could have taken, so the chain goes on (`.*a\w+\s`: `.*`, then `a`, then `\w+`, all on
   *    one chain — 4.3s).
   *  - **It cannot, and must consume a character**: that choice point's edge is forced, and it
   *    closes. This is why `\w+\s+\w+` (4ms) is accepted where `a+a+b` is not. Closing is not
   *    free, though, when paths CONVERGE: if the item carrying that choice point was itself
   *    re-entered once per stop of a BOUNDED choice point the piece also closes (`x*` after
   *    `x{0,30}`), each of those runs ends where the piece forces it to and hands on, so the
   *    piece is entered once per run. That count — the product of the closed bounded factors
   *    that re-entered it, times the floor it was itself entered under — becomes a FLOOR that
   *    multiplies this piece and every one after it (`carried`). Only a choice point this piece
   *    CLOSES counts: one it overlaps stays open, and its runs end apart. A group's body is
   *    judged on its own, and hands outward how its open choice points were entered ({@link
   *    Convergence}), the floor it reached ({@link Piece.carried}) and what its items start with
   *    ({@link Piece.absorb}), so that the floor comes out as it would for the same items
   *    written without the group. Unbounded factors never set the floor: see rule 2 in the
   *    header for why, and what that leaves.
   *  - **It cannot, but need not consume anything** (`b?`, `\s*` before a non-space): it settles
   *    nothing, and the choice point stays open past it — `a*b?a*c` (3.0s) is caught by the
   *    `a*` two atoms further on.
   *
   * How many times a piece is re-entered is the product of its multipliers' FACTORS, and a
   * factor is a choice point's range except where written-out text caps it:
   *
   *  - **A run's period.** A repeat followed directly by a run of written-out letters
   *    (`.*\\label\{`) goes on to anything past the run only where the run occurs, and a run
   *    whose shortest self-overlap is `p` occurs at most once per `p` characters. So past the
   *    run, that repeat's factor is at most the line length over `p`: 2000 for `.*a`, 286 for
   *    `.*\\label\{`. That does not make a cubic chain linear — `.*\\label\{[^}]*\}` is still
   *    cubic over seven (0.2-0.6s) and still refused — but together with the costly starting
   *    positions rule 3 counts, it accepts `\\section\{.*\\label\{[^}]*\}` (8ms). An item that
   *    consumes nothing (`\b`, `\B`, `^`, `$`, a lookaround) neither ends a run nor starts one:
   *    the letters either side of it must still sit side by side, so `[^}]*\bsmith\b` is pinned
   *    by `smith` exactly as `[^}]*smith` is.
   *  - **A bridge.** A repeat of one atom right after a run, that can take neither the run's
   *    last letter nor the first letter of the run after it (`\s*` in `.*\}\s*\\cite\{`), has one
   *    length that gets past the second run for each place the first run starts — it must end
   *    where its characters end — and no two places share it, since a second `}` inside the
   *    whitespace would be a character `\s` cannot take. So the repeat pinned by the first run
   *    is pinned by the second run's period too: `\\label\{.*\}\s*\\cite\{[^}]*\}` re-enters
   *    `[^}]*` once per `\cite{` (334), not once per `}` (2000) — 0.4ms, where the cap alone
   *    refused it. Bridges chain: each one's repeats carry on through the next.
   *  - **A fence.** When a repeat of one atom follows such a run and the run contains a letter
   *    that atom cannot match, the repeat's runs from different occurrences cannot overlap —
   *    each stops before the next occurrence's fence letter. Across every option of the repeat
   *    before the run, it then covers the line about `w` times in all, `w` being how far the
   *    fence sits from the run's end (1 for `.*\\label\{fig:[a-z_]+`, where `:` fences
   *    `[a-z_]`), instead of once per option: quadratic, not cubic. It is still STARTED once
   *    per option, so the credit is the options plus `w` lines, never less — which is no credit
   *    at all for a repeat of a letter or two (`a+\w\{?`); see {@link factor}.
   *
   * The caps apply only to the choice point of the quantified atom directly before the run
   * (and, through a bridge, to those pinned before it), whose right edge the run pins; the
   * repeats inside a group before it are left uncapped, since several of them can end at one
   * place, and leaving them uncapped only ever over-counts.
   *
   * Whatever is still open at the end goes on to the enclosing sequence when this one is a
   * group's body (the group's continuation is outside it). At the top level, or at the end of
   * a lookaround body (which JS never backtracks into), nothing after can fail: a trailing run
   * of pieces that cannot fail (`.*`, `\s*`, `(?:ab)?`) is reached once and succeeds, so it is
   * charged once and multiplies nothing — which is why `.*TODO.*` costs what `.*TODO` does.
   * "Trailing" is in matching order: in a lookbehind, the run a caller WROTE last is tried
   * first, and the credit goes to what they wrote first (`(?<=.*b)`).
   */
  private chain(items: Item[], end: SequenceEnd): Piece {
    const n = ANALYZED_LINE_CHARS;
    let suffix = items.length;
    if (end !== 'group') {
      while (suffix > 0 && items[suffix - 1]?.piece.infallible) suffix--;
    }

    let first: string[] | null = [];
    let firstSettled = false;
    let nullable = true;
    let infallible = true;
    let rigid = true;
    let open: ChoicePoint[] = [];
    let width = 0;
    let pass = 0;
    let retry = 0;
    let peak = 1;
    let peakBy: ChoicePoint[] = [];
    /** Choice point id → its factor's cap past the run that followed it. */
    const caps = new Map<number, number>();
    /** Fenced repeat's choice point id → (choice point it is fenced from → `w`). */
    const fences = new Map<number, Map<number, number>>();
    /** The run of written-out letters ending at the previous item, and the repeat before it. */
    let run: string[] = [];
    let runAfter: ChoicePoint | null = null;
    /** Repeats further back whose edge the current run pins too, through a bridge (below). */
    let runOuters: ChoicePoint[] = [];
    /**
     * A BRIDGE the previous consuming item opened: a repeat of one atom right after a run, which
     * matches neither that run's last letter nor — checked when it arrives — the first letter of
     * the run after it. Then `.*\}\s*\\cite\{` gets past `\cite{` at most once per `\cite{`:
     * where `.*` stops fixes where `}` is, `\s*` must end exactly where the whitespace after it
     * ends (it can take neither the `}` nor the `\`), so each stop leads to ONE `\cite{`, and no
     * two stops to the same one. The repeats pinned by the first run are then pinned by the
     * second run's period as well.
     */
    let bridge: { outers: ChoicePoint[]; atom: string } | null = null;
    /** The choice point of the last item that CONSUMES something (zero-width ones are skipped). */
    let lastOwn: ChoicePoint | null = null;
    let entry = 0;
    let entrySettled = false;
    let greedy = 0;
    /**
     * For each choice point that went into `open` here: how many times the item carrying it was
     * entered, and whether it is that item's OWN quantifier (whose factor a later run can cap).
     */
    const entered = new Map<number, { times: number; own: boolean; converge: Convergence }>();
    /**
     * The converging-paths floor: how many times, at least, every piece from here on is
     * entered, and the bounded choice points that set it. See the rule in this method's doc.
     */
    let carried = 1;
    let carriedBy: ChoicePoint[] = [];
    /** Choice point id → what the piece that closed it can start with (a group's summary). */
    const closedAt = new Map<number, string[] | null>();
    const steps: AbsorbStep[] = [];
    /** For each step, the choice points its item opened. */
    const opened: ChoicePoint[][] = [];
    const base = (c: ChoicePoint): number => Math.min(c.range, caps.get(c.id) ?? Infinity);
    /** How many times per attempt of this sequence the engine stands at one of `c`'s stops. */
    const reachOf = (c: ChoicePoint): number => {
      const e = entered.get(c.id);
      if (!e) return c.reach ?? c.range;
      return e.times * (e.own ? base(c) : (c.reach ?? c.range));
    };

    /**
     * What can consume the first character after each item, in matching order: the union of
     * the first sets up to and including the next piece that must consume. `undefined` when the
     * sequence ends first — what follows lies outside it and is not known here.
     */
    const follow: Array<string[] | null | undefined> = [];
    let after: string[] | null | undefined = undefined;
    for (let k = items.length - 1; k >= 0; k--) {
      follow[k] = after;
      const p = items[k]?.piece;
      if (!p) continue;
      if (!p.nullable) after = p.first;
      else if (after !== undefined) {
        after = after === null || p.first === null ? null : [...p.first, ...after];
      }
    }

    for (const [k, item] of items.entries()) {
      let piece = item.piece;
      let own = item.own;
      // An optional piece that must consume, and cannot start with a character that what follows
      // it can (`(\[[^\]]*\])?\{`: `[` against `{`), is no choice: at any one place the next
      // character rules out one of its two options on its first check. So it re-runs nothing.
      const opt = item.optionalOf;
      const next = follow[k];
      if (
        own !== null &&
        opt !== null &&
        !opt.nullable &&
        next !== undefined &&
        next !== null &&
        !this.setsOverlap(opt.first, next)
      ) {
        const dropped = own;
        piece = { ...piece, open: piece.open.filter((c) => c !== dropped) };
        own = null;
      }
      let fence: Map<number, number> | null = null;
      if (item.zeroWidth) {
        // Transparent to a run: `[^}]*\bsmith\b` still needs `smith` to start exactly where
        // `[^}]*` stops, so the run still pins that repeat's edge — the assertion only filters
        // which of those places survive, and filtering never adds one.
      } else {
        const bridgeIn = bridge;
        bridge = null;
        if (item.text !== null) {
          if (run.length === 0) {
            runAfter = lastOwn;
            runOuters = bridgeIn && !this.overlaps(item.text, bridgeIn.atom) ? bridgeIn.outers : [];
          }
          run.push(item.text);
        } else {
          if (run.length > 0) {
            const cap = Math.ceil(n / this.period(run));
            const pinned = runAfter ? [runAfter, ...runOuters] : runOuters;
            for (const cp of pinned) caps.set(cp.id, Math.min(caps.get(cp.id) ?? Infinity, cap));
            if (runAfter) {
              const w = item.repeated === null ? null : this.fenceWidth(run, item.repeated);
              if (w !== null) {
                fence = new Map([[runAfter.id, w]]);
                // Through a repeat that is itself fenced: `.*\\ref\{[a-z:_]+\}\s*`. Each
                // character is covered by runs of this repeat from at most `w` places the one
                // before it stopped, and each such place is reached from at most `w2 + 1` stops
                // of the repeat THAT one is fenced from — so, across that earlier repeat's
                // stops, this one still covers the line at most `w × (w2 + 1)` times.
                for (const [m, w2] of fences.get(runAfter.id) ?? []) {
                  const t = w * (w2 + 1);
                  if (t < (fence.get(m) ?? Infinity)) fence.set(m, t);
                }
                if (own) fences.set(own.id, fence);
              }
            }
            const last = run[run.length - 1];
            if (
              pinned.length > 0 &&
              item.repeated !== null &&
              last !== undefined &&
              !this.overlaps(last, item.repeated)
            ) {
              bridge = { outers: pinned, atom: item.repeated };
            }
          }
          run = [];
          runAfter = null;
          runOuters = [];
        }
      }

      const before = open;
      const stillOpen: ChoicePoint[] = [];
      const multipliers: ChoicePoint[] = [];
      for (const prev of open) {
        if (this.setsOverlap(prev.src === null ? null : [prev.src], piece.first)) {
          stillOpen.push(prev);
          multipliers.push(prev);
        } else if (piece.nullable) {
          stillOpen.push(prev);
        }
      }
      open = [...stillOpen, ...piece.open];

      // Converging paths (see this method's doc): every run of an item that a BOUNDED choice
      // point re-entered ends somewhere, and when this piece forces that choice point's edge the
      // runs all hand on to it — so it, and everything after it, is entered at least once per
      // such run, whether or not it overlaps anything. A choice point this piece overlaps stays
      // open and its edge is NOT forced: its runs end at different places, so they set no floor
      // here (`[A-Z]{2,5}.*\\cite` — `.*` goes on past the `\`, and runs 0.1-15ms).
      for (const c of before) {
        if (stillOpen.includes(c)) continue;
        const e = entered.get(c.id);
        if (!e) continue;
        let times = e.converge.carried;
        const sources: ChoicePoint[] = [...e.converge.carriedBy];
        for (const [m, f] of e.converge.by) {
          if (m.range < n && !stillOpen.includes(m)) {
            times *= f;
            sources.push(m);
          }
        }
        if (times > carried) {
          carried = times;
          carriedBy = sources;
        }
      }
      for (const c of before) if (!stillOpen.includes(c)) closedAt.set(c.id, piece.first);

      // A piece in the infallible suffix is reached once: the first arrival is a match.
      let entries = 1;
      const by: Array<[ChoicePoint, number]> = [];
      let floor = 1;
      if (k < suffix) {
        for (const m of multipliers) {
          const f = factor(m, multipliers, caps, fences, fence, piece.width);
          by.push([m, f]);
          entries *= f;
        }
        floor = carried;
        entries *= floor;
      }
      const floorBy = floor > 1 ? carriedBy : [];
      for (const c of floorBy) this.converged.add(c.id);

      for (const c of piece.open) {
        // A choice point handed out of a group brings how ITS item was entered in there.
        const inner = c === own ? undefined : c.converge;
        entered.set(c.id, {
          times: entries,
          own: c === own,
          converge: {
            carried: floor * (inner?.carried ?? 1),
            carriedBy: [...floorBy, ...(inner?.carriedBy ?? [])],
            by: [...by, ...(inner?.by ?? [])],
          },
        });
      }
      // A group whose body set a floor: the runs converging inside it hand on past its `)`, so
      // everything after it is entered that many times for each time the group is — the floor
      // it was entered under. Stopping at the `)` accepted `(x{0,30}x*\{)(y{0,30}y*\{)a+a{4}b`
      // (2.9s), which written without the groups is refused.
      const through = piece.carried ?? 1;
      if (k < suffix && through > 1 && floor * through > carried) {
        carried = floor * through;
        carriedBy = [...floorBy, ...(piece.carriedBy ?? [])];
      }
      // And a bounded choice point before the group that re-enters it can converge INSIDE it:
      // `x{0,40}(?:x*\{)a+a{9}b` is `x{0,40}x*\{a+a{9}b` (1.2s) with a group around `x*\{`, and
      // `x*` closes in there, so no record of it reaches this sequence. The group's items say
      // where the flat spelling finds the floor, and that it forces the edge of that choice point
      // there too (see {@link absorbs}), so the factor counts from here on.
      const absorb = piece.absorb;
      if (k < suffix && absorb !== undefined) {
        let times = floor * through;
        const sources = [...floorBy, ...(piece.carriedBy ?? [])];
        const absorbed: ChoicePoint[] = [];
        // Each of these questions turns on the choice points' atoms alone, and a long run of
        // `x?` asks the same one of a deep group hundreds of times: answer each atom once.
        const memo = new Map<string, boolean>();
        const ask = (key: string, answer: () => boolean): boolean => {
          let known = memo.get(key);
          if (known === undefined) memo.set(key, (known = answer()));
          return known;
        };
        for (const [m, f] of by) {
          if (
            m.range < n &&
            ask(JSON.stringify(['absorbs', m.src]), () =>
              absorb.some((body) => this.absorbs(m, body)),
            )
          ) {
            times *= f;
            sources.push(m);
            absorbed.push(m);
          }
        }
        if (times > carried) {
          carried = times;
          carriedBy = sources;
        }
        // The flat spelling CLOSES such a choice point in there, too — it only stays in `open`
        // because the group, read from outside, can start with what it takes. Left open, it
        // multiplied every later piece it overlaps by the factor just counted into the floor:
        // `\s?(\s*\\cite)(.*\\cite)` came to 2 x 2 x 2000 where `\s?\s*\\cite.*\\cite` is
        // 2 x 2000. So it closes here, as it does written out — only where the group cannot be
        // skipped and every way through it closes it ({@link closedWithin}), and only where this
        // sequence has the whole record of how it was entered: in a group body the enclosing
        // sequence adds to that record through `open`, so there it stays open, and over-counts.
        // Closing it settles its own runs, as the flat spelling's close does: they converge
        // where it closes, with each bounded choice point that re-entered it and is closed by
        // then — before the group, or inside it no later than it ({@link closesFirst}). One
        // that closes further in is still open there, and its runs end apart: counting it
        // anyway refused `[xy]?[xy]{0,2}[x ]?(?:x*y\{)x{0,28}?y*:a+`, which written out is not.
        if (end !== 'group' && !piece.nullable) {
          const closed = absorbed.filter((c) =>
            ask(JSON.stringify(['closedWithin', c.src]), () => this.closedWithin(c, absorb)),
          );
          const stillSet = new Set(stillOpen);
          for (const c of closed) {
            const e = entered.get(c.id);
            if (!e) continue;
            let settled = e.converge.carried;
            const settledBy: ChoicePoint[] = [...e.converge.carriedBy];
            for (const [m, f] of e.converge.by) {
              if (
                m.range < n &&
                (!stillSet.has(m) ||
                  ask(JSON.stringify(['closesFirst', m.src, c.src]), () =>
                    this.closesFirst(m, c, absorb),
                  ))
              ) {
                settled *= f;
                settledBy.push(m);
              }
            }
            if (settled > carried) {
              carried = settled;
              carriedBy = settledBy;
            }
          }
          if (closed.length > 0) {
            const gone = new Set(closed);
            open = open.filter((c) => !gone.has(c));
          }
        }
      }
      steps.push({
        first: piece.first,
        nullable: piece.nullable,
        closedBy: [],
        ...(absorb !== undefined && absorb.length > 0 ? { inner: absorb } : {}),
      });
      opened.push(piece.open);

      // Rule 3. A piece that is not re-entered runs once per attempt, on characters no other
      // such piece consumes, so those add up to one pass over the line at most. One that is
      // re-entered runs in full once per combination of its multipliers' options.
      const cost = piece.pass + piece.retry;
      if (entries === 1) {
        pass += piece.pass;
        retry += piece.retry;
        greedy += piece.greedy;
        if (!this.largest || cost >= this.largest.cost) this.largest = { cost, label: item.label };
      } else {
        const charge = entries * cost;
        retry += charge;
        greedy += entries * piece.greedy;
        this.weigh({
          charge,
          label: item.label,
          at: item.at,
          entries,
          each: cost,
          multipliers: [...multipliers, ...floorBy],
          kind: 'rerun',
        });
      }
      // A piece that can match nothing is ARRIVED AT once per stop of every choice point still
      // open before it — overlapping or not, since it settles none of them — and at each arrival
      // it is entered, matches nothing and hands on. The re-entries above already paid for the
      // arrivals its multipliers make; the rest cost its entry. (A piece that must consume is
      // arrived at as often, and fails on its first check except where the runs before it
      // converge — those arrivals are the converging-paths floor above, charged in full.)
      // Without this, twenty-three `a*`, `b*`, … after `x{0,75}x*` were charged once each and
      // took 8-10s.
      if (k < suffix && piece.nullable && before.length > 0) {
        const arrivals = before.reduce((sum, c) => sum + reachOf(c), 0);
        const extra = Math.max(0, arrivals - entries) * piece.entry;
        if (extra > 0) {
          retry += extra;
          this.weigh({
            charge: extra,
            label: item.label,
            at: item.at,
            entries: arrivals - entries,
            each: piece.entry,
            multipliers: before,
            kind: 'arrival',
          });
        }
      }
      // Rule 2: the most times any one piece is entered, this one's inner pieces included.
      const reach = entries * piece.peak;
      if (reach > peak) {
        peak = reach;
        peakBy = [...(k < suffix ? [...multipliers, ...floorBy] : []), ...piece.peakBy];
      }

      if (!firstSettled) {
        first = first === null || piece.first === null ? null : [...first, ...piece.first];
        if (!piece.nullable) firstSettled = true;
      }
      // One arrival at the sequence enters every piece up to and including the first that
      // must consume: the nullable ones hand on, that one fails.
      if (!entrySettled) {
        entry += piece.entry;
        if (!piece.nullable) entrySettled = true;
      }
      nullable = nullable && piece.nullable;
      infallible = infallible && piece.infallible;
      rigid = rigid && piece.rigid;
      width += piece.width;
      if (!item.zeroWidth) lastOwn = own;
    }
    if (end === 'group') {
      // Handed outward, a choice point's reach is per attempt of THIS sequence; the enclosing one
      // scales it by how often it enters the group.
      const reaches = open.map((c) => [c, reachOf(c), entered.get(c.id)?.converge] as const);
      for (const [c, r, converge] of reaches) {
        c.reach = r;
        c.converge = converge;
      }
    }
    const capped = Math.min(pass, n);
    let absorb: AbsorbStep[] | undefined;
    if (end === 'group') {
      for (const [k, step] of steps.entries()) {
        for (const c of opened[k] ?? []) {
          if (closedAt.has(c.id)) step.closedBy.push(closedAt.get(c.id) ?? null);
        }
      }
      // Every body, even one where nothing closed: {@link closedWithin} asks whether EVERY way
      // through a group closes a choice point, and a body left out is one it never asks about.
      absorb = steps;
    }
    return {
      first,
      nullable,
      infallible,
      open: end === 'group' ? open : [],
      rigid,
      width: Math.min(width, n),
      pass: capped,
      retry,
      peak,
      peakBy,
      entry,
      greedy: Math.min(greedy, capped + retry),
      // Only a group's continuation lies outside it; a lookaround's is never backtracked into.
      ...(end === 'group' && carried > 1 ? { carried, carriedBy } : {}),
      ...(absorb ? { absorb: [absorb] } : {}),
    };
  }

  /**
   * Whether runs of a group entered once per stop of `m` — a choice point before the group that
   * re-enters it — CONVERGE inside it, judged the way {@link chain} judges the same items written
   * without the group: some repeat in the body can take what `m` takes (so `m` multiplies it), is
   * reached while `m` is still open (every piece before it that must consume can take what `m`
   * takes), and was closed inside the body by a piece that `m` cannot take either — so the flat
   * spelling forces both edges at one piece and counts `m`'s factor there.
   */
  private absorbs(m: ChoicePoint, body: AbsorbStep[]): boolean {
    if (m.src === null) return false;
    const src = [m.src];
    for (const step of body) {
      const takes = this.setsOverlap(src, step.first);
      if (takes) {
        if (step.closedBy.some((closer) => !this.setsOverlap(src, closer))) return true;
        if (step.inner?.some((inner) => this.absorbs(m, inner))) return true;
      } else if (!step.nullable) {
        return false;
      }
    }
    return false;
  }

  /**
   * Whether EVERY way through a group — each alternative's body in `bodies` — forces the edge of
   * `c`, a choice point before the group, by the rule {@link chain} closes one with: some piece
   * that must consume and cannot start with what `c` takes, at the body's level or, all the way
   * through, inside a group the body holds. The caller also has to know the group itself cannot
   * be skipped (`?`, `{0,n}`); a group that can match nothing leaves `c` open past it.
   */
  private closedWithin(c: ChoicePoint, bodies: AbsorbStep[][]): boolean {
    if (c.src === null || bodies.length === 0) return false;
    const src = [c.src];
    return bodies.every((body) =>
      body.some(
        (step) =>
          !step.nullable &&
          (!this.setsOverlap(src, step.first) ||
            (step.inner !== undefined && this.closedWithin(c, step.inner))),
      ),
    );
  }

  /**
   * Whether, on some way through a group, `b` is closed by the time `a` is — at the same piece or
   * an earlier one — both being choice points before the group, and both closed by the rule
   * {@link closedWithin} reads. "Some way" counts `b` whenever any alternative, or any way into
   * or past a group the body holds, closes it first: that can only over-count.
   */
  private closesFirst(b: ChoicePoint, a: ChoicePoint, bodies: AbsorbStep[][]): boolean {
    if (a.src === null || b.src === null) return false;
    const srcA = [a.src];
    const srcB = [b.src];
    return bodies.some((body) => {
      for (const step of body) {
        if (!step.nullable && !this.setsOverlap(srcB, step.first)) return true;
        if (!step.nullable && !this.setsOverlap(srcA, step.first)) return false;
        if (step.inner !== undefined) {
          if (this.closesFirst(b, a, step.inner)) return true;
          if (!step.nullable && this.closedWithin(a, step.inner)) return false;
        }
      }
      return false;
    });
  }

  /** Keep the costliest single charge, for the refusal to name. */
  private weigh(charge: Charge): void {
    if (!this.heaviest || charge.charge >= this.heaviest.charge) this.heaviest = charge;
  }

  /**
   * The shortest shift at which a run of written-out letters can overlap itself — the least
   * distance between two of its occurrences. `\label{` cannot overlap itself, so its period is
   * its length, 7; `aaa` overlaps itself at every shift, so its period is 1. Decided letter by
   * letter with the same overlap test as everything else, so classes (`[ab]`, `\w`) count too.
   */
  private period(run: string[]): number {
    const letters = run.slice(0, MAX_PERIOD_LETTERS);
    for (let d = 1; d < letters.length; d++) {
      const fits = letters.every((a, k) => {
        const b = letters[k + d];
        return b === undefined || this.overlaps(a, b);
      });
      if (fits) return d;
    }
    return letters.length;
  }

  /**
   * How far from its end a run holds a letter the repeat after it cannot match — `w` in the
   * fence rule of {@link chain} — or null when every letter of it overlaps the repeat.
   */
  private fenceWidth(run: string[], repeated: string): number | null {
    const k = run.findLastIndex((letter) => !this.overlaps(letter, repeated));
    return k === -1 ? null : run.length - k;
  }

  /** Apply a quantifier to an atom: rule 1, rule 4's product, and the atom's own choice point. */
  private quantified(
    atom: Atom,
    atomSrc: string,
    quant: Quantifier | null,
    label: string,
    at: number,
  ): { piece: Piece; own: ChoicePoint | null } {
    const base = atom.piece;
    if (!quant) return { piece: base, own: null };
    if (quant.max === Infinity && atom.group) {
      this.refuse(
        `it repeats a group without bound (\`${label}\`) — the construct that makes ` +
          'backtracking exponential, where a few dozen characters on one line are already ' +
          "enough to use up the search's whole time budget",
      );
    }
    if (quant.max > 1 && !base.rigid) {
      this.refuse(
        `it repeats \`${label}\`, a group or backreference that can match in more than one ` +
          'way — an alternation, a variable repeat or a backreference inside it — more than once. A ' +
          'bounded count does not make that safe: `(?:a|aa){0,40}` has Fibonacci-many ways to ' +
          'split forty characters, and took 29 seconds. Repeat only a fixed-width body ' +
          '(`(?:ab){2,5}`), or write the alternatives out as one class (`[ab]{0,40}`)',
      );
    }
    if (quant.max !== Infinity) {
      this.repeatProduct *= Math.max(1, quant.max);
      if (this.repeatProduct > MAX_REPEAT_PRODUCT) {
        this.refuse(
          `its counted repeats multiply out past ${MAX_REPEAT_PRODUCT} at \`${label}\` ` +
            '(`{n,m}` bounds multiply: `(?:a{200}){100}` is twenty thousand character ' +
            'comparisons per position). Lower one of the counts, or search for a shorter run and check the ' +
            'rest of the line by reading it',
        );
      }
    }

    // How many lengths it can stop at — an unbounded repeat at most as many as the line holds.
    const range =
      quant.max === Infinity
        ? ANALYZED_LINE_CHARS
        : Math.min(ANALYZED_LINE_CHARS, quant.max - quant.min + 1);
    const times = Math.min(quant.max, ANALYZED_LINE_CHARS);
    // One atom repeated: a step per character, at GREEDY_STEP where V8 runs it as a plain
    // greedy loop (`*`, `+`) and a full step where it keeps a count (`{n,m}`, `{5,}`).
    const plain = atom.single && quant.max === Infinity && quant.min <= 1;
    const pass = atom.single
      ? (plain ? GREEDY_STEP : 1) * times
      : Math.min(ANALYZED_LINE_CHARS, times * (1 + base.pass));
    let retry = times * base.retry;
    let greedy = plain ? pass : times * base.greedy;
    if (atom.loopHeavy) {
      // A quantified group that captures, holds a capture or can match nothing saves and
      // restores its registers (or runs its empty check) each time a greedy loop inside it gives
      // a character back: measured, `x{0,39}(x*)?\}` took 3.7 times what `x{0,39}(?:x+)?\}`
      // does, and `(x*)` unquantified no more than `x*`. So those loops are charged a full step
      // per character, not {@link GREEDY_STEP}.
      retry += greedy * (1 / GREEDY_STEP - 1);
      greedy = 0;
    }
    const piece: Piece = {
      first: base.first,
      nullable: base.nullable || quant.min === 0,
      infallible: base.infallible || quant.min === 0,
      open: [...base.open],
      rigid: base.rigid && quant.min === quant.max,
      width: Math.min(ANALYZED_LINE_CHARS, times * base.width),
      pass,
      retry,
      peak: base.peak,
      peakBy: base.peakBy,
      // An arrival sets up the loop, then enters its body once.
      entry: 1 + base.entry,
      greedy,
      // A body with a floor has choice points, so it is not rigid and rule 1 has refused any
      // count above one: the floor passes through `?` and `{1}` as it is, and `{0}` runs nothing.
      ...(quant.max > 0
        ? {
            carried: base.carried,
            carriedBy: base.carriedBy,
            absorb: base.absorb,
          }
        : {}),
    };
    let own: ChoicePoint | null = null;
    if (range > 1) {
      own = this.choicePoint(range, atom.single ? atomSrc : null, label, at);
      piece.open.push(own);
    }
    return { piece, own };
  }

  private choicePoint(range: number, src: string | null, label: string, at: number): ChoicePoint {
    return { id: this.nextId++, range, src, label, at, inLook: this.lookDepth > 0 };
  }

  /** Whether any atom in one set can match a character some atom in the other can. */
  private setsOverlap(a: string[] | null, b: string[] | null): boolean {
    if (a === null || b === null) return true;
    return a.some((x) => b.some((y) => this.overlaps(x, y)));
  }

  /**
   * Whether two single-atom sources can match the same character, decided by running them
   * against {@link sample}'s alphabet rather than by reasoning about class semantics.
   *
   * Using the engine itself is what makes this exact for the constructs that matter: two
   * character sets intersect only if the intersection contains a point where one of them BEGINS
   * — a range's start, or one past the end of a range a negated class or a class escape
   * excludes — and {@link sample} carries every such point the pattern or a class escape can
   * produce. Anything that cannot be compiled answers "yes, they overlap" — the refusing
   * direction. (No Unicode property class can occur: without the `u` flag, which the search
   * never sets, `\p{L}` is the letter `p` and a quantifier.)
   */
  private overlaps(a: string, b: string): boolean {
    let row = this.overlapCache.get(a);
    const cached = row?.get(b);
    if (cached !== undefined) return cached;
    const ma = this.matchSet(a);
    const mb = this.matchSet(b);
    const hit = !ma || !mb ? true : ma.some((word, k) => (word & (mb[k] ?? 0)) !== 0);
    if (!row) this.overlapCache.set(a, (row = new Map()));
    row.set(b, hit);
    return hit;
  }

  /**
   * Which alphabet characters one atom matches, as a bitset, computed once per distinct atom:
   * the analyzer runs on the server's own thread, and a 500-character pattern asks the same
   * atoms the same question hundreds of times. Null when the atom does not compile on its own.
   */
  private matchSet(src: string): Uint32Array | null {
    const cached = this.matchSets.get(src);
    if (cached !== undefined) return cached;
    let set: Uint32Array | null;
    try {
      const re = new RegExp(`^(?:${src})$`, this.ignoreCase ? 'i' : '');
      // A bit per alphabet character: under `i` the alphabet is some 2800 characters, and a
      // long pattern compares hundreds of pairs of these.
      set = new Uint32Array(Math.ceil(this.alphabet.length / 32));
      for (const [k, ch] of this.alphabet.entries()) {
        if (re.test(ch)) set[k >>> 5] = (set[k >>> 5] ?? 0) | (1 << (k & 31));
      }
    } catch {
      set = null;
    }
    this.matchSets.set(src, set);
    return set;
  }

  /** One atom, without its quantifier: a group, a class, an escape, an anchor or a character. */
  private atom(): Atom {
    const ch = this.src[this.i];
    if (ch === '(') return this.group();
    if (ch === '[') return this.characterClass();
    if (ch === '\\') return this.escape();
    if (ch === '^' || ch === '$') {
      this.i++;
      return { ...zeroWidth(), anchor: ch === '^' };
    }
    const start = this.i;
    this.i++;
    return this.single(start);
  }

  /** A one-character atom whose source the overlap test can re-compile. */
  private single(start: number): Atom {
    return {
      piece: {
        first: [this.src.slice(start, this.i)],
        nullable: false,
        infallible: false,
        open: [],
        rigid: true,
        width: 1,
        pass: TEXT_STEP,
        retry: 0,
        peak: 1,
        peakBy: [],
        entry: TEXT_STEP,
        greedy: 0,
      },
      group: false,
      single: true,
    };
  }

  private group(): Atom {
    const start = this.i;
    const capturesBefore = this.captureCount;
    this.i++; // past '('
    let look: 'ahead' | 'behind' | null = null;
    // Groups are numbered in the order their `(` appears, named ones included.
    let captureNumber: number | null = null;
    let captureName: string | null = null;
    if (this.src[this.i] !== '?') captureNumber = ++this.captureCount;
    if (this.src[this.i] === '?') {
      const two = this.src.slice(this.i, this.i + 2);
      const three = this.src.slice(this.i, this.i + 3);
      if (three === '?<=' || three === '?<!') {
        look = 'behind';
        this.i += 3;
      } else if (two === '?=' || two === '?!') {
        look = 'ahead';
        this.i += 2;
      } else if (two === '?:') {
        this.i += 2;
      } else if (two === '?<') {
        // Named capture `(?<name>` — never a lookbehind, those were taken above.
        const close = this.src.indexOf('>', this.i);
        if (close === -1) this.refuse('it contains a malformed named group');
        captureName = this.src.slice(this.i + 2, close);
        captureNumber = ++this.captureCount;
        this.i = close + 1;
      } else {
        // A modifier group `(?i:...)`, or something this scanner has not been taught. Fail
        // closed: an unrecognised construct is one whose cost is unknown.
        const opener = /^\?[^:)]{0,8}[:)]?/.exec(this.src.slice(this.i))?.[0] ?? '?';
        this.refuse(`it contains a group construct this server cannot verify (\`(${opener}\`)`);
      }
    }
    // The direction the body is MATCHED in: a lookbehind runs right to left, a lookahead left to
    // right again, and any other group the way its surroundings do.
    const outerBackward = this.backward;
    if (look === 'behind') this.backward = true;
    if (look === 'ahead') this.backward = false;
    const bodyBackward = this.backward;
    if (look) this.lookDepth++;
    const { piece: inner, choice } = this.disjunction(look ? 'lookaround' : 'group');
    if (look) this.lookDepth--;
    this.backward = outerBackward;
    if (this.src[this.i] !== ')') this.refuse('it contains an unterminated group');
    this.i++;
    if (choice) {
      choice.label = this.src.slice(start, this.i);
      choice.at = start;
    }
    if (captureNumber !== null) {
      // Matched backwards, `first` is what the body consumes LAST in source order — not what a
      // backreference, which always runs forwards from wherever it is, would start with.
      const seen: Capture = { first: bodyBackward ? null : inner.first, width: inner.width };
      this.captures.set(captureNumber, seen);
      if (captureName !== null) this.captures.set(captureName, seen);
    }
    if (!look) {
      // A capturing group saves its registers on entry and restores them on every backtrack
      // through it: measured, `(a)` repeated after a repeat costs several times what `a` does.
      const piece =
        captureNumber === null ? inner : { ...inner, pass: inner.pass + 1, entry: inner.entry + 1 };
      const loopHeavy = this.captureCount > capturesBefore || inner.nullable;
      return { piece, group: true, single: false, loopHeavy };
    }
    // A lookaround consumes nothing, so it never forces an earlier repeat's edge — but it is
    // RUN once per option of any choice point before it, so it answers the overlap test with
    // what its body looks at: the characters ahead (a lookbehind's are unknown), and the choice
    // points inside it. What it contains still counts, which is what keeps `(?=(a+)+)` out.
    // Inside a lookbehind the next thing consumed lies to the LEFT, while a lookahead reads to
    // the right, so there its first characters say nothing about what it overlaps: unknown.
    return {
      piece: {
        first: look === 'ahead' && !outerBackward ? inner.first : null,
        nullable: true,
        infallible: false,
        open: [],
        rigid: inner.rigid,
        width: 0,
        // It consumes nothing, but its body still runs every time it is reached.
        pass: 0,
        retry: inner.pass + inner.retry,
        peak: inner.peak,
        peakBy: inner.peakBy,
        entry: Math.max(TEXT_STEP, inner.entry),
        greedy: inner.greedy,
      },
      group: true,
      single: false,
      zeroWidth: true,
    };
  }

  private characterClass(): Atom {
    const start = this.i;
    this.i++; // past '['
    if (this.src[this.i] === '^') this.i++;
    while (this.i < this.src.length && this.src[this.i] !== ']') {
      this.i += this.src[this.i] === '\\' ? 2 : 1;
    }
    if (this.src[this.i] !== ']') this.refuse('it contains an unterminated character class');
    this.i++;
    return this.single(start);
  }

  private escape(): Atom {
    const start = this.i;
    this.i++; // past '\'
    const ch = this.src[this.i];
    if (ch === undefined) this.refuse('it ends in a trailing backslash');
    this.i++;
    // The search never sets the `u` flag, and without it `\u{...}` and `\p{...}` are NOT braced
    // escapes: `\u` and `\p` are the letters themselves and the braces are a QUANTIFIER on them
    // (`\u{999}` is `u` repeated 999 times). So only `\uXXXX` / `\xXX` consume anything past
    // the letter; a following `{...}` is left for {@link quantifier} to read as what it is.
    if (ch === 'u') {
      if (/^[0-9a-fA-F]{4}/.test(this.src.slice(this.i))) this.i += 4;
      return this.single(start);
    }
    if (ch === 'x') {
      if (/^[0-9a-fA-F]{2}/.test(this.src.slice(this.i))) this.i += 2;
      return this.single(start);
    }
    if (ch === 'c') {
      // `\cJ` is one control character. `\c` followed by anything else is a literal backslash,
      // and the `c` is an atom of its own — which a quantifier after it then repeats.
      if (/^[A-Za-z]/.test(this.src.slice(this.i))) {
        this.i++;
        return this.single(start);
      }
      this.i = start + 1;
      const backslash = this.single(start);
      backslash.piece.first = ['\\\\'];
      return backslash;
    }
    if (ch === 'k' && this.src[this.i] === '<') {
      const close = this.src.indexOf('>', this.i);
      if (close === -1) this.refuse('it contains a malformed named backreference');
      const name = this.src.slice(this.i + 1, close);
      this.i = close + 1;
      return backreference(this.captures.get(name), this.backward);
    }
    if (ch === 'b' || ch === 'B') return zeroWidth();
    // Without the `u` flag a digit escape is read the way V8 (and Annex B) reads it, and getting
    // that wrong splits one atom in two: `\01*` is U+0001 repeated, not a NUL then `1*`.
    //  - `\N`, N all the digits, is a backreference when the pattern has at least N capturing
    //    groups anywhere — a forward reference included;
    //  - otherwise `\8` and `\9` are those digits, and `\0`-`\7` start a legacy octal escape:
    //    up to three octal digits when the first is 0-3 (`\012`, `\377`), two when it is 4-7
    //    (`\47` is U+0027, and `\477` is that then a `7`).
    if (ch >= '0' && ch <= '9') {
      if (ch !== '0') {
        const digits = /^\d*/.exec(this.src.slice(this.i))?.[0] ?? '';
        const n = Number(ch + digits);
        if (n <= this.totalCaptures) {
          this.i += digits.length;
          return backreference(this.captures.get(n), this.backward);
        }
      }
      if (ch <= '7') {
        const octal = (at: number): boolean => /^[0-7]$/.test(this.src[at] ?? '');
        if (octal(this.i)) {
          this.i++;
          if (ch <= '3' && octal(this.i)) this.i++;
        }
      }
      return this.single(start);
    }
    return this.single(start);
  }

  /** The quantifier following an atom, or null when there is none. */
  private quantifier(): Quantifier | null {
    const ch = this.src[this.i];
    let quant: Quantifier | null = null;
    if (ch === '*') {
      quant = { min: 0, max: Infinity };
      this.i++;
    } else if (ch === '+') {
      quant = { min: 1, max: Infinity };
      this.i++;
    } else if (ch === '?') {
      quant = { min: 0, max: 1 };
      this.i++;
    } else if (ch === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(this.src.slice(this.i));
      if (!m) return null; // a literal '{', which JS allows outside a quantifier
      const min = Number(m[1]);
      const max = m[2] === undefined ? min : m[3] === '' ? Infinity : Number(m[3]);
      quant = { min, max };
      this.i += m[0].length;
    }
    // Lazy (`*?`) backtracks exactly as hard as greedy — it changes the order the engine tries
    // things, never how many there are to try. Consumed, then treated identically.
    if (quant && this.src[this.i] === '?') this.i++;
    return quant;
  }

  private refuse(why: string): never {
    throw new UnsafePatternError(
      `This server refuses to run that regular expression: ${why}. Rewrite it without that ` +
        'construct, or pass regex: false to search for the pattern as literal text. (The limit ' +
        'is not about what the pattern means: a regex match cannot be interrupted once started, ' +
        "so the shapes whose backtracking would use up the search's time budget are refused " +
        'before anything is searched.)',
    );
  }
}

/**
 * The "drop the `.*`" half of a refusal's advice — which is sound only outside a lookaround.
 *
 * At the top level a match anywhere in the line counts, so a leading or trailing `.*` changes no
 * line's verdict (except under `excludeComments`, which judges a hit by where it STARTS). Inside a
 * lookaround the `.*` is part of what is asserted: `(?<=\\cite\{.*)` looks for a `\cite{`
 * anywhere to the left, and without the `.*` only immediately to the left. So there the advice is
 * to bound it instead.
 */
function dropAdvice(
  named: ReadonlyArray<ChoicePoint>,
  which: 'leading' | 'leading/trailing' = 'leading/trailing',
): string {
  if (named.some((c) => c.inLook)) {
    return (
      'bound a repeat inside the lookaround (`.{0,80}` rather than `.*`) — dropping a `.*` ' +
      'there would change what it asserts, since a lookaround checks only where it stands'
    );
  }
  return (
    `drop a ${which} \`.*\` — a match anywhere in the line counts, so it does not change which ` +
    'lines match (with `excludeComments` it can: a hit counts as commented by where it STARTS, ' +
    'and a leading `.*` starts every hit at the beginning of the line — dropping it is what lets ' +
    'a hit inside a `%` comment be seen as one)'
  );
}

/** A sentence to splice after another one: a leading space, or nothing when it is empty. */
function convergeGap(sentence: string): string {
  return sentence === '' ? '' : ` ${sentence}`;
}

/**
 * One multiplier's factor for a piece: its range, capped by the period of a run that followed
 * it, and lowered where a fence applies. See {@link RegexSafetyScanner.chain}.
 *
 * A fence says the runs of a repeat F from different stops of an earlier repeat M do not
 * overlap: over all of M's stops, F covers the line about `w` times. It does NOT say F is tried
 * fewer times — F starts once at every stop of M, even where it stops after nothing. So what
 * the fence bounds is the SUM, over M's stops, of what F does there: at most M's stops plus `w`
 * lines of characters (and never more than the plain product). As a factor for M:
 *
 *  - the piece IS F: F's work is one entry per stop of M plus the characters it covers, so M
 *    counts `(stops + w × line) / F's widest run` entries of F — about `w + 1` for an unbounded
 *    F (`.*\\label\{fig:[a-z_]+`), and no credit at all for one that runs a letter or two;
 *  - the piece is re-entered by F: the pairs of a stop of M and a stop of F number at most
 *    `stops + w × line`, so M's factor is that over F's own factor.
 *
 * Reading the fence as "M's factor is `w`" undercounted both: `a+\w\{?[\s\S]{0,999}x` was
 * credited with ONE re-entry of `[\s\S]{0,999}` where it has one per stop of `a+` (3.8s).
 */
function factor(
  m: ChoicePoint,
  multipliers: ChoicePoint[],
  caps: Map<number, number>,
  fences: Map<number, Map<number, number>>,
  ownFence: Map<number, number> | null,
  ownWidth: number,
): number {
  const n = ANALYZED_LINE_CHARS;
  const base = (c: ChoicePoint): number => Math.min(c.range, caps.get(c.id) ?? Infinity);
  const stops = base(m);
  let f = stops;
  const own = ownFence?.get(m.id);
  if (own !== undefined) f = Math.min(f, Math.ceil((stops + own * n) / Math.max(1, ownWidth)));
  for (const d of multipliers) {
    const w = fences.get(d.id)?.get(m.id);
    if (w !== undefined) f = Math.min(f, Math.ceil((stops + w * n) / base(d)));
  }
  return f;
}

/** `^`, `$`, `\b`, `\B`: consumes nothing, and matches no character the overlap test tries. */
function zeroWidth(): Atom {
  return {
    piece: {
      first: [],
      nullable: true,
      // An assertion can fail: `$` before a character `.` stops at, `\b` between two letters.
      infallible: false,
      open: [],
      rigid: true,
      width: 0,
      pass: 0,
      retry: 0,
      peak: 1,
      peakBy: [],
      entry: TEXT_STEP,
      greedy: 0,
    },
    group: false,
    single: false,
    zeroWidth: true,
  };
}

/**
 * `\1`, `\k<name>`: matches whatever its group captured — possibly nothing (so it never forces
 * an earlier repeat's edge), and at most what the group could. When the group is closed and
 * known, it starts with what the group starts with and costs a step per character the group can
 * consume; otherwise it overlaps everything and may run the whole line. It is never rigid (its
 * width varies with the capture), so rule 1 refuses to repeat it.
 */
function backreference(group: Capture | undefined, backward: boolean): Atom {
  const width = group ? group.width : ANALYZED_LINE_CHARS;
  return {
    piece: {
      // Matched backwards (in a lookbehind) it consumes the capture's LAST character first.
      first: group && !backward ? group.first : null,
      nullable: true,
      infallible: false,
      open: [],
      rigid: false,
      width,
      pass: width,
      retry: 0,
      peak: 1,
      peakBy: [],
      entry: 1,
      greedy: 0,
    },
    group: false,
    single: false,
  };
}

/**
 * How many capturing groups the whole pattern has — `(` not followed by `?`, and named groups
 * `(?<name>`, outside character classes and escapes. What decides whether `\N` is a
 * backreference (see {@link RegexSafetyScanner.escape}); a source V8 accepted is all this is
 * ever given, so the count is exact.
 */
function countCaptures(src: string): number {
  let n = 0;
  let inClass = false;
  for (let k = 0; k < src.length; k++) {
    const ch = src[k];
    if (ch === '\\') {
      k++;
    } else if (inClass) {
      if (ch === ']') inClass = false;
    } else if (ch === '[') {
      inClass = true;
    } else if (ch === '(') {
      if (src[k + 1] !== '?') n++;
      else if (src[k + 2] === '<' && src[k + 3] !== '=' && src[k + 3] !== '!') n++;
    }
  }
  return n;
}

/**
 * Under the `i` flag: every BMP code unit that shares its case fold with another, and one either
 * side of each — see {@link sample}. Computed once, on the first case-insensitive pattern.
 * The fold is ECMAScript's `Canonicalize` without the `u` flag (upper-case to one code unit,
 * never from non-ASCII into ASCII), which is exactly the equivalence V8 matches `i` by: checked
 * code unit by code unit against the engine when this was written.
 */
let foldedSample: readonly number[] | undefined;
function caseFoldSample(): readonly number[] {
  if (foldedSample) return foldedSample;
  const codes = new Set<number>();
  for (let c = 0; c <= 0xffff; c++) {
    const upper = String.fromCharCode(c).toUpperCase();
    if (upper.length !== 1) continue;
    const u = upper.charCodeAt(0);
    if (u === c || (c >= 0x80 && u < 0x80)) continue;
    for (const d of [c - 1, c, c + 1, u - 1, u, u + 1]) if (d >= 0 && d <= 0xffff) codes.add(d);
  }
  foldedSample = [...codes];
  return foldedSample;
}

/**
 * Pieces of the pattern as a refusal quotes them: as written, and — when two of them are
 * written the same, as the two `a*` of `(?:a*)a*b` are — with where each starts, so the
 * refusal does not read "`a*` is matched again at each place `a*` can stop".
 */
function quoted(pieces: ReadonlyArray<{ label: string; at: number }>): string[] {
  const labels = pieces.map((p) => p.label);
  const clash = new Set(labels).size < labels.length;
  return pieces.map((p) =>
    clash ? `\`${p.label}\` (at character ${p.at + 1})` : `\`${p.label}\``,
  );
}

function formatCount(n: number): string {
  if (n < 10 && !Number.isInteger(n)) return String(Math.round(n * 100) / 100);
  return n < 1e6 ? String(Math.round(n)) : n.toExponential(1).replace('e+', '×10^');
}

/**
 * The alphabet {@link RegexSafetyScanner.overlaps} tests two atoms against: the base, plus
 * every character the pattern itself names — literally or through a `\uXXXX` escape (every
 * shorter escape names a code unit the base already holds) — and the characters one either side
 * of each.
 *
 * That is what makes the test exact rather than a sample. Two sets of characters, each a union
 * of ranges, intersect only if the intersection contains a point where one of the ranges
 * BEGINS. A class's ranges begin at a character its source names (`[b-d]` at `b`), or — for a
 * negated class, which covers everything its ranges leave out — one past a character its source
 * names (`[^\x00-\x7f]` begins at U+0080), or at a boundary of a class escape, which the base
 * carries. Without the pattern's own characters `[\u1000-\u2000]*\u1500` would be judged
 * against an alphabet containing nothing between U+1000 and U+2000 — an under-refusal, the one
 * direction this must not err in.
 *
 * Under `i` the sets are no longer unions of the ranges written: the engine matches a character
 * when its case fold equals the fold of one in the set, so `[\u0250-\u0260]` also matches U+0181,
 * the fold of U+0253 inside it — a character nothing in the pattern names, and the other cases
 * of the characters it does name miss it too. So every code unit that HAS a fold partner is added
 * ({@link caseFoldSample}, about 2500 of them), with one either side. That restores exactness: a
 * character in both sets either has a fold partner — and is in the alphabet — or matches each set
 * only as itself, and then the raw ranges and the runs of fold-free characters (which begin next
 * to a character with a partner) meet at a point the alphabet carries.
 *
 * Code units, not code points: without the `u` flag the engine matches UTF-16 code units, and an
 * astral character in the pattern is two atoms.
 */
function sample(source: string, ignoreCase: boolean): string[] {
  const codes = new Set<number>(BASE_SAMPLE);
  if (ignoreCase) for (const c of caseFoldSample()) codes.add(c);
  const named: number[] = [];
  for (let k = 0; k < source.length; k++) named.push(source.charCodeAt(k));
  for (const m of source.matchAll(/\\u([0-9a-fA-F]{4})/g)) {
    named.push(Number.parseInt(m[1] ?? '', 16));
  }
  for (const c of named) for (const d of [c - 1, c, c + 1]) if (d >= 0 && d <= 0xffff) codes.add(d);
  return [...codes].map((c) => String.fromCharCode(c));
}
