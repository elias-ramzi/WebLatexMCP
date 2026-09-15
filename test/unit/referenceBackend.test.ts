import { describe, it, expect } from 'vitest';
import {
  BackendUnavailableError,
  BIBTEX_ENTRY,
  assertApiBody,
  httpHint,
} from '../../src/services/referenceBackend.js';

describe('assertApiBody', () => {
  it('offers the exemption remedy ONLY when a challenge was actually identified', () => {
    // A plain error page is not a challenge: telling the reader to wait for an API-path
    // exemption from a challenge that is not there sends them after the wrong problem.
    try {
      assertApiBody('Crossref', '<html>not found</html>', 'a search');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as Error).message).not.toMatch(/exempts its API paths/);
      expect((err as Error).message).toMatch(/cannot be reached from this machine\./);
    }
    try {
      assertApiBody(
        'DBLP',
        "<!doctype html><title>Making sure you're not a bot!</title>",
        'a search',
      );
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as Error).message).toMatch(/exempts its API paths from it/);
    }
  });
  it('accepts a JSON body', () => {
    expect(() => assertApiBody('Crossref', '{"status":"ok"}', 'a search')).not.toThrow();
  });

  it('accepts a BibTeX body', () => {
    expect(() =>
      assertApiBody('DBLP', '@inproceedings{key,\n  title = {X}\n}', 'a BibTeX request'),
    ).not.toThrow();
  });

  it('throws BackendUnavailableError on a body starting with "<", naming the given service', () => {
    let thrown: unknown;
    try {
      assertApiBody('Crossref', '<html>nope</html>', 'a search for "x"');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BackendUnavailableError);
    expect((thrown as Error).message).toContain('Crossref');
    expect((thrown as Error).message).not.toContain('DBLP');
  });

  it('mentions the anti-bot challenge when the body signals one', () => {
    expect(() => assertApiBody('DBLP', '<html>please prove you are not a bot</html>', 'x')).toThrow(
      /anti-bot proof-of-work/,
    );
  });

  it('does not mention the anti-bot challenge for a plain not-found page', () => {
    expect(() => assertApiBody('DBLP', '<html>not found</html>', 'x')).toThrow(
      /HTML page instead of API data/,
    );
    try {
      assertApiBody('DBLP', '<html>not found</html>', 'x');
      throw new Error('expected assertApiBody to throw');
    } catch (err) {
      expect((err as Error).message).not.toMatch(/anti-bot proof-of-work/);
    }
  });
});

describe('httpHint', () => {
  it('mentions rate limiting and names the service for 429', () => {
    const hint = httpHint('OpenAlex', 429);
    expect(hint).toMatch(/rate-limits/);
    expect(hint).toContain('OpenAlex');
  });

  it('returns empty string for 503', () => {
    expect(httpHint('OpenAlex', 503)).toBe('');
  });
});

describe('BackendUnavailableError', () => {
  it('carries its backend and is an instanceof Error', () => {
    const err = new BackendUnavailableError('Crossref', 'boom');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(BackendUnavailableError);
    expect(err.backend).toBe('Crossref');
    expect(err.name).toBe('BackendUnavailableError');
  });
});

describe('BIBTEX_ENTRY', () => {
  it('matches a real entry header', () => {
    expect(BIBTEX_ENTRY.test('@inproceedings{key,\n  title = {X}\n}')).toBe(true);
  });

  it('does not match a body whose only @ is a @licstart license header', () => {
    const body =
      '<script>/*\n@licstart The following is the entire license notice.\n@licend*/</script>';
    expect(BIBTEX_ENTRY.test(body)).toBe(false);
  });
});
