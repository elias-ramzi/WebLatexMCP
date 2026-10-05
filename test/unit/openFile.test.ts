import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OPEN_PATH_ENV,
  WIN32_OPEN_COMMAND,
  openFile,
  win32PowerShellPath,
} from '../../src/lib/openFile.js';
import { execCapture } from '../../src/lib/exec.js';
import type { ExecOptions, ExecResult } from '../../src/lib/exec.js';

interface Call {
  cmd: string;
  args: string[];
  opts: ExecOptions | undefined;
}

function recorder(result: Partial<ExecResult> = {}) {
  const calls: Call[] = [];
  const run = vi.fn((cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult> => {
    calls.push({ cmd, args, opts });
    return Promise.resolve({ code: 0, stdout: '', stderr: '', timedOut: false, ...result });
  });
  return { calls, run };
}

describe('openFile', () => {
  it('on win32 never puts the path on the command line, and hands it over in the environment', async () => {
    const target = String.raw`C:\Users\R&D\Temp\a^b%PATH%.mcpb`;
    const env = { SystemRoot: String.raw`D:\Win`, PATH: String.raw`C:\bin`, OTHER: 'kept' };
    const { calls, run } = recorder();
    const ok = await openFile(target, { platform: 'win32', run, env });
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    // By absolute path under the system root: a bare name is looked up in the cwd first.
    expect(call!.cmd).toBe(String.raw`D:\Win\System32\WindowsPowerShell\v1.0\powershell.exe`);
    expect(call!.args).toEqual(['-NoProfile', '-NonInteractive', '-Command', WIN32_OPEN_COMMAND]);
    expect(WIN32_OPEN_COMMAND).toBe(
      'Invoke-Item -LiteralPath $env:WEB_LATEX_MCP_OPEN_PATH -ErrorAction Stop',
    );
    for (const arg of [call!.cmd, ...call!.args]) {
      for (const piece of [target, 'R&D', 'a^b', '%PATH%', 'Users', '.mcpb']) {
        expect(arg).not.toContain(piece);
      }
    }
    expect(call!.opts?.env?.[OPEN_PATH_ENV]).toBe(target);
    // The child gets the whole parent environment too (execCapture's `env` replaces, not merges).
    expect(call!.opts?.env).toEqual({ ...env, [OPEN_PATH_ENV]: target });
  });

  it('finds PowerShell under windir, then C:\\Windows, when SystemRoot is unset', () => {
    expect(win32PowerShellPath({ windir: String.raw`E:\W` })).toBe(
      String.raw`E:\W\System32\WindowsPowerShell\v1.0\powershell.exe`,
    );
    expect(win32PowerShellPath({})).toBe(
      String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
    );
  });

  // `??` falls through only on undefined: an empty or relative root yielded a path relative to
  // the cwd — a planted powershell.exe there is exactly what the absolute path exists to avoid.
  it.each([
    ['an empty SystemRoot', { SystemRoot: '', windir: String.raw`E:\W` }, String.raw`E:\W`],
    ['a relative SystemRoot', { SystemRoot: 'Windows', windir: '' }, 'C:\\Windows'],
    ['a bare drive SystemRoot', { SystemRoot: 'C:', windir: undefined }, 'C:\\Windows'],
    ['a drive-relative SystemRoot', { SystemRoot: 'C:foo', windir: 'D:foo' }, 'C:\\Windows'],
    ['a relative windir', { windir: String.raw`Win\dows` }, 'C:\\Windows'],
    // `path.win32.isAbsolute` accepts all of these, and none is a drive-qualified root: a
    // current-drive-rooted path resolves against the cwd's drive, a UNC or device path runs
    // PowerShell from a network share or the device namespace, and a padded root names a
    // directory Windows itself would not use.
    [
      'a current-drive-rooted SystemRoot',
      { SystemRoot: String.raw`\Windows`, windir: String.raw`E:\W` },
      String.raw`E:\W`,
    ],
    ['a forward-slash rooted SystemRoot', { SystemRoot: '/Windows' }, 'C:\\Windows'],
    ['a UNC SystemRoot', { SystemRoot: String.raw`\\srv\share`, windir: undefined }, 'C:\\Windows'],
    [
      'a \\\\?\\ device SystemRoot',
      { SystemRoot: String.raw`\\?\C:\Windows`, windir: String.raw`E:\W` },
      String.raw`E:\W`,
    ],
    ['a \\\\.\\ device windir', { windir: String.raw`\\.\C:\Windows` }, 'C:\\Windows'],
    [
      'a SystemRoot with a trailing space',
      { SystemRoot: 'C:\\Windows ', windir: String.raw`E:\W` },
      String.raw`E:\W`,
    ],
    ['a windir with a trailing space', { windir: 'D:\\Win ' }, 'C:\\Windows'],
  ] as const)('skips %s, never returning a relative path', (_label, env, root) => {
    const result = win32PowerShellPath(env);
    expect(result).toBe(
      path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    );
    expect(result).toMatch(/^[A-Za-z]:\\/);
  });

  it('accepts a drive-qualified root written with a forward slash', () => {
    const result = win32PowerShellPath({ SystemRoot: 'D:/Win', windir: String.raw`E:\W` });
    expect(result).toBe(String.raw`D:\Win\System32\WindowsPowerShell\v1.0\powershell.exe`);
    expect(result).toMatch(/^[A-Za-z]:\\/);
  });

  it('on darwin runs `open <path>`', async () => {
    const { calls, run } = recorder();
    expect(await openFile('/tmp/x y/a.mcpb', { platform: 'darwin', run })).toBe(true);
    expect(calls.map((c) => [c.cmd, c.args])).toEqual([['open', ['/tmp/x y/a.mcpb']]]);
  });

  it('on linux runs `xdg-open <path>`', async () => {
    const { calls, run } = recorder();
    expect(await openFile('/tmp/a.mcpb', { platform: 'linux', run })).toBe(true);
    expect(calls.map((c) => [c.cmd, c.args])).toEqual([['xdg-open', ['/tmp/a.mcpb']]]);
  });

  it('returns false on a non-zero exit', async () => {
    const { run } = recorder({ code: 1 });
    expect(await openFile('/tmp/a.mcpb', { platform: 'linux', run })).toBe(false);
  });

  it('returns false, never throwing, when the launcher cannot be spawned', async () => {
    const run = vi.fn(() => Promise.reject(new Error('spawn xdg-open ENOENT')));
    expect(await openFile('/tmp/a.mcpb', { platform: 'linux', run })).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['linux', '-rf.mcpb'],
    ['linux', 'relative/a.mcpb'],
    ['darwin', '--args.mcpb'],
    ['win32', String.raw`Temp\a.mcpb`],
    ['win32', '-a.mcpb'],
    // Drive-relative: names a path relative to drive C:'s current directory, not an absolute one.
    ['win32', 'C:a.mcpb'],
  ] as const)('on %s refuses the non-absolute path %s without spawning', async (platform, p) => {
    const { run } = recorder();
    expect(await openFile(p, { platform, run })).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});

/**
 * The unit tests above compare argv to the exported constant, which proves nothing about whether
 * PowerShell accepts it — `Start-Process -LiteralPath` passed them while failing every launch with
 * `NamedParameterNotFound`. These run the real thing on windows-latest; `-WhatIf` opens nothing.
 */
describe.skipIf(process.platform !== 'win32')('openFile against real Windows PowerShell', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const powershell = (command: string, env: NodeJS.ProcessEnv = process.env) =>
    execCapture(win32PowerShellPath(), ['-NoProfile', '-NonInteractive', '-Command', command], {
      timeoutMs: 60_000,
      env,
    });

  it('the cmdlet the command runs has a -LiteralPath parameter', async () => {
    const cmdlet = WIN32_OPEN_COMMAND.split(' ')[0]!;
    expect(cmdlet).toMatch(/^[A-Za-z]+-[A-Za-z]+$/);
    const res = await powershell(`(Get-Command ${cmdlet}).Parameters.ContainsKey('LiteralPath')`);
    expect(res.stderr).toBe('');
    expect(res.stdout.trim()).toBe('True');
    expect(res.code).toBe(0);
  }, 60_000);

  it('binds over a path holding &, ^, %PATH%, [1] and a space, verbatim', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'wlm-open-R&D-'));
    const file = path.join(dir, 'a^b %PATH% [1].mcpb');
    await writeFile(file, 'x');
    const res = await powershell(`${WIN32_OPEN_COMMAND} -WhatIf`, {
      ...process.env,
      [OPEN_PATH_ENV]: file,
    });
    expect(res.stderr).toBe('');
    expect(res.code).toBe(0);
    // The WhatIf line names the target: the path reached the cmdlet whole, not split or expanded.
    // Joined across line breaks: PowerShell wraps WhatIf output at the console width.
    expect(res.stdout.replace(/\r?\n/g, '')).toContain('a^b %PATH% [1].mcpb');
  }, 60_000);
});
