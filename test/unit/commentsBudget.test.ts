import { describe, it, expect } from 'vitest';
import {
  ALLOCATION_ORDER,
  COMMENTS_CONTENT_BUDGET,
  COMMENTS_JSON_SCAFFOLD_OVERHEAD,
  COMMENTS_NOTE_RESERVE,
  COMMENT_NOTE_CAP,
  COMMENT_QUOTE_CAP,
  clipText,
  commentRenderCost,
  planCommentsPayload,
  renderCommentText,
  renderCommentsText,
  type CommentLike,
  type CommentsPlan,
} from '../../src/lib/commentsBudget.js';

/**
 * `list_comments` had no bound of any kind and rendered every comment TWICE — once into
 * `structuredContent.comments`, once into the result text (#163). These pin the planner that fixed
 * it, and above all they pin the accounting against what the tool actually sends: the JSON of the
 * whole plan (the tool spreads it into `structuredContent`) **plus** the rendered text. A budget
 * that charged one channel would be wrong by 2x and this file would still be green.
 */

/** Exactly what the tool puts on the wire: `structuredContent: { ...plan }`, and the text. */
function wireSize(plan: CommentsPlan): number {
  return JSON.stringify(plan).length + renderCommentsText(plan).length;
}

function comment(i: number, over: Partial<CommentLike> = {}): CommentLike {
  return {
    id: `c${i}`,
    number: i,
    page: 1 + (i % 12),
    note: `tighten paragraph ${i}`,
    quote: `The selected sentence of comment ${i}`,
    file: 'sections/intro.tex',
    line: 100 + i,
    snippet: ['a', 'b', 'c', 'd', 'e'].map((l) => `${l.repeat(60)} ${i}`).join('\n'),
    snippetStartLine: 98 + i,
    resolved: false,
    ...over,
  };
}

function many(n: number, over: (i: number) => Partial<CommentLike> = () => ({})): CommentLike[] {
  return Array.from({ length: n }, (_, i) => comment(i + 1, over(i + 1)));
}

describe('commentsBudget: the bound itself', () => {
  it('bounds BOTH channels together for a 200-comment review pass', () => {
    // Long quotes and long source lines, which is the case the issue names: a review pass leaving
    // 200 comments is ordinary, and a PDF selection can be a paragraph.
    const comments = many(200, (i) => ({
      quote: `selection ${i} `.repeat(120),
      note: `please rework this passage, it reads badly — comment ${i}. `.repeat(6),
    }));
    const plan = planCommentsPayload(comments);

    expect(wireSize(plan)).toBeLessThanOrEqual(COMMENTS_CONTENT_BUDGET);
    // ...and the unbudgeted payload really was far over it, so the bound is not vacuous.
    const unbudgeted =
      JSON.stringify({ comments }).length +
      comments.map((c) => renderCommentText(c)).join('\n\n').length;
    expect(unbudgeted).toBeGreaterThan(10 * COMMENTS_CONTENT_BUDGET);
  });

  it('bounds a pathological single-field blowup too (one page-sized quote each)', () => {
    const plan = planCommentsPayload(
      many(40, () => ({ quote: 'x'.repeat(40000), note: 'y'.repeat(9000) })),
    );
    expect(wireSize(plan)).toBeLessThanOrEqual(COMMENTS_CONTENT_BUDGET);
  });

  it('every listed comment stays addressable by id, and the dropped ones are counted', () => {
    const comments = many(200, (i) => ({ quote: `sel ${i} `.repeat(200) }));
    const plan = planCommentsPayload(comments);

    // No comment is ever half-listed: id, number and note are the fields resolve_comments and the
    // reader need, and they survive for everything in the list.
    for (const c of plan.comments) {
      expect(c.id).toMatch(/^c\d+$/);
      expect(c.number).toBeGreaterThan(0);
      expect(c.note.length).toBeGreaterThan(0);
    }
    // The listed set is a prefix of the user's own #1..#N numbering, so "list again after
    // resolving" actually reaches the rest.
    expect(plan.comments.map((c) => c.id)).toEqual(
      comments.slice(0, plan.comments.length).map((c) => c.id),
    );
    expect(plan.comments.length + plan.commentsOmitted).toBe(comments.length);
    expect(plan.truncated).toBe(true);
    expect(plan.budgetNote).toContain('still in the viewer');
  });

  it('cuts recoverable fields across EVERY comment before dropping a single comment', () => {
    // The whole point of the within-a-comment priority: quote and snippet are recoverable, a
    // dropped comment is not. So a list that only just overflows loses its snippets, not its tail.
    const plan = planCommentsPayload(many(30));

    expect(plan.commentsOmitted).toBe(0);
    expect(plan.snippetsOmitted).toBeGreaterThan(0);
    expect(plan.comments).toHaveLength(30);
  });

  it('spends the budget in ALLOCATION_ORDER: snippets go before quotes', () => {
    const plan = planCommentsPayload(many(50));

    expect(ALLOCATION_ORDER).toEqual(['identity+note', 'quote', 'snippet']);
    // Every one of the 50 snippets is gone, and not one quote — never the other way round, and
    // no comment dropped while a recoverable field was still being carried.
    expect(plan.comments).toHaveLength(50);
    expect(plan.commentsOmitted).toBe(0);
    expect(plan.snippetsOmitted).toBe(50);
    expect(plan.quotesOmitted).toBe(0);
    expect(plan.comments.every((c) => c.quote !== undefined)).toBe(true);
  });

  it('cuts a tail within a lane rather than cherry-picking the small ones', () => {
    // Comment 1 has a tiny quote, comment 2 a huge one. Once 2's quote does not fit, 3's must not
    // slip in behind it just because it is small — a cherry-picked list is a different answer.
    const comments = [
      comment(1, { quote: 'tiny', snippet: undefined, snippetStartLine: undefined }),
      comment(2, { quote: 'Z'.repeat(400), snippet: undefined, snippetStartLine: undefined }),
      comment(3, { quote: 'also tiny', snippet: undefined, snippetStartLine: undefined }),
    ];
    // Sized so comment 1's quote fits and comment 2's does not.
    const plan = planCommentsPayload(comments, { budget: COMMENTS_NOTE_RESERVE + 1600 });

    expect(plan.comments[0]!.quote).toBe('tiny');
    expect(plan.comments[1]!.quote).toBeUndefined();
    expect(plan.comments[2]!.quote).toBeUndefined();
    expect(plan.quotesOmitted).toBe(2);
  });

  it('keeps one comment even when it alone exceeds the budget', () => {
    const plan = planCommentsPayload(many(5), { budget: 10 });
    expect(plan.comments).toHaveLength(1);
    expect(plan.commentsOmitted).toBe(4);
    expect(plan.comments[0]!.note.length).toBeGreaterThan(0);
  });
});

describe('commentsBudget: a cut is counted, never silent', () => {
  it('tells a cut quote apart from a comment the user selected no text for', () => {
    const plan = planCommentsPayload(
      [
        comment(1, { quote: undefined, snippet: undefined, snippetStartLine: undefined }),
        comment(2, { quote: 'W'.repeat(3000), snippet: undefined, snippetStartLine: undefined }),
      ],
      { budget: COMMENTS_NOTE_RESERVE + 1400 },
    );

    // No quote at all: absent, and no counter — nothing was cut.
    expect(plan.comments[0]!.quote).toBeUndefined();
    expect(plan.comments[0]!.quoteOmittedChars).toBeUndefined();
    // Cut: absent WITH a counter saying how much went.
    expect(plan.comments[1]!.quote).toBeUndefined();
    expect(plan.comments[1]!.quoteOmittedChars).toBe(3000);
    expect(plan.quotesOmitted).toBe(1);
  });

  it('marks a clipped note and a clipped quote per comment, and never drops the note', () => {
    const plan = planCommentsPayload([
      comment(1, { note: 'n'.repeat(COMMENT_NOTE_CAP + 250), quote: 'q'.repeat(9000) }),
    ]);
    const c = plan.comments[0]!;

    expect(c.note).toHaveLength(COMMENT_NOTE_CAP + 1); // clipped text plus the ellipsis
    expect(c.noteOmittedChars).toBe(250);
    expect(c.quote).toHaveLength(COMMENT_QUOTE_CAP + 1);
    expect(c.quoteOmittedChars).toBe(9000 - COMMENT_QUOTE_CAP);
    // A clip is not a drop: the quote is still shown, so quotesOmitted stays 0.
    expect(plan.quotesOmitted).toBe(0);
    expect(plan.truncated).toBe(true);
    expect(plan.budgetNote).toContain('note(s) clipped');
  });

  it('marks a dropped snippet with its full length, so a budget cut is not read as "no snippet"', () => {
    const plan = planCommentsPayload(many(80));
    const withSnippet = plan.comments.filter((c) => c.snippet !== undefined);
    const withoutSnippet = plan.comments.filter((c) => c.snippet === undefined);

    expect(withoutSnippet.length).toBeGreaterThan(0);
    for (const c of withoutSnippet) expect(c.snippetOmittedChars).toBeGreaterThan(0);
    for (const c of withSnippet) expect(c.snippetOmittedChars).toBeUndefined();
    expect(plan.snippetsOmitted).toBe(withoutSnippet.length);
  });

  it('leaves a small result untouched: no counters fire, no budgetNote, no markers', () => {
    const comments = many(3);
    const plan = planCommentsPayload(comments);

    expect(plan.commentsOmitted).toBe(0);
    expect(plan.quotesOmitted).toBe(0);
    expect(plan.snippetsOmitted).toBe(0);
    expect(plan.truncated).toBe(false);
    expect(plan.budgetNote).toBeUndefined();
    expect(renderCommentsText(plan)).not.toContain('chars cut');
    // Byte-for-byte the shape this tool has always emitted.
    expect(renderCommentsText(plan)).toBe(comments.map((c) => renderCommentText(c)).join('\n\n'));
  });

  it('an empty list is "no open comments", never "everything was cut"', () => {
    const plan = planCommentsPayload([]);
    expect(plan.comments).toEqual([]);
    expect(plan.truncated).toBe(false);
    expect(plan.commentsOmitted).toBe(0);
    expect(renderCommentsText(plan)).toBe('No open comments.');
  });
});

describe('commentsBudget: the charge matches what is rendered', () => {
  it('charges a comment in both channels, via the very template that renders it', () => {
    const c = planCommentsPayload([comment(1)]).comments[0]!;
    const cost = commentRenderCost(c);

    expect(cost).toBe(renderCommentText(c).length + JSON.stringify(c).length + 3);
    // A raw-length charge would be roughly half — the defect this whole module exists to fix.
    expect(cost).toBeGreaterThan(1.8 * renderCommentText(c).length);
  });

  it('COMMENTS_JSON_SCAFFOLD_OVERHEAD still accounts for the keys around the array', () => {
    const plan = planCommentsPayload(many(200, (i) => ({ quote: `sel ${i} `.repeat(200) })));
    const scaffold =
      JSON.stringify(plan).length -
      JSON.stringify(plan.comments).length -
      JSON.stringify(plan.budgetNote ?? '').length;

    expect(scaffold).toBeGreaterThan(0);
    expect(scaffold).toBeLessThanOrEqual(COMMENTS_JSON_SCAFFOLD_OVERHEAD);
  });

  it('the longest budgetNote this module can produce fits inside COMMENTS_NOTE_RESERVE', () => {
    // Every branch firing at once, with the widest counters a 20000-char budget could ever show.
    const plan = planCommentsPayload(
      many(300, (i) => ({
        note: 'n'.repeat(COMMENT_NOTE_CAP + 500),
        quote: `q${i} `.repeat(400),
      })),
    );
    const note = plan.budgetNote!;

    expect(note).toContain('comment(s)');
    expect(note).toContain('clipped');
    // Charged in both channels, exactly as the reserve claims to pay for.
    expect(note.length + JSON.stringify(note).length).toBeLessThanOrEqual(COMMENTS_NOTE_RESERVE);
  });

  it('names only the cut that actually fired', () => {
    const plan = planCommentsPayload(many(30));
    expect(plan.budgetNote).toContain('source snippet(s) dropped');
    expect(plan.budgetNote).not.toContain('comment(s) — the other');
    expect(plan.budgetNote).not.toContain('quote(s) dropped');
  });
});

describe('commentsBudget: what it must not do', () => {
  it('never restores a location the unopenable-path guard withheld', () => {
    // `withoutUnopenableLocation` hands the planner a comment with no file/line/snippet. The budget
    // only ever removes fields, so a withheld path can never come back through it.
    const stripped: CommentLike = {
      id: 'c1',
      number: 1,
      page: 2,
      note: 'this one pointed outside the project',
      quote: 'selected',
      file: undefined,
      line: undefined,
      snippet: undefined,
      snippetStartLine: undefined,
      resolved: false,
    };
    const plan = planCommentsPayload([stripped]);

    expect(plan.comments[0]!.file).toBeUndefined();
    expect(plan.comments[0]!.line).toBeUndefined();
    expect(plan.comments[0]!.snippet).toBeUndefined();
    expect(plan.comments[0]!.snippetOmittedChars).toBeUndefined();
    expect(renderCommentsText(plan)).toContain('(unresolved — page 2)');
  });

  it('renders the text from the CUT payload, never from the full one', () => {
    const plan = planCommentsPayload(
      many(200, (i) => ({ quote: `NEEDLE${i} ` + 'x'.repeat(2000) })),
    );
    const text = renderCommentsText(plan);

    expect(plan.quotesOmitted).toBeGreaterThan(0);
    // The last comment whose quote was dropped must not have it back in the text channel.
    const dropped = plan.comments.filter((c) => c.quote === undefined && c.quoteOmittedChars);
    expect(dropped.length).toBeGreaterThan(0);
    expect(text).not.toContain(`NEEDLE${dropped[dropped.length - 1]!.number}`);
    expect(text.length).toBeLessThan(COMMENTS_CONTENT_BUDGET);
  });

  it('clipText never leaves a lone surrogate half', () => {
    const astral = '😀'.repeat(10); // two UTF-16 code units each
    const cut = clipText(astral, 5); // would land between the halves of the third emoji
    expect(cut.text.slice(0, -1)).toBe('😀😀');
    expect(
      [...cut.text].every((ch) => ch.codePointAt(0)! < 0xd800 || ch.codePointAt(0)! > 0xdfff),
    ).toBe(true);
    expect(cut.omitted).toBe(16);
    expect(clipText('short', 99)).toEqual({ text: 'short', omitted: 0 });
  });
});
