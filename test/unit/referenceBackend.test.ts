import { describe, it, expect } from 'vitest';
import {
  BackendUnavailableError,
  BIBTEX_ENTRY,
  assertApiBody,
  bibtexEntrySpan,
  httpHint,
} from '../../src/services/referenceBackend.js';

describe('assertApiBody', () => {
  it('offers the exemption remedy ONLY when a challenge was actually identified', () => {
    // A plain error page is not a challenge: telling the reader to wait for an API-path
    // exemption from a challenge that is not there sends them after the wrong problem.
    try {
      assertApiBody('Crossref', '<html>not found</html>', 'a search');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as Error).message).not.toMatch(/exempts its API paths/);
      expect((err as Error).message).toMatch(/cannot be reached from this machine\./);
    }
    try {
      assertApiBody(
        'DBLP',
        "<!doctype html><title>Making sure you're not a bot!</title>",
        'a search',
      );
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as Error).message).toMatch(/exempts its API paths from it/);
    }
  });
  it('accepts a JSON body', () => {
    expect(() => assertApiBody('Crossref', '{"status":"ok"}', 'a search')).not.toThrow();
  });

  it('accepts a BibTeX body', () => {
    expect(() =>
      assertApiBody('DBLP', '@inproceedings{key,\n  title = {X}\n}', 'a BibTeX request'),
    ).not.toThrow();
  });

  it('throws BackendUnavailableError on a body starting with "<", naming the given service', () => {
    let thrown: unknown;
    try {
      assertApiBody('Crossref', '<html>nope</html>', 'a search for "x"');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BackendUnavailableError);
    expect((thrown as Error).message).toContain('Crossref');
    expect((thrown as Error).message).not.toContain('DBLP');
  });

  it('mentions the anti-bot challenge when the body signals one', () => {
    expect(() => assertApiBody('DBLP', '<html>please prove you are not a bot</html>', 'x')).toThrow(
      /anti-bot proof-of-work/,
    );
  });

  it('does not mention the anti-bot challenge for a plain not-found page', () => {
    expect(() => assertApiBody('DBLP', '<html>not found</html>', 'x')).toThrow(
      /HTML page instead of API data/,
    );
    try {
      assertApiBody('DBLP', '<html>not found</html>', 'x');
      throw new Error('expected assertApiBody to throw');
    } catch (err) {
      expect((err as Error).message).not.toMatch(/anti-bot proof-of-work/);
    }
  });
});

describe('httpHint', () => {
  it('mentions rate limiting and names the service for 429', () => {
    const hint = httpHint('OpenAlex', 429);
    expect(hint).toMatch(/rate-limits/);
    expect(hint).toContain('OpenAlex');
  });

  it('returns empty string for 503', () => {
    expect(httpHint('OpenAlex', 503)).toBe('');
  });
});

describe('BackendUnavailableError', () => {
  it('carries its backend and is an instanceof Error', () => {
    const err = new BackendUnavailableError('Crossref', 'boom');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(BackendUnavailableError);
    expect(err.backend).toBe('Crossref');
    expect(err.name).toBe('BackendUnavailableError');
  });
});

describe('BIBTEX_ENTRY', () => {
  it('matches a real entry header', () => {
    expect(BIBTEX_ENTRY.test('@inproceedings{key,\n  title = {X}\n}')).toBe(true);
  });

  it('does not match a body whose only @ is a @licstart license header', () => {
    const body =
      '<script>/*\n@licstart The following is the entire license notice.\n@licend*/</script>';
    expect(BIBTEX_ENTRY.test(body)).toBe(false);
  });

  it('does not match CSS at-rules, which share the "@word{" shape', () => {
    // An interstitial's inline <style> is the other thing that reaches this check carrying a
    // brace after an @word. None of these is an entry, and none may open one.
    for (const rule of [
      '@import url("x.css");',
      '@media screen {\n  body { color: red }\n}',
      '@font-face {\n  font-family: X;\n}',
      '@supports (display: grid) {\n  .a { color: red }\n}',
    ]) {
      expect(BIBTEX_ENTRY.test(rule)).toBe(false);
    }
  });

  it('does not match a header sitting MID-LINE', () => {
    // The match offset is what `fetchBibtex` slices from, so a header has to begin a line or
    // there is no honest place to cut: a mid-line "@article{x," is prose mentioning an entry,
    // and slicing from it would hand back a fragment of somebody's error page as BibTeX.
    expect(BIBTEX_ENTRY.test('Warning: proxy error @article{evil, note={x}}')).toBe(false);
  });

  it('matches a header at the start of a later line, or after indentation', () => {
    expect(BIBTEX_ENTRY.test('junk banner\n@article{x, title={T}}')).toBe(true);
    expect(BIBTEX_ENTRY.test('  @article{x, title={T}}')).toBe(true);
  });
});

describe('bibtexEntrySpan', () => {
  /** The bytes the span selects — what `fetchBibtex` hands to `mergeBibEntry`. */
  function cut(text: string): string | null {
    const span = bibtexEntrySpan(text);
    return span === null ? null : text.slice(span.start, span.end);
  }

  const ENTRY = '@inproceedings{he2016deep,\n  title = {Deep Residual Learning},\n}';

  it('returns a lone entry byte-identically', () => {
    expect(cut(ENTRY)).toBe(ENTRY);
    expect(bibtexEntrySpan(ENTRY)).toEqual({ start: 0, end: ENTRY.length });
  });

  it('returns null when there is no line-anchored entry header', () => {
    expect(bibtexEntrySpan('Warning: proxy error @article{evil, note={x}}')).toBe(null);
    expect(bibtexEntrySpan('Moved Permanently. See https://example.org/')).toBe(null);
  });

  it('ends the span at the entry, dropping a trailing <script>', () => {
    expect(cut(ENTRY + '\n<script>alert(1)</script>')).toBe(ENTRY);
  });

  it('ends the span at the entry, dropping trailing prose', () => {
    expect(cut(ENTRY + '\n\nRetrieved on Tuesday. Please cite responsibly.')).toBe(ENTRY);
  });

  it('cuts leading junk and trailing junk in one span', () => {
    const body = 'Warning: proxy error<br>\n' + ENTRY + '\n</body></html>';
    expect(cut(body)).toBe(ENTRY);
  });

  it('keeps a run of entries — DBLP emits the @proceedings a crossref field names', () => {
    // Dropping the second entry would corrupt the one that survives (its `crossref` field
    // would dangle), which is worse than the trailing junk this cut exists to remove.
    const two = ENTRY + '\n\n@proceedings{DBLP:conf/cvpr/2016,\n  title = {CVPR 2016}\n}';
    expect(cut(two)).toBe(two);
    expect(cut(two + '\n<script>alert(1)</script>')).toBe(two);
  });

  it('counts braces nested inside a field value', () => {
    const nested = '@article{k,\n  title = {A {Nested} {B{race}} Title},\n}';
    expect(cut(nested + '\ntrailing junk')).toBe(nested);
  });

  it('does not let an escaped \\} end the entry', () => {
    const escaped = '@article{k,\n  note = {a literal \\} brace},\n}';
    expect(cut(escaped + '\ntrailing junk')).toBe(escaped);
  });

  it('handles a paren-delimited entry', () => {
    const paren = '@article(k,\n  title = {Parens Are Legal BibTeX},\n)';
    expect(cut(paren + '\ntrailing junk')).toBe(paren);
    // The delimiter pair is the one the header opened with: a `}` inside does not close it.
    const mixed = '@article(k,\n  title = {X},\n)';
    expect(cut(mixed + '\njunk')).toBe(mixed);
  });

  it('fails OPEN on an unbalanced entry, spanning to the end of the text', () => {
    // A truncated-but-plausible entry is worse than a whole one with junk after it, and
    // `assertApiBody` plus the header check already stand in front of this.
    const broken = '@article{k,\n  title = {Deep {Residual Learning},\n';
    expect(cut(broken)).toBe(broken);
    const brokenSecond = ENTRY + '\n\n@proceedings{p,\n  title = {Unclosed\n';
    expect(cut(brokenSecond)).toBe(brokenSecond);
  });

  it('does not swallow a later entry header that is not line-anchored', () => {
    // Same reason the first header must begin a line: a header reached mid-line is prose
    // mentioning an entry, not an entry.
    const body = ENTRY + '\nnote: see @article{evil, x={y}}';
    expect(cut(body)).toBe(ENTRY);
  });
});

describe('bibtexEntrySpan: a brace inside a field VALUE never ends the entry early', () => {
  /** The bytes the span selects — what `fetchBibtex` hands to `mergeBibEntry`. */
  function cut(text: string): string | null {
    const span = bibtexEntrySpan(text);
    return span === null ? null : text.slice(span.start, span.end);
  }

  // The depth scan's fail-open covers UNDER-balance only. An entry that over-balances — one
  // unmatched `}` inside a value — hits depth 0 in the middle of itself, and the span used to end
  // there: a syntactically broken fragment appended to a user's .bib, which is worse than the
  // junk this cut exists to remove and is exactly what the fail-open promise rules out.

  it('keeps an entry whose "-quoted value carries a }', () => {
    const entry = '@article{k,\n  title = "A } weird title",\n  author = {Foo}\n}';
    expect(cut(entry)).toBe(entry);
    // Precisely, not by fail-open: the trailing junk is still cut off.
    expect(cut(entry + '\n<script>alert(1)</script>')).toBe(entry);
  });

  it('keeps an entry whose "-quoted value carries a { (over-balance the other way)', () => {
    const entry = '@article{k,\n  title = "A { weird title",\n  author = {Foo}\n}';
    expect(cut(entry)).toBe(entry);
    expect(cut(entry + '\n<script>alert(1)</script>')).toBe(entry);
  });

  it('does not mistake a LaTeX \\" umlaut inside a quoted value for the value\'s end', () => {
    const entry = '@article{k,\n  author = "Kurt G\\"{o}del and } Co",\n  year = {1931}\n}';
    expect(cut(entry)).toBe(entry);
    expect(cut(entry + '\ntrailing junk')).toBe(entry);
  });

  it('keeps an entry whose BRACED value carries an unescaped }, by failing open', () => {
    // Nothing distinguishes this `}` from the entry's own closer except that it is not the last
    // thing on its line, so the run cannot be cut honestly — and fail open beats truncation.
    const entry = '@article{k,\n  title = {A } weird title},\n  author = {Foo}\n}';
    expect(cut(entry)).toBe(entry);
    // Fail open means MORE of the service's bytes, never fewer: trailing junk rides along rather
    // than the entry being cut in half.
    const withJunk = entry + '\ntrailing junk';
    expect(cut(withJunk)).toBe(withJunk);
  });

  it('applies the line-position test to CRLF bodies identically', () => {
    // "the last non-whitespace character on its line" has to mean the same thing when the line
    // ends `\r\n`, or every CRLF body would fail open and carry its trailing junk into the .bib.
    const entry = '@article{k,\r\n  title = {T},\r\n}';
    expect(cut(entry + '\r\n<script>alert(1)</script>')).toBe(entry);
    // And the over-balance case still fails open under CRLF rather than truncating.
    const broken = '@article{k,\r\n  title = {A } weird title},\r\n  author = {Foo}\r\n}';
    expect(cut(broken)).toBe(broken);
  });
});

describe('bibtexEntrySpan: a separator between entries does not end the run', () => {
  function cut(text: string): string | null {
    const span = bibtexEntrySpan(text);
    return span === null ? null : text.slice(span.start, span.end);
  }

  const A = '@inproceedings{a,\n  title = {A},\n  crossref = {b}\n}';
  const B = '@proceedings{b,\n  title = {B}\n}';

  it('keeps a trailing entry separated by an @string block, and the block itself', () => {
    // The macro has to stay INSIDE the span: dropping it leaves the entries that use the
    // abbreviation with an unresolved macro, which is the corruption the continuation rule exists
    // to prevent.
    const body = A + '\n@string{cvpr = "CVPR"}\n' + B;
    expect(cut(body)).toBe(body);
    expect(cut(body + '\n<script>alert(1)</script>')).toBe(body);
  });

  it('keeps a trailing entry separated by @preamble or @comment', () => {
    const preamble = A + '\n@preamble{ "\\newcommand{\\noop}[1]{}" }\n' + B;
    expect(cut(preamble)).toBe(preamble);
    const comment = A + '\n@comment{ignore me}\n' + B;
    expect(cut(comment)).toBe(comment);
  });

  it('keeps a trailing entry separated by a %-comment line', () => {
    const body = A + '\n% a comment\n' + B;
    expect(cut(body)).toBe(body);
    expect(cut(body + '\ntrailing prose')).toBe(body);
  });

  it('does NOT widen the span over a separator that no entry follows', () => {
    // Skipping is only ever a bridge to another entry; a trailing macro or comment is junk like
    // any other and stays out.
    expect(cut(A + '\n@string{cvpr = "CVPR"}\n')).toBe(A);
    expect(cut(A + '\n% just a trailing comment\n')).toBe(A);
    expect(cut(A + '\n% a comment\nRetrieved on Tuesday.')).toBe(A);
  });

  it('keeps the line-anchor rule for the header AFTER a separator', () => {
    // Skipping a separator must not smuggle in a header the first-header rule would refuse: a
    // header reached mid-line is prose mentioning an entry, separator in front of it or not.
    expect(cut(A + '\n% a comment\nnote: see @article{evil, x={y}}')).toBe(A);
    expect(cut(A + '\n@string{cvpr = "CVPR"}\nnote: see @article{evil, x={y}}')).toBe(A);
  });

  it("fails open on a separator sharing the entry's own closing line", () => {
    // A `%` mid-line is not a separator — but it also means the entry's `}` is no longer the last
    // thing on its line, so the close is not believed and the whole body comes back. Fail open is
    // the answer to "this body is not shaped the way a service shapes one", here as everywhere.
    const body = A + ' % see also\n' + B;
    expect(cut(body)).toBe(body);
  });
});

describe('bibtexEntrySpan: a believed closer is ALONE on its line and outside the other pair', () => {
  function cut(text: string): string | null {
    const span = bibtexEntrySpan(text);
    return span === null ? null : text.slice(span.start, span.end);
  }

  const GOOD = '@inproceedings{a,\n  title = {A},\n}';

  // `endsItsLine` alone only caught a stray closer sitting MID-line. A stray closer that happens
  // to END its line was believed, and the entry was cut in half — the exact truncation the
  // fail-open promise rules out. Every service closes an entry with a lone `}`/`)` on its own
  // line, so demanding that costs nothing real and puts these bodies back on the fail-open path.

  const OVER_BALANCED = '@article{k,\n  abstract = {Sentence one} extra }\n  author = {Foo}\n}';

  it('fails open on an over-balanced entry whose stray } ENDS its line', () => {
    // Before: `@article{k,\n  abstract = {Sentence one} extra }` — the author field and the real
    // closer gone, a fragment appended to the user's .bib.
    const body = OVER_BALANCED + '\njunk';
    expect(cut(body)).toBe(body);
  });

  it('does not return a good entry plus the broken HALF of the next one', () => {
    // The nastier shape: the corruption hides behind a valid leading entry.
    const body = GOOD + '\n\n' + OVER_BALANCED + '\njunk';
    expect(cut(body)).toBe(body);
  });

  it('fails open on a single-line entry, whose closer is not alone on its line', () => {
    // A deliberate, documented consequence: a one-line entry has no believable closer, so the
    // span runs to the end of the text. Fail open is the right answer — rescuing it would take a
    // positional guess, which is what this function must never make.
    const oneLine = '@inproceedings{x, title={T}}';
    expect(cut(oneLine)).toBe(oneLine);
    const withJunk = oneLine + '\njunk';
    expect(cut(withJunk)).toBe(withJunk);
  });

  // The other half: `entryEnd` used to track ONE delimiter pair and ignore the other entirely, so
  // inside `@article(...)` any `)` in a braced value was treated as the entry's closer.

  it('fails open on a paren entry whose braced value carries a )', () => {
    const body = '@article(k,\n  title = {A )\n},\n  author = {F}\n)\njunk';
    // Before: `@article(k,\n  title = {A )` — an unbalanced fragment with a dangling `{`, which
    // breaks every entry after it in the user's .bib.
    expect(cut(body)).toBe(body);
  });

  it('fails open on a paren entry whose stray ) is ALONE on its line', () => {
    // This one the line-position rule cannot catch on its own: the stray `)` is alone on its
    // line, so only the brace counter says it is inside a value rather than closing the entry.
    const body = '@article(k,\n  title = {A\n)\n},\n  author = {F}\n)\njunk';
    expect(cut(body)).toBe(body);
  });

  it('fails open on a BRACE entry whose value carries an unmatched (', () => {
    // Symmetrically: a `}` reached inside a paren-nested region is not the entry's closer either.
    const body = '@article{k,\n  title = {A ( title},\n  author = {F}\n}\njunk';
    expect(cut(body)).toBe(body);
  });

  it('still cuts a paren entry precisely when its parens inside braces balance', () => {
    // NOT a regression pin (it passed before the fix too): it guards the other direction, that
    // tracking the second pair does not turn every paren entry into a blanket fail-open.
    const entry = '@article(k,\n  title = {A (nested) title},\n  author = {F}\n)';
    expect(cut(entry + '\njunk')).toBe(entry);
  });

  // A `"`-quoted value must stay opaque even when an earlier value left the OTHER pair open.
  // Gating the quote-skip on `otherDepth === 0` made it transparent there, so the delimiters
  // inside a string counted as structure and the entry was cut at a `}` sitting inside one. The
  // fragment is delimiter-balanced and ends with a lone closer on its own line — it looks whole —
  // but its `"` is unterminated, which in a .bib swallows every entry appended after it. That is
  // the "truncated-but-plausible" outcome this whole function ranks as worse than trailing junk,
  // and it is the one direction the alone-on-its-line rule was not allowed to move.
  it('keeps a quoted value opaque when an earlier value left the other pair open', () => {
    const brace = '@article{k,\n  a = {x(},\n  b = "z)\n}\n",\n}';
    expect(cut(brace)).toBe(brace);
    const paren = '@article(k,\n  a = (x{),\n  b = "z}\n)\n",\n)';
    expect(cut(paren)).toBe(paren);
  });
});
