import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import { quoteId } from '../../src/lib/projectId.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * `register_project { default: true }` under an explicit `WEB_LATEX_MCP_DEFAULT_PROJECT` names
 * that env value in its result. The value can be an id the server skipped as invalid (it is kept
 * as the default so the explanation reaches the caller), so it is quoted like every other id.
 */

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

describe('register_project default note', () => {
  it('quotes the env default id rather than interpolating it raw', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ovl-regdef-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'ws');
    await mkdir(workspace);
    const envDefault = 'thesis\nforged line';
    const config: ServerConfig = {
      workspaceRoot: workspace,
      sessionId: 'test',
      projects: [],
      defaultProject: envDefault,
      defaultProjectExplicit: true,
    };
    const ctx = createContext(
      config,
      new CredentialResolver({}),
      { name: 'Test', email: 'test@example.com' },
      new ProjectRegistry(workspace),
    );
    const server = createServer(ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(() => client.close());

    const res = await client.callTool({
      name: 'register_project',
      arguments: {
        project: 'paper',
        gitUrl: 'https://git.example/paper.git',
        clone: false,
        default: true,
      },
    });
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
    const text = ((res.content ?? []) as Array<{ text?: string }>)
      .map((c) => c.text ?? '')
      .join('');
    expect(text).toMatch(/WEB_LATEX_MCP_DEFAULT_PROJECT/);
    expect(text).toContain(quoteId(envDefault));
    expect(text).not.toContain(envDefault);
  });
});
