/**
 * `bytes` decoded as UTF-8 — or `null` when that decode would be lossy.
 *
 * `Buffer.toString('utf8')` never fails: a byte sequence that is not valid UTF-8 (a Latin-1 `é`
 * is the one byte 0xE9) decodes to U+FFFD, and encoding the string back writes ef bf bd in its
 * place. Any read-decode-modify-write of a whole file therefore rewrites every such byte, far
 * from the change the caller asked for. A decode is exact precisely when the string re-encodes to
 * the same bytes, which is the test here; a caller that is about to write the file back refuses
 * on `null` rather than corrupt it. (A UTF-8 BOM survives the round trip, so it is not refused.)
 */
export function decodeUtf8Exact(bytes: Buffer): string | null {
  const text = bytes.toString('utf8');
  return Buffer.from(text, 'utf8').equals(bytes) ? text : null;
}
