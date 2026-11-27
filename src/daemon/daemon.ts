import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  NodeStreamableHTTPServerTransport as StreamableHTTPServerTransport,
  toNodeHandler,
} from '@modelcontextprotocol/node';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  PROTOCOL_VERSION_META_KEY,
  createMcpHandler,
  isInitializeRequest,
} from '@modelcontextprotocol/server';
import { createServer } from '../server.js';
import {
  createSessionContext,
  createSharedServices,
  type SessionScope,
  type SharedServices,
} from '../context.js';
import { processNonce, withFileLock, LockTimeoutError } from '../lib/fileLock.js';
import { isScopeOpen } from '../lib/openScopes.js';
import {
  clientNameIn,
  stripsOutputSchema,
  type OutputSchemaMode,
} from '../lib/outputSchemaCompat.js';
import { loadSessionGuides } from '../lib/sessionGuides.js';
import { quoteId } from '../lib/projectId.js';
import { getServerVersion } from '../lib/version.js';
import { currentBuildId } from '../lib/buildId.js';
import type { CredentialResolver, CommitIdentity } from '../services/auth.js';
import type { ProjectRegistryStore } from '../services/projectManager.js';
import type { ServerConfig } from '../types.js';
import { guardRequest } from './requestGuard.js';
import {
  daemonLockPath,
  ensureDaemonDir,
  readDaemonInfo,
  removeDaemonInfo,
  writeDaemonInfo,
  type DaemonInfo,
} from './daemonFiles.js';
import {
  HEADER_CONNECTION,
  HEADER_SESSION,
  SessionHeaderError,
  connectionIdOf,
  parseSessionHeaders,
  uniqueSessionId,
} from './sessionHeaders.js';

/**
 * `web-latex-mcp serve`: one MCP server over Streamable HTTP for every session on a workspace
 * (docs/design/shared-server.md §4, milestone 4). One set of shared services; one `SessionScope`,
 * `McpServer` and transport per MCP session — the same `createServer` stdio runs.
 *
 * Lifecycle, in order:
 * 1. take `<workspace>/.daemon/daemon.lock` (refused when another daemon holds it), held until stop;
 * 2. listen on `127.0.0.1`, then write `daemon.json` (`0600`) with the port and a fresh token;
 * 3. serve; a session closes on `DELETE`, transport close, or `sessionIdleMs` without a request
 *    and without an open stream (§5.3), first draining its calls still running;
 * 4. stop on `/shutdown`, a signal, or — unless `keepAlive` — `idleExitMs` with no open session:
 *    close every session, delete `daemon.json` if it is still ours, release the lock.
 */

export const DEFAULT_SESSION_IDLE_MS = 30 * 60 * 1000;
export const DEFAULT_IDLE_EXIT_MS = 30 * 60 * 1000;
export const DEFAULT_MAX_SESSIONS = 64;
/**
 * How long a session whose client held an event stream open survives losing all of them. The
 * SDK's client transport re-opens a dropped stream within seconds (1 s, then backoff), so a minute
 * without one means the client is gone.
 */
export const DEFAULT_STREAM_LOSS_MS = 60 * 1000;
/**
 * How often a hold (`GET /hold`) gets a keep-alive byte. Node's `fetch` (undici) drops a response
 * body that stays silent for 5 minutes (`bodyTimeout`): a silent hold ended there, and the
 * connection's 2026 session closed a minute later. The SDK's own event streams send a comment
 * every 15 s for the same reason.
 */
export const DEFAULT_HOLD_KEEP_ALIVE_MS = 15_000;
export const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;
/** How long a closing session waits for its running calls (a compile) before closing anyway. */
export const DEFAULT_DRAIN_MS = 10 * 60 * 1000;
/** How long a stopping daemon gives each session's running writes. */
export const STOP_DRAIN_MS = 10_000;
/**
 * How long `serve` waits for the daemon lock when no daemon answers on `daemon.json`. Long enough
 * for `withFileLock` to reclaim a crashed daemon's lock whose pid was reused (two stale sightings
 * `STALE_CONFIRM_MS` apart, or `OWN_PID_STALE_MS`, `src/lib/fileLock.ts`) — a pid-1 container
 * restart is the usual case. A live daemon is detected at once by its `/health` instead.
 */
const LOCK_WAIT_MS = 30_000;

export interface DaemonOptions {
  config: ServerConfig;
  env: NodeJS.ProcessEnv;
  credentials: CredentialResolver;
  identity: CommitIdentity;
  registry?: ProjectRegistryStore;
  /** `0` (default) picks a free port; `WEB_LATEX_MCP_PORT` fixes it. */
  port?: number;
  /** Never exit for idleness (`serve --keep-alive`, for launchd/systemd units). */
  keepAlive?: boolean;
  sessionIdleMs?: number;
  streamLossMs?: number;
  holdKeepAliveMs?: number;
  idleExitMs?: number;
  drainMs?: number;
  maxSessions?: number;
  maxBodyBytes?: number;
  /** The entry script, recorded in `daemon.json` (§9.2). */
  buildPath?: string;
  /** Logging sink; stderr by default. Never stdout. */
  log?: (line: string) => void;
}

export interface RunningDaemon {
  port: number;
  /** The bearer token; a test or the proxy reads it from `daemon.json` in practice. */
  token: string;
  url: string;
  info: DaemonInfo;
  /** Open MCP sessions, by session id (the scope's, not the transport's). */
  sessionIds: () => string[];
  /**
   * Stop serving (idempotent): resolves once every session is closed and `daemon.json` is gone;
   * the lock file is removed just after (await `stopped` for that).
   */
  stop: (reason: string) => Promise<void>;
  /** Settles when the daemon has stopped, for whatever reason. */
  stopped: Promise<void>;
}

/**
 * One MCP session: one `SessionScope`, served either in the 2025 era (one `McpServer` over one
 * sessionful transport, keyed by `Mcp-Session-Id`) or in the 2026-07-28 era (`modern`: a handler
 * that builds a server per request, keyed by the proxy's connection id, since that revision has no
 * protocol session at all).
 */
interface Session {
  sessionId: string;
  scope: SessionScope;
  /** 2025 era: the session's server and its transport. */
  server?: McpServer;
  transport?: StreamableHTTPServerTransport;
  /** 2026-07-28: what serves the connection's requests (`openModern`). */
  modern?: ModernServing;
  /**
   * Open streams: a 2025 session's GET (SSE) streams, or a 2026 connection's holds (`GET /hold`,
   * the proxy's stand-in for that GET stream). A session with one is never idle.
   */
  openStreams: number;
  /** Whether the client ever held a stream open: one that drops all of them has likely gone. */
  hadStream: boolean;
  /** 2026-07-28 requests still being answered (a 2025 session's are its transport's business). */
  inflight: number;
  idleTimer?: NodeJS.Timeout;
  closing?: Promise<void>;
}

/** How a 2026-07-28 connection is served: one handler per output shape, built on first use. */
interface ModernServing {
  connection: string;
  outputSchema: OutputSchemaMode;
  serve: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: unknown,
    stripOutputSchema: boolean,
  ) => Promise<void>;
  close: () => Promise<void>;
}

/**
 * Whether a parsed POST body is a 2026-07-28 message: its `_meta` envelope claims a protocol
 * revision of that era. A 2025 client never sends the claim (the `io.modelcontextprotocol/` prefix
 * is reserved in 2025-11-25 too), so everything else is 2025 traffic, as `isLegacyRequest` decides.
 */
export function isModernMessage(body: unknown): boolean {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return false;
  const params = (body as { params?: unknown }).params;
  if (params === null || typeof params !== 'object') return false;
  const meta = (params as { _meta?: unknown })._meta;
  if (meta === null || typeof meta !== 'object') return false;
  const claim = (meta as Record<string, unknown>)[PROTOCOL_VERSION_META_KEY];
  return typeof claim === 'string' && claim >= MODERN_ERA_FIRST_REVISION;
}

/** Whether a parsed POST body is a `server/discover` request (the 2026 era probe). */
export function isDiscoverRequest(body: unknown): boolean {
  return (
    body !== null &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    (body as { method?: unknown }).method === 'server/discover'
  );
}

/** The first protocol revision of the per-request era: revisions are ISO dates, so they sort. */
const MODERN_ERA_FIRST_REVISION = '2026-07-28';

export class DaemonAlreadyRunningError extends Error {
  constructor(workspaceRoot: string, holder: string) {
    super(`Another web-latex-mcp daemon already serves ${quoteId(workspaceRoot)} (${holder}).`);
    this.name = 'DaemonAlreadyRunningError';
  }
}

export async function startDaemon(opts: DaemonOptions): Promise<RunningDaemon> {
  const log = opts.log ?? ((line: string) => process.stderr.write(`[web-latex-mcp] ${line}\n`));
  const { config } = opts;
  const workspace = config.workspaceRoot;
  await ensureDaemonDir(workspace);
  // A live daemon answers its own /health: refuse at once rather than wait out the lock.
  const running = await answeringDaemon(workspace);
  if (running) {
    throw new DaemonAlreadyRunningError(workspace, `pid ${running.pid}, port ${running.port}`);
  }

  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  let started!: (d: RunningDaemon) => void;
  let failed!: (err: unknown) => void;
  const ready = new Promise<RunningDaemon>((res, rej) => {
    started = res;
    failed = rej;
  });

  const stopped = withFileLock(
    daemonLockPath(workspace),
    async () => {
      let daemon: RunningDaemon;
      try {
        daemon = await serve(opts, log, release);
      } catch (err) {
        failed(err);
        return;
      }
      started(daemon);
      await released;
    },
    { timeoutMs: LOCK_WAIT_MS, owner: `daemon pid ${process.pid}` },
  ).catch((err: unknown) => {
    failed(
      err instanceof LockTimeoutError
        ? new DaemonAlreadyRunningError(
            workspace,
            `its lock ${quoteId(daemonLockPath(workspace))} is held; if no daemon runs, delete ` +
              'that file and retry',
          )
        : err,
    );
  });
  const daemon = await ready;
  return { ...daemon, stopped: stopped.then(() => undefined) };
}

async function serve(
  opts: DaemonOptions,
  log: (line: string) => void,
  releaseLock: () => void,
): Promise<RunningDaemon> {
  const { config, env } = opts;
  const sessionIdleMs = opts.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS;
  const streamLossMs = opts.streamLossMs ?? DEFAULT_STREAM_LOSS_MS;
  const holdKeepAliveMs = opts.holdKeepAliveMs ?? DEFAULT_HOLD_KEEP_ALIVE_MS;
  const idleExitMs = opts.idleExitMs ?? DEFAULT_IDLE_EXIT_MS;
  const drainMs = opts.drainMs ?? DEFAULT_DRAIN_MS;
  const maxSessions = opts.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const token = randomBytes(32).toString('base64url');
  const shared: SharedServices = createSharedServices(
    { ...config, serverMode: 'daemon' },
    opts.credentials,
    opts.identity,
    opts.registry,
  );

  /** 2025-era sessions, by transport session id (the `Mcp-Session-Id` header). */
  const sessions = new Map<string, Session>();
  /** 2026-07-28 sessions, by the proxy's connection id (`HEADER_CONNECTION`). */
  const connections = new Map<string, Session>();
  /** 2026 sessions being opened, so two first requests of one connection open one session. */
  const connecting = new Map<string, Promise<Session | undefined>>();
  /** Holds (`GET /hold`) open per connection, counted before its session exists too. */
  const holds = new Map<string, number>();
  /**
   * The session id each 2026 connection was given, kept until the proxy ends it (`DELETE`): a
   * session closed for idleness reopens under the same id, so its shadow and the ownership of its
   * edits survive, as a 2025 session's do across a daemon restart.
   */
  const connectionSessionIds = new Map<string, string>();
  const openSessions = (): Session[] => [
    ...new Set([...sessions.values(), ...connections.values()]),
  ];
  /** Session ids (case-folded) handed out to an `initialize` still being set up. */
  const reserved = new Set<string>();
  /** Initializes still being set up, which `stop` waits for before closing every session. */
  const opening = new Set<Promise<void>>();
  let stopping: Promise<void> | undefined;
  let idleExitTimer: NodeJS.Timeout | undefined;
  /** A newer build's proxy asked this daemon to make way once nobody uses it (§9.2). */
  let replaceRequested = false;
  const buildPath = opts.buildPath ?? process.argv[1] ?? '';
  const buildId = currentBuildId(buildPath);
  /**
   * Resolves `STOP_DRAIN_MS` after `stop` begins: no session's drain outlasts it, including one
   * whose close (a DELETE) began before the stop with the longer `drainMs` cap.
   */
  let passStopDeadline!: () => void;
  const stopDeadline = new Promise<void>((r) => (passStopDeadline = r));

  // Folded: on a case-insensitive disk `Alice` and `alice` are one session directory and one
  // shadow, so a second session asking for either while the other is open gets a suffix.
  const fold = (id: string): string => id.toLowerCase();
  const idTaken = (id: string): boolean =>
    reserved.has(fold(id)) ||
    openSessions().some((s) => fold(s.sessionId) === fold(id)) ||
    isScopeOpen(config.workspaceRoot, id);

  const scheduleIdleExit = (): void => {
    clearTimeout(idleExitTimer);
    idleExitTimer = undefined;
    if (stopping || openSessions().length > 0 || reserved.size > 0) return;
    if (replaceRequested && !opts.keepAlive) {
      void stop('a newer build asked to replace this one');
      return;
    }
    if (opts.keepAlive) return;
    idleExitTimer = setTimeout(() => void stop('idle: no open session'), idleExitMs);
    idleExitTimer.unref?.();
  };

  const armIdle = (s: Session): void => {
    clearTimeout(s.idleTimer);
    // A client that kept an event stream open and lost every one has likely gone (a proxy killed
    // without a DELETE): a short grace, enough for its transport to reconnect, rather than the
    // whole idle timeout during which the session would read live and hold its id.
    const wait =
      s.hadStream && s.openStreams === 0 ? Math.min(streamLossMs, sessionIdleMs) : sessionIdleMs;
    s.idleTimer = setTimeout(() => {
      if (s.openStreams > 0 || s.inflight > 0 || s.scope.ctx.projectManager.isBusy()) armIdle(s);
      else void closeSession(s, 'idle');
    }, wait);
    s.idleTimer.unref?.();
  };

  const closeSession = (s: Session, reason: string): Promise<void> => {
    const drainCapMs = drainMs;
    s.closing ??= (async () => {
      clearTimeout(s.idleTimer);
      // Refuse new requests first (the map is what routes them), then let running calls finish
      // so their writes land while the scope is still open — a write after close would re-create
      // a record peers in this process read dead (§5.3).
      for (const [key, value] of sessions) if (value === s) sessions.delete(key);
      for (const [key, value] of connections) if (value === s) connections.delete(key);
      // Every write runs inside `runExclusive`, which keeps running when the client cancels or
      // the transport aborts the call; so wait for those, not for responses.
      let capTimer: NodeJS.Timeout | undefined;
      await Promise.race([
        s.scope.ctx.projectManager.whenIdle(),
        new Promise<void>((r) => (capTimer = setTimeout(r, drainCapMs))),
        stopDeadline,
      ]);
      clearTimeout(capTimer);
      await s.scope.close();
      await s.server?.close().catch(() => {});
      await s.modern?.close().catch(() => {});
      log(`session ${quoteId(s.sessionId)} closed (${reason})`);
      scheduleIdleExit();
    })();
    return s.closing;
  };

  const httpServer = http.createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log(`request failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal error' });
      else res.end();
    });
  });

  let port = 0;

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const refusal = guardRequest(
      {
        host: req.headers.host,
        origin: req.headers.origin,
        authorization: req.headers.authorization,
      },
      { port, token },
    );
    if (refusal) return sendJson(res, refusal.status, { error: refusal.message });

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/health' && req.method === 'GET') {
      // A stopping daemon is not one to connect to: say so, so a proxy starts another.
      if (stopping) return sendJson(res, 503, { error: 'Stopping', processNonce });
      return sendJson(res, 200, {
        version: getServerVersion(),
        processNonce,
        pid: process.pid,
        buildId,
        sessions: openSessions().length,
        keepAlive: opts.keepAlive === true,
        replaceRequested,
      });
    }
    if (url.pathname === '/shutdown' && req.method === 'POST') {
      // A proxy stops an older daemon only when nobody uses it (§9.2); `?force=1` is the shell's.
      if (openSessions().length + reserved.size > 0 && url.searchParams.get('force') !== '1') {
        return sendJson(res, 409, { error: 'Sessions are open', sessions: openSessions().length });
      }
      sendJson(res, 200, { stopping: true });
      void stop('shutdown requested');
      return;
    }
    if (url.pathname === '/hold' && req.method === 'GET') return holdConnection(req, res);
    if (url.pathname !== '/mcp') return sendJson(res, 404, { error: 'Not found' });
    if (stopping) return sendRpcError(res, 503, 'The server is shutting down.');

    let body: unknown;
    if (req.method === 'POST') {
      const read = await readBody(req, maxBodyBytes);
      if (read === 'too-large') {
        return sendRpcError(res, 413, `Request body over ${maxBodyBytes} bytes.`);
      }
      try {
        body = JSON.parse(read);
      } catch {
        return sendRpcError(res, 400, 'Parse error: the body is not JSON.', -32700);
      }
    }

    const transportId = req.headers['mcp-session-id'];
    if (typeof transportId === 'string') {
      const s = sessions.get(transportId);
      if (!s) return sendRpcError(res, 404, 'Session not found.', -32001);
      armIdle(s);
      if (req.method === 'GET') {
        s.openStreams++;
        s.hadStream = true;
        res.on('close', () => {
          s.openStreams--;
          armIdle(s);
        });
      }
      return s.transport!.handleRequest(req, res, body);
    }
    // Protocol revision 2026-07-28: no session id at all, the era claimed in each message's own
    // `_meta` envelope, the session named by the proxy's connection id (#288).
    if (req.method === 'POST' && isModernMessage(body)) return serveModern(req, res, body);
    if (req.method === 'DELETE') return endConnection(req, res);
    if (req.method !== 'POST' || !isInitializeRequest(body)) {
      return sendRpcError(res, 400, 'Bad request: no valid session id, and not an initialize.');
    }
    await openSession(req, res, body);
  };

  /** The connection id a request names; answers the request itself (and is `null`) when bad. */
  const connectionOf = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): string | undefined | null => {
    try {
      return connectionIdOf(req.headersDistinct);
    } catch (err) {
      if (!(err instanceof SessionHeaderError)) throw err;
      sendRpcError(res, 400, err.message);
      return null;
    }
  };

  /**
   * `GET /hold`: the proxy holds this open for as long as it runs, naming its connection — the
   * 2026 stand-in for the 2025 GET stream, which that revision dropped. A connection's 2026
   * session is never idle while a hold is open, and closes `streamLossMs` after its last one goes
   * (a proxy killed without a `DELETE`). Only a newline is ever written to it, every
   * `holdKeepAliveMs` (`DEFAULT_HOLD_KEEP_ALIVE_MS`: `fetch` drops a body silent for 5 minutes).
   */
  const holdConnection = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const connection = connectionOf(req, res);
    if (connection === null) return;
    if (connection === undefined) {
      return sendRpcError(res, 400, `A hold names its connection (${HEADER_CONNECTION}).`);
    }
    if (stopping) return sendRpcError(res, 503, 'The server is shutting down.');
    holds.set(connection, (holds.get(connection) ?? 0) + 1);
    const s = connections.get(connection);
    if (s) {
      s.openStreams++;
      s.hadStream = true;
      armIdle(s);
    }
    res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
    res.flushHeaders();
    const keepAlive = setInterval(() => res.write('\n'), holdKeepAliveMs);
    keepAlive.unref?.();
    res.on('close', () => {
      clearInterval(keepAlive);
      const left = (holds.get(connection) ?? 1) - 1;
      if (left > 0) holds.set(connection, left);
      else holds.delete(connection);
      const open = connections.get(connection);
      if (open) {
        open.openStreams = Math.max(0, open.openStreams - 1);
        armIdle(open);
      }
    });
  };

  /** `DELETE /mcp` with no session id: the proxy ending its 2026 connection. */
  const endConnection = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> => {
    const connection = connectionOf(req, res);
    if (connection === null) return;
    if (connection === undefined) {
      return sendRpcError(res, 400, 'Bad request: no valid session id, and not an initialize.');
    }
    connectionSessionIds.delete(connection);
    const s = connections.get(connection) ?? (await connecting.get(connection));
    res.writeHead(200).end();
    // Not awaited: the answer must not wait for a compile to drain.
    if (s) void closeSession(s, 'ended by the client');
  };

  /**
   * A `server/discover` on a connection with no session yet: answered from a scope opened for it
   * alone and closed at once, so a probe opens no session; the connection's session opens on its
   * first other message. A probe often comes from a process that is gone a moment later: the SDK's
   * client probes a stdio server through a sibling process it then kills (outright on Windows, so
   * that proxy never sends its `DELETE`), and Claude Code may probe beside a 2025 `initialize` on
   * one proxy. A session the probe opened outlived it holding the name the client asked for, and
   * the client's real session got another (`modern-2`). The discover result is the same either
   * way: instructions and capabilities depend on the daemon's guides, not on the session.
   */
  const serveDiscover = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: unknown,
  ): Promise<void> => {
    if (stopping) return sendRpcError(res, 503, 'The server is shutting down.');
    try {
      // Refused as the session would be, so the client falls back the same way.
      parseSessionHeaders(req.headersDistinct, env);
    } catch (err) {
      if (err instanceof SessionHeaderError) return sendRpcError(res, 400, err.message);
      throw err;
    }
    let done!: () => void;
    const settled = new Promise<void>((r) => (done = r));
    opening.add(settled);
    try {
      const guides = await loadSessionGuides(env, config.extraWritingGuidePath);
      const scope = createSessionContext(shared, {
        sessionId: uniqueSessionId(`probe-${randomBytes(4).toString('hex')}`, idTaken),
      });
      const mcp = createMcpHandler(
        () =>
          createServer(
            scope.ctx,
            guides.writingGuide,
            guides.concurrencyGuide,
            guides.skills,
            guides.writingGuideHasExtra,
          ),
        {
          legacy: 'reject',
          maxRequestBodySize: maxBodyBytes,
          onerror: (err) => log(`server/discover: ${err.message}`),
        },
      );
      try {
        await toNodeHandler(mcp, { maxRequestBodySize: maxBodyBytes })(req, res, body);
      } finally {
        await mcp.close().catch(() => {});
        await scope.close();
      }
    } finally {
      opening.delete(settled);
      done();
    }
  };

  /** One 2026-07-28 message: to its connection's session, opened on its first message. */
  const serveModern = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: unknown,
  ): Promise<void> => {
    const named = connectionOf(req, res);
    if (named === null) return;
    // A client that reaches the daemon without a proxy (the web UI's Claude) names no connection
    // but always names its session: its requests share that session, run after run. The prefix
    // keeps such a key apart from every connection id (a UUID).
    const sessionHeader = req.headersDistinct[HEADER_SESSION];
    const connection =
      named ??
      (sessionHeader?.length === 1 && sessionHeader[0] ? `session:${sessionHeader[0]}` : undefined);
    if (connection === undefined) {
      // A proxy of a build before #288, relaying a 2026 client's probe: any error makes that
      // client fall back to the 2025 handshake, which this daemon serves.
      return sendRpcError(
        res,
        400,
        `Protocol 2026-07-28 needs the proxy's connection id (${HEADER_CONNECTION}) or a ` +
          `session id (${HEADER_SESSION}); use the 2025 initialize handshake.`,
      );
    }
    let s = connections.get(connection);
    if (!s && !connecting.has(connection) && isDiscoverRequest(body)) {
      return serveDiscover(req, res, body);
    }
    if (!s) {
      let opened = connecting.get(connection);
      if (!opened) {
        opened = openModern(req, res, connection).finally(() => connecting.delete(connection));
        connecting.set(connection, opened);
      }
      s = await opened;
      if (!s) return; // refused, and answered
    }
    s.inflight++;
    clearTimeout(s.idleTimer);
    try {
      const strip = stripsOutputSchema(s.modern!.outputSchema, clientNameIn(body));
      await s.modern!.serve(req, res, body, strip);
    } finally {
      s.inflight--;
      if (!s.closing) armIdle(s);
    }
  };

  /**
   * Open the 2026 session of `connection`, as `openSession` does a 2025 one: the same headers,
   * the same scope, the same guides. It is served by `createMcpHandler`, which builds a server per
   * request from one factory — one handler per output shape, since the client (and with it whether
   * `outputSchema` is left out) is named in each request's envelope. `undefined` when refused (and
   * answered).
   */
  const openModern = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    connection: string,
  ): Promise<Session | undefined> => {
    if (openSessions().length + reserved.size >= maxSessions) {
      sendRpcError(res, 503, `Too many open sessions (at most ${maxSessions}).`);
      return undefined;
    }
    let settings: ReturnType<typeof parseSessionHeaders>;
    try {
      settings = parseSessionHeaders(req.headersDistinct, env);
    } catch (err) {
      if (err instanceof SessionHeaderError) {
        sendRpcError(res, 400, err.message);
        return undefined;
      }
      throw err;
    }
    const requested = settings.requestedSessionId;
    if (settings.replaceWhenIdle && !replaceRequested) {
      replaceRequested = true;
      log('a newer build asked to replace this daemon; it stops once its last session closes');
      for (const open of openSessions()) open.scope.ctx.config.restartPending = true;
    }
    const previous = connectionSessionIds.get(connection);
    const sessionId =
      previous !== undefined && !idTaken(previous)
        ? previous
        : uniqueSessionId(requested ?? `session-${randomBytes(4).toString('hex')}`, idTaken);
    reserved.add(fold(sessionId));
    clearTimeout(idleExitTimer);
    let done!: () => void;
    const settled = new Promise<void>((r) => (done = r));
    opening.add(settled);
    try {
      const guides = await loadSessionGuides(env, config.extraWritingGuidePath);
      const scope = createSessionContext(shared, {
        sessionId,
        ...(settings.defaultProject !== undefined
          ? { defaultProject: settings.defaultProject, defaultProjectExplicit: true }
          : {}),
        ...(settings.credentialOverlay ? { credentialOverlay: settings.credentialOverlay } : {}),
      });
      Object.assign(scope.ctx.config, {
        extraWritingGuideLoaded: guides.extraWritingGuideLoaded,
        ...(requested !== undefined && requested !== sessionId
          ? { sessionIdRequested: requested }
          : {}),
        ...(settings.ignoredEnv.length > 0 ? { ignoredClientEnv: settings.ignoredEnv } : {}),
        ...(replaceRequested ? { restartPending: true } : {}),
        ...(settings.approvals !== undefined ? { approvals: settings.approvals } : {}),
      });
      const handlers = new Map<boolean, ReturnType<typeof toNodeHandler>>();
      const mcpHandlers: Array<ReturnType<typeof createMcpHandler>> = [];
      const handlerFor = (strip: boolean): ReturnType<typeof toNodeHandler> => {
        let node = handlers.get(strip);
        if (!node) {
          const mcp = createMcpHandler(
            () =>
              createServer(
                scope.ctx,
                guides.writingGuide,
                guides.concurrencyGuide,
                guides.skills,
                guides.writingGuideHasExtra,
                undefined,
                { stripOutputSchema: strip },
              ),
            {
              legacy: 'reject',
              maxRequestBodySize: maxBodyBytes,
              onerror: (err) => log(`session ${quoteId(sessionId)}: ${err.message}`),
            },
          );
          mcpHandlers.push(mcp);
          node = toNodeHandler(mcp, { maxRequestBodySize: maxBodyBytes });
          handlers.set(strip, node);
        }
        return node;
      };
      const held = holds.get(connection) ?? 0;
      const s: Session = {
        sessionId,
        scope,
        modern: {
          connection,
          outputSchema: settings.outputSchema,
          serve: (rq, rs, body, strip) => handlerFor(strip)(rq, rs, body),
          close: async () => {
            await Promise.all(mcpHandlers.map((h) => h.close().catch(() => {})));
          },
        },
        openStreams: held,
        hadStream: held > 0,
        inflight: 0,
      };
      if (stopping) {
        await scope.close();
        sendRpcError(res, 503, 'The server is shutting down.');
        return undefined;
      }
      connections.set(connection, s);
      connectionSessionIds.set(connection, sessionId);
      armIdle(s);
      log(
        `session ${quoteId(sessionId)} opened (protocol 2026-07-28)` +
          (requested !== undefined && requested !== sessionId
            ? ` (asked for ${quoteId(requested)}, already open)`
            : ''),
      );
      return s;
    } finally {
      reserved.delete(fold(sessionId));
      opening.delete(settled);
      done();
      scheduleIdleExit();
    }
  };

  const openSession = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: unknown,
  ): Promise<void> => {
    if (openSessions().length + reserved.size >= maxSessions) {
      return sendRpcError(res, 503, `Too many open sessions (at most ${maxSessions}).`);
    }
    let settings: ReturnType<typeof parseSessionHeaders>;
    try {
      // Distinct: Node joins a repeated custom header into one "a, b" string.
      settings = parseSessionHeaders(req.headersDistinct, env);
    } catch (err) {
      if (err instanceof SessionHeaderError) return sendRpcError(res, 400, err.message);
      throw err;
    }
    const requested = settings.requestedSessionId;
    if (settings.replaceWhenIdle && !replaceRequested) {
      replaceRequested = true;
      log('a newer build asked to replace this daemon; it stops once its last session closes');
      for (const open of openSessions()) open.scope.ctx.config.restartPending = true;
    }
    const sessionId = uniqueSessionId(
      requested ?? `session-${randomBytes(4).toString('hex')}`,
      idTaken,
    );
    reserved.add(fold(sessionId));
    clearTimeout(idleExitTimer);
    let done!: () => void;
    const settled = new Promise<void>((r) => (done = r));
    opening.add(settled);
    try {
      const guides = await loadSessionGuides(env, config.extraWritingGuidePath);
      const scope = createSessionContext(shared, {
        sessionId,
        ...(settings.defaultProject !== undefined
          ? { defaultProject: settings.defaultProject, defaultProjectExplicit: true }
          : {}),
        ...(settings.credentialOverlay ? { credentialOverlay: settings.credentialOverlay } : {}),
      });
      // The scope's config is its own copy: what this session was built with.
      Object.assign(scope.ctx.config, {
        extraWritingGuideLoaded: guides.extraWritingGuideLoaded,
        ...(requested !== undefined && requested !== sessionId
          ? { sessionIdRequested: requested }
          : {}),
        ...(settings.ignoredEnv.length > 0 ? { ignoredClientEnv: settings.ignoredEnv } : {}),
        ...(replaceRequested ? { restartPending: true } : {}),
        ...(settings.approvals !== undefined ? { approvals: settings.approvals } : {}),
      });
      // Built for the client the `initialize` names: no `outputSchema` for one that chokes on it
      // (src/lib/outputSchemaCompat.ts).
      const server = createServer(
        scope.ctx,
        guides.writingGuide,
        guides.concurrencyGuide,
        guides.skills,
        guides.writingGuideHasExtra,
        undefined,
        { stripOutputSchema: stripsOutputSchema(settings.outputSchema, clientNameIn(body)) },
      );
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, s);
          armIdle(s);
          log(
            `session ${quoteId(sessionId)} opened` +
              (requested !== undefined && requested !== sessionId
                ? ` (asked for ${quoteId(requested)}, already open)`
                : ''),
          );
        },
        // Not awaited: the DELETE's answer must not wait for a compile to drain.
        onsessionclosed: () => void closeSession(s, 'ended by the client'),
      });
      const s: Session = {
        sessionId,
        scope,
        server,
        transport,
        openStreams: 0,
        hadStream: false,
        inflight: 0,
      };
      // Set before `connect`, which chains its own handler after this one.
      transport.onclose = () => void closeSession(s, 'transport closed');
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      if (transport.sessionId === undefined || !sessions.has(transport.sessionId)) {
        // The initialize failed (the transport answered with the error): nothing to keep open.
        await closeSession(s, 'initialize failed');
      } else if (stopping) {
        // `stop` began while this session was being set up; it will not see it otherwise.
        await closeSession(s, 'server stopping');
      }
    } finally {
      reserved.delete(fold(sessionId));
      opening.delete(settled);
      done();
      scheduleIdleExit();
    }
  };

  const stop = (reason: string): Promise<void> => {
    stopping ??= (async () => {
      clearTimeout(idleExitTimer);
      log(`stopping (${reason})`);
      setTimeout(passStopDeadline, STOP_DRAIN_MS).unref?.();
      // An initialize under way finishes (and, seeing `stopping`, closes itself) before the rest.
      await Promise.all([...opening]);
      await Promise.all(openSessions().map((s) => closeSession(s, 'server stopping')));
      await new Promise<void>((r) => {
        httpServer.close(() => r());
        httpServer.closeAllConnections();
      });
      // Their own listeners: left open, they would keep the process alive past its lock.
      await shared.viewer.close().catch(() => {});
      await shared.credentialPortal.close().catch(() => {});
      await removeDaemonInfo(config.workspaceRoot, processNonce).catch(() => {});
      releaseLock();
    })();
    return stopping;
  };

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(opts.port ?? 0, '127.0.0.1', () => {
      httpServer.off('error', reject);
      resolve();
    });
  });
  const address = httpServer.address();
  port = typeof address === 'object' && address ? address.port : 0;
  httpServer.requestTimeout = 0; // a tool call (a compile) may run for minutes on an open request

  const info: DaemonInfo = {
    pid: process.pid,
    processNonce,
    port,
    token,
    version: getServerVersion(),
    buildPath,
    buildId,
    startedAt: new Date().toISOString(),
  };
  try {
    await writeDaemonInfo(config.workspaceRoot, info);
  } catch (err) {
    await new Promise<void>((r) => httpServer.close(() => r()));
    throw err;
  }
  log(
    `daemon ready on 127.0.0.1:${port} for workspace ${quoteId(config.workspaceRoot)}` +
      (opts.keepAlive ? ' (keep-alive)' : ''),
  );
  scheduleIdleExit();

  return {
    port,
    token,
    url: `http://127.0.0.1:${port}/mcp`,
    info,
    sessionIds: () => openSessions().map((s) => s.sessionId),
    stop,
    stopped: Promise.resolve(),
  };
}

/** The body as text, or `'too-large'` once it passes `cap` bytes (the rest is not read). */
function readBody(req: http.IncomingMessage, cap: number): Promise<string | 'too-large'> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > cap) {
        resolve('too-large');
        req.removeAllListeners('data');
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

function sendRpcError(
  res: http.ServerResponse,
  status: number,
  message: string,
  code = -32000,
): void {
  sendJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null });
}

/**
 * The daemon `daemon.json` names, when it answers `/health` with the token there: a live daemon.
 * Anything else (no file, a dead pid, no answer, a wrong answer) is `undefined`.
 */
async function answeringDaemon(workspaceRoot: string): Promise<DaemonInfo | undefined> {
  const info = await readDaemonInfo(workspaceRoot);
  if (!info) return undefined;
  try {
    process.kill(info.pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') return undefined;
  }
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/health`, {
      headers: { authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { processNonce?: unknown };
    return body.processNonce === info.processNonce ? info : undefined;
  } catch {
    return undefined;
  }
}
