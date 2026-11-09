import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { compareVersions, currentBuildId, versionOfBuild } from '../../src/lib/buildId.js';
import {
  credentialOverlay,
  credentialVarNames,
  daemonSpawnEnv,
  sessionRequestHeaders,
} from '../../src/proxy/clientEnv.js';
import {
  decideBuild,
  rotateDaemonLog,
  daemonLogPath,
  type FoundDaemon,
} from '../../src/proxy/discovery.js';
import { standaloneRequested } from '../../src/proxy/proxyCommand.js';
import { daemonDir } from '../../src/daemon/daemonFiles.js';
import { hashEnvValue } from '../../src/lib/daemonWideEnv.js';
import { registryPath } from '../../src/services/projectRegistry.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wlm-proxy-unit-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function daemon(over: Partial<FoundDaemon['health']> = {}): FoundDaemon {
  return {
    info: {
      pid: 1,
      processNonce: 'n',
      port: 1,
      token: 't',
      version: '0.9.0',
      buildPath: '/b',
      buildId: '0.9.0|/b|1',
      startedAt: '',
    },
    health: {
      version: '0.9.0',
      buildId: '0.9.0|/b|1',
      processNonce: 'n',
      pid: 1,
      sessions: 0,
      keepAlive: false,
      replaceRequested: false,
      ...over,
    },
  };
}

describe('builds', () => {
  it('compares versions numerically, and an unparseable one as equal', () => {
    expect(compareVersions('0.10.0', '0.9.1')).toBeGreaterThan(0);
    expect(compareVersions('0.9.0', '0.9.0')).toBe(0);
    expect(compareVersions('1.0.0', 'unknown')).toBe(0);
    expect(versionOfBuild('0.9.0|/x|5')).toBe('0.9.0');
  });

  it('tells a rebuilt entry apart from the build before it', async () => {
    const dir = await tempDir();
    const entry = path.join(dir, 'index.js');
    await writeFile(entry, '');
    await utimes(entry, new Date(1_000_000), new Date(1_000_000));
    const before = currentBuildId(entry);
    await utimes(entry, new Date(2_000_000), new Date(2_000_000));
    expect(currentBuildId(entry)).not.toBe(before);
    expect(currentBuildId(path.join(dir, 'missing.js'))).toMatch(/\|unknown$/);
  });

  it('connects to its own build, another install of its version, or a newer daemon', () => {
    expect(decideBuild('0.9.0|/b|1', daemon())).toBe('connect');
    expect(decideBuild('0.8.0|/old|1', daemon())).toBe('connect'); // the proxy is older
    // Claude Desktop's bundle and an npx install of one version share the daemon.
    expect(decideBuild('0.9.0|/desktop/bundle|7', daemon())).toBe('connect');
  });

  it('replaces the daemon for a newer version or the same entry rebuilt in place', () => {
    expect(decideBuild('0.9.0|/b|2', daemon())).toBe('replace-now'); // rebuilt in place
    expect(decideBuild('0.10.0|/c|1', daemon())).toBe('replace-now');
    expect(decideBuild('0.10.0|/c|1', daemon({ sessions: 2 }))).toBe('connect-and-replace');
    // A service manager's daemon is left to it.
    expect(decideBuild('0.10.0|/c|1', daemon({ keepAlive: true }))).toBe('connect');
  });
});

describe("the client's environment", () => {
  it('forwards the standard token variables and every registered tokenEnv', async () => {
    const ws = await tempDir();
    await writeFile(
      registryPath(ws),
      JSON.stringify({
        thesis: { gitUrl: 'https://git.example/t', tokenEnv: 'THESIS_TOKEN' },
        notes: { mode: 'local', path: ws },
        bad: { gitUrl: 'https://git.example/b', tokenEnv: 'not a name' },
      }),
    );
    const names = credentialVarNames({}, ws);
    expect(names).toEqual(
      expect.arrayContaining([
        'WEB_LATEX_MCP_TOKEN',
        'GITHUB_TOKEN',
        'OVERLEAF_GIT_TOKEN',
        'THESIS_TOKEN',
      ]),
    );
    expect(names).not.toContain('not a name');

    const overlay = credentialOverlay(
      { GITHUB_TOKEN: 'g', THESIS_TOKEN: ' ', OVERLEAF_GIT_TOKEN: 'x'.repeat(5000) },
      names,
    );
    expect({ ...overlay }).toEqual({ GITHUB_TOKEN: 'g' });
  });

  it('keeps tokens, secrets and per-connection settings out of the daemon, pinning its workspace', () => {
    const env = daemonSpawnEnv(
      {
        PATH: '/bin',
        GITHUB_TOKEN: 'g',
        THESIS_TOKEN: 't',
        GH_TOKEN: 'gh',
        GITHUB_ENTERPRISE_TOKEN: 'ge',
        AWS_SECRET_ACCESS_KEY: 'a',
        WEB_LATEX_MCP_SESSION: 's',
        WEB_LATEX_MCP_DEFAULT_PROJECT: 'p',
        WEB_LATEX_MCP_PROJECTS: '{}',
        WEB_LATEX_MCP_COMPILER: 'tectonic',
        WEB_LATEX_MCP_AUTHOR_NAME: 'Ada',
        WEB_LATEX_MCP_WORKSPACE: '~/x',
        WEB_LATEX_MCP_WRITING_GUIDE_EXTRA: 'notes/guide.md',
        WEB_LATEX_MCP_SKILLS_DIR: '~/skills',
        WEB_LATEX_MCP_CONCURRENCY_GUIDE: 'file:///abs/c.md',
      },
      '/abs/ws',
      ['GITHUB_TOKEN', 'THESIS_TOKEN'],
      '/client/dir',
    );
    expect(env).toEqual({
      PATH: '/bin',
      WEB_LATEX_MCP_COMPILER: 'tectonic',
      WEB_LATEX_MCP_AUTHOR_NAME: 'Ada',
      WEB_LATEX_MCP_WORKSPACE: '/abs/ws',
      // Relative to the client, since the daemon runs in the workspace; `~` and URLs left alone.
      WEB_LATEX_MCP_WRITING_GUIDE_EXTRA: path.resolve('/client/dir', 'notes/guide.md'),
      WEB_LATEX_MCP_SKILLS_DIR: '~/skills',
      WEB_LATEX_MCP_CONCURRENCY_GUIDE: 'file:///abs/c.md',
    });
  });

  it('sends the session settings as headers, and daemon-wide ones only as hashes', () => {
    const headers = sessionRequestHeaders(
      {
        WEB_LATEX_MCP_SESSION: 'agent-1',
        WEB_LATEX_MCP_DEFAULT_PROJECT: 'thesis',
        GITHUB_TOKEN: 'ghp_x',
        WEB_LATEX_MCP_CONTACT_EMAIL: 'me@example.com',
      },
      ['GITHUB_TOKEN'],
      { replaceWhenIdle: true },
    );
    expect(headers['x-web-latex-mcp-session']).toBe('agent-1');
    expect(headers['x-web-latex-mcp-default-project']).toBe('thesis');
    expect(JSON.parse(headers['x-web-latex-mcp-credentials'] ?? '{}')).toEqual({
      GITHUB_TOKEN: 'ghp_x',
    });
    expect(JSON.parse(headers['x-web-latex-mcp-client-env'] ?? '{}')).toEqual({
      WEB_LATEX_MCP_CONTACT_EMAIL: hashEnvValue('me@example.com'),
    });
    expect(JSON.stringify(headers)).not.toContain('me@example.com');
    expect(headers['x-web-latex-mcp-replace-when-idle']).toBe('1');
    expect(sessionRequestHeaders({}, [])).toEqual({});
  });

  it('serves in-process on --standalone or a true WEB_LATEX_MCP_STANDALONE only', () => {
    expect(standaloneRequested(['--standalone'], {})).toBe(true);
    expect(standaloneRequested([], { WEB_LATEX_MCP_STANDALONE: 'Yes' })).toBe(true);
    expect(standaloneRequested([], { WEB_LATEX_MCP_STANDALONE: '0' })).toBe(false);
    expect(standaloneRequested([], {})).toBe(false);
  });
});

describe('the daemon log', () => {
  it('is rotated once past its cap', async () => {
    const ws = await tempDir();
    await mkdir(daemonDir(ws), { recursive: true });
    await writeFile(daemonLogPath(ws), 'x'.repeat(100));
    rotateDaemonLog(ws, 1000);
    expect((await stat(daemonLogPath(ws))).size).toBe(100);
    rotateDaemonLog(ws, 50);
    expect((await stat(`${daemonLogPath(ws)}.1`)).size).toBe(100);
    await expect(stat(daemonLogPath(ws))).rejects.toThrow();
  });
});
