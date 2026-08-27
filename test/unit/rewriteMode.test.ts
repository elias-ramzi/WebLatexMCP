import { describe, it, expect } from 'vitest';
import {
  commentOut,
  classifyEdit,
  createPreserveTransform,
  resolveRewriteMode,
  supportsLineComments,
  NEAR_IDENTICAL_OVERLAP_THRESHOLD,
  MIN_UNMATCHED_BIGRAMS_FOR_PROSE,
  nearIdenticalOverlap,
  tokenMultisetOverlap,
  markupMask,
  DEFAULT_REWRITE_MODE,
} from '../../src/lib/rewriteMode.js';
import type { EditOp } from '../../src/services/fileService.js';

/**
 * Apply `edit` to `content` exactly the way `FileService.applyEdits` does for a non-replaceAll
 * edit: find the (first, and here always unique) match, hand it to the transform to get the
 * actual replacement text, then splice it in. Used so these unit tests exercise the transform
 * the same way the real caller does, rather than calling it in isolation with a hand-picked
 * `matchIndex` that might not correspond to a real match.
 */
function applyWithTransform(
  content: string,
  edit: EditOp,
  transform: (edit: EditOp, matchIndex: number, content: string) => string,
): string {
  const matchIndex = content.indexOf(edit.oldString);
  const newString = transform(edit, matchIndex, content);
  return (
    content.slice(0, matchIndex) + newString + content.slice(matchIndex + edit.oldString.length)
  );
}

describe('commentOut', () => {
  it('prefixes a single line', () => {
    expect(commentOut('hello world')).toBe('% hello world');
  });

  it('prefixes every line of a multi-line block', () => {
    expect(commentOut('one\ntwo\nthree')).toBe('% one\n% two\n% three');
  });

  it('double-comments a line that already starts with %, faithfully', () => {
    expect(commentOut('% already a comment')).toBe('% % already a comment');
    expect(commentOut('%no space')).toBe('% %no space');
  });

  it('turns an empty interior line into a bare % with no trailing space', () => {
    expect(commentOut('a\n\nb')).toBe('% a\n%\n% b');
  });

  it('preserves trailing-newline shape without a stray trailing % line', () => {
    expect(commentOut('a\nb\n')).toBe('% a\n% b\n');
    expect(commentOut('a\nb')).toBe('% a\n% b');
  });

  it('round-trips CRLF line endings', () => {
    expect(commentOut('a\r\nb\r\n')).toBe('% a\r\n% b\r\n');
    expect(commentOut('a\r\nb')).toBe('% a\r\n% b');
  });

  it('turns an empty CRLF line into a bare "%\\r" — no trailing space before the \\r', () => {
    // Regression coverage: an earlier version of the map only special-cased the '' segment,
    // missing the '\r'-only segment an empty CRLF line splits into, so it produced '% \r'
    // (trailing space) instead of '%\r'.
    expect(commentOut('\r\n')).toBe('%\r\n');
    expect(commentOut('a\r\n\r\nb')).toBe('% a\r\n%\r\n% b');
  });

  it('handles an empty string', () => {
    expect(commentOut('')).toBe('%');
  });
});

describe('classifyEdit', () => {
  it('classifies a real multi-sentence paragraph rewrite as prose', () => {
    const oldString =
      'The proposed method achieves strong results on the benchmark and generalizes well across ' +
      'domains, outperforming prior baselines by a large margin in every setting we tested.';
    const newString =
      'Our approach delivers competitive accuracy on the dataset while transferring effectively ' +
      'between tasks, exceeding earlier comparisons by a wide gap under all conditions examined.';
    expect(classifyEdit(oldString, newString)).toBe('prose');
  });

  it('classifies a typo fix inside a long sentence as minor', () => {
    const oldString =
      'We propose a nvoel method that improves accuracy across all benchmarks tested.';
    const newString =
      'We propose a novel method that improves accuracy across all benchmarks tested.';
    expect(classifyEdit(oldString, newString)).toBe('minor');
  });

  it('classifies a changed number as minor', () => {
    const oldString =
      'The model achieves an accuracy of 91.2 percent on the held out test set overall.';
    const newString =
      'The model achieves an accuracy of 93.4 percent on the held out test set overall.';
    expect(classifyEdit(oldString, newString)).toBe('minor');
  });

  it('classifies a swapped \\cite key as minor', () => {
    const oldString =
      'This idea was first introduced in prior work \\cite{smith2020} and later extended.';
    const newString =
      'This idea was first introduced in prior work \\cite{jones2021} and later extended.';
    expect(classifyEdit(oldString, newString)).toBe('minor');
  });

  it('classifies a renamed \\label as minor', () => {
    const oldString = 'We show the overview diagram in \\autoref{fig:overview_old} for the reader.';
    const newString = 'We show the overview diagram in \\autoref{fig:overview_new} for the reader.';
    expect(classifyEdit(oldString, newString)).toBe('minor');
  });

  it('classifies a one-word swap as minor', () => {
    const oldString =
      'This approach is remarkably fast and scales gracefully to very large datasets.';
    const newString =
      'This approach is remarkably slow and scales gracefully to very large datasets.';
    expect(classifyEdit(oldString, newString)).toBe('minor');
  });

  it('classifies a short (<8 token) rewrite as minor', () => {
    const oldString = 'a completely different short phrase';
    const newString = 'nothing whatsoever like the original text';
    expect(classifyEdit(oldString, newString)).toBe('minor');
  });

  it('classifies a mostly-markup block (>= 8 tokens) as minor even when heavily rewritten', () => {
    const oldString =
      '\\begin{tabular}{c c c} \\hline a & b & c \\\\ 1 & 2 & 3 \\\\ \\hline \\end{tabular}';
    const newString =
      '\\begin{tabular}{c c c} \\hline x & y & z \\\\ 9 & 8 & 7 \\\\ \\hline \\end{tabular}';
    expect(classifyEdit(oldString, newString)).toBe('minor');
  });

  it('classifies a heavily-markup equation block as minor', () => {
    const oldString =
      '$$ f(x) = a x^2 + b x + c \\quad \\text{where} \\quad a \\neq 0 \\quad \\text{always} $$';
    const newString =
      '$$ g(y) = p y^3 + q y + r \\quad \\text{where} \\quad p \\neq 0 \\quad \\text{never} $$';
    expect(classifyEdit(oldString, newString)).toBe('minor');
  });

  it('boundary: exactly 7 tokens stays minor, exactly 8 (non-markup, low overlap) is prose', () => {
    const sevenTokenOld = 'one two three four five six seven';
    expect(sevenTokenOld.split(/\s+/).length).toBe(7);
    expect(classifyEdit(sevenTokenOld, 'totally rewritten content here now indeed yes')).toBe(
      'minor',
    );

    const eightTokenOld = 'one two three four five six seven eight';
    expect(eightTokenOld.split(/\s+/).length).toBe(8);
    expect(
      classifyEdit(eightTokenOld, 'completely different words appear here instead now today'),
    ).toBe('prose');
  });

  it('boundary: bigram-overlap fraction just above vs just below the threshold', () => {
    // 11 tokens -> 10 bigrams. Keep the first 8 tokens (7 matching bigrams, 70% -> at
    // threshold, "minor"); keep only the first 7 tokens (6 matching bigrams, 60% -> "prose").
    const oldString = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda';
    const atThreshold = 'alpha beta gamma delta epsilon zeta eta theta ONE TWO THREE';
    expect(nearIdenticalOverlap(oldString.split(' '), atThreshold.split(' '))).toBe(
      NEAR_IDENTICAL_OVERLAP_THRESHOLD,
    );
    expect(classifyEdit(oldString, atThreshold)).toBe('minor');

    const belowThreshold = 'alpha beta gamma delta epsilon zeta eta ONE TWO THREE FOUR';
    expect(nearIdenticalOverlap(oldString.split(' '), belowThreshold.split(' '))).toBe(0.6);
    expect(classifyEdit(oldString, belowThreshold)).toBe('prose');
  });

  it('does not classify an 8-token single-word typo fix as prose — pins the 0.014 margin above NEAR_IDENTICAL_OVERLAP_THRESHOLD the docstring describes', () => {
    // NEAR_IDENTICAL_OVERLAP_THRESHOLD's docstring states its worst case: a single interior-token
    // fix in an 8-token string floors the bigram overlap at 5/7 ≈ 0.714, clearing the 0.7
    // threshold by only 0.014. The existing boundary test above only compares the computed
    // overlap against the implementation's own constant, so it can't tell you *why* the margin
    // matters — raising the threshold to, say, 0.72 would break that assertion without saying
    // what breaks for a real caller. This test pins the consequence directly: an 8-token typo fix
    // (exactly the docstring's shape) must stay 'minor', not get silently preserved as 'prose'.
    const oldString = 'one two three four five six seven eight';
    const newString = 'one two THREE four five six seven eight';
    expect(nearIdenticalOverlap(oldString.split(' '), newString.split(' '))).toBeCloseTo(5 / 7);
    expect(classifyEdit(oldString, newString)).toBe('minor');
  });

  it('classifies a pure reordering of the same clauses as prose (order-sensitive measure)', () => {
    // A bag-of-tokens count sees these as ~identical; the bigram measure sees the pipeline
    // order inverted, which is exactly the kind of change that must not be silently lost.
    const oldString =
      'We first train the model on ImageNet, and then we fine-tune it on COCO for detection.';
    const newString =
      'We first fine-tune it on COCO for detection, and then we train the model on ImageNet.';
    expect(classifyEdit(oldString, newString)).toBe('prose');
  });

  it('classifies an active-to-passive rewrite as prose', () => {
    const oldString =
      'The researchers trained the network on a large corpus of unlabeled text before fine-tuning.';
    const newString =
      'The network was trained on a large corpus of unlabeled text by the researchers before fine-tuning.';
    expect(classifyEdit(oldString, newString)).toBe('prose');
  });

  it('classifies a clause swap as prose', () => {
    // Not a discriminating case for order-sensitivity: measured against a bag-of-tokens
    // counterfactual, this scores 'prose' either way (unigram overlap ~0.69, bigram ~0.58), since
    // the two clauses share almost no bigrams across their new boundary regardless of order. The
    // pipeline-reorder and active-to-passive tests above are what actually pin that the measure is
    // order-sensitive (they score 'minor' under unigram overlap but 'prose' under bigram overlap).
    // This test is kept because it is still a real, common rewrite shape worth covering.
    const oldString =
      'Although the baseline is simple, it performs surprisingly well across every benchmark tested.';
    const newString =
      'It performs surprisingly well across every benchmark tested, although the baseline is simple.';
    expect(classifyEdit(oldString, newString)).toBe('prose');
  });

  it('classifies a full rewrite of complete inline-math tokens as minor (not prose)', () => {
    // Every token is entirely a "$...$" span, so none of them count as prose words, no matter
    // how thoroughly the math itself is rewritten.
    const oldString = '$x$ $y$ $z$ $a$ $b$ $c$ $d$ $e$';
    const newString = '$p$ $q$ $r$ $s$ $t$ $u$ $v$ $w$';
    expect(classifyEdit(oldString, newString)).toBe('minor');
  });

  it('classifies a deletion of a qualifying paragraph as prose', () => {
    const oldString =
      'This entire paragraph should be preserved in a comment above when it is deleted outright.';
    expect(classifyEdit(oldString, '')).toBe('prose');
  });

  it('does not let an unclosed "$" mask the rest of oldString as markup', () => {
    // Regression coverage: markupMask used to toggle inMath on any odd-"$"-count token and never
    // untoggle if the span was never closed, so one unbalanced "$" (invalid LaTeX, but exactly
    // the kind of draft text a prose rewrite targets) marked every later token as markup, failed
    // the strict-majority prose test, and silently dropped a genuine paragraph rewrite to
    // 'minor'. Only 1 of oldString's 20 tokens ("$50") even contains a "$"; the rest of the
    // sentence is plain prose and must count as such.
    const oldString =
      'The annual compute budget for this project is about $50 thousand which limits the number of runs we can afford.';
    const newString =
      'Compute for the project costs roughly fifty thousand dollars, capping how many runs are affordable.';
    expect(classifyEdit(oldString, newString)).toBe('prose');
  });

  it('classifies a total rewrite of a sentence containing escaped currency as prose', () => {
    // Regression coverage: an earlier version let the escaped "\$100" toggle markupMask's inMath
    // state, masking every token after it as markup for the rest of the string — only 4 of 13
    // tokens counted as prose (a minority), so classifyEdit returned 'minor' for a totally
    // different sentence. Now "\$100" is markup on its own (leading-backslash rule) but does not
    // mask its neighbors, so the majority of tokens are prose and the near-identical check (very
    // low overlap) correctly calls this a rewrite worth preserving.
    const oldString =
      'The annual budget of \\$100 covers every compute cost for the whole project.';
    const newString =
      'This entirely unrelated sentence discusses completely different topics using other words.';
    expect(classifyEdit(oldString, newString)).toBe('prose');
  });

  it('classifies a pure in-place expansion (old text wholly retained) as minor', () => {
    // Deliberate decision (see classifyEdit's doc comment): nothing is lost when the old text
    // survives verbatim inside the new text, so there is nothing to protect with a comment.
    const oldString =
      'The proposed method achieves strong results on the benchmark across every setting tested.';
    const newString =
      oldString +
      ' Additional analysis in the appendix further supports this conclusion in detail.';
    expect(classifyEdit(oldString, newString)).toBe('minor');
  });

  describe('absolute-loss floor (MIN_UNMATCHED_BIGRAMS_FOR_PROSE)', () => {
    // A 110-token paragraph built from ten ~11-token sentences. Deleting one whole sentence loses
    // 11 of the paragraph's 109 bigrams, and on this fixture all three positions measure the same
    // overlap — 0.8997 for leading, interior and trailing alike. Position is not merely a small
    // effect here, it is no effect: an edge deletion breaks one rejoin seam and an interior one
    // breaks two, but the repeated sentence shape means the seam bigram matches either way.
    // So the *fraction* of surviving bigrams stays far above NEAR_IDENTICAL_OVERLAP_THRESHOLD in
    // every case — diluted away by the length of the paragraph, which is the failure the absolute
    // floor exists for. Before the floor existed all three scored 'minor': a whole missing
    // sentence, well past the floor, silently not preserved. The three cases below pin that the
    // floor catches it wherever the sentence sat; none of them demonstrates a mid-vs-end contrast,
    // because on these numbers there is none to demonstrate.
    function sentences(n: number): string[] {
      const out: string[] = [];
      for (let i = 1; i <= n; i++) {
        out.push(`The method achieves strong results in experimental setting number ${i} today.`);
      }
      return out;
    }
    const allSentences = sentences(10);
    const oldString = allSentences.join(' ');

    it('classifies a trailing sentence deleted from a long paragraph as prose', () => {
      const newString = allSentences.slice(0, 9).join(' ');
      expect(classifyEdit(oldString, newString)).toBe('prose');
    });

    it('classifies a leading sentence deleted from a long paragraph as prose', () => {
      const newString = allSentences.slice(1).join(' ');
      expect(classifyEdit(oldString, newString)).toBe('prose');
    });

    it('classifies an interior sentence deleted from a long paragraph as prose (same floor, two seams)', () => {
      // Not a discriminating case on its own — it scores 'prose' for the same reason the
      // leading/trailing deletions above do (the absolute floor), and would flip to 'minor'
      // alongside them if the floor were removed. Kept because it pins that the floor applies
      // uniformly regardless of where in the paragraph the missing sentence sat, including the
      // two-seam (interior) case, not because it demonstrates a different fraction outcome.
      const newString = allSentences.slice(0, 4).concat(allSentences.slice(5)).join(' ');
      expect(classifyEdit(oldString, newString)).toBe('prose');
    });

    it('classifies a single one-token change in a long paragraph as minor', () => {
      // Loses exactly 2 bigrams — well under the floor of 6 — and the fraction alone is also
      // still high, so both tests agree: minor.
      const newString = oldString.replace('setting number 5', 'setting count 5');
      const oldTokens = oldString.split(/\s+/);
      const newTokens = newString.split(/\s+/);
      expect(nearIdenticalOverlap(oldTokens, newTokens)).toBeGreaterThanOrEqual(
        NEAR_IDENTICAL_OVERLAP_THRESHOLD,
      );
      expect(classifyEdit(oldString, newString)).toBe('minor');
    });

    it('classifies two scattered one-token changes in a long paragraph as minor', () => {
      // Loses exactly 4 bigrams — still under the floor of 6 — so this stays minor too, distinct
      // from the three-change case documented on MIN_UNMATCHED_BIGRAMS_FOR_PROSE which crosses it.
      const newString = oldString
        .replace('setting number 5', 'setting count 5')
        .replace('setting number 8', 'setting count 8');
      expect(classifyEdit(oldString, newString)).toBe('minor');
    });

    it('is documented as 6 with the arithmetic that justifies it', () => {
      expect(MIN_UNMATCHED_BIGRAMS_FOR_PROSE).toBe(6);
    });
  });

  it(
    'characterization: a hyphenation fix in a long sentence scores well below the fraction ' +
      "threshold and is classified 'prose' — a known, safe-direction cost, not a bug. See " +
      "NEAR_IDENTICAL_OVERLAP_THRESHOLD's docstring; this pins current behaviour rather than " +
      'endorsing it.',
    () => {
      const oldString =
        'The state of the art detector reaches ninety percent accuracy on this benchmark.';
      const newString =
        'The state-of-the-art detector reaches ninety percent accuracy on this benchmark.';
      expect(classifyEdit(oldString, newString)).toBe('prose');
    },
  );
});

describe('nearIdenticalOverlap / tokenMultisetOverlap degenerate cases', () => {
  it('falls back to unigram overlap when oldTokens has fewer than 2 tokens', () => {
    expect(nearIdenticalOverlap([], [])).toBe(0);
    expect(nearIdenticalOverlap(['solo'], ['solo'])).toBe(1);
    expect(nearIdenticalOverlap(['solo'], ['different'])).toBe(0);
    // Falls back to tokenMultisetOverlap directly (same value).
    expect(nearIdenticalOverlap(['solo'], ['solo', 'extra'])).toBe(
      tokenMultisetOverlap(['solo'], ['solo', 'extra']),
    );
  });

  it('handles an oldString made entirely of one repeated token', () => {
    const oldTokens = ['same', 'same', 'same', 'same'];
    // All 3 of oldTokens's bigrams are "same same", but newTokens contributes only 1 such
    // bigram to match against (as a multiset), so only 1 of the 3 old bigrams survives.
    expect(nearIdenticalOverlap(oldTokens, ['same', 'same'])).toBeCloseTo(1 / 3);
    expect(nearIdenticalOverlap(oldTokens, ['different', 'words', 'entirely', 'here'])).toBe(0);
  });
});

describe('markupMask', () => {
  it('masks a complete inline-math token as markup', () => {
    const tokens = ['$x$'];
    expect(markupMask(tokens)).toEqual([true]);
  });

  it('masks the opening delimiter of a math span split across tokens', () => {
    // "$x = 1$" tokenizes to ["$x", "=", "1$"] — all three are inside/opening/closing the span.
    const tokens = ['$x', '=', '1$'];
    expect(markupMask(tokens)).toEqual([true, true, true]);
  });

  it('leaves prose tokens outside any math span unmasked', () => {
    const tokens = ['we', '$x', '=', '1$', 'note'];
    expect(markupMask(tokens)).toEqual([false, true, true, true, false]);
  });

  it('does not treat an escaped \\$ (currency) as a math-span toggle', () => {
    // Regression coverage: an earlier version toggled inMath on any odd count of literal "$"
    // chars, even when the "$" was escaped (currency, not a math delimiter), masking every token
    // for the rest of the string as markup. "\$100" is already markup on its own (leading-
    // backslash rule), but the tokens after it must stay unmasked.
    const tokens = ['The', 'cost', 'is', '\\$100', 'today', 'and', 'tomorrow', 'too'];
    expect(markupMask(tokens)).toEqual([false, false, false, true, false, false, false, false]);
  });

  it('masks only itself for an unclosed math-span opener, not the rest of the tokens', () => {
    // Regression coverage for the $50 case: a toggling token with no matching close (an
    // unbalanced "$", e.g. a stray currency sign in draft prose) must not mark every later token
    // as markup. Only "$50" itself is masked; "which" and "note" on either side stay prose.
    const tokens = ['about', '$50', 'which', 'limits', 'note'];
    expect(markupMask(tokens)).toEqual([false, true, false, false, false]);
  });

  it('still masks the whole interior of a properly closed math span (regression guard)', () => {
    // The case the pairing logic exists to get right, unchanged from before the fix: a span
    // opened in one token and closed in a later one still masks everything from the opener
    // through the closer inclusive.
    const tokens = ['we', 'have', '$x', '=', '1$', 'here'];
    expect(markupMask(tokens)).toEqual([false, false, true, true, true, false]);
  });

  it('masks only the first unclosed opener when a second span never closes either', () => {
    // Two togglers with no third one to close the second: the first pair (both togglers) closes
    // the first span, and the trailing odd-one-out masks only itself — never everything after it.
    const tokens = ['$a', 'b$', 'plain', '$c', 'more', 'prose', 'here'];
    expect(markupMask(tokens)).toEqual([true, true, false, true, false, false, false]);
  });
});

describe('createPreserveTransform', () => {
  // NOTE: this describe block used to be `applyRewriteMode` (a function that transformed a whole
  // edit list up front, with no idea where `oldString` sat in the file). That function is gone —
  // the decision moved into `FileService.applyEdits`, where the match position and file content
  // are actually known, so it can refuse to preserve a mid-line match. The tests below are
  // written against `createPreserveTransform`'s `transform` hook, driven the same way
  // `FileService.applyEdits` drives it (see `applyWithTransform` above): find the match, ask the
  // hook for the replacement, splice it in.
  const longProse: EditOp = {
    oldString:
      'The proposed method achieves strong results on the benchmark and generalizes well across ' +
      'domains, outperforming prior baselines by a large margin in every setting we tested.',
    newString:
      'Our approach delivers competitive accuracy on the dataset while transferring effectively ' +
      'between tasks, exceeding earlier comparisons by a wide gap under all conditions examined.',
  };
  const minorTypo: EditOp = {
    oldString: 'We propose a nvoel method that improves accuracy across all benchmarks tested.',
    newString: 'We propose a novel method that improves accuracy across all benchmarks tested.',
  };

  it('off preserves nothing and leaves content unchanged', () => {
    const content = `${longProse.oldString}\n${minorTypo.oldString}\n`;
    const preserve = createPreserveTransform('off');
    const afterFirst = applyWithTransform(content, longProse, preserve.transform);
    expect(afterFirst).toBe(`${longProse.newString}\n${minorTypo.oldString}\n`);
    expect(preserve.preservedEdits()).toBe(0);
  });

  it('always preserves a whole-line edit, and a whole-line deletion with no trailing blank line', () => {
    const deletion: EditOp = {
      oldString: 'delete this whole sentence please right now today.',
      newString: '',
    };
    const content = `${longProse.oldString}\n${deletion.oldString}\n`;
    const preserve = createPreserveTransform('always');

    const afterFirst = applyWithTransform(content, longProse, preserve.transform);
    expect(afterFirst).toBe(
      `${commentOut(longProse.oldString)}\n${longProse.newString}\n${deletion.oldString}\n`,
    );

    const afterSecond = applyWithTransform(afterFirst, deletion, preserve.transform);
    // The deletion's line (including its own trailing newline in the file) is replaced by just
    // the commented block — no stray blank line left behind.
    expect(afterSecond).toBe(
      `${commentOut(longProse.oldString)}\n${longProse.newString}\n${commentOut(deletion.oldString)}\n`,
    );
    expect(preserve.preservedEdits()).toBe(2);
  });

  it('prose mode discriminates: preserves the prose edit, not the minor one', () => {
    const content = `${longProse.oldString}\n${minorTypo.oldString}\n`;
    const preserve = createPreserveTransform('prose');

    const afterFirst = applyWithTransform(content, longProse, preserve.transform);
    expect(afterFirst).toBe(
      `${commentOut(longProse.oldString)}\n${longProse.newString}\n${minorTypo.oldString}\n`,
    );

    const afterSecond = applyWithTransform(afterFirst, minorTypo, preserve.transform);
    expect(afterSecond).toBe(
      `${commentOut(longProse.oldString)}\n${longProse.newString}\n${minorTypo.newString}\n`,
    );
    expect(preserve.preservedEdits()).toBe(1);
  });

  it('passes an identical oldString/newString edit through untransformed in every mode', () => {
    const noop: EditOp = {
      oldString: 'same text here and nothing changes at all whatsoever',
      newString: 'same text here and nothing changes at all whatsoever',
    };
    const content = `${noop.oldString}\n`;
    for (const mode of ['off', 'prose', 'always'] as const) {
      const preserve = createPreserveTransform(mode);
      const result = applyWithTransform(content, noop, preserve.transform);
      expect(result).toBe(content);
      expect(preserve.preservedEdits()).toBe(0);
    }
  });

  it('does not double a trailing newline when commentOut already produced one (EOF case)', () => {
    const edit: EditOp = {
      oldString: 'a multi line block\nthat already ends\nwith a trailing newline right here now\n',
      newString: 'replacement text goes here instead of the original content shown above',
    };
    // oldString itself already ends in "\n", so its match is line-aligned trivially at both ends
    // when it is the entire (single-edit) file content.
    const content = edit.oldString;
    const preserve = createPreserveTransform('always');
    const result = applyWithTransform(content, edit, preserve.transform);
    const expectedCommented = commentOut(edit.oldString);
    expect(expectedCommented.endsWith('\n')).toBe(true);
    expect(result).toBe(expectedCommented + edit.newString);
    expect(result).not.toContain('\n\n' + edit.newString);
    expect(preserve.preservedEdits()).toBe(1);
  });

  describe('oldString whose own bytes include the trailing newline (Finding 4)', () => {
    // Round 1's fix rewrote the EOF case above so oldString === content exactly — the match's
    // "end" is content.length either way, so atLineEnd was trivially true regardless of whether
    // it checked oldString's own trailing newline. That sidesteps the actual bug: atLineStart
    // and end-of-file are not the only ways to be line-aligned — a match can also END with its
    // own trailing "\n" and still have real content (another line) after it in the file. Before
    // the fix, `atLineEnd` only looked at `content[end]`, which in that case is the first
    // character of the *next* line, not a newline — so a flagship "delete this whole paragraph"
    // edit was judged not line-aligned and silently dropped uncommented.
    it('preserves a mid-file paragraph whose oldString itself ends with "\\n", with real content after it', () => {
      const para =
        'This entire paragraph should be preserved in a comment above when it is deleted outright.';
      const edit: EditOp = { oldString: `${para}\n`, newString: '' };
      const content = `first.\n${edit.oldString}last.\n`;
      const preserve = createPreserveTransform('always');
      const result = applyWithTransform(content, edit, preserve.transform);
      // Pre-fix this silently deleted the paragraph outright (preservedEdits: 0). Post-fix, the
      // commented block already carries its own trailing "\n" (from oldString's own bytes), so
      // no separator is added and "last." is untouched on its own line.
      expect(result).toBe(`first.\n${commentOut(edit.oldString)}last.\n`);
      expect(result).toContain('% This entire paragraph');
      expect(result).toContain('last.\n');
      expect(preserve.preservedEdits()).toBe(1);
    });

    it('preserves a mid-file replacement whose oldString ends with "\\n", joining with the replacement on its own line', () => {
      const para =
        'This entire paragraph should be preserved in a comment above the replacement text.';
      const replacement = 'A completely different paragraph now stands in its place instead.';
      const edit: EditOp = { oldString: `${para}\n`, newString: replacement };
      const content = `first.\n${edit.oldString}last.\n`;
      const preserve = createPreserveTransform('always');
      const result = applyWithTransform(content, edit, preserve.transform);
      expect(result).toBe(`first.\n${commentOut(edit.oldString)}${replacement}\nlast.\n`);
      expect(result).not.toContain('\n\n' + replacement);
      expect(preserve.preservedEdits()).toBe(1);
    });

    // The terminator is restored only when newString does not already carry one. A caller that
    // mirrors its oldString — including the trailing newline on both sides — is the natural way
    // to write a whole-line replacement, and restoring unconditionally gave it a second
    // terminator: a blank line, which LaTeX reads as a paragraph break the edit never asked for.
    it('does not double the terminator when newString already ends with one', () => {
      const para =
        'This entire paragraph should be preserved in a comment above the replacement text.';
      const replacement = 'A completely different paragraph now stands in its place instead.';
      const edit: EditOp = { oldString: `${para}\n`, newString: `${replacement}\n` };
      const content = `first.\n${edit.oldString}last.\n`;
      const preserve = createPreserveTransform('always');
      const result = applyWithTransform(content, edit, preserve.transform);
      expect(result).toBe(`first.\n${commentOut(edit.oldString)}${replacement}\nlast.\n`);
      expect(result).not.toContain('\n\n');
      expect(preserve.preservedEdits()).toBe(1);
    });

    it('does not double a CRLF terminator when newString already ends with one', () => {
      const para =
        'This entire paragraph should be preserved in a comment above the replacement text.';
      const replacement = 'A completely different paragraph now stands in its place instead.';
      const edit: EditOp = { oldString: `${para}\r\n`, newString: `${replacement}\r\n` };
      const content = `first.\r\n${edit.oldString}last.\r\n`;
      const preserve = createPreserveTransform('always');
      const result = applyWithTransform(content, edit, preserve.transform);
      expect(result).toBe(`first.\r\n${commentOut(edit.oldString)}${replacement}\r\nlast.\r\n`);
      expect(result).not.toContain('\r\n\r\n');
      expect(preserve.preservedEdits()).toBe(1);
    });
  });

  describe('line-alignment (Finding 1)', () => {
    it('declines a mid-line deletion: the rest of the line survives, uncommented', () => {
      const oldString = 'This is a long prose sentence with many ordinary words here.';
      const content = `Alpha beta. ${oldString} Gamma delta.\n`;
      const edit: EditOp = { oldString, newString: '' };
      const preserve = createPreserveTransform('always');
      const result = applyWithTransform(content, edit, preserve.transform);
      // Reproduction from the task: Gamma delta. was never in oldString and must not be
      // swallowed into a "%" comment, nor lost.
      expect(result).toBe('Alpha beta.  Gamma delta.\n');
      expect(result).not.toContain('%');
      expect(preserve.preservedEdits()).toBe(0);
    });

    it('declines a mid-line replacement: no reflow onto the replacement line', () => {
      const oldString =
        'This is a long prose sentence with enough ordinary words to qualify as prose here.';
      const newString =
        'A completely different clause replaces the old one with entirely unrelated wording.';
      const content = `Alpha beta. ${oldString} Gamma delta.\n`;
      const edit: EditOp = { oldString, newString };
      const preserve = createPreserveTransform('always');
      const result = applyWithTransform(content, edit, preserve.transform);
      expect(result).toBe(`Alpha beta. ${newString} Gamma delta.\n`);
      expect(result).not.toContain('%');
      expect(preserve.preservedEdits()).toBe(0);
    });

    it('preserves a whole-line match at the very start of the file', () => {
      const content = `${longProse.oldString}\nsecond line stays put here always.\n`;
      const preserve = createPreserveTransform('always');
      const result = applyWithTransform(content, longProse, preserve.transform);
      expect(result).toBe(
        `${commentOut(longProse.oldString)}\n${longProse.newString}\nsecond line stays put here always.\n`,
      );
      expect(preserve.preservedEdits()).toBe(1);
    });

    it('preserves a whole-line match at end of file with no trailing newline', () => {
      const content = `first line stays put here always.\n${longProse.oldString}`;
      const preserve = createPreserveTransform('always');
      const result = applyWithTransform(content, longProse, preserve.transform);
      expect(result).toBe(
        `first line stays put here always.\n${commentOut(longProse.oldString)}\n${longProse.newString}`,
      );
      expect(preserve.preservedEdits()).toBe(1);
    });

    it('preserves a whole-line match with CRLF line endings, using \\r\\n between the comment and the replacement (Finding 3)', () => {
      // Corrected in review: the separator between the commented block and the replacement must
      // mirror the line ending the match actually sat on. Before the fix this was hardcoded to a
      // bare '\n', so a CRLF file came back with one stray LF-only line in an otherwise all-CRLF
      // file — a mixed-ending file produced by a fix whose own stated scope was CRLF correctness.
      const content = `first line stays put here always.\r\n${longProse.oldString}\r\nlast line here too.\r\n`;
      const preserve = createPreserveTransform('always');
      const result = applyWithTransform(content, longProse, preserve.transform);
      expect(result).toBe(
        `first line stays put here always.\r\n${commentOut(longProse.oldString)}\r\n${longProse.newString}\r\nlast line here too.\r\n`,
      );
      expect(result).not.toMatch(/[^\r]\n/); // no lone LF anywhere in this all-CRLF file
      expect(preserve.preservedEdits()).toBe(1);
    });
  });

  describe('splice correctness against literal "$"-patterns (Finding 1)', () => {
    // String.prototype.replace treats "$$", "$&", "$`", "$'" and "$<n>" in its *replacement*
    // argument as substitution patterns, not literal text. LaTeX inline math ("$a$", "$b$") is
    // exactly this shape, so a harness that applies the transform's output via `content.replace`
    // (instead of splicing by index, the way `FileService.applyEdits` actually does) can silently
    // corrupt output containing these sequences. This fixture pins the splice against that.
    it("preserves an oldString/newString pair containing literal $&, $$, $`, $', $1 byte-exact, with no substitution-pattern expansion", () => {
      const oldString = 'The mean score $a$ improves over the baseline $b$ today.';
      const newString = "A totally different result $$1 with $& and $` and $' patterns emerges.";
      const edit: EditOp = { oldString, newString };
      const content = `Intro line here.\n${oldString}\nOutro line here.\n`;
      const preserve = createPreserveTransform('always');
      const result = applyWithTransform(content, edit, preserve.transform);
      expect(result).toBe(
        `Intro line here.\n${commentOut(oldString)}\n${newString}\nOutro line here.\n`,
      );
      expect(preserve.preservedEdits()).toBe(1);
    });
  });

  describe('replaceAll defence in depth', () => {
    it(
      "createPreserveTransform's transform refuses to preserve a replaceAll edit even when " +
        'called directly with an otherwise whole-line, aligned match — belt-and-braces on top ' +
        'of FileService.applyEdits never calling this hook for a replaceAll edit at all (proven ' +
        'in test/unit/editFile.test.ts), so this function can never be the reason that guard ' +
        'goes quiet if the call order or a future caller ever changes',
      () => {
        const preserve = createPreserveTransform('always');
        const edit: EditOp = { ...longProse, replaceAll: true };
        const content = `${edit.oldString}\n`;
        const result = applyWithTransform(content, edit, preserve.transform);
        // Applies unchanged: no comment, no preservation, whatever the alignment looks like.
        expect(result).toBe(`${edit.newString}\n`);
        expect(preserve.preservedEdits()).toBe(0);
      },
    );
  });
});

describe('DEFAULT_REWRITE_MODE', () => {
  it('is "off" — preservation writes bytes the caller did not ask for, so it must stay opt-in;', () => {
    // flipping this back to a mode that preserves-by-default is a deliberate act that should
    // fail this test, never a silent side effect of some other change.
    expect(DEFAULT_REWRITE_MODE).toBe('off');
  });
});

describe('resolveRewriteMode', () => {
  it('falls back to the env default when nothing else is set', () => {
    const result = resolveRewriteMode({ stored: null, envDefault: 'prose' });
    expect(result).toEqual({ mode: 'prose', source: 'default' });
  });

  it('the stored per-project mode wins over the env default', () => {
    const result = resolveRewriteMode({ stored: 'always', envDefault: 'off' });
    expect(result).toEqual({ mode: 'always', source: 'project' });
  });

  it('the per-call assertion wins over a stored mode, in both directions', () => {
    // preserveOriginal: true overrides even a stored 'off'.
    expect(resolveRewriteMode({ perCall: true, stored: 'off', envDefault: 'off' })).toEqual({
      mode: 'always',
      source: 'call',
    });
    // preserveOriginal: false overrides even a stored 'always'.
    expect(resolveRewriteMode({ perCall: false, stored: 'always', envDefault: 'always' })).toEqual({
      mode: 'off',
      source: 'call',
    });
  });

  it('the per-call assertion wins over the env default when nothing is stored', () => {
    expect(resolveRewriteMode({ perCall: true, stored: null, envDefault: 'off' })).toEqual({
      mode: 'always',
      source: 'call',
    });
    expect(resolveRewriteMode({ perCall: false, stored: null, envDefault: 'always' })).toEqual({
      mode: 'off',
      source: 'call',
    });
  });
});

describe('supportsLineComments', () => {
  it('is true for the %-comment extensions, case-insensitively', () => {
    expect(supportsLineComments('main.tex')).toBe(true);
    expect(supportsLineComments('macros.sty')).toBe(true);
    expect(supportsLineComments('thesis.cls')).toBe(true);
    expect(supportsLineComments('refs.bbl')).toBe(true);
    expect(supportsLineComments('MAIN.TEX')).toBe(true);
    expect(supportsLineComments('sections/intro.Tex')).toBe(true);
    expect(supportsLineComments('paper.latex')).toBe(true);
    expect(supportsLineComments('paper.ltx')).toBe(true);
  });

  it('is false for a .bib and for non-LaTeX documents', () => {
    expect(supportsLineComments('refs.bib')).toBe(false);
    expect(supportsLineComments('notes.md')).toBe(false);
    expect(supportsLineComments('readme.txt')).toBe(false);
    expect(supportsLineComments('no-extension')).toBe(false);
  });
});
