import { describe, it, expect } from 'vitest';
import {
  applyProfile,
  citationProfileSchema,
  describeProfile,
  fieldsRemovedBy,
  type CitationProfile,
} from '../../src/lib/citationProfile.js';
import { parseBibtex } from '../../src/lib/references.js';

const DBLP =
  '@inproceedings{DBLP:conf/cvpr/HeZRS16,\n' +
  '  author       = {Kaiming He and Xiangyu Zhang},\n' +
  '  title        = {Deep Residual Learning for Image Recognition},\n' +
  '  booktitle    = {{CVPR}},\n' +
  '  pages        = {770--778},\n' +
  '  year         = {2016},\n' +
  '  timestamp    = {Wed, 16 Oct 2019 14:14:50 +0200},\n' +
  '  biburl       = {https://dblp.org/rec/conf/cvpr/HeZRS16.bib},\n' +
  '  bibsource    = {dblp computer science bibliography, https://dblp.org}\n' +
  '}';

const CROSSREF =
  '@inproceedings{He_2016, title={Deep Residual Learning}, url={http://dx.doi.org/10.1109/cvpr.2016.90}, ' +
  'DOI={10.1109/cvpr.2016.90}, booktitle={2016 IEEE CVPR}, publisher={IEEE}, ' +
  'author={He, Kaiming and Zhang, Xiangyu}, year={2016}, month=jun, pages={770–778} }';

/** Whether `out` is `input` with characters deleted and nothing added, moved or changed. */
function isDeletionOf(input: string, out: string): boolean {
  let i = 0;
  for (const ch of out) {
    while (i < input.length && input[i] !== ch) i++;
    if (i === input.length) return false;
    i++;
  }
  return true;
}

const profile = (p: CitationProfile): CitationProfile => citationProfileSchema.parse(p);

describe('applyProfile', () => {
  it('removes dropped fields from a DBLP entry, one field per line kept whole', () => {
    const { text, changed } = applyProfile(
      DBLP,
      profile({ drop: ['timestamp', 'biburl', 'bibsource', 'pages'] }),
    );
    expect(text).toBe(
      '@inproceedings{DBLP:conf/cvpr/HeZRS16,\n' +
        '  author       = {Kaiming He and Xiangyu Zhang},\n' +
        '  title        = {Deep Residual Learning for Image Recognition},\n' +
        '  booktitle    = {{CVPR}},\n' +
        '  year         = {2016}\n' +
        '}',
    );
    expect(changed).toEqual([
      {
        key: 'DBLP:conf/cvpr/HeZRS16',
        type: 'inproceedings',
        line: 1,
        removed: ['pages', 'timestamp', 'biburl', 'bibsource'],
      },
    ]);
    expect(isDeletionOf(DBLP, text)).toBe(true);
  });

  it('removes fields from a one-line Crossref entry, matching names without regard to case', () => {
    const { text, changed } = applyProfile(
      CROSSREF,
      profile({ drop: ['URL', 'doi', 'publisher', 'month', 'pages'] }),
    );
    expect(text).toBe(
      '@inproceedings{He_2016, title={Deep Residual Learning}, booktitle={2016 IEEE CVPR}, ' +
        'author={He, Kaiming and Zhang, Xiangyu}, year={2016} }',
    );
    expect(changed[0]!.removed).toEqual(['url', 'doi', 'publisher', 'month', 'pages']);
    expect(isDeletionOf(CROSSREF, text)).toBe(true);
    // Still one parseable entry, with the fields that were kept, values untouched.
    const [entry] = parseBibtex(text);
    expect(entry!.key).toBe('He_2016');
    expect(Object.keys(entry!.fields!)).toEqual(['title', 'booktitle', 'author', 'year']);
  });

  it('keeps only the whitelisted fields of a type, and leaves other types to `drop`', () => {
    const bib =
      DBLP +
      '\n\n@article{a1,\n  author = {A},\n  title = {T},\n  journal = {J},\n  issn = {1},\n}\n';
    const { text, changed } = applyProfile(
      bib,
      profile({
        drop: ['issn'],
        keep: [{ type: 'InProceedings', fields: ['author', 'title', 'booktitle', 'year'] }],
      }),
    );
    expect(changed.map((c) => [c.key, c.removed])).toEqual([
      ['DBLP:conf/cvpr/HeZRS16', ['pages', 'timestamp', 'biburl', 'bibsource']],
      ['a1', ['issn']],
    ]);
    // The article had a trailing comma after its last field; it keeps one.
    expect(text).toContain('@article{a1,\n  author = {A},\n  title = {T},\n  journal = {J},\n}');
    expect(isDeletionOf(bib, text)).toBe(true);
  });

  it('removes a final run of fields without leaving a trailing comma the entry never had', () => {
    const bib = '@misc{k,\n  title = {T},\n  note = {N},\n  url = {U}\n}';
    const { text } = applyProfile(bib, profile({ drop: ['note', 'url'] }));
    expect(text).toBe('@misc{k,\n  title = {T}\n}');
  });

  it('can remove every field, keeping the key and the closing brace', () => {
    const bib = '@misc{k, note = {N}, url = {U}}';
    expect(applyProfile(bib, profile({ drop: ['note', 'url'] })).text).toBe('@misc{k}');
  });

  it('reads values the way the parser does: commas inside braces and quotes are not separators', () => {
    const bib = '@misc{k, title = {A, B}, note = "C, {D}, E", year = 2020}';
    const { text } = applyProfile(bib, profile({ drop: ['note'] }));
    expect(text).toBe('@misc{k, title = {A, B}, year = 2020}');
  });

  it('touches nothing between entries, nor @string, @comment or @preamble blocks', () => {
    const bib =
      '% header comment, url = {x}\n@string{url = "x"}\n@comment{url = {x}}\n' +
      '@preamble{"url"}\n@misc{k, url = {U}, title = {T}}\n';
    const { text } = applyProfile(bib, profile({ drop: ['url'] }));
    expect(text).toBe(
      '% header comment, url = {x}\n@string{url = "x"}\n@comment{url = {x}}\n' +
        '@preamble{"url"}\n@misc{k, title = {T}}\n',
    );
  });

  it('never removes a part that is not a readable field', () => {
    const bib = '@misc{k, title = {T}, some stray text, 9bad = {x}}';
    const { text, changed } = applyProfile(
      bib,
      profile({ keep: [{ type: 'misc', fields: ['title'] }] }),
    );
    expect(text).toBe(bib);
    expect(changed).toEqual([]);
  });

  it('limits the change to the given cite keys', () => {
    const bib = '@misc{a, url = {U}}\n@misc{b, url = {U}}\n';
    const { text, changed } = applyProfile(bib, profile({ drop: ['url'] }), new Set(['b']));
    expect(text).toBe('@misc{a, url = {U}}\n@misc{b}\n');
    expect(changed.map((c) => [c.key, c.line])).toEqual([['b', 2]]);
  });

  it('returns the input itself when nothing is removed', () => {
    const r = applyProfile(DBLP, profile({ drop: ['issn'] }));
    expect(r.text).toBe(DBLP);
    expect(r.changed).toEqual([]);
    expect(applyProfile(DBLP, profile({})).text).toBe(DBLP);
  });

  it('only ever deletes, over many random profiles', () => {
    const names = ['title', 'author', 'url', 'doi', 'pages', 'year', 'booktitle', 'publisher'];
    const bib = `${DBLP}\n\n${CROSSREF}\n`;
    for (let seed = 1; seed < 200; seed++) {
      const drop = names.filter((_, i) => (seed >> i) & 1);
      const { text } = applyProfile(bib, profile({ drop }));
      expect(isDeletionOf(bib, text)).toBe(true);
      expect(parseBibtex(text).map((e) => e.key)).toEqual(['DBLP:conf/cvpr/HeZRS16', 'He_2016']);
    }
  });
});

describe('the profile schema', () => {
  it('refuses a type named twice, whatever the case', () => {
    const r = citationProfileSchema.safeParse({
      keep: [
        { type: 'article', fields: ['title'] },
        { type: 'Article', fields: ['author'] },
      ],
    });
    expect(r.success).toBe(false);
  });

  it('refuses names that are not BibTeX names, __proto__ included', () => {
    for (const bad of [
      { drop: ['__proto__'] },
      { drop: ['a b'] },
      { keep: [{ type: '__proto__', fields: ['title'] }] },
      { keep: [{ type: 'article', fields: [] }] },
      { extra: true },
    ]) {
      expect(citationProfileSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('describes a profile in one line', () => {
    expect(describeProfile(null)).toBe('none');
    expect(
      describeProfile({ drop: ['url'], keep: [{ type: 'misc', fields: ['title', 'year'] }] }),
    ).toBe('drop url; @misc keeps only title, year');
  });

  it('fieldsRemovedBy judges drop and keep together', () => {
    const p = profile({ drop: ['url'], keep: [{ type: 'misc', fields: ['title', 'url'] }] });
    expect(fieldsRemovedBy(p, 'MISC', ['title', 'url', 'note'])).toEqual(['url', 'note']);
    expect(fieldsRemovedBy(p, 'article', ['title', 'url', 'note'])).toEqual(['url']);
  });
});
