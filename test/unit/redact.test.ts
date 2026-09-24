import { describe, it, expect } from 'vitest';
import { redact } from '../../src/lib/redact.js';

describe('redact', () => {
  it('replaces a known secret value', () => {
    expect(redact('token is abcd1234secret here', ['abcd1234secret'])).toBe('token is *** here');
  });

  it('scrubs credentials embedded in a URL', () => {
    expect(redact('cloning https://git:tok_xyz@git.overleaf.com/abc failed')).toBe(
      'cloning https://***@git.overleaf.com/abc failed',
    );
  });

  it('scrubs a password that itself contains a raw "@", up to the last "@" of the authority', () => {
    expect(redact('fatal: https://u:p@ss-TOKEN@example.com/repo.git not found')).toBe(
      'fatal: https://***@example.com/repo.git not found',
    );
  });

  it('never reaches past the authority or across whitespace', () => {
    expect(redact('see https://example.com/a@b and mail me@x.org')).toBe(
      'see https://example.com/a@b and mail me@x.org',
    );
    expect(redact('https://a@h1/x https://b@h2/y')).toBe('https://***@h1/x https://***@h2/y');
  });

  it('ignores undefined and very short secrets', () => {
    expect(redact('nothing to hide', [undefined, 'ab'])).toBe('nothing to hide');
  });
});
