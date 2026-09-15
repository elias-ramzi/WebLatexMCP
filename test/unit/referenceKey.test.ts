import { describe, expect, it } from 'vitest';
import {
  REFERENCE_SOURCES,
  formatRecordKey,
  parseRecordKey,
  type ReferenceSourceId,
} from '../../src/lib/referenceKey.js';

function getThrownMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('expected function to throw');
}

describe('referenceKey', () => {
  describe('formatRecordKey', () => {
    it('joins source and id with a colon', () => {
      expect(formatRecordKey('dblp', 'conf/cvpr/HeZRS16')).toBe('dblp:conf/cvpr/HeZRS16');
      expect(formatRecordKey('crossref', '10.1109/CVPR.2016.90')).toBe(
        'crossref:10.1109/CVPR.2016.90',
      );
      expect(formatRecordKey('openalex', 'W2194775991')).toBe('openalex:W2194775991');
    });
  });

  describe('round-trip', () => {
    const cases: Array<{ source: ReferenceSourceId; id: string }> = [
      { source: 'dblp', id: 'conf/cvpr/HeZRS16' },
      { source: 'crossref', id: '10.1109/CVPR.2016.90' },
      { source: 'openalex', id: 'W2194775991' },
    ];
    for (const { source, id } of cases) {
      it(`round-trips a ${source} key`, () => {
        expect(parseRecordKey(formatRecordKey(source, id))).toEqual({ source, id });
      });
    }
  });

  describe('accepted input forms', () => {
    it('parses a dblp-prefixed key', () => {
      expect(parseRecordKey('dblp:conf/cvpr/HeZRS16')).toEqual({
        source: 'dblp',
        id: 'conf/cvpr/HeZRS16',
      });
    });

    it('parses a crossref-prefixed DOI', () => {
      expect(parseRecordKey('crossref:10.1109/CVPR.2016.90')).toEqual({
        source: 'crossref',
        id: '10.1109/CVPR.2016.90',
      });
    });

    it('parses an openalex-prefixed id', () => {
      expect(parseRecordKey('openalex:W2194775991')).toEqual({
        source: 'openalex',
        id: 'W2194775991',
      });
    });

    it('treats doi: as an alias for crossref', () => {
      expect(parseRecordKey('doi:10.1109/CVPR.2016.90')).toEqual({
        source: 'crossref',
        id: '10.1109/CVPR.2016.90',
      });
    });

    it('parses a bare DBLP key with no prefix (backward compatibility)', () => {
      expect(parseRecordKey('conf/cvpr/HeZRS16')).toEqual({
        source: 'dblp',
        id: 'conf/cvpr/HeZRS16',
      });
    });

    it('parses dblp URLs by host, in .html/.bib/.xml forms, and the uni-trier host', () => {
      expect(parseRecordKey('https://dblp.org/rec/conf/cvpr/HeZRS16.html')).toEqual({
        source: 'dblp',
        id: 'conf/cvpr/HeZRS16',
      });
      expect(parseRecordKey('https://dblp.org/rec/conf/cvpr/HeZRS16.bib')).toEqual({
        source: 'dblp',
        id: 'conf/cvpr/HeZRS16',
      });
      expect(parseRecordKey('https://dblp.org/rec/conf/cvpr/HeZRS16.xml')).toEqual({
        source: 'dblp',
        id: 'conf/cvpr/HeZRS16',
      });
      expect(parseRecordKey('https://dblp.uni-trier.de/rec/conf/cvpr/HeZRS16.html')).toEqual({
        source: 'dblp',
        id: 'conf/cvpr/HeZRS16',
      });
    });

    it('parses doi.org and dx.doi.org URLs as crossref', () => {
      expect(parseRecordKey('https://doi.org/10.1109/cvpr.2016.90')).toEqual({
        source: 'crossref',
        id: '10.1109/cvpr.2016.90',
      });
      expect(parseRecordKey('https://dx.doi.org/10.1109/cvpr.2016.90')).toEqual({
        source: 'crossref',
        id: '10.1109/cvpr.2016.90',
      });
    });

    it('parses an api.crossref.org works URL as crossref', () => {
      expect(parseRecordKey('https://api.crossref.org/works/10.1109/CVPR.2016.90')).toEqual({
        source: 'crossref',
        id: '10.1109/CVPR.2016.90',
      });
    });

    it('parses openalex.org and api.openalex.org URLs as openalex', () => {
      expect(parseRecordKey('https://openalex.org/W2194775991')).toEqual({
        source: 'openalex',
        id: 'W2194775991',
      });
      expect(parseRecordKey('https://api.openalex.org/works/W2194775991')).toEqual({
        source: 'openalex',
        id: 'W2194775991',
      });
    });

    it('parses a bare DOI with no prefix as crossref', () => {
      expect(parseRecordKey('10.1109/CVPR.2016.90')).toEqual({
        source: 'crossref',
        id: '10.1109/CVPR.2016.90',
      });
    });

    it('parses a bare openalex id with no prefix as openalex', () => {
      expect(parseRecordKey('W2194775991')).toEqual({ source: 'openalex', id: 'W2194775991' });
    });
  });

  describe('precedence', () => {
    it('routes a bare DOI-shaped string to crossref, not dblp', () => {
      const result = parseRecordKey('10.1109/CVPR.2016.90');
      expect(result.source).toBe('crossref');
    });

    it('routes a bare W-prefixed id to openalex, not dblp', () => {
      const result = parseRecordKey('W2194775991');
      expect(result.source).toBe('openalex');
    });

    it('still routes an ordinary bare key to dblp', () => {
      const result = parseRecordKey('conf/cvpr/HeZRS16');
      expect(result.source).toBe('dblp');
    });
  });

  describe('path traversal rejection', () => {
    it('rejects .. under every prefix', () => {
      expect(() => parseRecordKey('dblp:../../etc/passwd')).toThrow();
      expect(() => parseRecordKey('crossref:../../x')).toThrow();
      expect(() => parseRecordKey('openalex:../x')).toThrow();
    });

    it('rejects .. in a bare key', () => {
      expect(() => parseRecordKey('../../etc/passwd')).toThrow();
    });

    it('rejects .. smuggled in a DOI suffix, prefixed or bare', () => {
      expect(() => parseRecordKey('10.1109/../../secret')).toThrow();
      expect(() => parseRecordKey('doi:10.1109/../../secret')).toThrow();
      expect(() => parseRecordKey('crossref:10.1109/../../secret')).toThrow();
    });
  });

  describe('values just outside every guard', () => {
    it('rejects a W id with trailing letters after the digits', () => {
      expect(() => parseRecordKey('W12a')).toThrow();
    });

    it('rejects a bare W with no digits', () => {
      expect(() => parseRecordKey('W')).toThrow();
    });

    it('rejects a DOI with too few registrant digits', () => {
      expect(() => parseRecordKey('10.1/x')).toThrow();
    });

    it('rejects a DOI containing a space', () => {
      expect(() => parseRecordKey('crossref:10.1109/CVPR 2016.90')).toThrow();
    });

    it('rejects a DOI containing a newline', () => {
      expect(() => parseRecordKey('crossref:10.1109/CVPR\n2016.90')).toThrow();
    });

    it('rejects an unknown prefix and lists the accepted sources in the message', () => {
      expect(() => parseRecordKey('scopus:123')).toThrow();
      const message = getThrownMessage(() => parseRecordKey('scopus:123'));
      for (const source of REFERENCE_SOURCES) {
        expect(message).toContain(source);
      }
    });

    it('rejects the empty string', () => {
      expect(() => parseRecordKey('')).toThrow();
    });

    it('rejects a whitespace-only string', () => {
      expect(() => parseRecordKey('   ')).toThrow();
    });
  });

  describe('case-insensitivity', () => {
    it('accepts an uppercase source prefix', () => {
      expect(parseRecordKey('DBLP:conf/x/y')).toEqual({ source: 'dblp', id: 'conf/x/y' });
    });

    it('accepts an uppercase doi: prefix', () => {
      expect(parseRecordKey('DOI:10.1109/CVPR.2016.90')).toEqual({
        source: 'crossref',
        id: '10.1109/CVPR.2016.90',
      });
    });

    it('normalises a lowercase openalex id to uppercase W', () => {
      expect(parseRecordKey('w2194775991')).toEqual({ source: 'openalex', id: 'W2194775991' });
    });
  });

  describe('DOI suffix case preservation', () => {
    it('does not lowercase or uppercase the DOI suffix', () => {
      expect(parseRecordKey('10.1109/CVPR.2016.90')).toEqual({
        source: 'crossref',
        id: '10.1109/CVPR.2016.90',
      });
      expect(parseRecordKey('crossref:10.1109/cvpr.2016.90')).toEqual({
        source: 'crossref',
        id: '10.1109/cvpr.2016.90',
      });
    });
  });
});

describe('a DBLP key that merely starts with w', () => {
  it('is not swallowed by the OpenAlex namespace claim', () => {
    // DBLP really has `www/`-prefixed keys. A loose /^w/i claim rejected them outright with an
    // error that never mentioned DBLP, making a legitimate key unusable.
    expect(parseRecordKey('www/gh/HeZRS16')).toEqual({ source: 'dblp', id: 'www/gh/HeZRS16' });
    expect(parseRecordKey('dblp:www/gh/HeZRS16').source).toBe('dblp');
  });

  it('still rejects the OpenAlex lookalikes', () => {
    expect(() => parseRecordKey('W12a')).toThrow();
    expect(() => parseRecordKey('W')).toThrow();
    expect(parseRecordKey('W2194775991')).toEqual({ source: 'openalex', id: 'W2194775991' });
  });
});
