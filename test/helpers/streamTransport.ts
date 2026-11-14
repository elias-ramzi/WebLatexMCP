import { PassThrough } from 'node:stream';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/**
 * A client transport speaking newline-delimited JSON-RPC over two streams — what an MCP client
 * does over a server's stdio — so a test drives the stdio proxy in-process: write to `toServer`
 * (the proxy's stdin), read `fromServer` (its stdout). `close()` ends the proxy's stdin, as a
 * client exiting does.
 */
export function streamPair(): {
  toServer: PassThrough;
  fromServer: PassThrough;
  transport: Transport;
} {
  const toServer = new PassThrough();
  const fromServer = new PassThrough();
  const buffer = new ReadBuffer();
  const transport: Transport = {
    async start() {
      fromServer.on('data', (chunk: Buffer) => {
        buffer.append(chunk);
        for (;;) {
          let message: JSONRPCMessage | null;
          try {
            message = buffer.readMessage();
          } catch (err) {
            transport.onerror?.(err as Error);
            continue;
          }
          if (message === null) break;
          transport.onmessage?.(message);
        }
      });
    },
    async send(message) {
      toServer.write(serializeMessage(message));
    },
    async close() {
      toServer.end();
      transport.onclose?.();
    },
  };
  return { toServer, fromServer, transport };
}
