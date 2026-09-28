import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { chmod, mkdtemp, mkdir, rm, stat, symlink } from 'node:fs/promises';
import {
  buildDir,
  buildRoot,
  ensureBuildRoot,
  userPathSegment,
  UnsafeBuildRootError,
} from '../../src/services/compiler.js';
import type { BuildRootFs } from '../../src/services/compiler.js';

/*
 * #215: the build root was a shared, predictable `/tmp/web-latex-mcp-build`, which another local
 * user could create first (or plant links in) and so read or swap every build artifact the PDF
 * tools read back. It is now per user, created 0700, and verified — fail closed — before anything
 * is built in it. The verifier's decisions are tested against an injected filesystem and uid, so
 * the POSIX ownership rules run on every CI platform, win32 included.
 */

interface FakeEntry {
  kind: 'dir' | 'link' | 'file';
  uid: number;
  mode: number;
}

/** An in-memory filesystem holding at most the one entry the verifier looks at. */
function fakeFs(initial: FakeEntry | undefined, opts: { chmodIgnored?: boolean } = {}) {
  let entry = initial;
  const calls: string[] = [];
  const fs: BuildRootFs = {
    mkdir: async (_p, { mode }) => {
      calls.push(`mkdir ${mode.toString(8)}`);
      if (entry !== undefined) {
        throw Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' });
      }
      entry = { kind: 'dir', uid: 1000, mode: 0o40000 | mode };
    },
    lstat: async () => {
      calls.push('lstat');
      if (entry === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      const e = entry;
      return {
        isDirectory: () => e.kind === 'dir',
        isSymbolicLink: () => e.kind === 'link',
        uid: e.uid,
        mode: e.mode,
      };
    },
    chmod: async (_p, mode) => {
      calls.push(`chmod ${mode.toString(8)}`);
      if (entry !== undefined && !opts.chmodIgnored) entry = { ...entry, mode: 0o40000 | mode };
    },
  };
  return { fs, calls, current: () => entry };
}

const ROOT = '/tmp/web-latex-mcp-build-1000';
const posix = (fs: BuildRootFs) => ({ platform: 'linux', uid: 1000, fs }) as const;

describe('buildRoot (#215)', () => {
  it('is per user on POSIX (the uid is in the name) and stays a pure path', () => {
    const root = buildRoot();
    expect(path.dirname(root)).toBe(os.tmpdir());
    if (process.platform === 'win32') {
      expect(path.basename(root)).toBe(
        `web-latex-mcp-build-${userPathSegment(os.userInfo().username)!}`,
      );
    } else {
      expect(path.basename(root)).toBe(`web-latex-mcp-build-${process.getuid!()}`);
    }
    // Every project's build dir sits directly under it.
    expect(path.dirname(buildDir('/some/project'))).toBe(root);
  });

  it('names the root after the uid where there is one, never asking for the user name', () => {
    let asked = 0;
    const root = buildRoot({
      tmpdir: '/t',
      uid: 1000,
      username: () => {
        asked += 1;
        return 'alice';
      },
    });
    expect(root).toBe(path.join('/t', 'web-latex-mcp-build-1000'));
    // `os.userInfo()` throws on POSIX for a uid with no passwd entry; it must not be consulted.
    expect(asked).toBe(0);
  });

  // A managed Windows machine with a shared TEMP (C:\Temp) gave every account the one root, and
  // win32 verifies no owner: another user could create it first. The name is now per user.
  it('names the root after the user name where there is no uid (win32)', () => {
    const win = (username: () => string) =>
      path.basename(buildRoot({ tmpdir: 'C:\\Temp', uid: undefined, username }));
    expect(win(() => 'alice')).toBe('web-latex-mcp-build-alice');
    expect(win(() => 'bob')).toBe('web-latex-mcp-build-bob');
    expect(win(() => 'alice')).not.toBe(win(() => 'bob'));
  });

  it('falls back to a fixed name when the user name cannot be read, and never throws', () => {
    const unknown = 'web-latex-mcp-build-unknown.user';
    const at = (username: () => string) =>
      path.basename(buildRoot({ tmpdir: '/t', uid: undefined, username }));
    expect(
      at(() => {
        throw new Error('uv_os_get_passwd returned ENOENT');
      }),
    ).toBe(unknown);
    expect(at(() => '')).toBe(unknown);
    // No real user name can land on the fallback, however it is spelled.
    for (const name of ['unknown.user', 'UNKNOWN.USER', 'unknown-user', 'unknown_user']) {
      expect(
        at(() => name),
        name,
      ).not.toBe(unknown);
    }
  });
});

describe('userPathSegment (#215)', () => {
  it('keeps a plain name as it is', () => {
    for (const name of ['alice', 'Bob_2', 'x-y', 'a'.repeat(64)]) {
      expect(userPathSegment(name)).toBe(name);
    }
  });

  it('turns any other name into one safe segment, deterministically', () => {
    for (const name of [
      'CORP\\bob',
      'a/b',
      '..',
      '.',
      'C:',
      'josé',
      'name with spaces ',
      'trailing.',
      'con',
      'a'.repeat(65),
      '../../etc',
      '\\\\server\\share',
    ]) {
      const seg = userPathSegment(name)!;
      expect(seg, name).toMatch(/^[A-Za-z0-9_-]{1,64}(\.[0-9a-f]{8})?$/);
      // A single segment that stays where it is put: no separator, no dot-only name, no drive.
      expect(path.basename(seg), name).toBe(seg);
      expect(path.join('/t', seg).startsWith(path.join('/t') + path.sep), name).toBe(true);
      expect(seg === '.' || seg === '..', name).toBe(false);
      expect(userPathSegment(name), name).toBe(seg);
    }
  });

  it('never maps two distinct names onto one segment', () => {
    // Each pair sanitises to the same characters; the hash keeps them apart, and a name used as
    // is never contains the `.` a rewritten one carries.
    const pairs = [
      ['jo:e', 'jo*e'],
      ['josé', 'jos_'],
      ['a'.repeat(65), 'a'.repeat(66)],
    ];
    for (const [a, b] of pairs) {
      expect(userPathSegment(a!), `${a} / ${b}`).not.toBe(userPathSegment(b!));
    }
    const rewritten = userPathSegment('josé')!;
    expect(userPathSegment(rewritten)).not.toBe(rewritten);
  });

  it('gives no segment for an empty name', () => {
    expect(userPathSegment('')).toBeUndefined();
  });
});

describe('ensureBuildRoot (#215), against an injected filesystem', () => {
  it('creates a missing root with mode 0700 and accepts it', async () => {
    const f = fakeFs(undefined);
    await expect(ensureBuildRoot(ROOT, posix(f.fs))).resolves.toBe(ROOT);
    expect(f.calls[0]).toBe('mkdir 700');
    expect(f.calls).not.toContain('chmod 700');
  });

  it('accepts an existing root this user owns with mode 0700, changing nothing', async () => {
    const f = fakeFs({ kind: 'dir', uid: 1000, mode: 0o40700 });
    await expect(ensureBuildRoot(ROOT, posix(f.fs))).resolves.toBe(ROOT);
    expect(f.calls.filter((c) => c.startsWith('chmod'))).toEqual([]);
  });

  it('refuses a root another user owns, naming the path and both uids', async () => {
    const f = fakeFs({ kind: 'dir', uid: 4242, mode: 0o40700 });
    const err = await ensureBuildRoot(ROOT, posix(f.fs)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnsafeBuildRootError);
    expect((err as Error).message).toContain(ROOT);
    expect((err as Error).message).toContain('owned by uid 4242');
    expect((err as Error).message).toContain('(uid 1000)');
    // Never adopted: no chmod on someone else's directory.
    expect(f.calls.filter((c) => c.startsWith('chmod'))).toEqual([]);
  });

  it('refuses a root another user owns even when its mode looks private', async () => {
    const f = fakeFs({ kind: 'dir', uid: 0, mode: 0o40700 });
    await expect(ensureBuildRoot(ROOT, posix(f.fs))).rejects.toThrow(/owned by uid 0/);
  });

  it('refuses a symbolic link at the root, whoever it points at', async () => {
    const f = fakeFs({ kind: 'link', uid: 1000, mode: 0o120777 });
    await expect(ensureBuildRoot(ROOT, posix(f.fs))).rejects.toThrow(
      `${ROOT}: it is a symbolic link`,
    );
  });

  it('refuses a file at the root', async () => {
    const f = fakeFs({ kind: 'file', uid: 1000, mode: 0o100600 });
    await expect(ensureBuildRoot(ROOT, posix(f.fs))).rejects.toThrow(/it is not a directory/);
  });

  it('tightens a root this user owns but left group/other-readable, then re-checks it', async () => {
    const f = fakeFs({ kind: 'dir', uid: 1000, mode: 0o40755 });
    await expect(ensureBuildRoot(ROOT, posix(f.fs))).resolves.toBe(ROOT);
    expect(f.calls).toContain('chmod 700');
    expect(f.current()!.mode & 0o777).toBe(0o700);
    // Judged again after the chmod, not assumed.
    expect(f.calls.filter((c) => c === 'lstat')).toHaveLength(2);
  });

  it('refuses a root this user owns that others could WRITE, without tightening it', async () => {
    // A chmod closes the door, not the room: what another user placed while it was writable
    // would survive it. Group-writable (umask 002), other-writable, and write-only bits alike.
    for (const mode of [0o40775, 0o40757, 0o40777, 0o40720, 0o40702]) {
      const f = fakeFs({ kind: 'dir', uid: 1000, mode });
      const err = await ensureBuildRoot(ROOT, posix(f.fs)).catch((e: unknown) => e);
      expect(err, mode.toString(8)).toBeInstanceOf(UnsafeBuildRootError);
      expect((err as Error).message).toContain(`Refusing to build in ${ROOT}`);
      expect((err as Error).message).toContain('group or other WRITE access');
      expect((err as Error).message).toContain('Remove it');
      expect(
        f.calls.filter((c) => c.startsWith('chmod')),
        mode.toString(8),
      ).toEqual([]);
    }
  });

  it('refuses when the tightening did not take', async () => {
    const f = fakeFs({ kind: 'dir', uid: 1000, mode: 0o40755 }, { chmodIgnored: true });
    await expect(ensureBuildRoot(ROOT, posix(f.fs))).rejects.toThrow(
      /could not be restricted to its owner/,
    );
  });

  it('fails closed when the current uid cannot be determined on POSIX', async () => {
    const f = fakeFs({ kind: 'dir', uid: 1000, mode: 0o40700 });
    await expect(
      ensureBuildRoot(ROOT, { platform: 'linux', uid: undefined, fs: f.fs }),
    ).rejects.toThrow(/current user id could not be determined/);
  });

  it('on win32 skips ownership and mode (the name is per user) but still refuses a link', async () => {
    // The owner/ACL is deliberately not verified on win32: the per-user name is the protection.
    const winRoot = 'C:\\T\\web-latex-mcp-build-alice';
    const loose = fakeFs({ kind: 'dir', uid: 0, mode: 0o40777 });
    await expect(
      ensureBuildRoot(winRoot, {
        platform: 'win32',
        uid: undefined,
        fs: loose.fs,
      }),
    ).resolves.toBe(winRoot);
    expect(loose.calls.filter((c) => c.startsWith('chmod'))).toEqual([]);

    // A junction lstat()s as a symbolic link in node.
    const junction = fakeFs({ kind: 'link', uid: 0, mode: 0o120666 });
    await expect(
      ensureBuildRoot(winRoot, {
        platform: 'win32',
        uid: undefined,
        fs: junction.fs,
      }),
    ).rejects.toThrow(/symbolic link \(or junction\)/);
  });

  it('refuses the fallback name for an unreadable user name before creating anything', async () => {
    const root = buildRoot({ tmpdir: '/t', uid: undefined, username: () => '' });
    for (const platform of ['win32', 'linux'] as const) {
      const f = fakeFs(undefined);
      const err = await ensureBuildRoot(root, { platform, uid: undefined, fs: f.fs }).catch(
        (e: unknown) => e,
      );
      expect(err, platform).toBeInstanceOf(UnsafeBuildRootError);
      expect((err as Error).message).toContain(`Refusing to build in ${root}`);
      expect((err as Error).message).toContain('current user name could not be determined');
      expect(f.calls, platform).toEqual([]);
    }
  });

  // The mkdir is deliberately not recursive, so a TMPDIR naming no directory used to surface as
  // a raw `ENOENT: no such file or directory, mkdir '…'` from every compile and PDF read.
  it('refuses in words, naming the temp dir, when the temp dir does not exist', async () => {
    for (const [code, says] of [
      ['ENOENT', 'does not exist'],
      ['ENOTDIR', 'is not a directory'],
    ] as const) {
      const fs: BuildRootFs = {
        mkdir: async (p) => {
          throw Object.assign(new Error(`${code}: mkdir '${p}'`), { code });
        },
        lstat: async () => {
          throw new Error('lstat must not run');
        },
        chmod: async () => {},
      };
      const err = await ensureBuildRoot(ROOT, posix(fs)).catch((e: unknown) => e);
      expect(err, code).toBeInstanceOf(UnsafeBuildRootError);
      const msg = (err as Error).message;
      expect(msg).toContain(`Refusing to build in ${ROOT}`);
      expect(msg).toContain(`the temp directory it goes in, /tmp, ${says}`);
      expect(msg).toContain('Point TMPDIR (TEMP on Windows) at an existing directory');
      expect(msg).not.toContain(code);
    }
  });

  it('rethrows a mkdir failure other than EEXIST', async () => {
    const fs: BuildRootFs = {
      mkdir: async () => {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      },
      lstat: async () => {
        throw new Error('lstat must not run');
      },
      chmod: async () => {},
    };
    await expect(ensureBuildRoot(ROOT, posix(fs))).rejects.toThrow(/EACCES/);
  });
});

describe.skipIf(process.platform === 'win32')(
  'ensureBuildRoot (#215), on the real filesystem',
  () => {
    const cleanups: string[] = [];
    afterEach(async () => {
      for (const d of cleanups.splice(0)) await rm(d, { recursive: true, force: true });
    });

    it('creates the root 0700, tightens a readable one, refuses a writable one and a planted link', async () => {
      const parent = await mkdtemp(path.join(os.tmpdir(), 'wlm-buildroot-'));
      cleanups.push(parent);

      const fresh = path.join(parent, 'fresh');
      await ensureBuildRoot(fresh);
      expect((await stat(fresh)).mode & 0o777).toBe(0o700);

      const loose = path.join(parent, 'loose');
      await mkdir(loose);
      await chmod(loose, 0o755);
      await ensureBuildRoot(loose);
      expect((await stat(loose)).mode & 0o777).toBe(0o700);

      const open = path.join(parent, 'open');
      await mkdir(open);
      await chmod(open, 0o775);
      await expect(ensureBuildRoot(open)).rejects.toThrow(/group or other WRITE access/);
      expect((await stat(open)).mode & 0o777).toBe(0o775);

      const target = path.join(parent, 'elsewhere');
      await mkdir(target, { mode: 0o700 });
      const planted = path.join(parent, 'planted');
      await symlink(target, planted);
      await expect(ensureBuildRoot(planted)).rejects.toThrow(/symbolic link/);
    });

    it('refuses a missing temp dir in words and creates neither it nor the root', async () => {
      const parent = await mkdtemp(path.join(os.tmpdir(), 'wlm-buildroot-'));
      cleanups.push(parent);
      const missingTmp = path.join(parent, 'no-such-tmp');
      const root = path.join(missingTmp, 'web-latex-mcp-build-1000');
      const err = await ensureBuildRoot(root).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnsafeBuildRootError);
      expect((err as Error).message).toContain(`${missingTmp}, does not exist`);
      expect((err as Error).message).toContain('Point TMPDIR');
      await expect(stat(missingTmp)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  },
);
