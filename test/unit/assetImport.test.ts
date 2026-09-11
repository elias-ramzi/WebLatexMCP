import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm, symlink, chmod, mkdir, realpath } from 'node:fs/promises';
import { resolveAssetSource } from '../../src/lib/assetImport.js';
import { MAX_ASSET_BYTES, MAX_INLINE_ASSET_BYTES } from '../../src/lib/assets.js';
import { assetSourceBlockedMessage } from '../../src/lib/assets.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0xfd]);

describe('resolveAssetSource', () => {
  const cleanups: Array<() => Promise<unknown>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  /**
   * A temp dir, **canonicalized**. `resolveAssetSource` reports the realpath'd source — that is the
   * security property, not a detail — so a test comparing against an unresolved path fails wherever
   * the temp root is itself a link: macOS (`/var` -> `/private/var`) and Windows (the `RUNNER~1`
   * 8.3 alias). Resolving at creation keeps every path derived from it canonical on every platform.
   */
  async function tmp(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-asset-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    return realpath(dir);
  }

  it('reads a real file from an absolute sourcePath, byte-identically', async () => {
    const dir = await tmp();
    const file = path.join(dir, 'plot.png');
    await writeFile(file, PNG);
    const res = await resolveAssetSource({ destPath: 'figures/plot.png', sourcePath: file });
    expect(Buffer.compare(res.bytes, PNG)).toBe(0);
    expect(res.origin).toBe(file);
    expect(res.sha256).toBe(createHash('sha256').update(PNG).digest('hex'));
  });

  it.skipIf(process.platform === 'win32')(
    'follows a symlinked sourcePath and reports the real path as origin',
    async () => {
      const dir = await tmp();
      const real = path.join(dir, 'real.png');
      await writeFile(real, PNG);
      const link = path.join(dir, 'link.png');
      await symlink(real, link);
      const res = await resolveAssetSource({ destPath: 'figures/plot.png', sourcePath: link });
      expect(res.origin).toBe(real);
      expect(Buffer.compare(res.bytes, PNG)).toBe(0);
    },
  );

  it('refuses non-importable destinations, and accepts the value just outside the guard', async () => {
    const dir = await tmp();
    const file = path.join(dir, 'plot.png');
    await writeFile(file, PNG);

    for (const dest of ['notes.tex', 'refs.bib', 'README.md', 'id_rsa']) {
      await expect(resolveAssetSource({ destPath: dest, sourcePath: file })).rejects.toThrow(
        /not a recognized asset type/,
      );
    }
    // The .bib case specifically: add_asset must not become a second .bib write path behind
    // confirmBibEdit's back.
    await expect(resolveAssetSource({ destPath: 'refs.bib', sourcePath: file })).rejects.toThrow(
      /add_citation/,
    );

    const ok = await resolveAssetSource({ destPath: 'figures/plot.png', sourcePath: file });
    expect(Buffer.compare(ok.bytes, PNG)).toBe(0);
  });

  it('checks the allowlist before touching the filesystem at all', async () => {
    await expect(
      resolveAssetSource({
        destPath: 'notes.tex',
        sourcePath: '/definitely/does/not/exist/at/all.png',
      }),
    ).rejects.toThrow(/not a recognized asset type/);
  });

  it('rejects when neither source is given, naming both parameters', async () => {
    await expect(resolveAssetSource({ destPath: 'figures/plot.png' })).rejects.toThrow(
      /sourcePath.*contentBase64|contentBase64.*sourcePath/s,
    );
  });

  it('rejects when both sources are given', async () => {
    await expect(
      resolveAssetSource({
        destPath: 'figures/plot.png',
        sourcePath: '/tmp/whatever.png',
        contentBase64: 'AAAA',
      }),
    ).rejects.toThrow(/exactly one/);
  });

  it('refuses a relative sourcePath', async () => {
    await expect(
      resolveAssetSource({ destPath: 'figures/plot.png', sourcePath: 'plot.png' }),
    ).rejects.toThrow(/absolute/);
  });

  it('expands a leading ~ against the home directory', async () => {
    const res = resolveAssetSource({
      destPath: 'figures/plot.png',
      sourcePath: '~/definitely-not-here-xyz.png',
    });
    await expect(res).rejects.toThrow(/not found/);
    await expect(res).rejects.not.toThrow(/~/);
    try {
      await res;
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).not.toContain('~');
      expect(msg).toContain(path.join(os.homedir(), 'definitely-not-here-xyz.png'));
    }
  });

  it('refuses a sourcePath that is a directory', async () => {
    const dir = await tmp();
    // Named with an asset extension so it clears the cheap pre-I/O filter and actually reaches
    // the stat/isFile check this test means to exercise; an extensionless directory would now
    // be refused earlier, by the allowlist, before ever reaching that check.
    const sub = path.join(dir, 'looks-like-an-asset.png');
    await mkdir(sub);
    await expect(
      resolveAssetSource({ destPath: 'figures/plot.png', sourcePath: sub }),
    ).rejects.toThrow(/not a regular file/);
  });

  it('refuses a missing sourcePath, naming the path', async () => {
    const dir = await tmp();
    const missing = path.join(dir, 'nope.png');
    await expect(
      resolveAssetSource({ destPath: 'figures/plot.png', sourcePath: missing }),
    ).rejects.toThrow(/was not found/);
  });

  it('accepts a file exactly at MAX_ASSET_BYTES and refuses one byte over', async () => {
    const dir = await tmp();
    const okFile = path.join(dir, 'ok.png');
    const bigFile = path.join(dir, 'big.png');
    await writeFile(okFile, Buffer.alloc(MAX_ASSET_BYTES, 1));
    const ok = await resolveAssetSource({ destPath: 'figures/ok.png', sourcePath: okFile });
    expect(ok.bytes.length).toBe(MAX_ASSET_BYTES);

    await writeFile(bigFile, Buffer.alloc(MAX_ASSET_BYTES + 1, 1));
    await expect(
      resolveAssetSource({ destPath: 'figures/big.png', sourcePath: bigFile }),
    ).rejects.toThrow(/exceeds/);
  }, 30000);

  it('decodes valid base64', async () => {
    const res = await resolveAssetSource({
      destPath: 'figures/plot.png',
      contentBase64: PNG.toString('base64'),
    });
    expect(Buffer.compare(res.bytes, PNG)).toBe(0);
    expect(res.origin).toBe('inline base64');
  });

  it('strips a data-URL prefix', async () => {
    const res = await resolveAssetSource({
      destPath: 'figures/plot.png',
      contentBase64: `data:image/png;base64,${PNG.toString('base64')}`,
    });
    expect(Buffer.compare(res.bytes, PNG)).toBe(0);
  });

  it('tolerates embedded whitespace/newlines', async () => {
    const b64 = PNG.toString('base64');
    const wrapped = b64.replace(/(.{4})/g, '$1\n');
    const res = await resolveAssetSource({ destPath: 'figures/plot.png', contentBase64: wrapped });
    expect(Buffer.compare(res.bytes, PNG)).toBe(0);
  });

  it('rejects invalid base64 rather than silently decoding it', async () => {
    const res = resolveAssetSource({
      destPath: 'figures/plot.png',
      contentBase64: 'not base64!!',
    });
    await expect(res).rejects.toThrow(/base64/);
  });

  it('rejects an empty base64 payload', async () => {
    await expect(
      resolveAssetSource({ destPath: 'figures/plot.png', contentBase64: '' }),
    ).rejects.toThrow();
  });

  it('accepts base64 decoding to exactly MAX_INLINE_ASSET_BYTES and refuses just over', async () => {
    const exact = Buffer.alloc(MAX_INLINE_ASSET_BYTES, 7).toString('base64');
    const res = await resolveAssetSource({ destPath: 'figures/plot.png', contentBase64: exact });
    expect(res.bytes.length).toBe(MAX_INLINE_ASSET_BYTES);

    const over = Buffer.alloc(MAX_INLINE_ASSET_BYTES + 1, 7).toString('base64');
    await expect(
      resolveAssetSource({ destPath: 'figures/plot.png', contentBase64: over }),
    ).rejects.toThrow(/exceeds/);
  }, 30000);

  // --- Finding 1: the allowlist must gate sourcePath too, not only destPath ---

  it('refuses a sourcePath outside the asset allowlist even when destPath is fine (the exfiltration hole)', async () => {
    const dir = await tmp();
    // An extensionless file, the shape of a credential (~/.ssh/id_rsa, /etc/passwd).
    const secret = path.join(dir, 'secret');
    await writeFile(secret, 'fake-secret-token=hunter2\n');

    const res = resolveAssetSource({ destPath: 'figures/innocent.png', sourcePath: secret });
    await expect(res).rejects.toThrow(assetSourceBlockedMessage(secret));
  });

  it('refuses id_rsa, .env, and notes.txt as sourcePath, each naming the offending file', async () => {
    const dir = await tmp();
    for (const name of ['id_rsa', '.env', 'notes.txt']) {
      const file = path.join(dir, name);
      await writeFile(file, 'not an asset\n');
      await expect(
        resolveAssetSource({ destPath: 'figures/plot.png', sourcePath: file }),
      ).rejects.toThrow(assetSourceBlockedMessage(file));
    }
  });

  it('still accepts a real asset sourcePath, and differing asset extensions on each side', async () => {
    const dir = await tmp();
    const pngSrc = path.join(dir, 'plot.png');
    await writeFile(pngSrc, PNG);
    const ok = await resolveAssetSource({ destPath: 'figures/plot.png', sourcePath: pngSrc });
    expect(Buffer.compare(ok.bytes, PNG)).toBe(0);

    // plot.jpeg -> plot.jpg: differing asset extensions on either side are legitimate.
    const jpegSrc = path.join(dir, 'plot.jpeg');
    await writeFile(jpegSrc, PNG);
    const ok2 = await resolveAssetSource({ destPath: 'figures/plot.jpg', sourcePath: jpegSrc });
    expect(Buffer.compare(ok2.bytes, PNG)).toBe(0);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a symlink named photo.png whose realpath target is an extensionless secret',
    async () => {
      const dir = await tmp();
      const secret = path.join(dir, 'secret-no-ext');
      await writeFile(secret, 'fake-secret\n');
      const link = path.join(dir, 'photo.png');
      await symlink(secret, link);

      // The check must run on the realpath'd target (secret-no-ext), not the symlink's own
      // name (photo.png), or a symlink launders any source past the gate.
      await expect(
        resolveAssetSource({ destPath: 'figures/plot.png', sourcePath: link }),
      ).rejects.toThrow(assetSourceBlockedMessage(secret));
    },
  );

  it('contentBase64 is unaffected by the source gate (those bytes never touch the filesystem)', async () => {
    const res = await resolveAssetSource({
      destPath: 'figures/plot.png',
      contentBase64: PNG.toString('base64'),
    });
    expect(Buffer.compare(res.bytes, PNG)).toBe(0);
    expect(res.origin).toBe('inline base64');
  });

  // --- Reviewer findings: the source allowlist must be checked BEFORE any filesystem access,
  // not only after realpath/stat, or a caller can use resolveAssetSource as an existence/type
  // oracle over the whole filesystem. ---

  // Running as root defeats chmod-based unreadability, so these are skipped there too.
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  it('refuses a non-existent, extensionless sourcePath with the allowlist message, not "was not found"', async () => {
    // Pre-fix, this hit realpath first and failed ENOENT -> "was not found", which lets a
    // caller distinguish "exists" from "doesn't exist" for any absolute path it names.
    const res = resolveAssetSource({
      destPath: 'figures/plot.png',
      sourcePath: '/definitely/does/not/exist/secret',
    });
    await expect(res).rejects.toThrow(/not a recognized asset type/);
    await expect(res).rejects.not.toThrow(/was not found/);
  });

  it.skipIf(process.platform === 'win32' || isRoot)(
    'a non-asset sourcePath is refused with zero filesystem access, even when the containing directory is unreadable',
    async () => {
      const dir = await tmp();
      const secret = path.join(dir, 'secret-no-ext');
      await writeFile(secret, 'fake-secret\n');
      await chmod(dir, 0o000);
      cleanups.unshift(() => chmod(dir, 0o755));

      // If the extension check ran after any fs syscall (realpath/stat), this would fail with
      // a permission error (EACCES) rather than the allowlist message, because the directory
      // itself cannot be traversed. Since the extension check is pure string work done before
      // any I/O, the file being unreadable must not matter at all.
      const res = resolveAssetSource({ destPath: 'figures/plot.png', sourcePath: secret });
      await expect(res).rejects.toThrow(assetSourceBlockedMessage(secret));
      await expect(res).rejects.not.toThrow(/EACCES|permission denied/i);
    },
  );

  it.skipIf(process.platform === 'win32' || isRoot)(
    'wraps a permission error from realpath into a clean message, without leaking the raw errno text',
    async () => {
      const dir = await tmp();
      // An asset-shaped name, so the cheap pre-I/O check passes and the call actually reaches
      // realpath, which then fails because the containing directory cannot be traversed.
      const file = path.join(dir, 'photo.png');
      await writeFile(file, PNG);
      await chmod(dir, 0o000);
      cleanups.unshift(() => chmod(dir, 0o755));

      const res = resolveAssetSource({ destPath: 'figures/plot.png', sourcePath: file });
      await expect(res).rejects.toThrow(/could not be resolved/i);
      await expect(res).rejects.not.toThrow(/EACCES/);
      await expect(res).rejects.not.toThrow(/realpath/);
    },
  );

  // --- Finding 1: a raw errno other than ENOENT/EACCES/EPERM must not leak the syscall name or
  // path back to the caller — that text is itself a file-type oracle (ENOTDIR proves a path
  // segment exists and is a regular file; ELOOP proves a symlink cycle). ---

  it('treats an asset-shaped path through a regular file (ENOTDIR) as not-found, without leaking realpath/ENOTDIR', async () => {
    const dir = await tmp();
    const secret = path.join(dir, 'secret');
    await writeFile(secret, 'fake-secret\n');
    // secret is a regular file, not a directory, so treating it as a path segment (secret/x.png)
    // makes realpath fail with ENOTDIR rather than ENOENT. Pre-fix this rethrew the raw error,
    // whose message ("ENOTDIR: not a directory, realpath '<path>'") proves /etc/passwd-shaped
    // paths exist and are regular files.
    const probe = path.join(secret, 'x.png');

    const res = resolveAssetSource({ destPath: 'figures/plot.png', sourcePath: probe });
    await expect(res).rejects.toThrow(`sourcePath "${probe}" was not found.`);
    await expect(res).rejects.not.toThrow(/ENOTDIR|realpath|not a directory/);
  });

  it.skipIf(process.platform === 'win32')(
    'treats a symlink loop (ELOOP) as not-found, without leaking realpath/ELOOP',
    async () => {
      const dir = await tmp();
      const loop = path.join(dir, 'loop.png');
      await symlink(loop, loop);

      const res = resolveAssetSource({ destPath: 'figures/plot.png', sourcePath: loop });
      await expect(res).rejects.toThrow(`sourcePath "${loop}" was not found.`);
      await expect(res).rejects.not.toThrow(/ELOOP/);
    },
  );
});
