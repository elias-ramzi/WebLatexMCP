/**
 * `add_asset`'s source read, attacked between its checks and its use.
 *
 * The flow is realpath -> extension check on the realpath'd target -> read. Reading BY PATH after
 * those checks let whoever owns the source name swap it for a link to `~/.ssh/id_rsa` (or for a
 * file that grows past the size cap) once the checks had passed. The fix opens the resolved target
 * once, with `O_NOFOLLOW`, judges the HANDLE (`fstat`), and reads through the handle.
 *
 * A real race is not deterministic, so these tests use `resolveAssetSource`'s injectable fs seam
 * (`AssetSourceFs`) to perform the attacker's move at exactly the moment it matters — inside
 * `realpath` (after it has resolved) or inside the handle's `stat` (after the open) — against a
 * real temp directory. Nothing external is mocked: every file, link and read is real.
 */
import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import {
  mkdtemp,
  writeFile,
  rm,
  symlink,
  realpath,
  open,
  appendFile,
  unlink,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import {
  resolveAssetSource,
  isUncOrDevicePath,
  type AssetSourceFs,
} from '../../src/lib/assetImport.js';
import { MAX_ASSET_BYTES } from '../../src/lib/assets.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0xfd]);
const SECRET = 'fake-secret-token=hunter2\n';
const WINDOWS = process.platform === 'win32';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-assetrace-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return realpath(dir);
}

/** The real fs, with a counter, so a test can assert NO syscall was made. */
function countingFs(): AssetSourceFs & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    realpath: (p) => {
      calls.push(`realpath ${p}`);
      return realpath(p);
    },
    open: (p, flags) => {
      calls.push(`open ${p}`);
      return open(p, flags);
    },
  };
}

describe('resolveAssetSource: Windows network (UNC) and device paths', () => {
  // `realpath` on `\\server\share\x.png` makes Windows open an SMB connection to `server`, which
  // hands the server this machine's NTLM credentials. So the refusal must precede every syscall,
  // and it is pure string work — it runs, and is asserted, on every platform.
  const UNC_INPUTS = [
    '\\\\attacker.example\\share\\plot.png',
    '\\\\?\\C:\\figs\\plot.png',
    '\\\\?\\UNC\\attacker.example\\share\\plot.png',
    '\\\\.\\pipe\\plot.png',
  ];

  for (const input of UNC_INPUTS) {
    it(`refuses ${JSON.stringify(input)} before any filesystem access`, async () => {
      const fs = countingFs();
      const res = resolveAssetSource({ destPath: 'figures/plot.png', sourcePath: input }, fs);
      await expect(res).rejects.toThrow(/network \(UNC\) or device path/);
      await expect(res).rejects.toThrow(`sourcePath "${input}"`);
      expect(fs.calls).toEqual([]);
    });
  }

  it('classifies UNC/device spellings per platform, as pure string work', () => {
    for (const p of UNC_INPUTS) {
      expect(isUncOrDevicePath(p, 'win32')).toBe(true);
      expect(isUncOrDevicePath(p, 'linux')).toBe(true);
    }
    // Windows treats `/` and `\` alike, so a forward-slash UNC is still a network path there.
    expect(isUncOrDevicePath('//attacker.example/share/plot.png', 'win32')).toBe(true);
    expect(isUncOrDevicePath('/\\attacker.example\\share\\plot.png', 'win32')).toBe(true);
    expect(isUncOrDevicePath('\\/attacker.example/share/plot.png', 'win32')).toBe(true);
    // ...but on POSIX a leading `//` is an ordinary absolute path, and must stay importable.
    expect(isUncOrDevicePath('//home/you/plot.png', 'linux')).toBe(false);
    expect(isUncOrDevicePath('//home/you/plot.png', 'darwin')).toBe(false);
    // Local paths are never caught.
    expect(isUncOrDevicePath('C:\\Users\\you\\plot.png', 'win32')).toBe(false);
    expect(isUncOrDevicePath('C:/Users/you/plot.png', 'win32')).toBe(false);
    expect(isUncOrDevicePath('\\Users\\you\\plot.png', 'win32')).toBe(false);
    expect(isUncOrDevicePath('/home/you/plot.png', 'linux')).toBe(false);
  });
});

describe('resolveAssetSource: the read goes through the handle it checked', () => {
  it.skipIf(WINDOWS)(
    'refuses a source swapped for a link to a secret after realpath resolved it',
    async () => {
      const dir = await tmp();
      const photo = path.join(dir, 'photo.png');
      const secret = path.join(dir, 'secret-no-ext');
      await writeFile(photo, PNG);
      await writeFile(secret, SECRET);

      // The attacker's move, at the worst moment: realpath has resolved `photo.png` (a regular
      // file, correctly named) and every name check on that result will pass — then the name is
      // replaced with a link to the secret.
      const fs: AssetSourceFs = {
        realpath: async (p) => {
          const resolved = await realpath(p);
          await unlink(photo);
          await symlink(secret, photo);
          return resolved;
        },
        open: (p, flags) => open(p, flags),
      };

      let result: unknown = null;
      let error: Error | null = null;
      try {
        result = await resolveAssetSource({ destPath: 'figures/plot.png', sourcePath: photo }, fs);
      } catch (e) {
        error = e as Error;
      }
      // Pre-fix, the by-path read followed the link and returned the secret's bytes.
      expect(result).toBeNull();
      expect(error).not.toBeNull();
      expect(error!.message).not.toContain('hunter2');
      expect(error!.message).not.toMatch(/ELOOP|EMLINK|open/);
    },
  );

  it.skipIf(WINDOWS)(
    'opens the realpath-resolved target once, with O_NOFOLLOW, and reads through that handle',
    async () => {
      const dir = await tmp();
      const photo = path.join(dir, 'photo.png');
      await writeFile(photo, PNG);
      const fs = countingFs();
      const flagsSeen: number[] = [];
      const spying: AssetSourceFs = {
        realpath: fs.realpath,
        open: (p, flags) => {
          flagsSeen.push(flags);
          return fs.open(p, flags);
        },
      };

      const res = await resolveAssetSource(
        { destPath: 'figures/plot.png', sourcePath: photo },
        spying,
      );

      expect(Buffer.compare(res.bytes, PNG)).toBe(0);
      expect(fs.calls).toEqual([`realpath ${photo}`, `open ${photo}`]);
      expect(flagsSeen).toHaveLength(1);
      const nofollow = constants.O_NOFOLLOW as number;
      const nonblock = constants.O_NONBLOCK as number;
      expect(nofollow).toBeGreaterThan(0);
      expect(flagsSeen[0]! & nofollow).toBe(nofollow);
      // Without O_NONBLOCK, a FIFO swapped in at the name would hang the open itself.
      expect(flagsSeen[0]! & nonblock).toBe(nonblock);
    },
  );

  it('enforces the size cap on the bytes read, not on a size reported before the read', async () => {
    // A file that grows past the cap after it was measured. Reading by path (or reading the
    // handle to EOF) after a `stat` returns every byte the file has by then.
    const dir = await tmp();
    const photo = path.join(dir, 'photo.png');
    await writeFile(photo, PNG);

    const growAfterMeasure = (fh: FileHandle): FileHandle =>
      new Proxy(fh, {
        get(target, prop, receiver) {
          if (prop === 'stat') {
            return async (...args: unknown[]) => {
              const st = await (target.stat as (...a: unknown[]) => Promise<unknown>)(...args);
              await appendFile(photo, Buffer.alloc(MAX_ASSET_BYTES, 1));
              return st;
            };
          }
          const v: unknown = Reflect.get(target, prop, receiver);
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      });
    const fs: AssetSourceFs = {
      realpath: (p) => realpath(p),
      open: async (p, flags) => growAfterMeasure(await open(p, flags)),
    };

    await expect(
      resolveAssetSource({ destPath: 'figures/plot.png', sourcePath: photo }, fs),
    ).rejects.toThrow(/exceeds/);
  }, 30000);

  it.skipIf(WINDOWS)(
    'refuses a FIFO named like an asset as not a regular file, without blocking on it',
    async () => {
      const dir = await tmp();
      const fifo = path.join(dir, 'photo.png');
      execFileSync('mkfifo', [fifo]);
      await expect(
        resolveAssetSource({ destPath: 'figures/plot.png', sourcePath: fifo }),
      ).rejects.toThrow(`sourcePath "${fifo}" is not a regular file.`);
    },
    5000,
  );
});
