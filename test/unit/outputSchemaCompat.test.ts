import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from '../../src/server.js';
import {
  outputSchemaMode,
  isIncompatibleClient,
  stripOutputSchema,
  installOutputSchemaCompat,
} from '../../src/lib/outputSchemaCompat.js';
import type { OutputSchemaMode } from '../../src/lib/outputSchemaCompat.js';
import type { AppContext } from '../../src/context.js';

const fakeCtx = {} as unknown as AppContext;

async function listToolsAs(clientName: string, mode: OutputSchemaMode) {
  const server = createServer(fakeCtx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  installOutputSchemaCompat(server, serverTransport, mode);
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

describe('isIncompatibleClient', () => {
  it('matches Claude Desktop (claude-ai) only', () => {
    expect(isIncompatibleClient('claude-ai')).toBe(true);
    expect(isIncompatibleClient('claude-code')).toBe(false);
    expect(isIncompatibleClient('cursor-vscode')).toBe(false);
    expect(isIncompatibleClient(undefined)).toBe(false);
  });
});

describe('stripOutputSchema', () => {
  it('removes outputSchema from a tools/list result', () => {
    const msg = {
      jsonrpc: '2.0',
      id: 1,
      result: { tools: [{ name: 'a', outputSchema: { type: 'object' } }, { name: 'b' }] },
    } as unknown as JSONRPCMessage;
    stripOutputSchema(msg);
    expect(msg).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { tools: [{ name: 'a' }, { name: 'b' }] },
    });
  });

  it('removes structuredContent from a tool-call result', () => {
    const msg = {
      jsonrpc: '2.0',
      id: 2,
      result: { content: [{ type: 'text', text: 'ok' }], structuredContent: { x: 1 } },
    } as unknown as JSONRPCMessage;
    stripOutputSchema(msg);
    expect(msg).toEqual({
      jsonrpc: '2.0',
      id: 2,
      result: { content: [{ type: 'text', text: 'ok' }] },
    });
  });

  it('leaves unrelated messages untouched', () => {
    const msg = {
      jsonrpc: '2.0',
      id: 3,
      result: { resources: [] },
    } as unknown as JSONRPCMessage;
    stripOutputSchema(msg);
    expect(msg).toEqual({ jsonrpc: '2.0', id: 3, result: { resources: [] } });
  });
});

describe('installOutputSchemaCompat', () => {
  it('auto mode strips outputSchema for the Claude Desktop client (claude-ai)', async () => {
    const tools = await listToolsAs('claude-ai', 'auto');
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((t) => t.outputSchema === undefined)).toBe(true);
  });

  it('auto mode keeps outputSchema for other clients', async () => {
    const tools = await listToolsAs('claude-code', 'auto');
    expect(tools.some((t) => t.outputSchema !== undefined)).toBe(true);
  });

  it('always mode strips regardless of client', async () => {
    const tools = await listToolsAs('claude-code', 'always');
    expect(tools.every((t) => t.outputSchema === undefined)).toBe(true);
  });

  it('never mode keeps outputSchema even for claude-ai', async () => {
    const tools = await listToolsAs('claude-ai', 'never');
    expect(tools.some((t) => t.outputSchema !== undefined)).toBe(true);
  });
});
