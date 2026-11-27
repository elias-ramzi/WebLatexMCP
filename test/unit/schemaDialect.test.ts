/**
 * The advertised tool schemas must be acceptable to a JSON Schema 2020-12 validator AND to a
 * draft-07 one (an SDK v1 client's), off a real `listTools()` round trip.
 *
 * SDK v1 converted zod with no target and stamped every schema
 * `"$schema": "http://json-schema.org/draft-07/schema#"`, which the Claude desktop app's Code tab
 * (a 2020-12-only Ajv) refused before any call came back; SDK v2 stamps 2020-12 instead, which a
 * draft-07 Ajv cannot resolve. `dialectFree` drops the stamp at registration, which is only
 * correct while the bodies mean the same thing in both dialects — so this compiles every schema
 * under both, strictly, and a zod feature that emits a draft-specific keyword (`definitions`,
 * array-form `items`, `prefixItems`) fails here rather than in a client.
 */
import { describe, it, expect } from 'vitest';
import { Ajv } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createServer } from '../../src/server.js';
import { dialectFree, stripsOutputSchema } from '../../src/lib/outputSchemaCompat.js';
import type { StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { OutputSchemaMode } from '../../src/lib/outputSchemaCompat.js';
import type { AppContext } from '../../src/context.js';

const DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';

/** `listTools()` from a server built the way `src/standalone.ts` and the daemon build one. */
async function listTools(mode: OutputSchemaMode, clientName = 'claude-code') {
  const server = createServer(
    {} as unknown as AppContext,
    undefined,
    undefined,
    [],
    false,
    undefined,
    {
      stripOutputSchema: stripsOutputSchema(mode, clientName),
    },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
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

describe('dialectFree', () => {
  const schema = z.object({ $schema: z.string(), n: z.number() });
  const free = dialectFree(schema as unknown as StandardSchemaWithJSON);

  it('drops only the root $schema of the converted document', () => {
    const target = { target: 'draft-2020-12' } as const;
    for (const io of ['input', 'output'] as const) {
      const original = schema['~standard'].jsonSchema[io](target);
      const shaped = free['~standard'].jsonSchema[io](target);
      expect(original.$schema).toBeTypeOf('string');
      const { $schema: _dropped, ...rest } = original;
      expect(shaped).toEqual(rest);
      // A property named `$schema` is the document's own business, kept.
      expect((shaped.properties as Record<string, unknown>).$schema).toEqual({ type: 'string' });
    }
  });

  it('validates exactly as the original schema does', async () => {
    for (const value of [{ $schema: 'a', n: 1 }, { n: 'x' }, null]) {
      expect(await free['~standard'].validate(value)).toEqual(
        await schema['~standard'].validate(value),
      );
    }
  });
});
