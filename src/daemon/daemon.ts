import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from '../server.js';
import {
  createSessionContext,
  createSharedServices,
  type SessionScope,
  type SharedServices,
} from '../context.js';
import { processNonce, withFileLock, LockTimeoutError } from '../lib/fileLock.js';
import { isScopeOpen } from '../lib/openScopes.js';
import { installOutputSchemaCompat } from '../lib/outputSchemaCompat.js';
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
import { SessionHeaderError, parseSessionHeaders, uniqueSessionId } from './sessionHeaders.js';

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

interface Session {
  sessionId: string;
  scope: SessionScope;
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  /** Open GET (SSE) streams; a session with one is never idle. */
  openStreams: number;
  /** Whether the client ever held a stream open: one that drops all of them has likely gone. */
  hadStream: boolean;
  idleTimer?: NodeJS.Timeout;
  closing?: Promise<void>;
}

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

  /** By transport session id (the `Mcp-Session-Id` header). */
  const sessions = new Map<string, Session>();
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
    [...sessions.values()].some((s) => fold(s.sessionId) === fold(id)) ||
    isScopeOpen(config.workspaceRoot, id);

  const scheduleIdleExit = (): void => {
    clearTimeout(idleExitTimer);
    idleExitTimer = undefined;
    if (stopping || sessions.size > 0 || reserved.size > 0) return;
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
      if (s.openStreams > 0 || s.scope.ctx.projectManager.isBusy()) armIdle(s);
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
      await s.server.close().catch(() => {});
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
        sessions: sessions.size,
        keepAlive: opts.keepAlive === true,
        replaceRequested,
      });
    }
    if (url.pathname === '/shutdown' && req.method === 'POST') {
      // A proxy stops an older daemon only when nobody uses it (§9.2); `?force=1` is the shell's.
      if (sessions.size + reserved.size > 0 && url.searchParams.get('force') !== '1') {
        return sendJson(res, 409, { error: 'Sessions are open', sessions: sessions.size });
      }
      sendJson(res, 200, { stopping: true });
      void stop('shutdown requested');
      return;
    }
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
      return s.transport.handleRequest(req, res, body);
    }
    if (req.method !== 'POST' || !isInitializeRequest(body)) {
      return sendRpcError(res, 400, 'Bad request: no valid session id, and not an initialize.');
    }
    await openSession(req, res, body);
  };

  const openSession = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: unknown,
  ): Promise<void> => {
    if (sessions.size + reserved.size >= maxSessions) {
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
      for (const open of sessions.values()) open.scope.ctx.config.restartPending = true;
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
      });
      const server = createServer(
        scope.ctx,
        guides.writingGuide,
        guides.concurrencyGuide,
        guides.skills,
        guides.writingGuideHasExtra,
      );
      const s: Session = {
        sessionId,
        scope,
        server,
        // Assigned below; the transport's callbacks need `s`.
        transport: undefined as unknown as StreamableHTTPServerTransport,
        openStreams: 0,
        hadStream: false,
      };
      s.transport = new StreamableHTTPServerTransport({
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
      // Set before `connect`, which chains its own handler after this one.
      s.transport.onclose = () => void closeSession(s, 'transport closed');
      installOutputSchemaCompat(server, s.transport, settings.outputSchema);
      await server.connect(s.transport);
      await s.transport.handleRequest(req, res, body);
      if (s.transport.sessionId === undefined || !sessions.has(s.transport.sessionId)) {
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
      await Promise.all(
        [...new Set(sessions.values())].map((s) => closeSession(s, 'server stopping')),
      );
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
    sessionIds: () => [...new Set([...sessions.values()].map((s) => s.sessionId))],
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
