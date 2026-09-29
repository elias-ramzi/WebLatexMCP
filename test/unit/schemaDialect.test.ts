/**
 * The advertised tool schemas must be acceptable to a JSON Schema 2020-12 validator AND to the
 * SDK's own draft-07 one, off a real `listTools()` round trip.
 *
 * The SDK converts zod with no target, so every `inputSchema`/`outputSchema` it advertises carries
 * `"$schema": "http://json-schema.org/draft-07/schema#"`. The Claude desktop app's Code tab
 * validates with a 2020-12-only Ajv and refused every tool call ("unsupported dialect") before any
 * result came back. `stripSchemaDialect` drops the marker, which is only correct while the bodies
 * mean the same thing in both dialects — so this compiles every schema under both, strictly, and a
 * zod feature that emits a draft-specific keyword (`definitions`, array-form `items`) fails here
 * rather than in a client.
 */
import { describe, it, expect } from 'vitest';
import { Ajv } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from '../../src/server.js';
import { installOutputSchemaCompat, stripSchemaDialect } from '../../src/lib/outputSchemaCompat.js';
import type { OutputSchemaMode } from '../../src/lib/outputSchemaCompat.js';
import type { AppContext } from '../../src/context.js';

const DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';

/**
 * `listTools()` through the same hook `src/index.ts` installs. The SDK `Client` compiles an Ajv
 * (draft-07) validator for every `outputSchema` inside `listTools()`, so a resolved call is itself
 * proof that an older SDK client still accepts what is advertised.
 */
async function listTools(mode: OutputSchemaMode, clientName = 'claude-code') {
  const server = createServer({} as unknown as AppContext);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  installOutputSchemaCompat(server, serverTransport, mode);
  const client = new Client({ name: clientName, version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

type Advertised = Awaited<ReturnType<typeof listTools>>[number];

/** Every advertised schema, labelled for assertion messages. */
function schemasOf(tools: Advertised[]): [string, Record<string, unknown>][] {
  return tools.flatMap((t) => {
    const out: [string, Record<string, unknown>][] = [[`${t.name}.inputSchema`, t.inputSchema]];
    if (t.outputSchema) out.push([`${t.name}.outputSchema`, t.outputSchema]);
    return out;
  });
}

describe('advertised schema dialect', () => {
  for (const mode of ['auto', 'never'] as const) {
    it(`declares no non-2020-12 $schema (mode ${mode})`, async () => {
      const tools = await listTools(mode);
      const schemas = schemasOf(tools);
      // The round trip must actually carry output schemas, or this proves nothing about them.
      expect(schemas.filter(([label]) => label.endsWith('.outputSchema')).length).toBe(
        tools.length,
      );
      const offenders = schemas
        .filter(([, s]) => s.$schema !== undefined && s.$schema !== DRAFT_2020_12)
        .map(([label, s]) => `${label}: ${String(s.$schema)}`);
      expect(offenders).toEqual([]);
    });
  }

  it('compiles every schema under a strict 2020-12 validator and a strict draft-07 one', async () => {
    const schemas = schemasOf(await listTools('auto'));
    expect(schemas.length).toBeGreaterThan(0);
    const validators = {
      '2020-12': new Ajv2020({ strict: true, validateFormats: false }),
      'draft-07': new Ajv({ strict: true, validateFormats: false }),
    };
    const failures: string[] = [];
    for (const [dialect, ajv] of Object.entries(validators)) {
      for (const [label, schema] of schemas) {
        try {
          ajv.compile(schema);
        } catch (err) {
          failures.push(`${dialect} ${label}: ${(err as Error).message}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('keeps stripping $schema from input schemas when outputSchema is omitted (claude-ai)', async () => {
    const tools = await listTools('auto', 'claude-ai');
    expect(tools.every((t) => t.outputSchema === undefined)).toBe(true);
    expect(tools.filter((t) => '$schema' in t.inputSchema).map((t) => t.name)).toEqual([]);
  });
});

describe('stripSchemaDialect', () => {
  it('drops the root $schema of both schemas and nothing else', () => {
    const msg = {
      jsonrpc: '2.0',
      id: 1,
      result: {
        tools: [
          {
            name: 'a',
            inputSchema: {
              $schema: 'x',
              type: 'object',
              properties: { $schema: { type: 'string' } },
            },
            outputSchema: { $schema: 'x', type: 'object' },
          },
          { name: 'b', inputSchema: { type: 'object' } },
        ],
      },
    } as unknown as JSONRPCMessage;
    stripSchemaDialect(msg);
    expect(msg).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        tools: [
          {
            name: 'a',
            inputSchema: { type: 'object', properties: { $schema: { type: 'string' } } },
            outputSchema: { type: 'object' },
          },
          { name: 'b', inputSchema: { type: 'object' } },
        ],
      },
    });
  });

  it('leaves messages without a tool list untouched', () => {
    const msg = {
      jsonrpc: '2.0',
      id: 2,
      result: { content: [], structuredContent: { $schema: 'x' } },
    } as unknown as JSONRPCMessage;
    stripSchemaDialect(msg);
    expect(msg).toEqual({
      jsonrpc: '2.0',
      id: 2,
      result: { content: [], structuredContent: { $schema: 'x' } },
    });
  });
});
