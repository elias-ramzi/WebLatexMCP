import { describe, it, expect } from 'vitest';
import {
  isBibFile,
  extractEntryKeys,
  mergeBibEntry,
  bibEditBlockedMessage,
} from '../../src/lib/bib.js';

describe('isBibFile', () => {
  it('matches .bib regardless of case or directory', () => {
    expect(isBibFile('refs.bib')).toBe(true);
    expect(isBibFile('bib/References.BIB')).toBe(true);
  });
  it('rejects non-.bib paths', () => {
    expect(isBibFile('main.tex')).toBe(false);
    expect(isBibFile('bibliography')).toBe(false);
    expect(isBibFile('notes.bib.txt')).toBe(false);
  });
});

describe('extractEntryKeys', () => {
  it('collects cite keys in order', () => {
    const bib = '@article{a2020,\n title={A}}\n@inproceedings{ b2021 ,\n title={B}}';
    expect(extractEntryKeys(bib)).toEqual(['a2020', 'b2021']);
  });
  it('ignores @string / @comment / @preamble directives', () => {
    const bib = '@string{cvpr = "CVPR"}\n@comment{x}\n@book{real2019, title={R}}';
    expect(extractEntryKeys(bib)).toEqual(['real2019']);
  });
});

describe('mergeBibEntry', () => {
  const entry = '@inproceedings{he2016deep,\n  title={Deep Residual Learning}\n}';

  it('appends to an empty file', () => {
    const res = mergeBibEntry('', entry);
    expect(res.alreadyPresent).toBe(false);
    expect(res.key).toBe('he2016deep');
    expect(res.content).toBe(`${entry}\n`);
  });

  it('appends after existing entries with a blank-line separator', () => {
    const existing = '@article{prev2015,\n  title={Prev}\n}\n';
    const res = mergeBibEntry(existing, entry);
    expect(res.alreadyPresent).toBe(false);
    expect(res.content).toBe(`@article{prev2015,\n  title={Prev}\n}\n\n${entry}\n`);
  });

  it('is a no-op when the key already exists', () => {
    const existing = '@inproceedings{he2016deep,\n  title={Old}\n}\n';
    const res = mergeBibEntry(existing, entry);
    expect(res.alreadyPresent).toBe(true);
    expect(res.content).toBe(existing);
  });

  it('throws when the entry has no cite key', () => {
    expect(() => mergeBibEntry('', '@comment{nope}')).toThrow(/no entry with a citation key/);
  });
});

describe('bibEditBlockedMessage', () => {
  it('names the file and points at add_citation', () => {
    const msg = bibEditBlockedMessage('refs.bib');
    expect(msg).toContain('refs.bib');
    expect(msg).toContain('add_citation');
    expect(msg).toContain('confirmBibEdit');
  });
});
