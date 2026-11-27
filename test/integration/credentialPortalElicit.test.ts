import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { CredentialPortal } from '../../src/services/credentialPortal.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * `credential_portal` through URL-mode elicitation (#291): the client shows the page, the user
 * types the token there, and the one call returns the outcome. A real client whose
 * `elicitation/create` handler plays the user — it submits the form the URL serves — over the
 * 2025-era in-memory transport, so the SDK's legacy shim carries the request.
 */

const IDENTITY = { name: 'Test', email: 'test@example.com' };

describe('credential_portal with URL-mode elicitation', () => {
  const cleanups: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c().catch(() => {});
  });

  async function setup(opts: { url: boolean; user?: 'submit' | 'decline' }) {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-portal-ws-'));
    cleanups.push(() => rm(workspace, { recursive: true, force: true }));
    const config: ServerConfig = { workspaceRoot: workspace, sessionId: 'portal', projects: [] };
    const ctx = createContext(
      config,
      new CredentialResolver({}),
      IDENTITY,
      new ProjectRegistry(workspace),
    );
    const stored: string[] = [];
    ctx.credentialPortal = new CredentialPortal(async (_host, _user, token) => {
      stored.push(token);
      return { persisted: true };
    });
    cleanups.push(() => ctx.credentialPortal.close());
    // A helper is configured, so the page opens (with none, the tool answers no-helper).
    ctx.credentials.credentialHelpers = async () => ['store'];

    const server = createServer(ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: 'claude-code', version: '0.0.0' },
      opts.url ? { capabilities: { elicitation: { url: {} } } } : undefined,
    );
    const shown: string[] = [];
    if (opts.url) {
      client.setRequestHandler('elicitation/create', async (request) => {
        const params = request.params as { mode?: string; url?: string };
        shown.push(String(params.url));
        if (opts.user === 'decline') return { action: 'decline' };
        // The user opens the page and, a moment later, types the token there.
        setTimeout(() => {
          void fetch(params.url!, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token: 'olp_secret' }).toString(),
          });
        }, 100);
        return { action: 'accept' };
      });
    }
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(() => client.close());
    return { client, ctx, stored, shown };
  }

  const call = async (client: Client) =>
    (
      await client.callTool({
        name: 'credential_portal',
        arguments: { host: 'git.overleaf.com', open: false },
      })
    ).structuredContent as Record<string, unknown>;

  it('shows the page through the client and returns the outcome in the same call', async () => {
    const { client, stored, shown } = await setup({ url: true, user: 'submit' });
    const result = await call(client);
    expect(result).toMatchObject({ host: 'git.overleaf.com', username: 'git', status: 'stored' });
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
    expect(stored).toEqual(['olp_secret']);
    // The secret never reaches the result.
    expect(JSON.stringify(result)).not.toContain('olp_secret');
  });

  it('reports declined and closes the page when the user declines to open it', async () => {
    const { client, ctx, stored } = await setup({ url: true, user: 'decline' });
    const result = await call(client);
    expect(result).toMatchObject({ status: 'declined' });
    expect(ctx.credentialPortal.isRunning()).toBe(false);
    expect(stored).toEqual([]);
  });

  it('keeps the open-then-call-again flow for a client without URL elicitation', async () => {
    const { client } = await setup({ url: false });
    const result = await call(client);
    expect(result).toMatchObject({ status: 'awaiting-entry' });
    expect(String(result.url)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
  });
});
