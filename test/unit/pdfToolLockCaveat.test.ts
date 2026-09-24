import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import type { AppContext } from '../../src/context.js';

/*
 * The three read-only tools that nonetheless take the per-project lock (they read the temp build
 * dir a peer's compile rewrites in place) must SAY so in the description the client sees:
 * "writes nothing" is not true of them without the caveat, and a caller hitting the lock timeout
 * needs to know why a read-only call waited. Judged off a listTools() round trip — the text a
 * client actually receives — not off the source.
 */

// Registration reads the context lazily; see test/unit/server.test.ts for why this stand-in works.
const fakeCtx = {} as unknown as AppContext;

const LOCKING_READ_TOOLS = ['render_pages', 'pdf_geometry', 'extract_text'] as const;

describe('lock caveat on the read-only tools that lock', () => {
  it.each(LOCKING_READ_TOOLS)(
    '%s names the per-project lock, the .sessions directory and the wait/timeout',
    async (name) => {
      const server = createServer(fakeCtx);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'test', version: '0.0.0' });
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      try {
        const { tools } = await client.listTools();
        const description = tools.find((t) => t.name === name)?.description ?? '';
        expect(description).toContain('per-project lock');
        expect(description).toContain('<workspace>/.sessions/<project>/');
        expect(description).toMatch(/wait on/);
        expect(description).toMatch(/time out against/);
      } finally {
        await client.close();
      }
    },
  );
});
