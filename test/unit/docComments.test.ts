import { describe, it, expect } from 'vitest';
import { isViewableDocument, normalizeDocPath, resolveDocLine } from '../../src/lib/docComments.js';
import { splitLines } from '../../src/lib/lines.js';

describe('isViewableDocument', () => {
  it.each([
    ['notes.md', true],
    ['notes.MD', true],
    ['docs/guide.markdown', true],
    ['paper-review.local/run/final-review.md', true],
    ['notes.md.txt', false],
    ['notes', false],
    ['.md', false],
    ['main.tex', false],
  ])('%s -> %s', (p, expected) => {
    expect(isViewableDocument(p)).toBe(expected);
  });

  it('accepts a backslash-separated path', () => {
    expect(isViewableDocument('docs\\notes.md')).toBe(true);
  });
});

describe('resolveDocLine: entities as the renderer decodes them', () => {
  it('matches across named and numeric entities beyond the basic five', () => {
    const lines = ['intro', '&copy; 2026 the authors &#8212; all rights', 'outro'];
    expect(resolveDocLine(lines, 1, 3, '© 2026 the authors — all rights')).toBe(2);
    const nb = ['intro', 'ten&nbsp;points of gain', 'outro'];
    expect(resolveDocLine(nb, 1, 3, 'ten\u00a0points of gain')).toBe(2);
  });
});

describe('resolveDocLine', () => {
  const para = splitLines(
    [
      'The first line of the paragraph.', // 1
      'The second line holds the needle here.', // 2
      'And a third line closes it.', // 3
    ].join('\n'),
  );

  it('finds the line a quote sits on', () => {
    expect(resolveDocLine(para, 1, 3, 'holds the needle')).toBe(2);
  });

  it('collapses whitespace in the quote', () => {
    expect(resolveDocLine(para, 1, 3, '  holds   the\n needle ')).toBe(2);
  });

  it('ignores emphasis markup in the source', () => {
    const lines = ['intro', 'some **bold** text here', 'outro'];
    expect(resolveDocLine(lines, 1, 3, 'bold text')).toBe(2);
  });

  it('ignores link syntax in the source', () => {
    const lines = ['intro', 'see [DBLP](https://dblp.org) for more', 'outro'];
    expect(resolveDocLine(lines, 1, 3, 'DBLP')).toBe(2);
    expect(resolveDocLine(lines, 1, 3, 'see DBLP for')).toBe(2);
  });

  it('ignores autolink brackets in the source', () => {
    const lines = ['intro', 'at <https://example.com> now'];
    expect(resolveDocLine(lines, 1, 2, 'at https://example.com now')).toBe(2);
  });

  it('strips the same markup from the quote: a code span with an underscore', () => {
    const lines = ['The opening line.', 'the `my_var` is set', 'A closing line.'];
    expect(resolveDocLine(lines, 1, 3, 'my_var is set')).toBe(2);
  });

  it('decodes a backslash escape in the source before stripping', () => {
    const lines = ['The opening line.', 'a\\_b c', 'A closing line.'];
    expect(resolveDocLine(lines, 1, 3, 'a_b c')).toBe(2);
    // An escaped backslash stays one backslash.
    expect(resolveDocLine(['x', 'p\\\\q'], 1, 2, 'p\\q')).toBe(2);
  });

  it('decodes the basic HTML entities in the source', () => {
    const lines = ['The opening line.', 'R&amp;D budget', 'A closing line.'];
    expect(resolveDocLine(lines, 1, 3, 'R&D budget')).toBe(2);
    expect(resolveDocLine(['x', '&lt;a&gt; &quot;b&quot; &#39;c&#39;'], 1, 2, `<a> "b" 'c'`)).toBe(
      2,
    );
    // An escaped ampersand is a literal `&amp;`, as markdown-it renders it.
    expect(resolveDocLine(['x', '\\&amp;'], 1, 2, '&amp;')).toBe(2);
  });

  it('resolves a CRLF document to the same line as its LF twin', () => {
    const lf = 'one\nthe `my_var` is set\nthree\n';
    const crlf = lf.replaceAll('\n', '\r\n');
    const q = 'my_var is set';
    expect(resolveDocLine(splitLines(crlf), 1, 3, q)).toBe(2);
    expect(resolveDocLine(splitLines(crlf), 1, 3, q)).toBe(resolveDocLine(splitLines(lf), 1, 3, q));
  });

  it('falls back to blockStart when the quote is not found', () => {
    expect(resolveDocLine(para, 1, 3, 'nowhere in this text')).toBe(1);
  });

  it('finds where a quote spanning a line break starts', () => {
    // The first 40 characters run from line 2 onto line 3.
    expect(resolveDocLine(para, 1, 3, 'needle here. And a third line closes it.')).toBe(2);
  });

  it('clamps a blockEnd one past the last line', () => {
    expect(resolveDocLine(para, 3, para.length + 1, 'closes it')).toBe(3);
    expect(resolveDocLine(para, 3, para.length + 1, 'nothing')).toBe(3);
  });

  it('clamps a blockStart past the end', () => {
    expect(resolveDocLine(para, 99, 120, 'nothing')).toBe(3);
  });

  it('treats blockStart 0 as 1', () => {
    expect(resolveDocLine(para, 0, 3, 'nothing')).toBe(1);
  });

  it.each([2.5, '3', Number.NaN, undefined, null, Infinity])(
    'treats a non-integer blockStart %s as 1',
    (start) => {
      expect(resolveDocLine(para, start, 3, 'nothing')).toBe(1);
    },
  );

  it('searches only blockStart when blockEnd is before it', () => {
    expect(resolveDocLine(para, 2, 1, 'closes it')).toBe(2);
    expect(resolveDocLine(para, 1, 0, 'holds the needle')).toBe(1);
  });

  it('does not search outside the block', () => {
    expect(resolveDocLine(para, 1, 2, 'closes it')).toBe(1);
  });

  it('returns 1 for an empty document', () => {
    expect(resolveDocLine([], 5, 9, 'x')).toBe(1);
  });

  it.each([42, null, undefined, {}, ['x'], '', '   '])(
    'falls back to blockStart for a quote %j',
    (quote) => {
      expect(resolveDocLine(para, 2, 3, quote)).toBe(2);
    },
  );
});

describe('normalizeDocPath', () => {
  it.each([
    ['./a.md', 'a.md'],
    ['a/../b.md', 'b.md'],
    ['a//b.md', 'a/b.md'],
    ['', ''],
    ['../x.md', '../x.md'],
    ['notes.md', 'notes.md'],
  ])('%j -> %j', (p, expected) => {
    expect(normalizeDocPath(p)).toBe(expected);
  });

  // `toPosix` converts the native separator only, so a backslash is a separator on win32 and an
  // ordinary filename byte elsewhere.
  it('treats a backslash as a separator only on win32', () => {
    if (process.platform === 'win32') {
      expect(normalizeDocPath('docs\\a.md')).toBe('docs/a.md');
      expect(normalizeDocPath('.\\docs\\..\\a.md')).toBe('a.md');
    } else {
      expect(normalizeDocPath('docs\\a.md')).toBe('docs\\a.md');
      expect(normalizeDocPath('./docs\\a.md')).toBe('docs\\a.md');
    }
  });
});
