import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../../src/lib/markdownRender.js';

describe('renderMarkdown: source line mapping', () => {
  const doc = [
    '# Title', // 1
    '', // 2
    'First line of a', // 3
    'two-line paragraph.', // 4
    '', // 5
    '```ts', // 6
    'const a = 1;', // 7
    'const b = 2;', // 8
    '```', // 9
    '', // 10
    '- one', // 11
    '- two', // 12
    '', // 13
    '| a | b |', // 14
    '| - | - |', // 15
    '| 1 | 2 |', // 16
    '| 3 | 4 |', // 17
    '', // 18
    '---', // 19
    '', // 20
    '    indented code', // 21
  ].join('\n');
  const html = renderMarkdown(doc);

  it('maps a heading to its line', () => {
    expect(html).toContain('<h1 data-src="1-1">Title</h1>');
  });

  it('maps a two-line paragraph to both lines', () => {
    expect(html).toMatch(/<p data-src="3-4">First line of a\ntwo-line paragraph\.<\/p>/);
  });

  it('puts the range on the emitted element of a fenced code block', () => {
    expect(html).toMatch(/<pre data-src="6-9"><code class="language-ts">const a = 1;/);
  });

  it('maps an indented code block', () => {
    expect(html).toMatch(/<pre data-src="21-21"><code>indented code/);
  });

  it('maps the list and each item', () => {
    expect(html).toContain('<ul data-src="11-12">');
    expect(html).toContain('<li data-src="11-11">');
    expect(html).toContain('<li data-src="12-12">');
  });

  it('ends a loose list item on its own last text line, not the blank after it', () => {
    const loose = renderMarkdown('- a\n\n- b\n\ntext\n');
    expect(loose).toContain('<ul data-src="1-3">');
    expect(loose).toContain('<li data-src="1-1">');
    expect(loose).toContain('<li data-src="3-3">');
  });

  it('maps the table and each row', () => {
    expect(html).toContain('<table data-src="14-17">');
    expect(html).toContain('<tr data-src="14-14">');
    expect(html).toContain('<tr data-src="16-16">');
    expect(html).toContain('<tr data-src="17-17">');
  });

  it('maps a horizontal rule', () => {
    expect(html).toContain('<hr data-src="19-19">');
  });

  it('is deterministic', () => {
    expect(renderMarkdown(doc)).toBe(html);
  });
});

describe('renderMarkdown: safety', () => {
  it('escapes raw HTML instead of emitting it', () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\ntext <b>x</b>\n');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<b>');
  });

  it('refuses every data: link, an image type included', () => {
    for (const src of [
      '[x](data:image/png;base64,AAAA)\n',
      '[x](DATA:image/gif;base64,AAAA)\n',
      '[x](<  data:text/html,hi>)\n',
      '<data:image/png;base64,AAAA>\n',
    ]) {
      const html = renderMarkdown(src);
      expect(html, src).not.toMatch(/href="\s*data:/i);
    }
    expect(renderMarkdown('[x](https://example.com)\n')).toContain('href="https://example.com"');
  });

  it('refuses a javascript: link', () => {
    const html = renderMarkdown('[x](javascript:alert(1))\n');
    expect(html).not.toContain('href="javascript:');
  });

  it('never emits an image, only its alt text', () => {
    const html = renderMarkdown('![alt text](http://evil.example/x.png)\n');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('evil.example');
    expect(html).toContain('<span class="md-img">[image: alt text]</span>');
  });

  it('escapes markup in an image alt text', () => {
    const html = renderMarkdown('![a &lt;b&gt; `<i>`](x.png)\n');
    expect(html).not.toContain('<i>');
    expect(html).not.toContain('<img');
  });

  it('opens links in a new tab without an opener', () => {
    const html = renderMarkdown('[a](https://example.com)\n');
    expect(html).toContain(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">a</a>',
    );
  });

  it('returns a fragment, not a document', () => {
    const html = renderMarkdown('hello\n');
    expect(html).not.toMatch(/<html|<body/);
  });
});
