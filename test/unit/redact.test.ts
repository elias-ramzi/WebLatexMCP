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

  it('ignores undefined and very short secrets', () => {
    expect(redact('nothing to hide', [undefined, 'ab'])).toBe('nothing to hide');
  });
});
