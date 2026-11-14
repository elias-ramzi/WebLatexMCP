import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { allowedHosts, guardRequest, sameSecret } from '../../src/daemon/requestGuard.js';
import {
  HEADER_CREDENTIALS,
  HEADER_DEFAULT_PROJECT,
  HEADER_CLIENT_ENV,
  HEADER_REPLACE_WHEN_IDLE,
  HEADER_NO_OUTPUT_SCHEMA,
  HEADER_SESSION,
  MAX_CREDENTIALS,
  SessionHeaderError,
  parseSessionHeaders,
  uniqueSessionId,
} from '../../src/daemon/sessionHeaders.js';
import {
  daemonDir,
  daemonInfoPath,
  ensureDaemonDir,
  readDaemonInfo,
  removeDaemonInfo,
  writeDaemonInfo,
  type DaemonInfo,
} from '../../src/daemon/daemonFiles.js';
import { parseServeArgs } from '../../src/daemon/serveCommand.js';
import { hashEnvValue } from '../../src/lib/daemonWideEnv.js';

const POSIX = process.platform !== 'win32';
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wlm-daemon-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

describe('guardRequest', () => {
  const expected = { port: 4321, token: 'the-token' };
  const ok = { host: '127.0.0.1:4321', origin: undefined, authorization: 'Bearer the-token' };

  it('lets a loopback request with the token through, by either host name', () => {
    expect(guardRequest(ok, expected)).toBeNull();
    expect(guardRequest({ ...ok, host: 'LOCALHOST:4321' }, expected)).toBeNull();
    expect(allowedHosts(4321)).toEqual(['127.0.0.1:4321', 'localhost:4321']);
    // On port 80 a client omits the port.
    expect(allowedHosts(80)).toEqual(['127.0.0.1:80', 'localhost:80', '127.0.0.1', 'localhost']);
  });

  it('refuses a browser request even with the token', () => {
    expect(guardRequest({ ...ok, origin: 'http://127.0.0.1:4321' }, expected)?.status).toBe(403);
  });

  it('refuses a foreign Host, the right name on the wrong port, and no Host', () => {
    for (const host of [
      'evil.example',
      'evil.example:4321',
      '127.0.0.1:4322',
      'localhost',
      undefined,
    ]) {
      expect(guardRequest({ ...ok, host }, expected)?.status, String(host)).toBe(421);
    }
  });

  it('refuses a missing, malformed or one-byte-off token, naming no secret', () => {
    for (const authorization of [
      undefined,
      '',
      'the-token',
      'Basic the-token',
      'Bearer the-tokeN',
      'Bearer the-token ',
    ]) {
      const refusal = guardRequest({ ...ok, authorization }, expected);
      expect(refusal?.status, String(authorization)).toBe(401);
      expect(refusal?.message).not.toContain('the-token');
    }
    expect(sameSecret('a', 'a')).toBe(true);
    expect(sameSecret('a', 'ab')).toBe(false);
  });
});

describe('parseSessionHeaders', () => {
  it('reads every per-connection setting', () => {
    const s = parseSessionHeaders(
      {
        [HEADER_SESSION]: 'agent-1',
        [HEADER_DEFAULT_PROJECT]: 'thèse',
        [HEADER_CREDENTIALS]: JSON.stringify({ GITHUB_TOKEN: 'ghp_x', __proto__: 'p' }),
        [HEADER_NO_OUTPUT_SCHEMA]: '1',
        [HEADER_CLIENT_ENV]: JSON.stringify({
          WEB_LATEX_MCP_COMPILER: hashEnvValue('tectonic'),
          WEB_LATEX_MCP_REWRITE_MODE: hashEnvValue('prose'),
          NOT_DAEMON_WIDE: hashEnvValue('x'),
        }),
        [HEADER_REPLACE_WHEN_IDLE]: '1',
      },
      // The daemon agrees on the rewrite mode, not on the compiler.
      { WEB_LATEX_MCP_COMPILER: 'latexmk', WEB_LATEX_MCP_REWRITE_MODE: ' prose ' },
    );
    expect(s.requestedSessionId).toBe('agent-1');
    expect(s.defaultProject).toBe('thèse');
    expect(s.credentialOverlay?.GITHUB_TOKEN).toBe('ghp_x');
    expect(Object.getPrototypeOf(s.credentialOverlay)).toBeNull();
    expect(s.outputSchema).toBe('always');
    expect(s.ignoredEnv).toEqual(['WEB_LATEX_MCP_COMPILER']);
    expect(s.replaceWhenIdle).toBe(true);
  });

  it("falls back to the daemon's output-schema mode and asks for nothing else", () => {
    expect(parseSessionHeaders({}, { WEB_LATEX_MCP_NO_OUTPUT_SCHEMA: '0' })).toEqual({
      outputSchema: 'never',
      ignoredEnv: [],
      replaceWhenIdle: false,
    });
  });

  it('refuses rather than rewrites: reserved, unsafe or repeated session ids', () => {
    for (const bad of ['shelves', 'a b', '../x', '', 'x'.repeat(65)]) {
      expect(() => parseSessionHeaders({ [HEADER_SESSION]: bad }, {}), bad).toThrow(
        SessionHeaderError,
      );
    }
    expect(() => parseSessionHeaders({ [HEADER_SESSION]: ['a', 'b'] }, {})).toThrow(
      /more than once/,
    );
  });

  it('refuses a bad default project and malformed credentials without echoing a value', () => {
    expect(() => parseSessionHeaders({ [HEADER_DEFAULT_PROJECT]: 'a/b' }, {})).toThrow(
      /not usable/,
    );
    const bad = [
      'not json',
      '[]',
      JSON.stringify({ 'NOT A NAME': 'v' }),
      JSON.stringify({ TOKEN: 42 }),
      JSON.stringify({ TOKEN: 'v'.repeat(5000) }),
      JSON.stringify(
        Object.fromEntries(Array.from({ length: MAX_CREDENTIALS + 1 }, (_, i) => [`T${i}`, 'v'])),
      ),
    ];
    for (const raw of bad) {
      let message = '';
      try {
        parseSessionHeaders({ [HEADER_CREDENTIALS]: raw }, {});
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message, raw.slice(0, 30)).not.toBe('');
      expect(message).not.toContain('vvvv');
    }
  });
});

describe('the client-env header', () => {
  it('refuses a malformed digest and never needs a value', () => {
    expect(() =>
      parseSessionHeaders({ [HEADER_CLIENT_ENV]: '{"WEB_LATEX_MCP_COMPILER":"tectonic"}' }, {}),
    ).toThrow(/SHA-256/);
    expect(() => parseSessionHeaders({ [HEADER_CLIENT_ENV]: '[]' }, {})).toThrow(/object/);
    // Set on the client, unset on the daemon: differs. Unset on both: never sent, never named.
    expect(
      parseSessionHeaders(
        { [HEADER_CLIENT_ENV]: JSON.stringify({ WEB_LATEX_MCP_SKILLS_DIR: hashEnvValue('/s') }) },
        {},
      ).ignoredEnv,
    ).toEqual(['WEB_LATEX_MCP_SKILLS_DIR']);
  });
});

describe('uniqueSessionId', () => {
  it('suffixes a taken id, keeping it within 64 characters', () => {
    const taken = new Set(['beta', 'beta-2']);
    expect(uniqueSessionId('alpha', (id) => taken.has(id))).toBe('alpha');
    expect(uniqueSessionId('beta', (id) => taken.has(id))).toBe('beta-3');
    const long = 'x'.repeat(64);
    const next = uniqueSessionId(long, (id) => id === long);
    expect(next).toHaveLength(64);
    expect(next.endsWith('-2')).toBe(true);
  });
});

describe('daemon files', () => {
  const info: DaemonInfo = {
    pid: process.pid,
    processNonce: 'nonce-a',
    port: 1234,
    token: 'tok',
    version: '0.0.0',
    buildPath: '/x/dist/index.js',
    buildId: '0.0.0|/x/dist/index.js|1',
    startedAt: '2026-11-09T00:00:00.000Z',
  };

  it('writes daemon.json 0600 in a 0700 directory, and removes only its own', async () => {
    const ws = await tempDir();
    await writeDaemonInfo(ws, info);
    expect(await readDaemonInfo(ws)).toEqual(info);
    if (POSIX) {
      expect((await stat(daemonDir(ws))).mode & 0o777).toBe(0o700);
      expect((await stat(daemonInfoPath(ws))).mode & 0o777).toBe(0o600);
    }
    await removeDaemonInfo(ws, 'someone-else');
    expect(await readDaemonInfo(ws)).toBeDefined();
    await removeDaemonInfo(ws, 'nonce-a');
    expect(await readDaemonInfo(ws)).toBeUndefined();
  });

  it.skipIf(!POSIX)('tightens a loose .daemon and refuses a link there', async () => {
    const ws = await tempDir();
    await mkdir(daemonDir(ws), { mode: 0o755 });
    await ensureDaemonDir(ws);
    expect((await stat(daemonDir(ws))).mode & 0o777).toBe(0o700);

    const other = await tempDir();
    const ws2 = await tempDir();
    await symlink(other, daemonDir(ws2));
    await expect(ensureDaemonDir(ws2)).rejects.toThrow(/not a directory/);
  });

  it('reads an unusable daemon.json as none', async () => {
    const ws = await tempDir();
    await ensureDaemonDir(ws);
    await writeFile(daemonInfoPath(ws), '{"pid": "x"}');
    expect(await readDaemonInfo(ws)).toBeUndefined();
  });
});

describe('parseServeArgs', () => {
  it('reads --keep-alive and a port from the flag or WEB_LATEX_MCP_PORT, flag winning', () => {
    expect(parseServeArgs([], {})).toEqual({ keepAlive: false });
    expect(parseServeArgs(['--keep-alive', '--port', '8123'], {})).toEqual({
      keepAlive: true,
      port: 8123,
    });
    expect(parseServeArgs([], { WEB_LATEX_MCP_PORT: '9000' })).toEqual({
      keepAlive: false,
      port: 9000,
    });
    expect(parseServeArgs(['--port', '7000'], { WEB_LATEX_MCP_PORT: '9000' })).toMatchObject({
      port: 7000,
    });
  });

  it('refuses a bad port or argument', () => {
    for (const port of ['0', '70000', '12ab', '-1']) {
      expect(parseServeArgs([], { WEB_LATEX_MCP_PORT: port }), port).toEqual(expect.any(String));
    }
    expect(parseServeArgs(['--port'], {})).toEqual(expect.any(String));
    expect(parseServeArgs(['--stdio'], {})).toEqual(expect.stringMatching(/Unknown argument/));
  });
});
