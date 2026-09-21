import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { redact } from './redact.js';

/**
 * Opt-in stderr instrumentation for the session-identity spike (#18, "Step 0 — spike first").
 *
 * The question it exists to answer is empirical and cannot be answered from the code: when a user
 * opens several Claude Desktop chats against one configured server, does Desktop open one MCP
 * connection per chat, one connection carrying a conversation id in each request's `_meta`, or one
 * connection with nothing that distinguishes the chats? So this module logs exactly three things:
 *
 * - **(a)** every `oninitialized` firing, with a **monotonic counter** — "one connection or N?" is
 *   then a matter of reading the highest `#n`, not of counting lines;
 * - **(b)** the `clientInfo` (name and version) negotiated on each of those connections, plus the
 *   pid, since "one process or N?" is the other half of the same question;
 * - **(c)** `_meta` on every tool call, with the tool name so a caller can correlate it with what
 *   they did in which chat.
 *
 * Three properties are load-bearing and are each pinned by a test:
 *
 * 1. **stderr only.** stdout is the JSON-RPC channel; a probe that writes there corrupts the
 *    protocol. The sink is injectable for tests and defaults to `console.error`.
 * 2. **`_meta` is client-controlled data of unknown shape.** It is rendered through
 *    {@link renderMeta}, which scrubs known secrets (a client that echoes a token into `_meta` must
 *    not put it in a log the user pastes into an issue), caps the rendered length, and survives a
 *    `JSON.stringify` that throws (circular references, `BigInt`) or returns `undefined`.
 * 3. **A probe never fails a call.** Every entry point swallows its own failures. The tool result
 *    must be byte-identical whether the probe is installed or not — which is why, when it is
 *    disabled, nothing is installed at all rather than a no-op being installed.
 *
 * This is a measuring device, not the #18 refactor: it reads identity, it establishes none.
 */

/** Env var that turns the probe on. Unset (the default) installs nothing whatsoever. */
export const SESSION_PROBE_ENV = 'WEB_LATEX_MCP_SESSION_PROBE';

/** Prefix on every probe line, so the spike's output is one `grep` away from the rest of stderr. */
export const PROBE_PREFIX = '[web-latex-mcp][probe]';

/**
 * Default cap on the rendered `_meta` string. A conversation id is tens of characters; this leaves
 * room for a client that attaches a whole envelope while keeping one hostile or buggy call from
 * flooding the terminal the human is reading the spike out of.
 */
export const META_RENDER_CAP = 2000;

/** Rendering of an absent `_meta`, kept distinct from `{}` — that difference IS the spike's answer. */
export const META_ABSENT = '(absent)';

/**
 * Resolve the gate from {@link SESSION_PROBE_ENV}, mirroring `outputSchemaMode`'s shape:
 * unset/empty/whitespace-only → off, `0`/`false`/`no`/`off` → off, anything else (e.g. `1`) → on.
 */
export function sessionProbeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[SESSION_PROBE_ENV];
  if (raw === undefined || raw.trim() === '') return false;
  return !/^(0|false|no|off)$/i.test(raw.trim());
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Render a client-supplied `_meta` for stderr: JSON, scrubbed of known secrets, then capped.
 *
 * The order matters. Scrubbing runs over the WHOLE serialized string and truncation comes after,
 * because truncating first could cut a secret in half and leave the visible prefix unscrubbed.
 *
 * Nothing here throws: `JSON.stringify` dies on circular references and `BigInt`, and returns
 * `undefined` for a value with no JSON form at all. Both become a marker string, because a probe
 * that crashes a tool call is worse than no probe.
 */
export function renderMeta(
  meta: unknown,
  secrets: string[] = [],
  cap: number = META_RENDER_CAP,
): string {
  if (meta === undefined) return META_ABSENT;
  let json: string | undefined;
  try {
    json = JSON.stringify(meta);
  } catch (err) {
    json = `(unrenderable: ${messageOf(err)})`;
  }
  if (json === undefined) json = '(unrenderable: no JSON representation)';
  let out: string;
  try {
    out = redact(json, secrets);
  } catch {
    // `redact` is pure string work, but a secrets list is caller data; never let it win.
    out = json;
  }
  // A non-finite cap must not silently mean "no cap": `x.length > NaN` is false, which would
  // disable the bound entirely — the opposite of what a caller passing a cap asked for.
  const limit = Number.isFinite(cap) ? Math.max(1, Math.floor(cap)) : META_RENDER_CAP;
  if (out.length > limit) out = `${out.slice(0, limit)}…(+${out.length - limit} more chars)`;
  return out;
}

/** The negotiated `clientInfo`, narrowed to what the probe reports. */
export interface ProbeClientInfo {
  name?: string;
  version?: string;
}

export interface SessionProbe {
  /** One line at startup, naming the process this spike output belongs to. */
  startup(sessionId: string): void;
  /** (a) + (b): a connection reached `initialized`. */
  connectionInitialized(client: ProbeClientInfo | undefined): void;
  /** (c): a tool call arrived, with whatever `_meta` the client attached to it. */
  toolCall(toolName: string, meta: unknown): void;
  /** How many `initialized` firings have been seen so far (the monotonic counter). */
  connectionCount(): number;
}

export interface SessionProbeOptions {
  /**
   * Known secrets to scrub out of `_meta`, read lazily per call — the credential resolver learns
   * tokens as projects are touched, so a snapshot taken at startup would miss most of them.
   */
  secrets?: () => string[];
  /** Where a line goes. Defaults to `console.error` — **stderr**, never stdout. */
  log?: (line: string) => void;
  /** Clock, injectable so tests can assert an exact stamp. */
  now?: () => Date;
  /** Rendered-`_meta` cap; see {@link META_RENDER_CAP}. */
  cap?: number;
  /** Process id reported alongside each connection; injectable for tests. */
  pid?: number;
}

export function createSessionProbe(opts: SessionProbeOptions = {}): SessionProbe {
  const log = opts.log ?? ((line: string) => console.error(line));
  const now = opts.now ?? (() => new Date());
  const pid = opts.pid ?? process.pid;
  const cap = opts.cap ?? META_RENDER_CAP;
  let connections = 0;

  function secrets(): string[] {
    try {
      return opts.secrets?.() ?? [];
    } catch {
      return [];
    }
  }

  function emit(line: string): void {
    let stamp: string;
    try {
      stamp = now().toISOString();
    } catch {
      stamp = '(no timestamp)';
    }
    log(`${PROBE_PREFIX} ${stamp} ${line}`);
  }

  /**
   * Last resort: the probe's own machinery failed. Say so through the same sink (so a test can see
   * it) and give up if even that throws — the caller is a tool call that must proceed regardless.
   */
  function reportFailure(where: string, err: unknown): void {
    try {
      log(`${PROBE_PREFIX} ${where} probe failed: ${redact(messageOf(err), secrets())}`);
    } catch {
      /* nothing left to try; the tool call carries on */
    }
  }

  return {
    startup(sessionId: string): void {
      try {
        emit(
          `enabled via ${SESSION_PROBE_ENV} — pid ${pid}, process session id "${sessionId}". ` +
            `Reporting: connection initializations (with clientInfo) and per-tool-call _meta.`,
        );
      } catch (err) {
        reportFailure('startup', err);
      }
    },

    connectionInitialized(client: ProbeClientInfo | undefined): void {
      try {
        connections += 1;
        const info = client
          ? `clientInfo name="${client.name ?? '(unnamed)'}" version="${client.version ?? '(unversioned)'}"`
          : 'clientInfo (none reported)';
        emit(`connection #${connections} initialized — pid ${pid}, ${info}`);
      } catch (err) {
        reportFailure('connectionInitialized', err);
      }
    },

    toolCall(toolName: string, meta: unknown): void {
      try {
        emit(`tool call "${toolName}" — pid ${pid}, _meta=${renderMeta(meta, secrets(), cap)}`);
      } catch (err) {
        reportFailure('toolCall', err);
      }
    },

    connectionCount(): number {
      return connections;
    },
  };
}

/**
 * Pull `_meta` off the last argument of an `McpServer` tool callback.
 *
 * The SDK calls a tool callback as `(args, extra)` when the tool declares an `inputSchema` and as
 * `(extra)` when it does not, so the `RequestHandlerExtra` is the LAST argument either way — and
 * `extra._meta` is assigned straight from the request's `params._meta` (`shared/protocol.js`), so
 * this reads exactly what the client sent and exactly what the #18 refactor would later consume.
 */
export function extraMeta(cbArgs: readonly unknown[]): unknown {
  const extra = cbArgs.length > 0 ? cbArgs[cbArgs.length - 1] : undefined;
  if (extra === null || typeof extra !== 'object') return undefined;
  return (extra as { _meta?: unknown })._meta;
}

/**
 * The shape {@link installToolCallProbe} needs. `McpServer.registerTool` is heavily overloaded and
 * generic; the probe cares about none of that — only that a name and a callback go past — so the
 * wrapper is typed loosely here and the cast is confined to this one function.
 */
type AnyRegisterTool = (
  name: string,
  config: unknown,
  cb: (...cbArgs: unknown[]) => unknown,
) => unknown;

/**
 * Wrap `server.registerTool` so every tool registered afterwards reports its calls' `_meta`.
 *
 * This is the **single wiring point**: all 36 tools register through `server.registerTool`, so
 * installing here before `createServer` registers them covers every one of them — and every tool
 * added later — with no per-tool edit and nothing to keep in sync. Install it BEFORE the
 * registrations; tools registered earlier are not wrapped.
 */
export function installToolCallProbe(server: McpServer, probe: SessionProbe): void {
  const target = server as unknown as { registerTool: AnyRegisterTool };
  const original = target.registerTool.bind(server);
  target.registerTool = (name, config, cb) =>
    original(name, config, (...cbArgs: unknown[]) => {
      // Belt and braces: `probe.toolCall` swallows its own failures, and this catches a throwing
      // `_meta` getter on the way in. The call proceeds either way.
      try {
        probe.toolCall(name, extraMeta(cbArgs));
      } catch {
        /* a probe never fails a call */
      }
      return cb(...cbArgs);
    });
}

/** The part of the low-level `Server` {@link installConnectionProbe} touches. */
export interface ProbeConnection {
  oninitialized?: () => void;
  getClientVersion: () => ProbeClientInfo | undefined;
}

/**
 * Chain onto `server.server.oninitialized` so each connection's initialization is counted and its
 * `clientInfo` reported.
 *
 * The probe runs **before** the previously installed handler, not after: the count of firings is
 * the datum the spike is being run for, and it must not be lost because some other handler threw.
 * The previous handler still runs, unchanged, so behaviour is untouched.
 */
export function installConnectionProbe(connection: ProbeConnection, probe: SessionProbe): void {
  const previous = connection.oninitialized;
  connection.oninitialized = () => {
    try {
      probe.connectionInitialized(connection.getClientVersion());
    } catch {
      /* a probe never breaks initialization */
    }
    previous?.();
  };
}
