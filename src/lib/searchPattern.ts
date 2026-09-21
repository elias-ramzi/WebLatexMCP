/**
 * Turning a caller's `search_files` pattern into a matcher, and refusing the ones that would hang
 * the server.
 *
 * **Why this module is a guard and not a convenience.** A tool call runs on the server's event
 * loop, and `RegExp.prototype.exec` is uninterruptible: while V8 is inside the regex engine no
 * timer fires, no other tool call proceeds, no peer heartbeat is written. So a wall-clock budget
 * between lines (`searchFiles.ts`) bounds a search made of many cheap matches, and can do nothing
 * whatever about ONE expensive match. The pattern has to be bounded before it is ever run, and
 * this module is where that happens.
 *
 * The numbers below are measured on this codebase's own Node, not assumed. Against ONE
 * 2000-character line of `a`s: `a*b` (one ambiguous unbounded quantifier) takes 9ms; `.*a.*b`
 * (two) takes **7.8 seconds**; `.*a.*a.*b` (three) takes **37 minutes**; and
 * `[^x]*a[^x]*a[^x]*b` — no `.` in sight, a negated class that happens to match the letter
 * after it — takes **12 minutes**. `(a+)+$` is worse again and needs only a few dozen
 * characters. Cost grows as a power of the line length whose exponent is the number of
 * unbounded quantifiers that can trade input with each other — so the rules below bound that
 * exponent at one, and cap the line length the exponent applies to.
 *
 * **The bound, stated as a claim a test can check.** Once a pattern is accepted here:
 *
 *  1. No unbounded quantifier (`*`, `+`, `{n,}`, greedy or lazy) is applied to a GROUP — the
 *     nested ambiguity that makes backtracking EXPONENTIAL (`(a+)+`, `(a|a)*`, `(?:a|ab)+`)
 *     cannot be expressed at all.
 *  2. At most ONE unbounded quantifier in the whole pattern is AMBIGUOUS: one whose repeated
 *     characters can also be matched by what follows it, so the engine has more than one way to
 *     place the boundary between them. `.*a` is ambiguous (`.` matches `a` too); `[^}]*\}` is
 *     not (the class excludes the brace that follows), and neither is `\w+\s+\w+` (4ms —
 *     chaining quantifiers is not the hazard, overlapping ones are). Two overlapping repeats
 *     count 2 EACH way round, since they vary together: `a+a+b` is 2.8s. A repeat count
 *     multiplies what it contains, so `(?:.*a){3}` counts as three.
 *  3. The product of every counted repeat's upper bound is capped ({@link MAX_REPEAT_PRODUCT}),
 *     and the pattern source is at most {@link MAX_PATTERN_CHARS} characters.
 *
 * With one ambiguous quantifier the worst case is quadratic in the line length, and the search
 * caps that at `MAX_LINE_SCAN_CHARS` (2000) — measured at 9ms for `a*b` against a line of 2000
 * `a`s, tens of ms for a pattern with many (disjoint) repeats — after which the between-lines
 * deadline takes over. That is the whole argument: rules 1–2 bound the exponent, the line cap
 * bounds the base, and the deadline bounds the number of lines.
 *
 * Rules 1–2 are deliberately CONSERVATIVE and refuse patterns that would have been fine
 * (`(foo|bar)+` and `(a|b)*x` are perfectly cheap, and `.*a.*b` is only slow on a long line).
 * That is the right direction for a guard —
 * a refusal costs one error message naming the construct and the way around it, a miss costs the
 * whole server — and it is how the rest of this codebase treats an input it cannot verify: fail
 * closed, say why, hand back the escape route. Here the escape route is `regex: false`, which
 * needs none of this because an escaped literal has no quantifiers at all.
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
 * contributes 50; `a*`/`a+`/`a{2,}` contribute nothing here — rules 1–2 govern those).
 *
 * The product, not the maximum: `(?:a{100}){100}` is two innocent-looking counts that together
 * demand ten thousand character comparisons per start position.
 */
export const MAX_REPEAT_PRODUCT = 10_000;

/** How many ambiguous unbounded quantifiers a pattern may carry. See rule 2 above. */
export const MAX_AMBIGUOUS_QUANTIFIERS = 1;

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

/** One parsed atom, with the source slice the overlap test re-compiles. */
interface ParsedAtom {
  /** The atom's own source, without its quantifier. */
  src: string;
  /** Can match the empty string, quantifier NOT yet applied. */
  nullable: boolean;
  /** Can repeat without bound: itself, or (for a group) anything anywhere inside it. */
  unbounded: boolean;
  /** A `( ... )` of any kind, lookarounds included — what rule 1 refuses to repeat. */
  group: boolean;
  /** Whether the overlap test can say anything about this atom at all (false for a group). */
  known: boolean;
  /** Ambiguous unbounded quantifiers counted inside this atom (groups only). */
  ambiguousInside: number;
  quant: Quantifier | null;
}

interface Quantifier {
  min: number;
  /** `Infinity` for `*`, `+` and `{n,}`. */
  max: number;
}

/** What a sub-parse contributes to its parent. */
interface Summary {
  nullable: boolean;
  unbounded: boolean;
  ambiguous: number;
}

/** Characters every overlap test tries, before the pattern's own are added. See {@link sample}. */
const BASE_SAMPLE = (() => {
  const chars = ['\t', '\n', '\r', ' ', 'é', '中', '\u0000'];
  for (let c = 0x20; c <= 0x7e; c++) chars.push(String.fromCharCode(c));
  return chars;
})();

class RegexSafetyScanner {
  private i = 0;
  private repeatProduct = 1;
  private readonly alphabet: string[];

  constructor(
    private readonly src: string,
    private readonly ignoreCase: boolean,
  ) {
    this.alphabet = sample(src);
  }

  run(): void {
    const summary = this.disjunction(true);
    if (this.i < this.src.length) {
      // Only reachable on a stray `)`, which `new RegExp` rejects — the fail-closed arm.
      this.refuse('it contains a group that could not be parsed');
    }
    if (summary.ambiguous > MAX_AMBIGUOUS_QUANTIFIERS) {
      this.refuse(
        `it has ${summary.ambiguous} repeats that can also match what follows them ` +
          `(\`.*a.*b\`, \`a+a+b\`, \`(?:.*a){3}\`), where at most ` +
          `${MAX_AMBIGUOUS_QUANTIFIERS} is allowed — each one multiplies how many ways the ` +
          'engine must try to split a single line, and two of them already take seconds on a ' +
          '2000-character line. Anchor each repeat to something it cannot itself match ' +
          '(`[^}]*\\}` rather than `.*\\}`), or drop a leading/trailing `.*` — a match anywhere ' +
          'in the line counts, so wrapping a pattern in `.*` never changes which lines match',
      );
    }
  }

  /** `a|b|c` — every alternative checked on its own, the results merged conservatively. */
  private disjunction(top: boolean): Summary {
    let nullable = false;
    let unbounded = false;
    let ambiguous = 0;
    for (;;) {
      const alt = this.alternative(top);
      nullable = nullable || alt.nullable;
      unbounded = unbounded || alt.unbounded;
      // Summed across branches although only one branch ever runs: a branch-aware count would
      // have to model which branch the engine is in when the NEXT quantifier is reached, and
      // over-counting only ever refuses more.
      ambiguous += alt.ambiguous;
      if (this.src[this.i] === '|') {
        this.i++;
        continue;
      }
      break;
    }
    return { nullable, unbounded, ambiguous };
  }

  /** One alternative: the sequence of quantified atoms between two `|`s. */
  private alternative(top: boolean): Summary {
    const atoms: ParsedAtom[] = [];
    while (this.i < this.src.length && this.src[this.i] !== '|' && this.src[this.i] !== ')') {
      const start = this.i;
      const atom = this.atom();
      atom.src = this.src.slice(start, this.i);
      atom.quant = this.quantifier();
      atoms.push(atom);
    }
    return this.judge(atoms, top);
  }

  /**
   * Apply rules 1–3 to one parsed sequence.
   *
   * Split from the parse because rule 2 needs LOOKAHEAD: whether an unbounded quantifier is
   * ambiguous depends on what follows it, which is not known while it is being read.
   */
  private judge(atoms: ParsedAtom[], top: boolean): Summary {
    let nullable = true;
    let unbounded = false;
    let ambiguous = 0;

    for (const [idx, atom] of atoms.entries()) {
      const quant = atom.quant;
      if (quant && quant.max === Infinity && atom.group) {
        this.refuse(
          'it repeats a group without bound (`(...)*`, `(...)+`, `(...){n,}`) — the construct ' +
            'that makes backtracking exponential, where a few dozen characters on one line are ' +
            'already enough to hang the server',
        );
      }
      if (quant && quant.max !== Infinity) {
        this.repeatProduct *= Math.max(1, quant.max);
        if (this.repeatProduct > MAX_REPEAT_PRODUCT) {
          this.refuse(
            `its counted repeats multiply out past ${MAX_REPEAT_PRODUCT} (\`{n,m}\` bounds ` +
              'multiply: `(?:a{100}){100}` is ten thousand character comparisons per position)',
          );
        }
      }

      const atomUnbounded = atom.unbounded || quant?.max === Infinity;
      const atomNullable = quant ? quant.min === 0 || atom.nullable : atom.nullable;

      // A counted repeat multiplies whatever ambiguity it contains: `(?:.*a){3}` is three
      // boundaries to place, not one.
      ambiguous +=
        atom.ambiguousInside * (quant && quant.max !== Infinity ? Math.max(1, quant.max) : 1);
      if (quant?.max === Infinity) ambiguous += this.ambiguityOf(atoms, idx, atom, top);

      nullable = nullable && atomNullable;
      unbounded = unbounded || atomUnbounded;
    }
    return { nullable, unbounded, ambiguous };
  }

  /**
   * How much ambiguity the unbounded quantifier on `self` (at `idx`) contributes: 0, 1 or 2.
   *
   * The question is whether the engine has more than one way to place the quantifier's right
   * edge. Scanning forward from it:
   *
   *  - **An atom whose characters overlap `self`'s** is ambiguity: every boundary between them
   *    has to be tried. It counts 2 when that atom is ITSELF unbounded, because then both
   *    repeats vary together — `a+a+b` has n ways to split one run of `a`s at every position,
   *    which measured 2.8 SECONDS on a 2000-character line, while one ambiguous quantifier
   *    (`a*b`) measured 9ms. Counting such a pair as one would let exactly that through.
   *  - **A disjoint atom that must consume a character** ends the question: the boundary is
   *    forced. This is why `\w+\s+\w+` (4ms) is accepted where `a+a+b` is not — chaining is
   *    not the hazard, overlapping is.
   *  - **A disjoint atom that need not consume anything** (`b?`, `\s*` before a non-space)
   *    settles nothing, so the scan continues past it: `a*b?a*c` (3.0s) is caught by the `a*`
   *    two atoms further on, not by the `b?` in between.
   *  - **Nothing consuming follows at all**: at the top level the quantifier is at the end of
   *    the pattern, nothing after it can fail, and a greedy match never backtracks — 0, which
   *    is why a trailing `.*` is free. Inside a group the continuation is not visible from
   *    here, so assume 1.
   *
   * Anything the overlap test cannot decide (a group on either side) counts as overlapping.
   */
  private ambiguityOf(atoms: ParsedAtom[], idx: number, self: ParsedAtom, top: boolean): number {
    for (const next of atoms.slice(idx + 1)) {
      const nextNullable = next.quant ? next.quant.min === 0 || next.nullable : next.nullable;
      const nextUnbounded = next.unbounded || next.quant?.max === Infinity;
      const unknown = !self.known || !next.known;
      if (unknown || this.overlaps(self.src, next.src)) return nextUnbounded ? 2 : 1;
      if (!nextNullable) return 0; // a disjoint atom that must consume: the boundary is forced
    }
    return top ? 0 : 1;
  }

  /**
   * Whether two single-atom sources can match the same character, decided by running them
   * against {@link sample}'s alphabet rather than by reasoning about class semantics.
   *
   * Using the engine itself is what makes this exact for the constructs that matter: the
   * alphabet carries every literal character and every range endpoint the pattern mentions, and
   * two ranges intersect only if one's endpoint lies inside the other. Anything that cannot be
   * compiled, or that reaches into Unicode property classes the alphabet cannot enumerate,
   * answers "yes, they overlap" — the refusing direction.
   */
  private overlaps(a: string, b: string): boolean {
    if (/\\[pP]\{/.test(a) || /\\[pP]\{/.test(b)) return true;
    const ra = this.compileAtom(a);
    const rb = this.compileAtom(b);
    if (!ra || !rb) return true;
    return this.alphabet.some((ch) => ra.test(ch) && rb.test(ch));
  }

  private compileAtom(src: string): RegExp | null {
    try {
      return new RegExp(`^(?:${src})$`, this.ignoreCase ? 'i' : '');
    } catch {
      return null;
    }
  }

  /** One atom, without its quantifier: a group, a class, an escape, an anchor or a character. */
  private atom(): ParsedAtom {
    const ch = this.src[this.i];
    if (ch === '(') return this.group();
    if (ch === '[') return this.characterClass();
    if (ch === '\\') return this.escape();
    if (ch === '^' || ch === '$') {
      this.i++;
      return this.plain({ nullable: true }); // zero-width
    }
    this.i++;
    return this.plain({});
  }

  /** A non-group atom whose source the overlap test can re-compile. */
  private plain(opts: { nullable?: boolean; known?: boolean }): ParsedAtom {
    return {
      src: '',
      nullable: opts.nullable ?? false,
      unbounded: false,
      group: false,
      known: opts.known ?? true,
      ambiguousInside: 0,
      quant: null,
    };
  }

  private group(): ParsedAtom {
    this.i++; // past '('
    let zeroWidth = false;
    if (this.src[this.i] === '?') {
      const two = this.src.slice(this.i, this.i + 2);
      const three = this.src.slice(this.i, this.i + 3);
      if (three === '?<=' || three === '?<!') {
        zeroWidth = true;
        this.i += 3;
      } else if (two === '?=' || two === '?!') {
        zeroWidth = true;
        this.i += 2;
      } else if (two === '?:') {
        this.i += 2;
      } else if (two === '?<') {
        // Named capture `(?<name>` — never a lookbehind, those were taken above.
        const close = this.src.indexOf('>', this.i);
        if (close === -1) this.refuse('it contains a malformed named group');
        this.i = close + 1;
      } else {
        // A modifier group `(?i:...)`, or something this scanner has not been taught. Fail
        // closed: an unrecognised construct is one whose cost is unknown.
        this.refuse('it contains a group construct this server cannot verify');
      }
    }
    const inner = this.disjunction(false);
    if (this.src[this.i] !== ')') this.refuse('it contains an unterminated group');
    this.i++;
    return {
      src: '',
      // A lookaround consumes nothing, so it can never separate two unbounded quantifiers; what
      // it CONTAINS still counts, which is what keeps `(?=(a+)+)` out.
      nullable: zeroWidth || inner.nullable,
      unbounded: inner.unbounded,
      group: true,
      known: false,
      ambiguousInside: inner.ambiguous,
      quant: null,
    };
  }

  private characterClass(): ParsedAtom {
    this.i++; // past '['
    if (this.src[this.i] === '^') this.i++;
    while (this.i < this.src.length && this.src[this.i] !== ']') {
      this.i += this.src[this.i] === '\\' ? 2 : 1;
    }
    if (this.src[this.i] !== ']') this.refuse('it contains an unterminated character class');
    this.i++;
    return this.plain({});
  }

  private escape(): ParsedAtom {
    this.i++; // past '\'
    const ch = this.src[this.i];
    if (ch === undefined) this.refuse('it ends in a trailing backslash');
    this.i++;
    if (ch === 'u' || ch === 'p' || ch === 'P') {
      // `\u{1F600}`, `\p{Letter}` — consume the braced body so its `{`/`}` are never mistaken
      // for a counted quantifier.
      if (this.src[this.i] === '{') {
        const close = this.src.indexOf('}', this.i);
        if (close === -1) this.refuse('it contains an unterminated \\u{...} or \\p{...} escape');
        this.i = close + 1;
      } else if (ch === 'u') {
        // `\uXXXX` — four hex digits, consumed so a following `{n}` still reads as a quantifier.
        const hex = /^[0-9a-fA-F]{4}/.exec(this.src.slice(this.i));
        if (hex) this.i += 4;
      }
      return this.plain({});
    }
    if (ch === 'x') {
      const hex = /^[0-9a-fA-F]{2}/.exec(this.src.slice(this.i));
      if (hex) this.i += 2;
      return this.plain({});
    }
    if (ch === 'k' && this.src[this.i] === '<') {
      const close = this.src.indexOf('>', this.i);
      if (close === -1) this.refuse('it contains a malformed named backreference');
      this.i = close + 1;
      // A backreference can match the empty string (its group may have), so it is nullable and
      // `known: false`: it must never count as the character separating two unbounded
      // quantifiers, and nothing can be said about which characters it matches.
      return this.plain({ nullable: true, known: false });
    }
    if (ch === 'b' || ch === 'B') return this.plain({ nullable: true });
    if (ch >= '1' && ch <= '9') return this.plain({ nullable: true, known: false });
    return this.plain({});
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
        'so the shapes that can hang the server are refused before anything is searched.)',
    );
  }
}

/**
 * The alphabet {@link RegexSafetyScanner.overlaps} tests two atoms against: a fixed base, plus
 * every character the pattern itself mentions — literally, or through a `\uXXXX` / `\u{...}` /
 * `\xXX` escape.
 *
 * Adding the pattern's own characters is what makes the test exact rather than a sample: two
 * character ranges intersect only if one's endpoint lies inside the other, and every endpoint a
 * pattern can name appears in its source. Without that, a pattern like `[\\u1000-\\u2000]*\\u1500` would be
 * declared non-overlapping against an alphabet that contains no such character — an
 * under-refusal, and the one direction this must not err in.
 */
function sample(source: string): string[] {
  const chars = new Set(BASE_SAMPLE);
  for (const ch of source) chars.add(ch);
  for (const m of source.matchAll(
    /\\u\{([0-9a-fA-F]+)\}|\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})/g,
  )) {
    const hex = m[1] ?? m[2] ?? m[3];
    const code = Number.parseInt(hex ?? '', 16);
    if (Number.isFinite(code) && code <= 0x10ffff) chars.add(String.fromCodePoint(code));
  }
  return [...chars];
}
