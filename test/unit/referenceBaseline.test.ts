import { describe, it, expect } from 'vitest';
import { rawsCoverText, wholeSources, type ShippedEntry } from '../../src/lib/referenceBaseline.js';
import { parseReferences } from '../../src/lib/references.js';

const A = '@article{a,\n  title = {A},\n}';
const B = '@misc{b, title = {B}}';

function shipped(text: string, path = 'refs.bib'): ShippedEntry[] {
  return parseReferences(text, path).map((e) => ({ ...e, path }));
}

describe('rawsCoverText', () => {
  it('accepts entries separated by ASCII whitespace, CRLF and a leading blank included', () => {
    expect(rawsCoverText(`\n\n${A}\r\n\r\n\t${B}\n`, [A, B])).toBe(true);
  });

  it('refuses any non-whitespace byte before, between or after the entries', () => {
    expect(rawsCoverText(`header\n${A}\n${B}\n`, [A, B])).toBe(false);
    expect(rawsCoverText(`${A}\n% note\n${B}\n`, [A, B])).toBe(false);
    expect(rawsCoverText(`${A}\n${B}\ntrailing`, [A, B])).toBe(false);
  });

  it('refuses a byte-order mark or a no-break space, which no returned raw shows', () => {
    expect(rawsCoverText(`\uFEFF${A}\n`, [A])).toBe(false);
    expect(rawsCoverText(`${A}\u00A0\n`, [A])).toBe(false);
  });

  it('refuses entries out of file order, and an empty raw', () => {
    expect(rawsCoverText(`${A}\n${B}\n`, [B, A])).toBe(false);
    expect(rawsCoverText(`${A}\n`, [A, ''])).toBe(false);
  });
});

describe('wholeSources', () => {
  it('claims a .bib that is nothing but entries', () => {
    const text = `${A}\n\n${B}\n`;
    const entries = shipped(text);
    const texts = new Map([['refs.bib', text]]);
    expect(wholeSources([{ path: 'refs.bib', count: 2 }], entries, texts)).toEqual(['refs.bib']);
  });

  it('never claims a source it holds no bytes for', () => {
    const text = `${A}\n`;
    expect(wholeSources([{ path: 'refs.bib', count: 1 }], shipped(text), new Map())).toEqual([]);
  });

  it('never claims a bibitem source, even one that is only its bibitems', () => {
    const text = '\\bibitem{k} K. Author. A Title. 2020.\n';
    const entries = shipped(text, 'refs.tex');
    expect(entries.map((e) => e.format)).toEqual(['bibitem']);
    // Make the raw cover the file exactly, so only the format clause can refuse it.
    const exact = entries.map((e) => ({ ...e, raw: text.trimEnd() }));
    const texts = new Map([['refs.tex', text]]);
    expect(wholeSources([{ path: 'refs.tex', count: 1 }], exact, texts)).toEqual([]);
  });
});
