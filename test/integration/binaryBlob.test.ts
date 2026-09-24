import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { simpleGit } from 'simple-git';
import { GitService } from '../../src/services/gitService.js';

/**
 * The binary-asset path through `GitService.commitContents`/`readAtRefBytes`: a `Buffer`
 * staged and read back byte-exact, and the string path's corruption that motivates it.
 *
 * Real git against a plain temp repo (no remote needed — `commitContents` operates purely
 * on the local index/HEAD). See test/integration/sessionCommit.test.ts for the sibling
 * shape and test/integration/helpers/bareRepo.ts for the Windows-safe cleanup idiom.
 */

// Windows keeps transient locks on freshly-used .git files; retry to ride it out.
const rmDir = (dir: string): Promise<void> =>
  rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

// A real PNG header plus bytes that are invalid UTF-8 (0xff, 0xfe are never valid lead
// bytes), and deliberately containing CRLF (0x0d 0x0a) and a NUL — exactly what a text
// path (CRLF translation, UTF-8 decode/replace, NUL truncation) would mangle.
const PNG_PAYLOAD = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0xfd, 0x0d, 0x0a,
]);

describe('binary blob round-trip through GitService', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  async function setup(): Promise<{ dir: string; git: GitService }> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-binary-'));
    cleanups.push(() => rmDir(dir));
    const raw = simpleGit(dir);
    await raw.raw(['init', '-b', 'main']);
    await raw.addConfig('user.email', 'test@example.com');
    await raw.addConfig('user.name', 'Test');
    await raw.addConfig('core.autocrlf', 'false');
    // commitContents does `read-tree --reset HEAD`, which needs an existing HEAD.
    await raw.raw(['commit', '--allow-empty', '-m', 'initial commit']);
    return { dir, git: new GitService() };
  }

  it('stages a Buffer byte-identical and reads it back with readAtRefBytes', async () => {
    const { dir, git } = await setup();
    const result = await git.commitContents(dir, {
      message: 'add figure',
      files: [{ path: 'figures/plot.png', content: PNG_PAYLOAD }],
    });
    expect(result.committed).toBe(true);

    const readBack = await git.readAtRefBytes(dir, 'HEAD', 'figures/plot.png');
    expect(readBack).not.toBeNull();
    expect(Buffer.compare(readBack as Buffer, PNG_PAYLOAD)).toBe(0);

    // Corroborate independently of our own plumbing: git's own object size, and the file
    // actually checked out on disk, both match the exact byte length.
    const catFileSize = await simpleGit(dir).raw(['cat-file', '-s', `HEAD:${'figures/plot.png'}`]);
    expect(Number(catFileSize.trim())).toBe(PNG_PAYLOAD.length);

    await simpleGit(dir).raw(['checkout', 'HEAD', '--', 'figures/plot.png']);
    const onDisk = await readFile(path.join(dir, 'figures', 'plot.png'));
    expect(Buffer.compare(onDisk, PNG_PAYLOAD)).toBe(0);
  });

  it('readAtRefBytes returns null for a path absent at that ref', async () => {
    const { dir, git } = await setup();
    const missing = await git.readAtRefBytes(dir, 'HEAD', 'figures/does-not-exist.png');
    expect(missing).toBeNull();
  });

  it('documents the corruption: the same bytes through the pre-existing string path are not preserved', async () => {
    const { dir, git } = await setup();
    await git.commitContents(dir, {
      message: 'add figure via string path',
      files: [{ path: 'figures/via-string.png', content: PNG_PAYLOAD.toString('utf8') }],
    });

    const readBack = await git.readAtRefBytes(dir, 'HEAD', 'figures/via-string.png');
    expect(readBack).not.toBeNull();
    // The round trip through a JS string (UTF-8 decode then re-encode) does not reproduce
    // the original bytes: this is exactly the corruption the Buffer overload exists to avoid.
    expect(Buffer.compare(readBack as Buffer, PNG_PAYLOAD)).not.toBe(0);
  });

  it('mixes a text file and a binary file in one commitContents call, both round-tripping', async () => {
    const { dir, git } = await setup();
    const texContent = '\\includegraphics{figures/plot.png}\n';
    const result = await git.commitContents(dir, {
      message: 'add figure and reference it',
      files: [
        { path: 'figures/plot.png', content: PNG_PAYLOAD },
        { path: 'main.tex', content: texContent },
      ],
      allowEmpty: false,
    });
    expect(result.committed).toBe(true);
    expect(result.filesChanged).toBe(2);

    const png = await git.readAtRefBytes(dir, 'HEAD', 'figures/plot.png');
    expect(png).not.toBeNull();
    expect(Buffer.compare(png as Buffer, PNG_PAYLOAD)).toBe(0);

    const tex = await git.readAtRef(dir, 'HEAD', 'main.tex');
    expect(tex).toBe(texContent);
  });
});
