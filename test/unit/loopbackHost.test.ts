import { describe, it, expect, afterEach } from 'vitest';
import { allowedHosts, browserRequestRefusal } from '../../src/lib/loopbackHost.js';
import { CredentialPortal } from '../../src/services/credentialPortal.js';
import { ViewerService } from '../../src/services/viewer.js';
import { CommentStore } from '../../src/services/commentStore.js';
import { rawRequest } from '../helpers/rawRequest.js';

/** docs/design/shared-server.md §10: the viewer and the credential portal get the Host check. */

describe('browserRequestRefusal', () => {
  const at = { port: 4321 };

  it('answers only to the listener’s own name and port', () => {
    expect(
      browserRequestRefusal({ method: 'GET', host: '127.0.0.1:4321', origin: undefined }, at),
    ).toBeNull();
    expect(
      browserRequestRefusal({ method: 'GET', host: 'LOCALHOST:4321', origin: undefined }, at),
    ).toBeNull();
    for (const host of [
      undefined,
      'evil.example:4321',
      '127.0.0.1:4322',
      '127.0.0.1',
      'evil.example',
    ]) {
      expect(browserRequestRefusal({ method: 'GET', host, origin: undefined }, at)?.status).toBe(
        421,
      );
    }
  });

  it('lets a page read itself from any origin, but changes nothing for another site', () => {
    const host = '127.0.0.1:4321';
    // A cross-site GET cannot read the answer; the browser sends Origin only on some GETs.
    expect(
      browserRequestRefusal({ method: 'GET', host, origin: 'https://evil.example' }, at),
    ).toBeNull();
    for (const origin of ['http://127.0.0.1:4321', 'http://localhost:4321']) {
      expect(browserRequestRefusal({ method: 'POST', host, origin }, at)).toBeNull();
    }
    for (const origin of [
      'https://evil.example',
      'null',
      'http://127.0.0.1:4322',
      'https://127.0.0.1:4321',
    ]) {
      expect(browserRequestRefusal({ method: 'POST', host, origin }, at)?.status).toBe(403);
    }
    // No Origin at all is a non-browser client.
    expect(browserRequestRefusal({ method: 'POST', host, origin: undefined }, at)).toBeNull();
  });

  it('adds the bound name and the portless forms on port 80', () => {
    expect(allowedHosts(80, '::1')).toEqual([
      '::1:80',
      '127.0.0.1:80',
      'localhost:80',
      '::1',
      '127.0.0.1',
      'localhost',
    ]);
  });
});

describe('the browser-facing listeners', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  it('the credential portal refuses a rebinding Host and a cross-site POST, storing nothing', async () => {
    const stored: string[] = [];
    const portal = new CredentialPortal(async (_h, _u, t) => {
      stored.push(t);
      return { persisted: true };
    });
    cleanups.push(() => portal.close());
    const url = (await portal.open({ host: 'git.overleaf.com', username: 'git' }))!;
    const port = new URL(url).port;
    const form = 'token=ghp_secret';
    const formHeaders = { 'content-type': 'application/x-www-form-urlencoded' };

    expect((await rawRequest(url, { headers: { host: `evil.example:${port}` } })).status).toBe(421);
    const crossSite = await rawRequest(url, {
      method: 'POST',
      headers: { ...formHeaders, origin: 'https://evil.example' },
      body: form,
    });
    expect(crossSite.status).toBe(403);
    expect(stored).toEqual([]);

    const sameSite = await rawRequest(url, {
      method: 'POST',
      headers: { ...formHeaders, origin: `http://127.0.0.1:${port}` },
      body: form,
    });
    expect(sameSite.status).toBe(200);
    expect(stored).toEqual(['ghp_secret']);
  });

  it('the viewer refuses a rebinding Host and a cross-site comment', async () => {
    const store = new CommentStore();
    const viewer = new ViewerService({
      knownIds: () => ['demo'],
      locatePdf: async () => ({ pdf: null, root: null }),
      addComment: async (id, input) => store.add(id, input),
      listComments: (id) => store.list(id),
      updateComment: (id, cid, note) => store.update(id, cid, { note }),
      deleteComment: (id, cid) => store.remove(id, cid),
      undoDelete: (id) => store.undo(id),
      resolveComments: (id, ids) => store.resolve(id, ids),
    });
    cleanups.push(() => viewer.close());
    const base = (await viewer.start(0))!;
    const port = new URL(base).port;

    // The viewer keeps its own guard (`ViewerService.admits`: any loopback name on any port, for
    // forwarded ports), which answers a refused Host with 403 rather than the portal's 421.
    expect(
      (await rawRequest(`${base}/p/demo`, { headers: { host: `evil.example:${port}` } })).status,
    ).toBe(403);
    expect((await rawRequest(`${base}/p/demo`)).status).toBe(200);

    const comment = JSON.stringify({ page: 1, x: 1, y: 1, quote: 'q', note: 'n' });
    const json = { 'content-type': 'application/json' };
    const crossSite = await rawRequest(`${base}/p/demo/comments`, {
      method: 'POST',
      headers: { ...json, origin: 'https://evil.example' },
      body: comment,
    });
    expect(crossSite.status).toBe(403);
    expect(store.list('demo')).toEqual([]);

    const sameSite = await rawRequest(`${base}/p/demo/comments`, {
      method: 'POST',
      headers: { ...json, origin: `http://127.0.0.1:${port}` },
      body: comment,
    });
    expect(sameSite.status).toBe(201);
  });
});
