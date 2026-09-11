import { describe, it, expect } from 'vitest';
import {
  ASSET_EXT,
  MAX_ASSET_BYTES,
  MAX_INLINE_ASSET_BYTES,
  isImportableAsset,
  assetTypeBlockedMessage,
  assetTooLargeMessage,
  assetSourceBlockedMessage,
} from '../../src/lib/assets.js';

describe('isImportableAsset', () => {
  it('accepts known asset extensions, case-insensitively', () => {
    expect(isImportableAsset('figs/plot.png')).toBe(true);
    expect(isImportableAsset('figs/PLOT.PNG')).toBe(true);
    expect(isImportableAsset('scan.pdf')).toBe(true);
    expect(isImportableAsset('photo.jpeg')).toBe(true);
  });

  it('rejects the exfiltration and wrong-tool cases just outside the guard', () => {
    // .bib: the sanctioned write path is add_citation, not add_asset.
    expect(isImportableAsset('refs.bib')).toBe(false);
    // .tex: text belongs through write_file, never a binary import.
    expect(isImportableAsset('main.tex')).toBe(false);
    // .md: prose, same reasoning as .tex.
    expect(isImportableAsset('notes.md')).toBe(false);
    // No extension at all: the shape of an ssh private key (~/.ssh/id_rsa).
    expect(isImportableAsset('id_rsa')).toBe(false);
    // A dotfile: the shape of a credentials file (.env), not an asset.
    expect(isImportableAsset('.env')).toBe(false);
  });
});

describe('assetTypeBlockedMessage', () => {
  it('names the rejected extension and points at write_file and add_citation', () => {
    const msg = assetTypeBlockedMessage('id_rsa');
    expect(msg).toContain('id_rsa');
    expect(msg).toContain('write_file');
    expect(msg).toContain('add_citation');
  });

  it('names an actual rejected extension when present', () => {
    const msg = assetTypeBlockedMessage('refs.bib');
    expect(msg).toContain('.bib');
  });
});

describe('assetTooLargeMessage', () => {
  it('contains the actual byte count and the cap', () => {
    const msg = assetTooLargeMessage('big.png', 30_000_000, MAX_ASSET_BYTES);
    expect(msg).toContain('30000000');
    expect(msg).toContain(String(MAX_ASSET_BYTES));
  });
});

it('the inline cap is stricter than the on-disk cap', () => {
  expect(MAX_INLINE_ASSET_BYTES).toBeLessThan(MAX_ASSET_BYTES);
});

it('ASSET_EXT is exported for reuse by FileService classification', () => {
  expect(ASSET_EXT.has('.png')).toBe(true);
});

describe('assetSourceBlockedMessage', () => {
  it('names the offending extension, the allowlist, and contentBase64 as the alternative', () => {
    const msg = assetSourceBlockedMessage('/home/user/photo.txt');
    expect(msg).toContain('/home/user/photo.txt');
    expect(msg).toContain('.txt');
    expect(msg).toContain('.png');
    expect(msg).toContain('contentBase64');
  });

  it('reads sensibly for a file with no extension at all, without rendering an empty extension', () => {
    const msg = assetSourceBlockedMessage('/home/user/.ssh/id_rsa');
    expect(msg).toContain('/home/user/.ssh/id_rsa');
    // Must not render a bare `extension ""` or similar nonsense for an extensionless path.
    expect(msg).not.toMatch(/extension\s*""/);
    expect(msg).not.toMatch(/extension\s*''/);
    expect(msg.toLowerCase()).toMatch(/no extension|extensionless|has no extension/);
  });
});
