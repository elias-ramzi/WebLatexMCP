import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Who may talk to the daemon (docs/design/shared-server.md §10). Stdio needed none of this: only
 * the parent process could reach the server. A loopback listener is reachable by every local
 * process and, through DNS rebinding, by web pages, so every request — `/health` included — must:
 *
 * - carry `Authorization: Bearer <token>`, the token in `daemon.json` (`0600`), compared in
 *   constant time;
 * - name the listener in `Host` exactly: `127.0.0.1:<port>` or `localhost:<port>` (a rebinding
 *   page's `Host` is its own name; the right name on the wrong port is someone else's listener);
 * - carry no `Origin` header at all: MCP clients send none, and browsers always do.
 *
 * Pure, so every refusal is unit-tested without a socket.
 */

export interface GuardedRequest {
  host: string | undefined;
  origin: string | undefined;
  authorization: string | undefined;
}

export interface GuardRefusal {
  status: 401 | 403 | 421;
  message: string;
}

/** The `Host` values the daemon answers to on `port`. */
export function allowedHosts(port: number): string[] {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  // A client omits the default port from `Host` (RFC 9110 §7.2).
  if (port === 80) hosts.push('127.0.0.1', 'localhost');
  return hosts;
}

/** Constant-time equality of two strings, whatever their lengths. */
export function sameSecret(given: string, expected: string): boolean {
  // Hashing first gives equal-length inputs, so the comparison leaks neither content nor length.
  const a = createHash('sha256').update(given, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/** `null` when the request may proceed; otherwise the status and a message that names no secret. */
export function guardRequest(
  req: GuardedRequest,
  expected: { port: number; token: string },
): GuardRefusal | null {
  if (req.origin !== undefined) {
    return { status: 403, message: 'Requests from a browser (with an Origin header) are refused.' };
  }
  const host = req.host?.toLowerCase();
  if (host === undefined || !allowedHosts(expected.port).includes(host)) {
    return { status: 421, message: 'Unexpected Host header; this listener is loopback only.' };
  }
  const match = /^Bearer ([^\s]+)$/.exec(req.authorization ?? '');
  if (!match?.[1] || !sameSecret(match[1], expected.token)) {
    return { status: 401, message: 'Missing or wrong bearer token.' };
  }
  return null;
}
