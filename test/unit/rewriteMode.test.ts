import { describe, it, expect } from 'vitest';
import {
  commentOut,
  classifyEdit,
  applyRewriteMode,
  resolveRewriteMode,
  supportsLineComments,
  NEAR_IDENTICAL_OVERLAP_THRESHOLD,
  nearIdenticalOverlap,
  tokenMultisetOverlap,
  markupMask,
} from '../../src/lib/rewriteMode.js';
import type { EditOp } from '../../src/services/fileService.js';

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
});

describe('applyRewriteMode', () => {
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

  it('off preserves nothing and leaves edits unchanged', () => {
    const result = applyRewriteMode([longProse, minorTypo], 'off');
    expect(result.preservedEdits).toBe(0);
    expect(result.edits).toEqual([longProse, minorTypo]);
  });

  it('always preserves every edit, including a deletion with no trailing blank line', () => {
    const deletion: EditOp = {
      oldString: 'delete this whole sentence please right now today.',
      newString: '',
    };
    const result = applyRewriteMode([longProse, deletion], 'always');
    expect(result.preservedEdits).toBe(2);
    expect(result.edits[0]!.newString).toBe(
      commentOut(longProse.oldString) + '\n' + longProse.newString,
    );
    expect(result.edits[1]!.newString).toBe(commentOut(deletion.oldString));
    expect(result.edits[1]!.newString.endsWith('\n')).toBe(false);
  });

  it('prose mode discriminates: preserves the prose edit, not the minor one', () => {
    const result = applyRewriteMode([longProse, minorTypo], 'prose');
    expect(result.preservedEdits).toBe(1);
    expect(result.edits[0]!.newString).toBe(
      commentOut(longProse.oldString) + '\n' + longProse.newString,
    );
    expect(result.edits[1]!).toEqual(minorTypo);
  });

  it('carries replaceAll and other fields through untouched', () => {
    const edit: EditOp = { ...longProse, replaceAll: true };
    const result = applyRewriteMode([edit], 'always');
    expect(result.edits[0]!.replaceAll).toBe(true);
  });

  it('passes an identical oldString/newString edit through untransformed in every mode', () => {
    const noop: EditOp = {
      oldString: 'same text here and nothing changes at all whatsoever',
      newString: 'same text here and nothing changes at all whatsoever',
    };
    for (const mode of ['off', 'prose', 'always'] as const) {
      const result = applyRewriteMode([noop], mode);
      expect(result.edits[0]!).toEqual(noop);
      expect(result.preservedEdits).toBe(0);
    }
  });

  it('does not double a trailing newline when commentOut already produced one', () => {
    const edit: EditOp = {
      oldString: 'a multi line block\nthat already ends\nwith a trailing newline right here now\n',
      newString: 'replacement text goes here instead of the original content shown above',
    };
    const result = applyRewriteMode([edit], 'always');
    const expectedCommented = commentOut(edit.oldString);
    expect(expectedCommented.endsWith('\n')).toBe(true);
    expect(result.edits[0]!.newString).toBe(expectedCommented + edit.newString);
    expect(result.edits[0]!.newString).not.toContain('\n\n' + edit.newString);
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
  });

  it('is false for a .bib and for non-LaTeX documents', () => {
    expect(supportsLineComments('refs.bib')).toBe(false);
    expect(supportsLineComments('notes.md')).toBe(false);
    expect(supportsLineComments('readme.txt')).toBe(false);
    expect(supportsLineComments('no-extension')).toBe(false);
  });
});
