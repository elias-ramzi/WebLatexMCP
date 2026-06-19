import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { redact } from './redact.js';

/** Build an MCP error result with the message scrubbed of any known secrets. */
export function errorResult(err: unknown, secrets: string[] = []): CallToolResult {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: 'text', text: redact(msg, secrets) }],
    isError: true,
  };
}
