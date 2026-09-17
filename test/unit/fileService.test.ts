import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, rm, truncate, chmod } from 'node:fs/promises';
import { FileService, MAX_READ_BYTES } from '../../src/services/fileService.js';
import { MAX_ASSET_BYTES, MAX_BINARY_READ_BYTES } from '../../src/lib/assets.js';

describe('FileService', () => {
  let dir: string;
  const files = new FileService();

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-fs-'));
    await mkdir(path.join(dir, 'chapters'), { recursive: true });
    await mkdir(path.join(dir, '.git'), { recursive: true });
    await writeFile(path.join(dir, 'main.tex'), 'line1\nline2\nline3\n');
    await writeFile(path.join(dir, 'refs.bib'), '@book{x, title={T}}\n');
    await writeFile(path.join(dir, 'chapters', 'intro.tex'), 'intro\n');
    await writeFile(path.join(dir, 'figure.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/master\n');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('lists all files except .git, sorted', async () => {
    const all = await files.list(dir, { filter: 'all' });
    expect(all.map((f) => f.path)).toEqual([
      'chapters/intro.tex',
      'figure.png',
      'main.tex',
      'refs.bib',
    ]);
  });

  it('filters by type', async () => {
    expect((await files.list(dir, { filter: 'tex' })).map((f) => f.path)).toEqual([
      'chapters/intro.tex',
      'main.tex',
    ]);
    expect((await files.list(dir, { filter: 'bib' })).map((f) => f.path)).toEqual(['refs.bib']);
    expect((await files.list(dir, { filter: 'assets' })).map((f) => f.path)).toEqual([
      'figure.png',
    ]);
  });

  it('restricts to a subdirectory', async () => {
    expect((await files.list(dir, { subdir: 'chapters' })).map((f) => f.path)).toEqual([
      'chapters/intro.tex',
    ]);
  });

  it('reads a full text file', async () => {
    const res = await files.read(dir, { path: 'main.tex' });
    expect(res.content).toBe('line1\nline2\nline3\n');
    // A trailing newline ends the third line; it does not start a fourth. Counting the empty
    // string after it put a line number on a line the file does not have.
    expect(res.totalLines).toBe(3);
    expect(res.truncated).toBe(false);
  });

  it('returns a ranged read byte-exactly, CRLF included', async () => {
    // What comes back has to go straight back in as edit_file's oldString.
    await writeFile(path.join(dir, 'crlf.tex'), 'line one\r\nline two\r\nline three\r\n', 'utf8');
    const res = await files.read(dir, { path: 'crlf.tex', startLine: 1, endLine: 2 });
    expect(res.content).toBe('line one\r\nline two');

    await files.applyEdits(dir, 'crlf.tex', [{ oldString: res.content, newString: 'replaced' }]);
    expect(await readFile(path.join(dir, 'crlf.tex'), 'utf8')).toBe('replaced\r\nline three\r\n');
  });

  it('does not call a whole-file range truncated', async () => {
    const res = await files.read(dir, { path: 'main.tex', startLine: 1 });
    expect(res.content).toBe('line1\nline2\nline3\n');
    expect(res.truncated).toBe(false);
  });

  it('reads a line range', async () => {
    const res = await files.read(dir, { path: 'main.tex', startLine: 2, endLine: 2 });
    expect(res.content).toBe('line2');
    expect(res.truncated).toBe(true);
  });

  it('does not return binary content inline', async () => {
    const res = await files.read(dir, { path: 'figure.png' });
    expect(res.content).toBe('');
    expect(res.truncated).toBe(true);
    expect(res.note).toMatch(/Binary or large file/);
  });

  it('rejects path traversal on read', async () => {
    await expect(files.read(dir, { path: '../escape.tex' })).rejects.toThrow(/escapes/);
  });
});

describe('FileService binary asset read/write', () => {
  let dir: string;
  let files: FileService;
  // PNG header + a NUL + a CRLF + invalid UTF-8 sequences: a UTF-8 round trip destroys this.
  const payload = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0xfd,
  ]);

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-fs-bin-'));
    await mkdir(path.join(dir, '.git'), { recursive: true });
    files = new FileService();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips a binary payload byte-identically through writeBytes/readBytes', async () => {
    await files.writeBytes(dir, { path: 'fig.png', bytes: payload });
    const read = await files.readBytes(dir, { path: 'fig.png' });
    expect(read).not.toBeNull();
    expect(Buffer.compare(read as Buffer, payload)).toBe(0);
    const onDisk = await readFile(path.join(dir, 'fig.png'));
    expect(Buffer.compare(onDisk, payload)).toBe(0);
  });

  it('the corruption writeBytes exists to prevent: the text write path mangles the same payload', async () => {
    await files.write(dir, { path: 'fig-as-text.png', content: payload.toString('utf8') });
    const onDisk = await readFile(path.join(dir, 'fig-as-text.png'));
    expect(Buffer.compare(onDisk, payload)).not.toBe(0);
  });

  it('writeBytes reports created vs overwrite and the right bytesWritten', async () => {
    const first = await files.writeBytes(dir, { path: 'fig.png', bytes: payload });
    expect(first.created).toBe(true);
    expect(first.bytesWritten).toBe(payload.length);

    const second = await files.writeBytes(dir, { path: 'fig.png', bytes: payload });
    expect(second.created).toBe(false);
  });

  it('ExternalChangeError still fires on the byte path, and overrideExternalChanges still bypasses it', async () => {
    await files.writeBytes(dir, { path: 'fig.png', bytes: payload });
    await writeFile(path.join(dir, 'fig.png'), Buffer.from([0x00, 0x01, 0x02]));

    await expect(
      files.writeBytes(dir, { path: 'fig.png', bytes: Buffer.from([0x03, 0x04]) }),
    ).rejects.toThrow(/changed on disk/);

    await expect(
      files.writeBytes(dir, {
        path: 'fig.png',
        bytes: Buffer.from([0x03, 0x04]),
        overrideExternalChanges: true,
      }),
    ).resolves.toMatchObject({ path: 'fig.png' });
  });

  it('readBytes returns null for a missing file', async () => {
    expect(await files.readBytes(dir, { path: 'nope.png' })).toBeNull();
  });

  it('readBytes only arms the out-of-band guard when recordBaseline is set (default: false)', async () => {
    await files.writeBytes(dir, { path: 'fig.png', bytes: payload });

    // Default read does not re-arm anything new here, but exercise the "no baseline recorded"
    // side: read without recordBaseline, then externally modify, then a write should still see
    // the baseline set by writeBytes itself (unaffected) — so instead prove the flag's effect
    // directly: reading a file the server never wrote, without recordBaseline, then writing over
    // an out-of-band change must NOT throw (no baseline was ever recorded).
    await files.writeBytes(dir, {
      path: 'other.png',
      bytes: payload,
      overrideExternalChanges: true,
    });
    // Simulate the server never having a baseline for a file that already exists on disk:
    const freshDir = dir;
    await writeFile(path.join(freshDir, 'external.png'), payload);
    await files.readBytes(freshDir, { path: 'external.png' }); // no recordBaseline
    await writeFile(path.join(freshDir, 'external.png'), Buffer.from([0x11, 0x22]));
    await expect(
      files.writeBytes(freshDir, { path: 'external.png', bytes: Buffer.from([0x33]) }),
    ).resolves.toMatchObject({ path: 'external.png' });

    // Now with recordBaseline: true, the same sequence must throw.
    await writeFile(path.join(freshDir, 'external2.png'), payload);
    await files.readBytes(freshDir, { path: 'external2.png', recordBaseline: true });
    await writeFile(path.join(freshDir, 'external2.png'), Buffer.from([0x11, 0x22]));
    await expect(
      files.writeBytes(freshDir, { path: 'external2.png', bytes: Buffer.from([0x33]) }),
    ).rejects.toThrow(/changed on disk/);
  });

  it('missing-parent message names createDirs and the parent path (text write)', async () => {
    await expect(files.write(dir, { path: 'a/b/c.tex', content: 'hi' })).rejects.toThrow(
      /createDirs.*a\/b|a\/b.*createDirs/s,
    );
  });

  it('missing-parent message names createDirs and the parent path (byte write)', async () => {
    await expect(files.writeBytes(dir, { path: 'a/b/c.png', bytes: payload })).rejects.toThrow(
      /createDirs.*a\/b|a\/b.*createDirs/s,
    );
  });

  it('createDirs: true creates the missing directories and succeeds', async () => {
    const res = await files.write(dir, {
      path: 'a/b/c.tex',
      content: 'hi',
      createDirs: true,
    });
    expect(res.created).toBe(true);
    expect(await readFile(path.join(dir, 'a', 'b', 'c.tex'), 'utf8')).toBe('hi');
  });

  it('a different ENOENT (parent exists as a file) is not masked as a missing directory', async () => {
    await writeFile(path.join(dir, 'blocker'), 'im a file not a dir');
    await expect(
      files.write(dir, { path: 'blocker/child.tex', content: 'hi', createDirs: true }),
    ).rejects.toThrow(/ENOTDIR|ENOENT|EEXIST/);
    // And it must NOT be our friendly createDirs message, since createDirs was already set.
    await expect(
      files.write(dir, { path: 'blocker/child.tex', content: 'hi', createDirs: true }),
    ).rejects.not.toThrow(/Pass createDirs: true/);
  });

  it('externalModifications does not flag a binary file the server itself just wrote', async () => {
    await files.writeBytes(dir, { path: 'fig.png', bytes: payload });
    expect(await files.externalModifications(dir, ['fig.png'])).toEqual([]);

    await writeFile(path.join(dir, 'fig.png'), Buffer.from([0x01, 0x02, 0x03]));
    expect(await files.externalModifications(dir, ['fig.png'])).toEqual(['fig.png']);
  });

  it('does not flag a latin-1 (non-UTF-8) .tex file as externally modified when nothing changed', async () => {
    // "café" encoded latin-1: the trailing 0xe9 is not valid UTF-8 on its own, so reading it as
    // 'utf8' lossily decodes to U+FFFD. read()'s baseline is recorded from that decoded string,
    // while externalModifications hashes the raw bytes — those two must still agree here, or a
    // latin-1 .tex file (common in LaTeX) is reported as externally changed forever.
    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);
    await writeFile(path.join(dir, 'main.tex'), latin1);

    await files.read(dir, { path: 'main.tex', recordBaseline: true });

    expect(await files.externalModifications(dir, ['main.tex'])).toEqual([]);
  });
});

describe('FileService out-of-band guard: byte vs string baseline agreement', () => {
  // Reproduces the reviewer's scenario: add_asset writes a figure via writeBytes (which records
  // a Buffer baseline), then a later mutation on the SAME file re-reads it as a *string* to check
  // staleness. For non-UTF-8 bytes those two hashes never agree, so the refusal-site checks were
  // comparing a byte baseline against a decoded-string rehash of THE SERVER'S OWN WRITE and
  // concluding it had been externally edited.
  let dir: string;
  let files: FileService;

  // PNG header + invalid UTF-8 bytes — never valid UTF-8, exactly like `add_asset`'s payload.
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0xfd]);
  // "<svg>" + one invalid UTF-8 byte + "</svg>": not valid UTF-8, but the ASCII framing survives
  // the lossy decode so applyEdits/write can still target text in it.
  const SVG_NON_UTF8 = Buffer.from([
    0x3c, 0x73, 0x76, 0x67, 0x3e, 0xe9, 0x3c, 0x2f, 0x73, 0x76, 0x67, 0x3e,
  ]);

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-fs-guard-'));
    await mkdir(path.join(dir, '.git'), { recursive: true });
    await mkdir(path.join(dir, 'figures'), { recursive: true });
    files = new FileService();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('imports a figure and removes it in the same session: delete after writeBytes must succeed', async () => {
    await files.writeBytes(dir, { path: 'figures/plot.png', bytes: PNG });
    await expect(files.delete(dir, 'figures/plot.png')).resolves.toMatchObject({
      path: 'figures/plot.png',
    });
  });

  it('applyEdits on a file just imported via writeBytes (non-UTF-8) must succeed', async () => {
    await files.writeBytes(dir, { path: 'figures/icon.svg', bytes: SVG_NON_UTF8 });
    await expect(
      files.applyEdits(dir, 'figures/icon.svg', [{ oldString: '<svg>', newString: '<img>' }]),
    ).resolves.toMatchObject({ path: 'figures/icon.svg', appliedEdits: 1 });
  });

  it('text write on a file just imported via writeBytes (non-UTF-8) must succeed', async () => {
    await files.writeBytes(dir, { path: 'figures/icon.svg', bytes: SVG_NON_UTF8 });
    await expect(
      files.write(dir, { path: 'figures/icon.svg', content: '<svg>edited</svg>' }),
    ).resolves.toMatchObject({ path: 'figures/icon.svg', created: false });
  });

  it('writeBytes onto itself twice in a row must succeed', async () => {
    await files.writeBytes(dir, { path: 'figures/plot.png', bytes: PNG });
    await expect(
      files.writeBytes(dir, { path: 'figures/plot.png', bytes: PNG }),
    ).resolves.toMatchObject({ path: 'figures/plot.png', created: false });
  });

  describe('the guard still bites on a genuine external edit', () => {
    it('write: text file changed on disk after being written is refused', async () => {
      await files.write(dir, { path: 'note.tex', content: 'original\n' });
      await writeFile(path.join(dir, 'note.tex'), 'someone else edited this\n');
      await expect(
        files.write(dir, { path: 'note.tex', content: 'new content\n' }),
      ).rejects.toThrow(/changed on disk/);
      await expect(
        files.write(dir, {
          path: 'note.tex',
          content: 'new content\n',
          overrideExternalChanges: true,
        }),
      ).resolves.toMatchObject({ path: 'note.tex' });
    });

    it('write: binary file changed on disk after being writeBytes-written is refused', async () => {
      await files.writeBytes(dir, { path: 'figures/plot.png', bytes: PNG });
      await writeFile(path.join(dir, 'figures/plot.png'), Buffer.from([0x01, 0x02, 0x03]));
      await expect(
        files.write(dir, { path: 'figures/plot.png', content: 'not actually a png' }),
      ).rejects.toThrow(/changed on disk/);
    });

    it('writeBytes: binary file changed on disk after being writeBytes-written is refused', async () => {
      await files.writeBytes(dir, { path: 'figures/plot.png', bytes: PNG });
      await writeFile(path.join(dir, 'figures/plot.png'), Buffer.from([0x01, 0x02, 0x03]));
      await expect(
        files.writeBytes(dir, { path: 'figures/plot.png', bytes: Buffer.from([0x09, 0x08]) }),
      ).rejects.toThrow(/changed on disk/);
      await expect(
        files.writeBytes(dir, {
          path: 'figures/plot.png',
          bytes: Buffer.from([0x09, 0x08]),
          overrideExternalChanges: true,
        }),
      ).resolves.toMatchObject({ path: 'figures/plot.png' });
    });

    it('applyEdits: text file changed on disk after being written is refused', async () => {
      await files.write(dir, { path: 'note.tex', content: 'original text here\n' });
      await writeFile(path.join(dir, 'note.tex'), 'edited directly by a human\n');
      await expect(
        files.applyEdits(dir, 'note.tex', [{ oldString: 'edited', newString: 'changed' }]),
      ).rejects.toThrow(/changed on disk/);
    });

    it('applyEdits: binary file changed on disk after being writeBytes-written is refused', async () => {
      await files.writeBytes(dir, { path: 'figures/icon.svg', bytes: SVG_NON_UTF8 });
      await writeFile(path.join(dir, 'figures/icon.svg'), Buffer.from([0x7a, 0x7a, 0x7a]));
      await expect(
        files.applyEdits(dir, 'figures/icon.svg', [{ oldString: 'zzz', newString: 'yyy' }]),
      ).rejects.toThrow(/changed on disk/);
    });

    it('delete: text file changed on disk after being written is refused', async () => {
      await files.write(dir, { path: 'note.tex', content: 'original\n' });
      await writeFile(path.join(dir, 'note.tex'), 'edited by a human\n');
      await expect(files.delete(dir, 'note.tex')).rejects.toThrow(/changed on disk/);
      await expect(
        files.delete(dir, 'note.tex', { overrideExternalChanges: true }),
      ).resolves.toMatchObject({ path: 'note.tex' });
    });

    it('delete: binary file changed on disk after being writeBytes-written is refused', async () => {
      await files.writeBytes(dir, { path: 'figures/plot.png', bytes: PNG });
      await writeFile(path.join(dir, 'figures/plot.png'), Buffer.from([0x01, 0x02, 0x03]));
      await expect(files.delete(dir, 'figures/plot.png')).rejects.toThrow(/changed on disk/);
      await expect(
        files.delete(dir, 'figures/plot.png', { overrideExternalChanges: true }),
      ).resolves.toMatchObject({ path: 'figures/plot.png' });
    });
  });

  it('delete: a file with no recorded baseline at all is still deletable (hasBaseline guard unchanged)', async () => {
    await mkdir(path.join(dir, 'figures'), { recursive: true });
    await writeFile(path.join(dir, 'figures', 'never-seen.png'), PNG);
    await expect(files.delete(dir, 'figures/never-seen.png')).resolves.toMatchObject({
      path: 'figures/never-seen.png',
    });
  });
});

describe('FileService readBytes size cap', () => {
  // `readBytes` is the BINARY reader, and it is capped at MAX_BINARY_READ_BYTES — its own,
  // much larger cap — not at MAX_READ_BYTES, which is the TEXT cap `read`/`readText` live under.
  // The two limits have to differ because `add_asset` imports figures up to MAX_ASSET_BYTES and
  // `src/tools/revert.ts` reads every touched path back through `readBytes` to attribute a
  // revert: under the text cap, reading back a 3 MiB PNG this server itself wrote threw, and the
  // throw left the path flagged `conflicted` + `unrecorded` for good (issue #66 §7).
  let dir: string;
  let files: FileService;
  /** Paths chmod'd unreadable by a test, restored before `rm` so cleanup itself cannot fail. */
  let locked: string[];

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-fs-readcap-'));
    await mkdir(path.join(dir, '.git'), { recursive: true });
    files = new FileService();
    locked = [];
  });

  afterEach(async () => {
    for (const p of locked) await chmod(p, 0o600).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  /** A file whose `stat` size is `size` but which costs no real bytes — the guard reads `stat`. */
  async function sized(rel: string, size: number): Promise<string> {
    const p = path.join(dir, rel);
    await writeFile(p, '');
    await truncate(p, size);
    return p;
  }

  it('reads back a 3 MiB binary file — over the text cap, under the binary cap', async () => {
    // The actual case from issue #66 §7: a 3 MiB PNG `add_asset` imported and `revert` reads back
    // to attribute the change. Under the old MAX_READ_BYTES guard this was a hard throw.
    const size = 3 * 1024 * 1024;
    expect(size).toBeGreaterThan(MAX_READ_BYTES);
    expect(size).toBeLessThan(MAX_BINARY_READ_BYTES);
    await sized('figure.png', size);

    const read = await files.readBytes(dir, { path: 'figure.png' });
    expect(read).not.toBeNull();
    expect((read as Buffer).length).toBe(size);
  });

  it('reads a file of exactly MAX_BINARY_READ_BYTES fine', async () => {
    await sized('at-cap.bin', MAX_BINARY_READ_BYTES);

    const read = await files.readBytes(dir, { path: 'at-cap.bin' });
    expect(read).not.toBeNull();
    expect((read as Buffer).length).toBe(MAX_BINARY_READ_BYTES);
  });

  it('throws one byte over MAX_BINARY_READ_BYTES, naming the cap and the actual size', async () => {
    // The mandatory just-outside case: a security-shaped limit is only pinned by testing both
    // sides of its exact boundary, so this pairs with the exactly-at-cap case above.
    await sized('over-cap.bin', MAX_BINARY_READ_BYTES + 1);

    const err = await files
      .readBytes(dir, { path: 'over-cap.bin' })
      .then(() => null)
      .catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toMatch(/binary read cap/);
    expect(msg).toContain(String(MAX_BINARY_READ_BYTES));
    expect(msg).toContain(String(MAX_BINARY_READ_BYTES + 1));
  });

  it('names the binary cap as the one that fired, with the text cap only as the other limit', async () => {
    await sized('over-cap2.bin', MAX_BINARY_READ_BYTES + 1);

    const err = await files
      .readBytes(dir, { path: 'over-cap2.bin' })
      .then(() => null)
      .catch((e: unknown) => e as Error);
    const msg = (err as Error).message;
    // The number attached to "binary read cap" is the binary one, never the text one.
    expect(msg).toContain(`${MAX_BINARY_READ_BYTES}-byte binary read cap`);
    expect(msg).not.toContain(`${MAX_READ_BYTES}-byte binary read cap`);
    // The text cap is still reported, but explicitly as the separate, smaller limit.
    expect(msg).toContain(String(MAX_READ_BYTES));
    expect(msg).toContain(`the text read cap, ${MAX_READ_BYTES} bytes, is a separate`);
  });

  // Skipped rather than early-returned where it cannot prove anything, so it reports as skipped
  // instead of green: chmod 0o000 does not reliably block reads for the owning user on Windows,
  // and root reads straight through mode 000, so in both cases the read would succeed either way
  // and the assertion below would pass without discriminating. Both are knowable here.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'refuses on the pre-read stat, before the file is ever opened',
    async () => {
      const p = await sized('unreadable.bin', MAX_BINARY_READ_BYTES + 1);
      await chmod(p, 0o000);
      locked.push(p);

      // `stat` works on an unreadable file; `readFile` does not. Getting the cap message rather
      // than EACCES is what proves the size guard ran before `readFile` was attempted.
      await expect(files.readBytes(dir, { path: 'unreadable.bin' })).rejects.toThrow(
        /binary read cap/,
      );
    },
  );

  it('keeps the binary cap at or above what add_asset may import, and above the text cap', async () => {
    // The invariant: anything `add_asset` was allowed to write in can be read back out.
    expect(MAX_BINARY_READ_BYTES).toBeGreaterThanOrEqual(MAX_ASSET_BYTES);
    expect(MAX_BINARY_READ_BYTES).toBeGreaterThan(MAX_READ_BYTES);
  });

  it('still returns null for a missing file', async () => {
    expect(await files.readBytes(dir, { path: 'nope.bin' })).toBeNull();
  });

  it('still refuses a directory the same way read() does', async () => {
    await mkdir(path.join(dir, 'adir'), { recursive: true });
    await expect(files.readBytes(dir, { path: 'adir' })).rejects.toThrow(/Not a file/);
  });
});
