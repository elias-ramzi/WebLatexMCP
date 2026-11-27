import { z } from 'zod';
import type { McpServer, StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { CLIENT_INFO_META_KEY } from '@modelcontextprotocol/server';

/**
 * How tool schemas and results are shaped for the client, decided when a server is built.
 *
 * **`outputSchema` for clients that choke on it.** Some MCP clients — observed with **Claude
 * Desktop** (which identifies as `clientInfo.name` `"claude-ai"`) — silently fail to dispatch tool
 * calls to a server whose tools advertise an `outputSchema`: the tool list loads, but every call
 * fails with a generic error and never reaches the server. For such a client the server is built
 * without `outputSchema` and its results without `structuredContent`; every other client (Claude
 * Code) gets structured output in full.
 *
 * **No `$schema` dialect, for every client.** SDK v2 converts zod to JSON Schema 2020-12 and stamps
 * `"$schema": "https://json-schema.org/draft/2020-12/schema"` on every schema (SDK v1 stamped
 * draft-07). Each stamp shuts out the validators of the other dialect: a 2020-12-only Ajv (the
 * Claude desktop app's Code tab) refused v1's draft-07, and an SDK v1 client — many third-party
 * hosts — compiles output validators with a draft-07 Ajv that cannot resolve the 2020-12
 * meta-schema. MCP reads a schema without `$schema` as 2020-12, and the bodies zod emits here are
 * dialect-neutral (no `definitions`, no array-form `items`), so dropping the stamp serves both.
 * `test/unit/schemaDialect.test.ts` compiles every advertised schema under both dialects, which is
 * what keeps "dialect-neutral" true as the schemas grow.
 *
 * Both are applied at registration ({@link installSchemaShaping}, installed by `createServer`
 * before any tool), never on the wire: SDK v2's serving entries (`serveStdio`, `createMcpHandler`)
 * own their transports, and a 2026-07-28 request carries its client's identity in its own `_meta`
 * envelope rather than in a connection-wide `initialize`. So the client is read where each entry
 * builds its server — the stdio opening message, a daemon session's `initialize`, a 2026-era
 * request's envelope ({@link clientNameIn}) — and the server is built for it.
 */

/** `clientInfo.name` values known to choke on `outputSchema`. */
const INCOMPATIBLE_CLIENTS = new Set(['claude-ai']);

export function isIncompatibleClient(name: string | undefined): boolean {
  return name !== undefined && INCOMPATIBLE_CLIENTS.has(name);
}

export type OutputSchemaMode = 'auto' | 'always' | 'never';

/**
 * Resolve the mode from `WEB_LATEX_MCP_NO_OUTPUT_SCHEMA`:
 * unset/empty → `auto` (strip only for known-incompatible clients),
 * `0`/`false`/`no`/`off` → `never` (always keep structured output),
 * anything else (e.g. `1`) → `always` (strip for every client).
 */
export function outputSchemaMode(env: NodeJS.ProcessEnv = process.env): OutputSchemaMode {
  const v = env.WEB_LATEX_MCP_NO_OUTPUT_SCHEMA;
  if (v === undefined || v.trim() === '') return 'auto';
  return /^(0|false|no|off)$/i.test(v.trim()) ? 'never' : 'always';
}

/** Whether a server built for `clientName` under `mode` leaves out `outputSchema`. */
export function stripsOutputSchema(
  mode: OutputSchemaMode,
  clientName: string | undefined,
): boolean {
  return mode === 'always' || (mode === 'auto' && isIncompatibleClient(clientName));
}

const nameOf = (info: unknown): string | undefined => {
  if (info === null || typeof info !== 'object') return undefined;
  const name = (info as { name?: unknown }).name;
  return typeof name === 'string' ? name : undefined;
};

/**
 * The client's self-reported name in one inbound JSON-RPC message: `params.clientInfo` of a 2025
 * `initialize`, or the `io.modelcontextprotocol/clientInfo` key of a 2026-07-28 request's `_meta`
 * envelope. `undefined` when the message names no client (most 2025 messages; any notification).
 * Self-reported, so used only to choose a compatible shape, never to grant anything.
 */
export function clientNameIn(message: unknown): string | undefined {
  if (message === null || typeof message !== 'object') return undefined;
  const params = (message as { params?: unknown }).params;
  if (params === null || typeof params !== 'object') return undefined;
  const { method } = message as { method?: unknown };
  if (method === 'initialize') {
    const name = nameOf((params as { clientInfo?: unknown }).clientInfo);
    if (name !== undefined) return name;
  }
  const meta = (params as { _meta?: unknown })._meta;
  if (meta === null || typeof meta !== 'object') return undefined;
  return nameOf((meta as Record<string, unknown>)[CLIENT_INFO_META_KEY]);
}

/**
 * Call `see` with every message `transport` delivers, before whoever set `transport.onmessage`
 * gets it — so a serving entry that owns the transport (`serveStdio`) can still be watched for the
 * client's name ({@link clientNameIn}) ahead of building the server for it. `see` must not throw.
 */
export function watchInbound(
  transport: { onmessage?: (message: never, extra?: never) => void },
  see: (message: unknown) => void,
): void {
  type Handler = (message: unknown, extra?: unknown) => void;
  let handler = transport.onmessage as Handler | undefined;
  Object.defineProperty(transport, 'onmessage', {
    configurable: true,
    enumerable: true,
    get: (): Handler | undefined =>
      handler === undefined
        ? undefined
        : (message, extra) => {
            try {
              see(message);
            } catch {
              /* watching never drops a message */
            }
            handler!(message, extra);
          },
    set: (next: Handler | undefined) => {
      handler = next;
    },
  });
}

/**
 * The same schema, minus the root `$schema` of the JSON Schema the SDK converts it to: validation
 * is the original schema's own (`~standard.validate`), only the advertised document changes.
 */
export function dialectFree(schema: StandardSchemaWithJSON): StandardSchemaWithJSON {
  const std = schema['~standard'];
  const drop = (json: Record<string, unknown>): Record<string, unknown> => {
    const { $schema: _dialect, ...rest } = json;
    return rest;
  };
  return {
    '~standard': {
      ...std,
      jsonSchema: {
        input: (options) => drop(std.jsonSchema.input(options)),
        output: (options) => drop(std.jsonSchema.output(options)),
      },
    },
  } as StandardSchemaWithJSON;
}

/** A tool's `inputSchema`/`outputSchema` as registered here: a raw zod shape or a schema. */
function asSchema(value: unknown): StandardSchemaWithJSON {
  if (value !== null && typeof value === 'object' && '~standard' in value) {
    return value as StandardSchemaWithJSON;
  }
  return z.object(value as z.ZodRawShape) as unknown as StandardSchemaWithJSON;
}

/** The loose shape of `McpServer.registerTool` the wrapper needs (it is heavily overloaded). */
type AnyRegisterTool = (
  name: string,
  config: unknown,
  cb: (...cbArgs: unknown[]) => unknown,
) => unknown;

/** A tool result with `structuredContent` left out; any other value is returned as it is. */
function withoutStructuredContent(result: unknown): unknown {
  if (result === null || typeof result !== 'object' || !('structuredContent' in result)) {
    return result;
  }
  const { structuredContent: _omitted, ...rest } = result as Record<string, unknown>;
  return rest;
}

/**
 * Wrap `server.registerTool` so every tool registered afterwards advertises dialect-free schemas
 * and, with `stripOutputSchema`, no `outputSchema` and no `structuredContent`. Install it before
 * the registrations (`createServer` does); tools registered earlier are not shaped.
 */
export function installSchemaShaping(
  server: McpServer,
  opts: { stripOutputSchema?: boolean } = {},
): void {
  const target = server as unknown as { registerTool: AnyRegisterTool };
  const original = target.registerTool.bind(server);
  const strip = opts.stripOutputSchema === true;
  target.registerTool = (name, config, cb) => {
    const shaped = { ...(config as Record<string, unknown>) };
    if (shaped.inputSchema !== undefined)
      shaped.inputSchema = dialectFree(asSchema(shaped.inputSchema));
    if (strip) delete shaped.outputSchema;
    else if (shaped.outputSchema !== undefined) {
      shaped.outputSchema = dialectFree(asSchema(shaped.outputSchema));
    }
    const callback = strip
      ? (...cbArgs: unknown[]): unknown => {
          const result = cb(...cbArgs);
          return result instanceof Promise
            ? result.then(withoutStructuredContent)
            : withoutStructuredContent(result);
        }
      : cb;
    return original(name, shaped, callback);
  };
}
