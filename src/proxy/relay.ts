import type { Readable, Writable } from 'node:stream';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  isInitializeRequest,
  isJSONRPCRequest,
  type JSONRPCMessage,
  type RequestId,
} from '@modelcontextprotocol/sdk/types.js';

/**
 * The stdio proxy's relay (docs/design/shared-server.md §9.1): JSON-RPC from the client's stdin to
 * the daemon over Streamable HTTP and back, nothing else — it never reads tool arguments or
 * results. stdout carries only relayed messages; every log line goes to `log` (stderr).
 *
 * Reconnect: when a send fails, or the event stream errors and the daemon no longer answers, the
 * relay asks for a daemon once more (`reconnect`, which restarts it), replays the cached
 * `initialize` under the same session headers — so the session id, and with it the session's
 * shadow and the ownership of its edits, survives — and answers every request still waiting with
 * an error saying the server restarted. A second failure ends the relay.
 */

export interface Endpoint {
  url: string;
  token: string;
}

export interface RelayOptions {
  stdin: Readable;
  stdout: Writable;
  /** Per-connection headers (`sessionRequestHeaders`), sent with every request. */
  headers: Record<string, string>;
  /** The daemon to relay to first. */
  endpoint: Endpoint;
  /** Find or start a daemon after the first one went away. */
  reconnect: () => Promise<Endpoint>;
  /** Whether the current daemon still answers (after an event-stream error). */
  isAlive: () => Promise<boolean>;
  log: (line: string) => void;
  /** Called once with the function that ends the relay (DELETE, then close): wire signals to it. */
  onStop?: (stop: () => void) => void;
}

/** The id the relay's own replayed `initialize` carries; never one a client would pick. */
const REPLAY_ID = 'web-latex-mcp-proxy-replay';

export const RESTARTED_MESSAGE =
  'The shared web-latex-mcp server restarted while this request was running; retry it.';

export class RelayEndedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayEndedError';
  }
}

/** Relay until the client closes stdin (resolves) or the daemon is lost twice (rejects). */
export async function runRelay(opts: RelayOptions): Promise<void> {
  const stdio = new StdioServerTransport(opts.stdin, opts.stdout);
  let initRequest: JSONRPCMessage | undefined;
  /** Whether the daemon answered the client's own `initialize`. */
  let initAnswered = false;
  let initializedNote: JSONRPCMessage | undefined;
  let protocolVersion: string | undefined;
  /**
   * Client requests handed to a daemon and not yet answered, with the transport that carried them.
   * Only these can be lost with a daemon; a request queued behind a restart was never sent and is
   * sent to the new one instead — telling the client to retry it would run it twice.
   */
  const inflight = new Map<RequestId, StreamableHTTPClientTransport>();
  let restarts = 0;
  let restarting: Promise<void> | undefined;
  let ended = false;
  let finish!: () => void;
  let fail!: (err: Error) => void;
  const done = new Promise<void>((res, rej) => {
    finish = res;
    fail = rej;
  });
  let replayAnswered: ((m: JSONRPCMessage) => void) | undefined;

  const answerWithError = (id: RequestId, message: string): void => {
    void stdio.send({ jsonrpc: '2.0', id, error: { code: -32000, message } }).catch(() => {});
  };

  const makeHttp = (endpoint: Endpoint): StreamableHTTPClientTransport => {
    const t = new StreamableHTTPClientTransport(new URL(endpoint.url), {
      requestInit: { headers: { ...opts.headers, authorization: `Bearer ${endpoint.token}` } },
    });
    t.onmessage = (message) => {
      if (t !== http) return; // a transport being replaced
      if ('id' in message && !('method' in message)) {
        if (message.id === REPLAY_ID) {
          replayAnswered?.(message);
          return; // the client never asked for this one
        }
        if (initRequest && 'id' in initRequest && message.id === initRequest.id) {
          initAnswered = true;
          const v = (message as { result?: { protocolVersion?: unknown } }).result?.protocolVersion;
          if (typeof v === 'string') {
            protocolVersion = v;
            t.setProtocolVersion(v);
          }
        }
        if (message.id !== null && message.id !== undefined) inflight.delete(message.id);
      }
      void stdio.send(message).catch(() => {});
    };
    t.onerror = (err) => {
      if (t !== http || ended) return;
      opts.log(`relay: ${err.message}`);
      // An event stream that broke may mean the daemon is gone; it is only restarted if so.
      void opts.isAlive().then((alive) => (alive ? undefined : restart()));
    };
    return t;
  };

  let http = makeHttp(opts.endpoint);
  await http.start();

  const restart = (): Promise<void> => {
    restarting ??= (async () => {
      if (ended) return;
      if (restarts >= 1) {
        end(new RelayEndedError('the shared server was lost again after a restart; giving up'));
        return;
      }
      restarts++;
      opts.log('relay: the shared server went away; restarting it');
      const old = http;
      const initId = initRequest && 'id' in initRequest ? initRequest.id : undefined;
      try {
        const endpoint = await opts.reconnect();
        http = makeHttp(endpoint);
        await old.close().catch(() => {});
        await http.start();
        if (initRequest && !initAnswered) {
          // The client's own initialize was lost: send it again, as itself, so its answer reaches
          // the client — a client does not retry an initialize.
          inflight.set(initId as RequestId, http);
          await http.send(initRequest);
        } else if (initRequest) {
          const answered = new Promise<JSONRPCMessage>((r) => (replayAnswered = r));
          await http.send({ ...(initRequest as object), id: REPLAY_ID } as JSONRPCMessage);
          let timer: NodeJS.Timeout | undefined;
          const answer = await Promise.race([
            answered,
            new Promise<undefined>((r) => (timer = setTimeout(() => r(undefined), 15_000))),
          ]);
          clearTimeout(timer);
          replayAnswered = undefined;
          if (!answer || 'error' in answer) {
            throw new Error('the restarted server refused the session');
          }
          if (protocolVersion) http.setProtocolVersion(protocolVersion);
          if (initializedNote) await http.send(initializedNote);
        }
      } catch (err) {
        end(new RelayEndedError(`could not restart the shared server: ${(err as Error).message}`));
        return;
      } finally {
        restarting = undefined;
      }
      // What the lost server was running will not be answered: say so, so the client can retry.
      for (const [id, carrier] of [...inflight]) {
        if (carrier !== old) continue;
        inflight.delete(id);
        answerWithError(id, RESTARTED_MESSAGE);
      }
      opts.log('relay: reconnected; the session id is unchanged');
    })();
    return restarting;
  };

  const end = (err?: Error): void => {
    if (ended) return;
    ended = true;
    if (err) opts.log(`relay: ${err.message}`);
    void (async () => {
      // Always end the session on the daemon, so its scope closes now rather than when idle.
      await http.terminateSession().catch(() => {});
      await http.close().catch(() => {});
      await stdio.close().catch(() => {});
      if (err) fail(err);
      else finish();
    })();
  };

  stdio.onmessage = (message) => {
    if (ended) return;
    if (isInitializeRequest(message)) initRequest = message;
    else if ('method' in message && message.method === 'notifications/initialized') {
      initializedNote = message;
    }
    const send = async (): Promise<void> => {
      if (restarting) await restarting;
      if (ended) return;
      const carrier = http;
      if (isJSONRPCRequest(message)) inflight.set(message.id, carrier);
      try {
        await carrier.send(message);
      } catch (err) {
        if (ended) return;
        const reason = (err as Error).message;
        opts.log(`relay: send failed: ${reason}`);
        if (await opts.isAlive()) {
          // The daemon answers: it refused this message (a body over its cap, say). Pass that
          // on; the session is fine and must not be re-opened under another id.
          if (isJSONRPCRequest(message) && inflight.get(message.id) === carrier) {
            inflight.delete(message.id);
            answerWithError(message.id, `The shared server refused this request: ${reason}`);
          }
          return;
        }
        // Gone: `restart` answers this request with the others the lost server held.
        await restart();
      }
    };
    void send();
  };
  stdio.onclose = () => end();
  // The SDK's stdio transport never notices its input ending: the client closing stdin (or
  // exiting) is the proxy's cue to end the session on the daemon.
  opts.stdin.once('end', () => end());
  opts.stdin.once('close', () => end());
  // A proxy killed by a signal ends its session too (the caller wires the signals).
  opts.onStop?.(() => end());
  stdio.onerror = (err) => opts.log(`relay: stdin: ${err.message}`);
  await stdio.start();
  return done;
}
