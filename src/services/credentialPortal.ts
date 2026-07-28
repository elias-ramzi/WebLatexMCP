import http from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { OVERLEAF_TOKEN_URL } from './auth.js';

/**
 * A one-shot loopback web page for entering a git token **without it passing through the chat**.
 *
 * `set_credential` works, but it needs the user to paste the secret to Claude — and with a
 * cloud-synced transcript, some users would rather the token never appear there at all. This portal
 * closes that gap: the tool hands back a `http://127.0.0.1:<port>/<nonce>` URL, the user types the
 * token into a local form, and it is POSTed **straight to this process** and stored in the OS
 * keychain (via the injected `store`, i.e. `git credential approve`). The token reaches only the
 * local server and the keychain — never the model, the tool result, or the conversation.
 *
 * Bound to loopback only, behind an unguessable path nonce (so another local process can't blind-POST
 * to it), and one-shot: it stops right after a submission, and auto-closes after a timeout if the
 * user never gets to it. The outcome (did a helper keep the token?) is recorded so the tool can
 * report it on a follow-up call — the token itself is never retained.
 */

/** Stores a credential (host, username, token) and reports whether a helper kept it. */
export type CredentialStoreFn = (
  host: string,
  username: string,
  token: string,
) => Promise<{ persisted: boolean }>;

export interface PortalTarget {
  host: string;
  username: string;
}

export interface PortalOutcome {
  host: string;
  username: string;
  persisted: boolean;
}

/** Cap on the form POST body — a token is tiny; anything larger is a bad client. */
const MAX_BODY_BYTES = 64 * 1024;
/** Auto-close the portal if the user never submits, so no listener leaks. */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

function readBody(req: http.IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on('data', (c: Buffer) => {
      if (aborted) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!aborted) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', () => resolve(null));
  });
}

export class CredentialPortal {
  private server?: http.Server;
  private baseUrl?: string;
  private nonce?: string;
  private target?: PortalTarget;
  private lastOutcome?: PortalOutcome;
  private timer?: NodeJS.Timeout;

  constructor(private readonly store: CredentialStoreFn) {}

  isRunning(): boolean {
    return this.baseUrl !== undefined;
  }

  /**
   * Consume the outcome of a submission for `host`, if one has landed since the portal opened.
   * Read-once: returns it and clears it, so a stale outcome can't be reported for a later attempt.
   */
  takeOutcome(host: string): PortalOutcome | undefined {
    if (this.lastOutcome?.host === host) {
      const out = this.lastOutcome;
      this.lastOutcome = undefined;
      return out;
    }
    return undefined;
  }

  /**
   * Open (or re-point) the portal for a target and return the form URL, or undefined if no loopback
   * port could be bound. Idempotent: a second call reuses the listener and just updates the target.
   */
  async open(
    target: PortalTarget,
    port = 0,
    host = '127.0.0.1',
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<string | undefined> {
    this.target = target;
    this.lastOutcome = undefined;
    this.armTimeout(timeoutMs);
    if (this.baseUrl) return this.formUrl();

    this.nonce = randomBytes(16).toString('hex');
    const server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    return new Promise((resolve) => {
      const onError = (err: NodeJS.ErrnoException): void => {
        server.removeListener('error', onError);
        console.error(`[web-latex-mcp] credential portal could not start: ${err.message}`);
        resolve(undefined);
      };
      server.once('error', onError);
      server.listen(port, host, () => {
        server.removeListener('error', onError);
        const addr = server.address() as AddressInfo;
        this.server = server;
        this.baseUrl = `http://${host}:${addr.port}`;
        resolve(this.formUrl());
      });
    });
  }

  async close(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const server = this.server;
    if (server) {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    }
    this.server = undefined;
    this.baseUrl = undefined;
    this.nonce = undefined;
    this.target = undefined;
  }

  private armTimeout(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.close(), ms);
    this.timer.unref?.();
  }

  private formUrl(): string {
    return `${this.baseUrl}/${this.nonce}`;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname.replace(/^\/+/, '');
      // Everything is gated behind the nonce path; a process that doesn't know it gets nothing.
      if (!this.nonce || path !== this.nonce || !this.target) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found.\n');
        return;
      }
      if (req.method === 'GET') {
        this.sendHtml(res, 200, this.formHtml(this.target));
        return;
      }
      if (req.method === 'POST') {
        await this.submit(req, res, this.target);
        return;
      }
      res.writeHead(405, { Allow: 'GET, POST' }).end();
    } catch (err) {
      res
        .writeHead(500, { 'Content-Type': 'text/plain' })
        .end(`portal error: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  private async submit(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    target: PortalTarget,
  ): Promise<void> {
    const raw = await readBody(req);
    const token = raw ? new URLSearchParams(raw).get('token')?.trim() : undefined;
    if (!token) {
      this.sendHtml(
        res,
        400,
        this.resultHtml('No token was entered. Go back and try again.', false),
      );
      return;
    }
    let persisted: boolean;
    try {
      ({ persisted } = await this.store(target.host, target.username, token));
    } catch {
      persisted = false;
    }
    this.lastOutcome = { host: target.host, username: target.username, persisted };
    const msg = persisted
      ? `Stored the credential for ${target.username}@${target.host} in your OS keychain. You can close this tab.`
      : `Sent the credential to git, but no credential helper kept it. Configure one (e.g. libsecret on Linux) or use an env var. You can close this tab.`;
    this.sendHtml(res, 200, this.resultHtml(msg, persisted));
    // One-shot: nothing more to accept. Close after the response flushes.
    setTimeout(() => void this.close(), 250).unref?.();
  }

  private sendHtml(res: http.ServerResponse, status: number, html: string): void {
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(html);
  }

  private formHtml(target: PortalTarget): string {
    const host = escapeHtml(target.host);
    const username = escapeHtml(target.username);
    const action = `/${this.nonce}`;
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Store a git credential — web-latex-mcp</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, -apple-system, sans-serif; max-width: 30em; margin: 3em auto;
    padding: 0 1.2em; }
  h1 { font-size: 1.25rem; }
  .meta { background: rgba(127,127,127,.12); border-radius: 8px; padding: .7em 1em; margin: 1em 0; }
  .meta code { font: 13px ui-monospace, SFMono-Regular, monospace; }
  label { display: block; font-weight: 600; margin: 1.2em 0 .4em; }
  input[type=password] { width: 100%; box-sizing: border-box; padding: .6em .7em; font-size: 1rem;
    border: 1px solid rgba(127,127,127,.5); border-radius: 6px; background: transparent; color: inherit; }
  button { margin-top: 1.2em; padding: .6em 1.4em; font-size: 1rem; border: 0; border-radius: 6px;
    background: #2d4a7a; color: #fff; cursor: pointer; }
  button:hover { background: #345489; }
  .note { color: #888; font-size: .85rem; margin-top: 1.6em; }
  .note a { color: inherit; }
</style></head>
<body>
<h1>Store your git credential</h1>
<p>Enter the token for this host. It is sent only to the local web-latex-mcp server on your machine
and stored in your OS keychain — it never goes through Claude or the chat.</p>
<div class="meta">Host: <code>${host}</code><br>Username: <code>${username}</code></div>
<form method="POST" action="${action}" autocomplete="off">
  <label for="token">Token / password</label>
  <input id="token" name="token" type="password" autocomplete="off" autofocus
    placeholder="e.g. your Overleaf Git authentication token">
  <button type="submit">Store in keychain</button>
</form>
<p class="note">Overleaf: create one under Account Settings → Git integration →
<a href="${OVERLEAF_TOKEN_URL}" target="_blank" rel="noopener noreferrer">Git authentication token</a>.
GitHub: a Personal Access Token with <code>repo</code> scope.</p>
</body></html>`;
  }

  private resultHtml(message: string, ok: boolean): string {
    const icon = ok ? '✅' : '⚠️';
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>web-latex-mcp</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, -apple-system, sans-serif; max-width: 30em; margin: 4em auto;
    padding: 0 1.2em; }
</style></head>
<body><p style="font-size:1.1rem">${icon} ${escapeHtml(message)}</p></body></html>`;
  }
}
