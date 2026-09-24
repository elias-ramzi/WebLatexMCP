import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, readFile, writeFile, stat, readdir, chmod } from 'node:fs/promises';
import { ShelfStore, ShelfCorruptError } from '../../src/services/shelfStore.js';
import type { ShelfFileInput } from '../../src/services/shelfStore.js';
import { sessionStateDir } from '../../src/lib/sessionPaths.js';

const PROJECT = 'paper';

/** Ids handed out in order, so every assertion can name the shelf it means. */
function idSource(ids: string[]): () => string {
  let i = 0;
  return () => ids[i++] ?? `sh-ffffff${String(i).padStart(2, '0')}`;
}

function fileInput(over: Partial<ShelfFileInput> = {}): ShelfFileInput {
  return {
    path: 'main.tex',
    status: 'modified',
    added: 1,
    removed: 0,
    content: Buffer.from('working\n', 'utf8'),
    base: Buffer.from('head\n', 'utf8'),
    ...over,
  };
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe('ShelfStore', () => {
  let workspace: string;
  let store: ShelfStore;
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-shelf-'));
    store = new ShelfStore(workspace, 'sess-a', idSource(['sh-1a2b3c4d', 'sh-99887766']));
    stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    stderr.mockRestore();
    await rm(workspace, { recursive: true, force: true });
  });

  it('puts shelves under .sessions/<projectId>/shelves, beside the clone', () => {
    expect(store.shelvesDir(PROJECT)).toBe(
      path.join(sessionStateDir(workspace, PROJECT), 'shelves'),
    );
  });

  it('round-trips a manifest and the exact bytes, decoding and normalising nothing', async () => {
    // A NUL and CRLF: anything that decoded to text or normalised line endings would corrupt these.
    const content = Buffer.from([0x61, 0x0d, 0x0a, 0x00, 0x62, 0xff]);
    const base = Buffer.from('head\r\nlines\r\n', 'utf8');
    const manifest = await store.create(PROJECT, {
      label: 'mid-sentence intro',
      headSha: 'a'.repeat(40),
      files: [fileInput({ path: 'main.tex', content, base, added: 4, removed: 2 })],
    });

    expect(manifest.id).toBe('sh-1a2b3c4d');
    expect(manifest.version).toBe(1);
    expect(manifest.sessionId).toBe('sess-a');
    expect(manifest.label).toBe('mid-sentence intro');
    expect(manifest.headSha).toBe('a'.repeat(40));
    expect(manifest.files).toEqual([
      { path: 'main.tex', status: 'modified', added: 4, removed: 2 },
    ]);

    expect(await store.list(PROJECT)).toEqual([manifest]);

    const entry = await store.read(PROJECT, 'sh-1a2b3c4d');
    expect(entry?.manifest).toEqual(manifest);
    const readContent = await entry?.content('main.tex');
    const readBase = await entry?.base('main.tex');
    expect(readContent?.equals(content)).toBe(true);
    expect(readBase?.equals(base)).toBe(true);
  });

  it('stores nothing on the side a status says is absent', async () => {
    await store.create(PROJECT, {
      label: null,
      headSha: 'unborn',
      files: [
        fileInput({ path: 'new.tex', status: 'added', base: null }),
        fileInput({ path: 'gone.tex', status: 'deleted', content: null }),
      ],
    });
    const entry = await store.read(PROJECT, 'sh-1a2b3c4d');
    expect(await entry?.base('new.tex')).toBeNull();
    expect(await entry?.content('gone.tex')).toBeNull();
    expect((await entry?.content('new.tex'))?.toString('utf8')).toBe('working\n');
    expect((await entry?.base('gone.tex'))?.toString('utf8')).toBe('head\n');
  });

  it('round-trips a nested path, creating its parent directories', async () => {
    await store.create(PROJECT, {
      label: null,
      headSha: 'b'.repeat(40),
      files: [fileInput({ path: 'sections/b.tex', content: Buffer.from('deep\n', 'utf8') })],
    });
    const entry = await store.read(PROJECT, 'sh-1a2b3c4d');
    expect(entry?.manifest.files[0]?.path).toBe('sections/b.tex');
    expect((await entry?.content('sections/b.tex'))?.toString('utf8')).toBe('deep\n');
  });

  it('lists newest first', async () => {
    await store.create(PROJECT, { label: 'first', headSha: 'x', files: [fileInput()] });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.create(PROJECT, { label: 'second', headSha: 'x', files: [fileInput()] });

    const listed = await store.list(PROJECT);
    expect(listed.map((m) => m.label)).toEqual(['second', 'first']);
    expect(listed.map((m) => m.id)).toEqual(['sh-99887766', 'sh-1a2b3c4d']);
  });

  it('returns [] for a project nothing has been shelved on, logging nothing', async () => {
    expect(await store.list('never-used')).toEqual([]);
    expect(stderr).not.toHaveBeenCalled();
  });

  it('skips a shelf directory holding content but no manifest, and still lists the valid ones', async () => {
    await store.create(PROJECT, { label: 'real', headSha: 'x', files: [fileInput()] });
    // A shelve that died before writing its manifest: content on disk, no shelf.json.
    const halfWritten = path.join(store.shelvesDir(PROJECT), 'sh-deadbeef');
    await mkdir(path.join(halfWritten, 'content'), { recursive: true });
    await writeFile(path.join(halfWritten, 'content', 'main.tex'), 'half\n', 'utf8');

    const listed = await store.list(PROJECT);
    expect(listed.map((m) => m.id)).toEqual(['sh-1a2b3c4d']);
    expect(await store.read(PROJECT, 'sh-deadbeef')).toBeNull();
    expect(stderr).toHaveBeenCalled();
  });

  it('skips a shelf whose manifest is not valid JSON, without throwing', async () => {
    await store.create(PROJECT, { label: 'real', headSha: 'x', files: [fileInput()] });
    const broken = path.join(store.shelvesDir(PROJECT), 'sh-deadbeef');
    await mkdir(broken, { recursive: true });
    await writeFile(path.join(broken, 'shelf.json'), '{ not json', 'utf8');

    await expect(store.list(PROJECT)).resolves.toHaveLength(1);
    await expect(store.read(PROJECT, 'sh-deadbeef')).resolves.toBeNull();
  });

  it('skips a shelf whose manifest is JSON but fails parseManifest, without throwing', async () => {
    await store.create(PROJECT, { label: 'real', headSha: 'x', files: [fileInput()] });
    const broken = path.join(store.shelvesDir(PROJECT), 'sh-deadbeef');
    await mkdir(broken, { recursive: true });
    await writeFile(
      path.join(broken, 'shelf.json'),
      JSON.stringify({ version: 2, id: 'sh-deadbeef', files: [] }),
      'utf8',
    );

    await expect(store.list(PROJECT)).resolves.toHaveLength(1);
    await expect(store.read(PROJECT, 'sh-deadbeef')).resolves.toBeNull();
  });

  it('skips a hand-written manifest whose file path escapes the shelf', async () => {
    const dir = path.join(store.shelvesDir(PROJECT), 'sh-deadbeef');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'shelf.json'),
      JSON.stringify({
        version: 1,
        id: 'sh-deadbeef',
        label: null,
        createdAt: '2026-09-18T10:00:00.000Z',
        sessionId: 'sess-x',
        headSha: 'x',
        files: [{ path: '../escape.tex', status: 'modified', added: 1, removed: 0 }],
      }),
      'utf8',
    );

    expect(await store.list(PROJECT)).toEqual([]);
    expect(await store.read(PROJECT, 'sh-deadbeef')).toBeNull();
  });

  it('refuses to read outside the shelf directory rather than follow an escaping relPath', async () => {
    await store.create(PROJECT, { label: null, headSha: 'x', files: [fileInput()] });
    const entry = await store.read(PROJECT, 'sh-1a2b3c4d');
    expect(entry).not.toBeNull();

    // `../shelf.json` is a real, readable file one level up from `content/`: without the escape
    // check these would hand back the manifest's bytes instead of throwing.
    await expect(entry?.content('../shelf.json')).rejects.toThrow(/escapes/);
    await expect(entry?.base('../shelf.json')).rejects.toThrow(/escapes/);
    await expect(entry?.content('../../../../etc/passwd')).rejects.toThrow(/escapes/);
    await expect(entry?.content('/etc/passwd')).rejects.toThrow(/absolute/);
    await expect(entry?.content('..\\shelf.json')).rejects.toThrow(/not usable/);
    await expect(entry?.content('main.tex\u0000.png')).rejects.toThrow(/not usable/);
  });

  it('refuses an invalid shelf id in read without touching the filesystem', async () => {
    const sentinel = path.join(sessionStateDir(workspace, PROJECT), 'sentinel');
    await mkdir(sentinel, { recursive: true });
    await writeFile(path.join(sentinel, 'keep.txt'), 'keep\n', 'utf8');

    await expect(store.read(PROJECT, '../sentinel')).rejects.toThrow(/list_shelves/);
    await expect(store.read(PROJECT, 'sh-1A2B3C4D')).rejects.toThrow(/list_shelves/);
    expect(await exists(path.join(sentinel, 'keep.txt'))).toBe(true);
    // Nothing was created either: no shelves directory sprang into being.
    expect(await exists(store.shelvesDir(PROJECT))).toBe(false);
  });

  it('refuses an invalid shelf id in remove without deleting anything', async () => {
    await store.create(PROJECT, { label: null, headSha: 'x', files: [fileInput()] });
    const sentinel = path.join(sessionStateDir(workspace, PROJECT), 'sentinel');
    await mkdir(sentinel, { recursive: true });
    await writeFile(path.join(sentinel, 'keep.txt'), 'keep\n', 'utf8');

    await expect(store.remove(PROJECT, '../sentinel')).rejects.toThrow(/list_shelves/);
    await expect(store.remove(PROJECT, '')).rejects.toThrow(/list_shelves/);
    expect(await exists(path.join(sentinel, 'keep.txt'))).toBe(true);
    expect((await store.list(PROJECT)).map((m) => m.id)).toEqual(['sh-1a2b3c4d']);
  });

  it('removes a shelf, and removing an unknown one is a no-op', async () => {
    await store.create(PROJECT, { label: null, headSha: 'x', files: [fileInput()] });
    await store.remove(PROJECT, 'sh-1a2b3c4d');
    expect(await store.list(PROJECT)).toEqual([]);
    expect(await store.read(PROJECT, 'sh-1a2b3c4d')).toBeNull();
    await expect(store.remove(PROJECT, 'sh-1a2b3c4d')).resolves.toBeUndefined();
    await expect(store.remove('never-used', 'sh-1a2b3c4d')).resolves.toBeUndefined();
  });

  it('leaves nothing behind when a write fails part-way through', async () => {
    await expect(
      store.create(PROJECT, {
        label: null,
        headSha: 'x',
        files: [
          fileInput({ path: 'ok.tex' }),
          fileInput({ path: '../escape.tex' }), // fails only after ok.tex has landed
        ],
      }),
    ).rejects.toThrow(/escapes/);

    // The whole shelf directory is gone — not merely manifest-less.
    expect(await exists(path.join(store.shelvesDir(PROJECT), 'sh-1a2b3c4d'))).toBe(false);
    expect(await readdir(store.shelvesDir(PROJECT))).toEqual([]);
    expect(await store.list(PROJECT)).toEqual([]);
    expect(await store.read(PROJECT, 'sh-1a2b3c4d')).toBeNull();
    // And nothing escaped into the parent directory either.
    expect(await exists(path.join(store.shelvesDir(PROJECT), '..', 'escape.tex'))).toBe(false);
  });

  it('isolates shelves per project', async () => {
    await store.create('paper-a', { label: 'a', headSha: 'x', files: [fileInput()] });
    await store.create('paper-b', { label: 'b', headSha: 'x', files: [fileInput()] });

    expect((await store.list('paper-a')).map((m) => m.label)).toEqual(['a']);
    expect((await store.list('paper-b')).map((m) => m.label)).toEqual(['b']);
  });

  it('writes the manifest as JSON holding exactly the recorded files', async () => {
    const manifest = await store.create(PROJECT, {
      label: null,
      headSha: 'x',
      files: [fileInput({ path: 'sections/b.tex' })],
    });
    const raw = await readFile(
      path.join(store.shelvesDir(PROJECT), 'sh-1a2b3c4d', 'shelf.json'),
      'utf8',
    );
    expect(JSON.parse(raw)).toEqual(manifest);
  });

  describe('a side that cannot be read is never read as absent', () => {
    // `null` from content()/base() is a VALUE — "the shelf recorded a deletion" / "the file was
    // untracked" — and unshelve acts on it: a null content side is restored by DELETING the
    // file. So a read that failed for any reason other than "there is no such file" must throw,
    // or an intact-but-unreadable shelf deletes the user's file and is then removed itself.
    const noChmod =
      process.platform === 'win32' ||
      (typeof process.getuid === 'function' && process.getuid() === 0);

    it.skipIf(noChmod)(
      'rethrows a non-ENOENT failure (EACCES) instead of returning null',
      async () => {
        await store.create(PROJECT, { label: null, headSha: 'x', files: [fileInput()] });
        const contentFile = path.join(
          store.shelvesDir(PROJECT),
          'sh-1a2b3c4d',
          'content',
          'main.tex',
        );
        await chmod(contentFile, 0o000);
        try {
          const entry = await store.read(PROJECT, 'sh-1a2b3c4d');
          await expect(entry!.content('main.tex')).rejects.toMatchObject({ code: 'EACCES' });
        } finally {
          await chmod(contentFile, 0o600);
        }
      },
    );
    // (A genuinely absent side still reads as null — 'stores nothing on the side a status says
    // is absent' above already pins that, so the rethrow cannot overshoot unnoticed.)
  });

  describe('sides() checks what is on disk against what the manifest records', () => {
    it('reads both sides of a consistent entry, once', async () => {
      await store.create(PROJECT, {
        label: null,
        headSha: 'x',
        files: [
          fileInput({ path: 'm.tex' }),
          fileInput({ path: 'a.tex', status: 'added', base: null }),
          fileInput({ path: 'd.tex', status: 'deleted', content: null }),
        ],
      });
      const entry = (await store.read(PROJECT, 'sh-1a2b3c4d'))!;
      const [m, a, d] = entry.manifest.files;
      const sm = await entry.sides(m!);
      expect(sm.content?.toString('utf8')).toBe('working\n');
      expect(sm.base?.toString('utf8')).toBe('head\n');
      const sa = await entry.sides(a!);
      expect(sa.content?.toString('utf8')).toBe('working\n');
      expect(sa.base).toBeNull();
      const sd = await entry.sides(d!);
      expect(sd.content).toBeNull();
      expect(sd.base?.toString('utf8')).toBe('head\n');
    });

    it.each([
      ['modified', 'content'],
      ['modified', 'base'],
      ['added', 'content'],
      ['deleted', 'base'],
    ] as const)('refuses a %s entry whose %s side has gone missing', async (status, side) => {
      await store.create(PROJECT, {
        label: null,
        headSha: 'x',
        files: [
          fileInput({
            status,
            content: status === 'deleted' ? null : Buffer.from('working\n'),
            base: status === 'added' ? null : Buffer.from('head\n'),
          }),
        ],
      });
      await rm(path.join(store.shelvesDir(PROJECT), 'sh-1a2b3c4d', side, 'main.tex'));
      const entry = (await store.read(PROJECT, 'sh-1a2b3c4d'))!;
      await expect(entry.sides(entry.manifest.files[0]!)).rejects.toBeInstanceOf(ShelfCorruptError);
    });

    it.each([
      ['added', 'base'],
      ['deleted', 'content'],
    ] as const)('refuses a %s entry that holds a %s side it should not', async (status, side) => {
      await store.create(PROJECT, {
        label: null,
        headSha: 'x',
        files: [
          fileInput({
            status,
            content: status === 'deleted' ? null : Buffer.from('working\n'),
            base: status === 'added' ? null : Buffer.from('head\n'),
          }),
        ],
      });
      const extra = path.join(store.shelvesDir(PROJECT), 'sh-1a2b3c4d', side, 'main.tex');
      await mkdir(path.dirname(extra), { recursive: true });
      await writeFile(extra, 'stray\n');
      const entry = (await store.read(PROJECT, 'sh-1a2b3c4d'))!;
      await expect(entry.sides(entry.manifest.files[0]!)).rejects.toThrow(/corrupt/i);
    });
  });
});
