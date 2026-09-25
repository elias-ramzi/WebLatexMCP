import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/**
 * Client-compatibility shim for `outputSchema`.
 *
 * Some MCP clients — observed with **Claude Desktop** (which identifies as `clientInfo.name`
 * `"claude-ai"`) — silently fail to dispatch tool calls to a server whose tools advertise an
 * `outputSchema`: the tool list loads, but every call fails with a generic error and never reaches
 * the server. This module strips `outputSchema` (from `tools/list`) and `structuredContent` (from
 * tool-call results) on the way out for affected clients, so they work — while leaving structured
 * output fully intact for clients that support it (e.g. Claude Code).
 *
 * The strip happens at the transport boundary (post-serialization shaping), so the server stays
 * spec-compliant internally and the decision can be made per-connection from the negotiated client.
 *
 * Separately, and for **every** client, the same hook drops the root `$schema` of each advertised
 * `inputSchema`/`outputSchema` (`stripSchemaDialect`). The SDK (1.29, and 1.30 still) converts zod
 * with no target, which falls back to draft-07 and stamps
 * `"$schema": "http://json-schema.org/draft-07/schema#"` on every schema; a client validating with a
 * 2020-12-only Ajv (the Claude desktop app's Code tab) refuses such a schema outright — "unsupported
 * dialect" — and no call reaches the server. MCP reads a schema without `$schema` as 2020-12, and the
 * bodies zod emits here are dialect-neutral (no `definitions`, no array-form `items`), so the SDK's own
 * draft-07 `Client` compiles them unchanged. Stamping 2020-12 instead would trade one client's refusal
 * for another's. `test/unit/schemaDialect.test.ts` compiles every advertised schema under both
 * dialects, which is what keeps "dialect-neutral" true as the schemas grow.
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

/**
 * Strip `outputSchema` from an outgoing `tools/list` result and `structuredContent` from a tool-call
 * result, mutating the message in place. Other messages are left untouched.
 */
export function stripOutputSchema(message: JSONRPCMessage): void {
  if (!('result' in message) || typeof message.result !== 'object' || message.result === null)
    return;
  const result = message.result as Record<string, unknown>;
  if (Array.isArray(result.tools)) {
    for (const tool of result.tools) {
      if (tool && typeof tool === 'object') {
        delete (tool as Record<string, unknown>).outputSchema;
      }
    }
  }
  if ('structuredContent' in result) {
    delete result.structuredContent;
  }
}

/**
 * Drop the root `$schema` from every tool's `inputSchema` and `outputSchema` in an outgoing
 * `tools/list` result, mutating the message in place (see the module comment for why). Other
 * messages are left untouched.
 */
export function stripSchemaDialect(message: JSONRPCMessage): void {
  if (!('result' in message) || typeof message.result !== 'object' || message.result === null)
    return;
  const tools = (message.result as Record<string, unknown>).tools;
  if (!Array.isArray(tools)) return;
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    for (const key of ['inputSchema', 'outputSchema']) {
      const schema = (tool as Record<string, unknown>)[key];
      if (schema && typeof schema === 'object') delete (schema as Record<string, unknown>).$schema;
    }
  }
}

/**
 * Wrap `transport.send` so outgoing tool schemas/results are shaped for the client. The `$schema`
 * strip applies in every mode, `never` included. Whether `outputSchema`/`structuredContent` are
 * also stripped is decided per message in `auto` mode from the negotiated `clientInfo` (available
 * once the client has initialized, which is always before it requests `tools/list`).
 */
export function installOutputSchemaCompat(
  server: McpServer,
  transport: Transport,
  mode: OutputSchemaMode = outputSchemaMode(),
): void {
  const origSend = transport.send.bind(transport);
  transport.send = (message, options) => {
    stripSchemaDialect(message);
    const strip =
      mode === 'always' ||
      (mode === 'auto' && isIncompatibleClient(server.server.getClientVersion()?.name));
    if (strip) stripOutputSchema(message);
    return origSend(message, options);
  };
}
