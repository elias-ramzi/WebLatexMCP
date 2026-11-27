import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { runRelay } from '../../src/proxy/relay.js';
import { HEADER_CONNECTION } from '../../src/daemon/sessionHeaders.js';

/**
 * The relay's hold (`GET /hold`), against a stand-in daemon that drops every hold at once: the
 * daemon of a build before the keep-alive fix sent nothing on a hold, `fetch` dropped it after
 * 5 minutes, and the connection's 2026 session closed a minute later.
 */

describe('the relay hold', () => {
  const cleanups: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c().catch(() => {});
  });

  /** A stand-in daemon answering `/hold` with `holdStatus` and dropping it after 20 ms. */
  async function standIn(holdStatus = 200): Promise<{ url: string; holds: () => number }> {
    let holds = 0;
    const server = http.createServer((req, res) => {
      if (req.url === '/hold') {
        holds++;
        res.writeHead(holdStatus);
        res.flushHeaders();
        setTimeout(() => res.end(), 20);
        return;
      }
      res.writeHead(200).end(); // the relay's DELETE on its way out
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise((r) => server.close(r)));
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}/mcp`, holds: () => holds };
  }

  function relayTo(url: string, isAlive: () => Promise<boolean>): { stop: () => Promise<void> } {
    const stdin = new PassThrough();
    const relay = runRelay({
      stdin,
      stdout: new PassThrough(),
      headers: { [HEADER_CONNECTION]: '6f1d3a52-6c0e-4b8e-9d55-0a9d2b7e8c11' },
      endpoint: { url, token: 'token' },
      reconnect: () => Promise.reject(new Error('no restart expected')),
      isAlive,
      log: () => {},
      holdRetryMs: 10,
    });
    const stop = async (): Promise<void> => {
      stdin.end();
      await relay;
    };
    cleanups.push(stop);
    return { stop };
  }

  it('holds again after a drop while the daemon answers, and stops once it does not', async () => {
    const daemon = await standIn();
    let alive = true;
    const { stop } = relayTo(daemon.url, async () => alive);
    await expect.poll(() => daemon.holds(), { timeout: 5_000 }).toBeGreaterThanOrEqual(3);
    alive = false;
    const seen = daemon.holds();
    await new Promise((r) => setTimeout(r, 400));
    // At most the hold already on its way; a gone daemon is the restart's business.
    expect(daemon.holds()).toBeLessThanOrEqual(seen + 1);
    await stop();
  });

  it('never holds again where the daemon refuses a hold (a build before #288)', async () => {
    const daemon = await standIn(404);
    const { stop } = relayTo(daemon.url, async () => true);
    await expect.poll(() => daemon.holds()).toBe(1);
    await new Promise((r) => setTimeout(r, 200));
    expect(daemon.holds()).toBe(1);
    await stop();
  });
});
