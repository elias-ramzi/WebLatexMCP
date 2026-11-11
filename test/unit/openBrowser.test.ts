import { describe, it, expect } from 'vitest';
import { browserCommands, openBrowser } from '../../src/lib/openBrowser.js';
import { isWsl } from '../../src/lib/wsl.js';
import type { ExecResult } from '../../src/lib/exec.js';

const URL_ = 'http://127.0.0.1:36207/b4bee3b036195ebd5451f00138643c43';

describe('browserCommands', () => {
  it('uses xdg-open alone on plain Linux', () => {
    expect(browserCommands(URL_, 'linux', false).map((c) => c.cmd)).toEqual(['xdg-open']);
  });

  it('tries wslview, then cmd.exe, then xdg-open under WSL', () => {
    const cmds = browserCommands(URL_, 'linux', true);
    expect(cmds.map((c) => c.cmd)).toEqual(['wslview', 'cmd.exe', 'xdg-open']);
    // An empty title argument reaches cmd as "", which `start` needs before a URL.
    expect(cmds[1]!.args).toEqual(['/c', 'start', '', URL_]);
  });

  it('never hands cmd.exe a URL carrying shell syntax', () => {
    const cmds = browserCommands('http://127.0.0.1:1/a&calc', 'linux', true);
    expect(cmds.map((c) => c.cmd)).toEqual(['wslview', 'xdg-open']);
  });
});

describe('openBrowser', () => {
  it('falls through to the next command until one exits 0', async () => {
    const tried: string[] = [];
    const exec = async (cmd: string): Promise<ExecResult> => {
      tried.push(cmd);
      if (cmd === 'wslview') throw new Error('spawn wslview ENOENT');
      return { code: 0, stdout: '', stderr: '', timedOut: false };
    };
    expect(await openBrowser(URL_, { platform: 'linux', wsl: true, exec })).toBe(true);
    expect(tried).toEqual(['wslview', 'cmd.exe']);
  });

  it('returns false when nothing opens', async () => {
    const exec = async (): Promise<ExecResult> => ({
      code: 3,
      stdout: '',
      stderr: '',
      timedOut: false,
    });
    expect(await openBrowser(URL_, { platform: 'linux', wsl: false, exec })).toBe(false);
  });
});

describe('isWsl', () => {
  it('reads the WSL env vars, then the kernel release, on Linux only', () => {
    expect(isWsl({ WSL_DISTRO_NAME: 'Ubuntu' }, 'linux', () => '')).toBe(true);
    expect(isWsl({}, 'linux', () => '6.18.33.2-microsoft-standard-WSL2')).toBe(true);
    expect(isWsl({}, 'linux', () => '6.8.0-generic')).toBe(false);
    expect(isWsl({ WSL_DISTRO_NAME: 'Ubuntu' }, 'darwin', () => '')).toBe(false);
    expect(
      isWsl({}, 'linux', () => {
        throw new Error('ENOENT');
      }),
    ).toBe(false);
  });
});
