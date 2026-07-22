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
 * Wrap `transport.send` so outgoing tool schemas/results are stripped when appropriate. In `auto`
 * mode the decision is made per message from the negotiated `clientInfo` (available once the client
 * has initialized, which is always before it requests `tools/list`). `never` installs nothing.
 */
export function installOutputSchemaCompat(
  server: McpServer,
  transport: Transport,
  mode: OutputSchemaMode = outputSchemaMode(),
): void {
  if (mode === 'never') return;
  const origSend = transport.send.bind(transport);
  transport.send = (message, options) => {
    const strip = mode === 'always' || isIncompatibleClient(server.server.getClientVersion()?.name);
    if (strip) stripOutputSchema(message);
    return origSend(message, options);
  };
}
