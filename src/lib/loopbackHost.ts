/**
 * Which requests a loopback listener answers (docs/design/shared-server.md §10). A listener on
 * `127.0.0.1` is reachable by every web page through DNS rebinding: the page's own name resolves to
 * `127.0.0.1`, and the request then carries that name in `Host`. Naming the listener exactly in
 * `Host` refuses it.
 *
 * The daemon (`src/daemon/requestGuard.ts`) also refuses any `Origin`, since MCP clients send none.
 * The credential portal is a page people open in a browser, so its own requests carry an
 * `Origin`: {@link browserRequestRefusal} accepts one only when it is the listener itself,
 * and only judges it on requests that change something (a cross-site form POST is sent without
 * rebinding, so the `Host` check alone would let it through).
 *
 * Pure, so every refusal is unit-tested without a socket.
 */

/** The `Host` values a listener bound to `bindHost`:`port` answers to. */
export function allowedHosts(port: number, bindHost = '127.0.0.1'): string[] {
  const names = [...new Set([bindHost.toLowerCase(), '127.0.0.1', 'localhost'])];
  const hosts = names.map((n) => `${n}:${port}`);
  // A client omits the default port from `Host` (RFC 9110 §7.2).
  if (port === 80) hosts.push(...names);
  return hosts;
}

export function hostAllowed(host: string | undefined, port: number, bindHost?: string): boolean {
  return host !== undefined && allowedHosts(port, bindHost).includes(host.toLowerCase());
}

export interface BrowserRequest {
  method: string | undefined;
  host: string | undefined;
  origin: string | undefined;
}

export interface LoopbackRefusal {
  status: 403 | 421;
  message: string;
}

/** Methods that only read: a cross-site page can send them, but cannot read the answer. */
const SAFE_METHODS = new Set(['GET', 'HEAD']);

/**
 * `null` when a browser-facing loopback listener may answer; otherwise the status and a message.
 * `Host` must name the listener; on a request that is not GET/HEAD, an `Origin` must be
 * `http://<a name the listener answers to>` (none at all is a non-browser client, accepted).
 */
export function browserRequestRefusal(
  req: BrowserRequest,
  listener: { port: number; bindHost?: string },
): LoopbackRefusal | null {
  if (!hostAllowed(req.host, listener.port, listener.bindHost)) {
    return { status: 421, message: 'Unexpected Host header; this listener is loopback only.' };
  }
  const method = (req.method ?? 'GET').toUpperCase();
  if (req.origin !== undefined && !SAFE_METHODS.has(method)) {
    const origins = allowedHosts(listener.port, listener.bindHost).map((h) => `http://${h}`);
    if (!origins.includes(req.origin.toLowerCase())) {
      return { status: 403, message: 'Requests from another site are refused.' };
    }
  }
  return null;
}
