import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { SessionRegistry } from '../../src/services/sessionRegistry.js';
import { isScopeOpen, openScope } from '../../src/lib/openScopes.js';
import { processNonce } from '../../src/lib/fileLock.js';
import { sessionDir } from '../../src/lib/sessionPaths.js';

/**
 * Connection-based liveness (docs/design/shared-server.md §5.3): a record written by a session
 * scope of THIS process is live exactly while that scope is open here; any other record keeps the
 * pid, boot and heartbeat rules.
 */

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function workspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wlm-live-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function recordPath(ws: string, id: string): string {
  return path.join(sessionDir(ws, 'demo', id), 'session.json');
}

async function rewrite(ws: string, id: string, patch: Record<string, unknown>): Promise<void> {
  const file = recordPath(ws, id);
  const record = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  await writeFile(file, JSON.stringify({ ...record, ...patch }));
}

async function liveness(ws: string, asker: string): Promise<Record<string, boolean>> {
  const peers = await new SessionRegistry(ws, asker).peers('demo');
  return Object.fromEntries(peers.map((p) => [p.sessionId, p.live]));
}

describe('scope liveness', () => {
  it('reads a scope of this process live while it is open and dead once closed', async () => {
    const ws = await workspace();
    const close = openScope(ws, 'beta');
    cleanups.push(close);
    await new SessionRegistry(ws, 'beta', { scoped: true }).touch('demo');

    expect(JSON.parse(await readFile(recordPath(ws, 'beta'), 'utf8'))).toMatchObject({
      pid: process.pid,
      processNonce,
    });
    expect(await liveness(ws, 'alpha')).toEqual({ beta: true });

    // Closed: its pid runs and its heartbeat is seconds old, and neither is consulted.
    close();
    expect(await liveness(ws, 'alpha')).toEqual({ beta: false });
    // The session asking about itself is always live.
    expect((await new SessionRegistry(ws, 'beta').peers('demo'))[0]?.live).toBe(true);
  });

  it('keeps an open scope live however old its heartbeat', async () => {
    const ws = await workspace();
    cleanups.push(openScope(ws, 'beta'));
    await new SessionRegistry(ws, 'beta', { scoped: true }).touch('demo');
    await rewrite(ws, 'beta', { heartbeatAt: new Date(Date.now() - 86_400_000).toISOString() });
    expect(await liveness(ws, 'alpha')).toEqual({ beta: true });
  });

  it("judges a scope open in another workspace, or another process's record, by the old rules", async () => {
    const ws = await workspace();
    const other = await workspace();
    cleanups.push(openScope(other, 'beta')); // open, but on another workspace
    await new SessionRegistry(ws, 'beta', { scoped: true }).touch('demo');
    expect(await liveness(ws, 'alpha')).toEqual({ beta: false });

    // Another process's nonce: same pid (reused), fresh heartbeat → the heartbeat clause grants.
    await rewrite(ws, 'beta', { processNonce: 'someone-else' });
    expect(await liveness(ws, 'alpha')).toEqual({ beta: true });
    // ... and a dead pid with a stale heartbeat reads dead, as before.
    await rewrite(ws, 'beta', {
      pid: 2 ** 30,
      heartbeatAt: new Date(Date.now() - 86_400_000).toISOString(),
    });
    expect(await liveness(ws, 'alpha')).toEqual({ beta: false });
  });

  it('stamps no nonce from a bare registry, and ignores a nonce that is not a string', async () => {
    const ws = await workspace();
    await new SessionRegistry(ws, 'beta').touch('demo');
    const record = JSON.parse(await readFile(recordPath(ws, 'beta'), 'utf8')) as object;
    expect(record).not.toHaveProperty('processNonce');
    // No scope is open, yet the pid runs: judged by pid, so live.
    expect(await liveness(ws, 'alpha')).toEqual({ beta: true });

    await rewrite(ws, 'beta', { processNonce: 42 });
    const [peer] = await new SessionRegistry(ws, 'alpha').peers('demo');
    expect(peer).not.toHaveProperty('processNonce');
    expect(peer?.live).toBe(true);
  });

  it('counts two scopes holding one id, staying open until both close', async () => {
    const ws = await workspace();
    const first = openScope(ws, 'beta');
    const second = openScope(ws, 'beta');
    first();
    first(); // closing twice closes once
    expect(isScopeOpen(ws, 'beta')).toBe(true);
    second();
    expect(isScopeOpen(ws, 'beta')).toBe(false);
  });

  it('finds an open scope whatever spelling of the workspace the reader uses', async () => {
    const ws = await workspace();
    cleanups.push(openScope(path.join(ws, '.', 'sub', '..'), 'beta'));
    expect(isScopeOpen(ws, 'beta')).toBe(true);
    if (process.platform !== 'win32') {
      const link = path.join(await workspace(), 'link');
      await symlink(ws, link);
      expect(isScopeOpen(link, 'beta')).toBe(true);
    }
  });

  it('matches a scope opened before its workspace existed', async () => {
    const parent = await workspace();
    const ws = path.join(parent, 'later');
    cleanups.push(openScope(ws, 'beta'));
    await mkdir(ws);
    expect(isScopeOpen(ws, 'beta')).toBe(true);
  });
});
