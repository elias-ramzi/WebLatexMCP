import { describe, it, expect } from 'vitest';
import { asShadowContent } from '../../src/lib/shadowContent.js';

/**
 * `asShadowContent` decides whether bytes reach `ShadowStore.record` as TEXT (three-way
 * mergeable) or as a Buffer (sticky `binary`, stored byte-exact). Text is only ever safe when the
 * decode is lossless: a latin-1 `.tex` has no NUL, and decoding it as UTF-8 turns every é (0xe9)
 * into U+FFFD — which the shadow then re-encodes as ef bf bd and the next session commit stages.
 */
describe('asShadowContent', () => {
  it('passes null through', () => {
    expect(asShadowContent(null)).toBeNull();
  });

  it('decodes valid UTF-8 text, CRLF and a BOM included', () => {
    const text = '\ufeff\\section{Résumé}\r\nLine two — dash.\n';
    expect(asShadowContent(Buffer.from(text, 'utf8'))).toBe(text);
  });

  it('keeps bytes containing a NUL as a Buffer', () => {
    const bytes = Buffer.from([0x61, 0x00, 0x62]);
    const out = asShadowContent(bytes);
    expect(Buffer.isBuffer(out)).toBe(true);
    expect((out as Buffer).equals(bytes)).toBe(true);
  });

  it('keeps latin-1 bytes (no NUL, not valid UTF-8) as a Buffer, byte for byte', () => {
    // "Résumé\n" in ISO-8859-1.
    const bytes = Buffer.from([0x52, 0xe9, 0x73, 0x75, 0x6d, 0xe9, 0x0a]);
    const out = asShadowContent(bytes);
    expect(Buffer.isBuffer(out)).toBe(true);
    expect((out as Buffer).equals(bytes)).toBe(true);
  });

  it('keeps a truncated UTF-8 sequence as a Buffer', () => {
    // The first two bytes of a three-byte sequence (U+2014): lossy under decode.
    const bytes = Buffer.from([0x61, 0xe2, 0x80]);
    expect(Buffer.isBuffer(asShadowContent(bytes))).toBe(true);
  });

  it('decodes an empty file as the empty string', () => {
    expect(asShadowContent(Buffer.alloc(0))).toBe('');
  });
});
