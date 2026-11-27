import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/client';
import { CLIENT_INFO_META_KEY, InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { createServer } from '../../src/server.js';
import {
  clientNameIn,
  installSchemaShaping,
  isIncompatibleClient,
  outputSchemaMode,
  stripsOutputSchema,
  watchInbound,
} from '../../src/lib/outputSchemaCompat.js';
import type { OutputSchemaMode } from '../../src/lib/outputSchemaCompat.js';
import type { AppContext } from '../../src/context.js';

const fakeCtx = {} as unknown as AppContext;

/** `listTools()` from a server built the way every serving entry builds one for `clientName`. */
async function listToolsAs(clientName: string, mode: OutputSchemaMode) {
  const server = createServer(fakeCtx, undefined, undefined, [], false, undefined, {
    stripOutputSchema: stripsOutputSchema(mode, clientName),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: clientName, version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

describe('outputSchemaMode', () => {
  const cases: [string | undefined, OutputSchemaMode][] = [
    [undefined, 'auto'],
    ['', 'auto'],
    ['   ', 'auto'],
    ['1', 'always'],
    ['true', 'always'],
    ['yes', 'always'],
    ['0', 'never'],
    ['false', 'never'],
    ['off', 'never'],
  ];
  for (const [value, expected] of cases) {
    it(`maps ${JSON.stringify(value)} -> ${expected}`, () => {
      const env = { WEB_LATEX_MCP_NO_OUTPUT_SCHEMA: value } as NodeJS.ProcessEnv;
      expect(outputSchemaMode(env)).toBe(expected);
    });
  }
});

describe('isIncompatibleClient and stripsOutputSchema', () => {
  it('matches Claude Desktop (claude-ai) only', () => {
    expect(isIncompatibleClient('claude-ai')).toBe(true);
    expect(isIncompatibleClient('claude-code')).toBe(false);
    expect(isIncompatibleClient('cursor-vscode')).toBe(false);
    expect(isIncompatibleClient(undefined)).toBe(false);
  });

  it('strips in auto mode only for an incompatible client, always or never otherwise', () => {
    expect(stripsOutputSchema('auto', 'claude-ai')).toBe(true);
    expect(stripsOutputSchema('auto', 'claude-code')).toBe(false);
    expect(stripsOutputSchema('auto', undefined)).toBe(false);
    expect(stripsOutputSchema('always', 'claude-code')).toBe(true);
    expect(stripsOutputSchema('never', 'claude-ai')).toBe(false);
  });
});

describe('clientNameIn', () => {
  it('reads a 2025 initialize and a 2026-07-28 envelope, and nothing else', () => {
    expect(
      clientNameIn({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'claude-ai', version: '1' } },
      }),
    ).toBe('claude-ai');
    expect(
      clientNameIn({
        jsonrpc: '2.0',
        id: 2,
        method: 'server/discover',
        params: { _meta: { [CLIENT_INFO_META_KEY]: { name: 'claude-code', version: '2' } } },
      }),
    ).toBe('claude-code');
    // Only `initialize` carries a top-level clientInfo; anywhere else it is just a parameter.
    expect(
      clientNameIn({ method: 'tools/call', params: { clientInfo: { name: 'claude-ai' } } }),
    ).toBeUndefined();
    expect(clientNameIn({ method: 'notifications/initialized' })).toBeUndefined();
    expect(clientNameIn(null)).toBeUndefined();
    expect(clientNameIn({ params: { _meta: { [CLIENT_INFO_META_KEY]: 7 } } })).toBeUndefined();
  });
});

describe('watchInbound', () => {
  it('sees every message before the handler the serving entry sets', () => {
    const seen: unknown[] = [];
    const handled: unknown[] = [];
    const transport: { onmessage?: (m: never) => void } = {};
    watchInbound(transport, (m) => seen.push(m));
    expect(transport.onmessage).toBeUndefined();
    transport.onmessage = (m: never) => handled.push(m);
    (transport.onmessage as unknown as (m: unknown) => void)({ a: 1 });
    expect(seen).toEqual([{ a: 1 }]);
    expect(handled).toEqual([{ a: 1 }]);
  });

  it('never drops a message because watching it threw', () => {
    const handled: unknown[] = [];
    const transport: { onmessage?: (m: never) => void } = {};
    watchInbound(transport, () => {
      throw new Error('boom');
    });
    transport.onmessage = (m: never) => handled.push(m);
    (transport.onmessage as unknown as (m: unknown) => void)('x');
    expect(handled).toEqual(['x']);
  });
});

describe('a server built for its client', () => {
  it('auto mode leaves out outputSchema for the Claude Desktop client (claude-ai)', async () => {
    const tools = await listToolsAs('claude-ai', 'auto');
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((t) => t.outputSchema === undefined)).toBe(true);
  });

  it('auto mode keeps outputSchema for other clients', async () => {
    const tools = await listToolsAs('claude-code', 'auto');
    expect(tools.some((t) => t.outputSchema !== undefined)).toBe(true);
  });

  it('always mode leaves it out regardless of client', async () => {
    const tools = await listToolsAs('claude-code', 'always');
    expect(tools.every((t) => t.outputSchema === undefined)).toBe(true);
  });

  it('never mode keeps outputSchema even for claude-ai', async () => {
    const tools = await listToolsAs('claude-ai', 'never');
    expect(tools.some((t) => t.outputSchema !== undefined)).toBe(true);
  });

  it('returns no structuredContent where it advertises no outputSchema', async () => {
    const results: Record<string, unknown>[] = [];
    for (const strip of [false, true]) {
      const server = new McpServer({ name: 't', version: '0' });
      installSchemaShaping(server, { stripOutputSchema: strip });
      server.registerTool(
        'echo',
        { inputSchema: { x: z.number() }, outputSchema: { x: z.number() } },
        async ({ x }) => ({
          content: [{ type: 'text' as const, text: String(x) }],
          structuredContent: { x },
        }),
      );
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'c', version: '0' });
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      await client.listTools();
      results.push(
        (await client.callTool({ name: 'echo', arguments: { x: 3 } })) as Record<string, unknown>,
      );
      await client.close();
    }
    expect(results[0]!.structuredContent).toEqual({ x: 3 });
    expect(results[1]!.structuredContent).toBeUndefined();
    expect(results[1]!.content).toEqual([{ type: 'text', text: '3' }]);
  });
});
