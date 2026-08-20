import { describe, it, expect } from 'vitest';
import {
  cleanTeX,
  extractCitations,
  isProseDocument,
  missingRequiredFields,
  parseBibitems,
  parseBibtex,
  parseProseReferences,
  parseReferences,
} from '../../src/lib/references.js';

const BIB = [
  '@string{cvpr = "IEEE/CVF Conference on Computer Vision and Pattern Recognition"}',
  '',
  '@comment{not an entry}',
  '',
  '@inproceedings{he2016deep,',
  '  title     = {Deep Residual Learning for {Image} Recognition},',
  '  author    = {He, Kaiming and Zhang, Xiangyu and Ren, Shaoqing and Sun, Jian},',
  '  booktitle = cvpr,',
  '  year      = {2016},',
  '}',
  '',
  '@article{vaswani2017attention,',
  '  title  = {Attention is All you Need},',
  '  author = {Vaswani, Ashish and others},',
  '  year   = 2017,',
  '}',
  '',
].join('\n');

describe('parseBibtex', () => {
  const entries = parseBibtex(BIB);

  it('reads keys, types, titles and line numbers', () => {
    expect(entries.map((e) => e.key)).toEqual(['he2016deep', 'vaswani2017attention']);
    expect(entries[0]!.type).toBe('inproceedings');
    expect(entries[0]!.title).toBe('Deep Residual Learning for Image Recognition');
    expect(entries[0]!.line).toBe(5);
    expect(entries[0]!.format).toBe('bibtex');
  });

  it('resolves @string macros into the venue', () => {
    expect(entries[0]!.venue).toBe(
      'IEEE/CVF Conference on Computer Vision and Pattern Recognition',
    );
  });

  it('normalizes authors to "First Last"', () => {
    expect(entries[0]!.authors).toEqual([
      'Kaiming He',
      'Xiangyu Zhang',
      'Shaoqing Ren',
      'Jian Sun',
    ]);
    expect(entries[0]!.truncatedAuthors).toBe(false);
  });

  it('flags an author list truncated with `and others`', () => {
    expect(entries[1]!.authors).toEqual(['Ashish Vaswani']);
    expect(entries[1]!.truncatedAuthors).toBe(true);
  });

  it('keeps the entry verbatim in `raw`', () => {
    expect(entries[0]!.raw).toContain('@inproceedings{he2016deep,');
    expect(entries[0]!.raw.endsWith('}')).toBe(true);
  });

  it('reads a bare-number year and unbraced values', () => {
    expect(entries[1]!.year).toBe(2017);
  });

  it('does not choke on an unterminated entry', () => {
    expect(parseBibtex('@article{broken,\n  title = {No closing brace')).toEqual([]);
  });
});

describe('missingRequiredFields', () => {
  it('names the field an entry type needs and does not have', () => {
    const [entry] = parseBibtex('@article{x, title={T}, author={A}, year={2020}}');
    expect(missingRequiredFields(entry!)).toEqual(['journal|journaltitle']);
  });

  it('accepts either alternative of a "a|b" requirement', () => {
    const [entry] = parseBibtex('@book{x, editor={E}, title={T}, publisher={P}, date={2020-01}}');
    expect(missingRequiredFields(entry!)).toEqual([]);
  });

  it('has no requirement for @misc, and none for a prose entry', () => {
    const [misc] = parseBibtex('@misc{x, note={n}}');
    expect(missingRequiredFields(misc!)).toEqual([]);
    const [prose] = parseProseReferences('# References\n\n1. Someone (2020). A thing.');
    expect(missingRequiredFields(prose!)).toEqual([]);
  });
});

describe('cleanTeX', () => {
  it('strips braces, escapes, accents and formatting commands', () => {
    expect(cleanTeX("{Deep} \\emph{Residual} Learning \\& More, Caf\\'{e}")).toBe(
      'Deep Residual Learning & More, Cafe',
    );
  });
});

describe('parseBibitems', () => {
  const tex = [
    '\\begin{thebibliography}{9}',
    '\\bibitem[HZRS16]{he2016deep} K. He and X. Zhang, "Deep Residual Learning," CVPR, 2016.',
    '\\bibitem{smith99} J. Smith. A Book. Publisher, 1999.',
    '\\end{thebibliography}',
  ].join('\n');
  const entries = parseBibitems(tex);

  it('takes the key exactly and the description as free text', () => {
    expect(entries.map((e) => e.key)).toEqual(['he2016deep', 'smith99']);
    expect(entries[0]!.format).toBe('bibitem');
    expect(entries[0]!.title).toBe('Deep Residual Learning');
    expect(entries[0]!.year).toBe(2016);
  });

  it('stops the last entry at \\end{thebibliography}', () => {
    expect(entries[1]!.raw).not.toContain('\\end{thebibliography}');
    expect(entries[1]!.year).toBe(1999);
  });
});

describe('parseProseReferences', () => {
  const md = [
    '# Proposal',
    '',
    'A bullet that is not a reference:',
    '',
    '- buy milk',
    '',
    '## References',
    '',
    '1. He, K., Zhang, X., & Sun, J. (2016). "Deep Residual Learning." CVPR.',
    '2. Cabon, Y., Murray, N. (2020). Virtual KITTI 2. arXiv:2001.10773.',
    '',
    '## Budget',
    '',
    '- not a reference either',
  ].join('\n');
  const entries = parseProseReferences(md);

  it('reads only the References section when there is one', () => {
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.label)).toEqual(['1', '2']);
    expect(entries[0]!.format).toBe('prose');
  });

  it('pulls out a quoted title, the parenthesized year and the authors before it', () => {
    expect(entries[0]!.title).toBe('Deep Residual Learning');
    expect(entries[0]!.year).toBe(2016);
    expect(entries[0]!.authors).toEqual(['He, K.', 'Zhang, X.', 'Sun, J.']);
  });

  it('keeps compound initials with their surname, so the author count stays right', () => {
    // "A.-Q." is Anh-Quan, one author — splitting it off would report three authors for two, and
    // the count is what gets compared against the DBLP record.
    const list = '# References\n\n1. Cao, A.-Q., & de Charette, R. (2022). "MonoScene." CVPR.';
    expect(parseProseReferences(list)[0]!.authors).toEqual(['Cao, A.-Q.', 'de Charette, R.']);
  });

  it('recognizes an arXiv id, and leaves the title alone when nothing delimits it', () => {
    expect(entries[1]!.arxivId).toBe('2001.10773');
    expect(entries[1]!.title).toBeUndefined();
    expect(entries[1]!.raw).toContain('Virtual KITTI 2');
  });

  it('without a References heading, only items carrying a year/DOI/URL count', () => {
    const loose = ['- buy milk', '- Smith, J. (2021). Something. Venue.'].join('\n');
    expect(parseProseReferences(loose).map((e) => e.year)).toEqual([2021]);
  });

  it('joins an entry wrapped across lines', () => {
    const wrapped = ['## References', '', '1. Smith, J. (2021). A Long', '   Title. Venue.'].join(
      '\n',
    );
    expect(parseProseReferences(wrapped)[0]!.raw).toContain('Title. Venue.');
  });
});

describe('parseReferences', () => {
  it('prefers structured entries and never mines a .tex for bullets', () => {
    const tex = '\\begin{itemize}\\item a thing from 2020\\end{itemize}';
    expect(parseReferences(tex, 'main.tex')).toEqual([]);
  });

  it('reads a .bib as BibTeX and a .md as prose', () => {
    expect(parseReferences(BIB, 'ref.bib').map((e) => e.key)).toEqual([
      'he2016deep',
      'vaswani2017attention',
    ]);
    const md = '## References\n\n1. Smith, J. (2021). A Thing. Venue.';
    expect(parseReferences(md, 'proposal.md').map((e) => e.year)).toEqual([2021]);
  });

  it('reads BibTeX out of a file that is not named .bib', () => {
    expect(parseReferences(BIB, 'notes.txt').map((e) => e.format)).toEqual(['bibtex', 'bibtex']);
  });
});

describe('isProseDocument', () => {
  it('covers the common prose extensions and nothing else', () => {
    expect(['a.md', 'a.MARKDOWN', 'a.txt', 'a.rst', 'a.org'].every(isProseDocument)).toBe(true);
    expect(['a.tex', 'a.bib', 'a.png'].some(isProseDocument)).toBe(false);
  });
});

describe('extractCitations', () => {
  it('covers the \\cite family, multi-key and optional arguments', () => {
    const tex = '\\citep[see][p.~3]{he2016deep, vaswani2017attention} and \\textcite{smith99}.';
    expect(extractCitations(tex)).toEqual([
      { key: 'he2016deep', line: 1, command: 'citep' },
      { key: 'vaswani2017attention', line: 1, command: 'citep' },
      { key: 'smith99', line: 1, command: 'textcite' },
    ]);
  });

  it('ignores a \\cite inside a TeX comment', () => {
    expect(extractCitations('% \\cite{ghost}\n\\cite{real}')).toEqual([
      { key: 'real', line: 2, command: 'cite' },
    ]);
  });

  it('counts an escaped percent as text, not a comment', () => {
    expect(extractCitations('100\\% of \\cite{real}').map((c) => c.key)).toEqual(['real']);
  });

  it('reads pandoc [@key] and bare @key in markdown, but not an email address', () => {
    const md = 'As shown [@he2016deep; @smith99] and @vaswani2017attention. Mail a@b.com.';
    expect(extractCitations(md, { markdown: true }).map((c) => c.key)).toEqual([
      'he2016deep',
      'smith99',
      'vaswani2017attention',
    ]);
  });

  it('does not read pandoc keys out of LaTeX source', () => {
    expect(extractCitations('an @sign in text')).toEqual([]);
  });
});
