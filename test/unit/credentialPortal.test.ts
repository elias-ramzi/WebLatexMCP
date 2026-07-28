import { describe, it, expect, afterEach } from 'vitest';
import { CredentialPortal } from '../../src/services/credentialPortal.js';

describe('CredentialPortal', () => {
  let portal: CredentialPortal | undefined;

  afterEach(async () => {
    await portal?.close();
    portal = undefined;
  });

  it('serves the form on the nonce path and 404s everywhere else', async () => {
    const stored: string[] = [];
    portal = new CredentialPortal(async (h, u, t) => {
      stored.push(`${u}@${h}:${t}`);
      return { persisted: true };
    });
    const url = await portal.open({ host: 'git.overleaf.com', username: 'git' });
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}$/);

    const form = await fetch(url!);
    expect(form.status).toBe(200);
    const html = await form.text();
    expect(html).toContain('git.overleaf.com');
    expect(html).toContain('never goes through Claude');

    // The nonce guards the portal: the root path (and any wrong path) reveals nothing.
    const base = url!.replace(/\/[0-9a-f]{32}$/, '');
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/deadbeef`)).status).toBe(404);
  });

  it('stores a submitted token and reports the outcome without echoing it', async () => {
    const stored: Array<{ host: string; username: string; token: string }> = [];
    portal = new CredentialPortal(async (host, username, token) => {
      stored.push({ host, username, token });
      return { persisted: true };
    });
    const url = await portal.open({ host: 'git.overleaf.com', username: 'git' });

    const res = await fetch(url!, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: 'olp_secret' }).toString(),
    });
    const body = await res.text();
    expect(res.status).toBe(200);
    // The secret is never reflected back into the page.
    expect(body).not.toContain('olp_secret');
    expect(body).toContain('keychain');

    // It reached the store exactly once, with the right target.
    expect(stored).toEqual([{ host: 'git.overleaf.com', username: 'git', token: 'olp_secret' }]);

    // The outcome is readable once, then cleared.
    expect(portal.takeOutcome('git.overleaf.com')).toEqual({
      host: 'git.overleaf.com',
      username: 'git',
      persisted: true,
    });
    expect(portal.takeOutcome('git.overleaf.com')).toBeUndefined();
  });

  it('reports not-persisted when no helper keeps the token', async () => {
    portal = new CredentialPortal(async () => ({ persisted: false }));
    const url = await portal.open({ host: 'git.overleaf.com', username: 'git' });
    await fetch(url!, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: 'x' }).toString(),
    });
    expect(portal.takeOutcome('git.overleaf.com')?.persisted).toBe(false);
  });

  it('rejects an empty submission with a 400 and stores nothing', async () => {
    let called = false;
    portal = new CredentialPortal(async () => {
      called = true;
      return { persisted: true };
    });
    const url = await portal.open({ host: 'git.overleaf.com', username: 'git' });
    const res = await fetch(url!, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: '' }).toString(),
    });
    expect(res.status).toBe(400);
    expect(called).toBe(false);
  });
});
