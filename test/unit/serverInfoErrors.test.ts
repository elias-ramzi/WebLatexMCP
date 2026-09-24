import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import type { AppContext } from '../../src/context.js';

describe('server_info error handling', () => {
  it('returns a token-scrubbed isError result when the handler throws', async () => {
    // Every handler catches with errorResult(err, allSecrets()). Without that catch the SDK turns
    // the throw into an isError result carrying the raw message — secret included.
    const secret = 'ghp_serverInfoLeakCanary123';
    const config = {
      workspaceIsLocal: false,
      compiler: 'latexmk',
      get workspaceRoot(): string {
        throw new Error(`cannot read workspace: token ${secret} rejected`);
      },
    };
    const ctx = {
      config,
      credentials: { allSecrets: () => [secret] },
    } as unknown as AppContext;
    const server = createServer(ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const res = await client.callTool({ name: 'server_info', arguments: {} });
    expect(res.isError).toBe(true);
    const text = (res.content as Array<{ text: string }>)[0]?.text ?? '';
    expect(text).toContain('cannot read workspace');
    expect(text).not.toContain(secret);

    await client.close();
  });
});
