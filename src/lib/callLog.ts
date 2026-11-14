import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * The tool-call log: one JSON line per tool call in `<workspace>/.logs/tool-calls.jsonl`, for
 * finding where the server spends the model's tokens and the user's time — which results are
 * large, which calls are slow and on what (the project lock, the compile queue, TeX, pdf.js, the
 * remote), and which tools are called in runs or pairs a single tool could replace.
 * `web-latex-mcp call-stats` summarises it (`src/lib/callStats.ts`).
 *
 * **What it never holds: argument or result content.** A line names the tool, the session, the
 * project id, the timings and sizes, and each argument's *shape* (`argShape`): a boolean or number
 * as is, a string as its length, an array as its length — except the few enum-like options listed
 * in `ENUM_ARGS`, whose short value says which variant was used. No path, text, URL or token is
 * written. The file never leaves the machine. `WEB_LATEX_MCP_CALL_LOG=off` turns it off.
 *
 * Every process on a workspace (the shared server, a `--standalone` session) appends to the same
 * file; a line is one `appendFile` (O_APPEND), so lines from two processes do not interleave
 * mid-line. Past `MAX_LOG_BYTES` the file is renamed to `tool-calls.jsonl.1` (the previous `.1`
 * is replaced), so the log holds at most twice that.
 *
 * Logging never fails or delays a call: a write is queued after the result is returned, and the
 * first write error disables this process's log with one line on stderr.
 */

/** Where in a call its time went, besides running its own code. */
export interface CallTimings {
  /** Waiting for the project lock (`ProjectManager.runExclusive`: mutex and lock file). */
  lockWaitMs: number;
  /** Waiting for a compile/PDF slot (`WorkGate`). */
  gateWaitMs: number;
  /** Time spent in named heavy steps: `compile`, `pdf`, `git-remote`. Summed per call. */
  phases: Record<string, number>;
}

const current = new AsyncLocalStorage<CallTimings>();

/** Record a project-lock wait against the tool call running now, if any. */
export function noteLockWait(ms: number): void {
  const t = current.getStore();
  if (t) t.lockWaitMs += Math.max(0, ms);
}

/** Record a work-gate wait against the tool call running now, if any. */
export function noteGateWait(ms: number): void {
  const t = current.getStore();
  if (t) t.gateWaitMs += Math.max(0, ms);
}

/** Add `ms` to the named phase of the tool call running now, if any. */
export function notePhase(name: string, ms: number): void {
  const t = current.getStore();
  if (t) t.phases[name] = (t.phases[name] ?? 0) + Math.max(0, ms);
}

/** Run `fn`, charging its duration to phase `name` of the current call. */
export async function timedPhase<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    notePhase(name, Date.now() - start);
  }
}

/** One line of the log. Field names are the file format; `call-stats` reads them. */
export interface CallRecord {
  v: 1;
  /** Start of the call, ISO 8601. */
  ts: string;
  tool: string;
  session: string;
  /** `daemon` for a shared-server session, `stdio` for one served in-process. */
  mode: string;
  /** The `project` argument, else the session's default project; absent when neither. */
  project?: string;
  ms: number;
  /** The result was an error (`isError`), or the handler threw (`threw`). */
  error: boolean;
  threw?: boolean;
  argShape: Record<string, unknown>;
  /** Characters of the arguments as JSON — what the model wrote. */
  inChars: number;
  /** Characters of the result's text content — what the model reads. */
  outTextChars: number;
  /** Characters of `structuredContent` as JSON. */
  outStructChars: number;
  images: number;
  /** Characters of base64 image data. */
  imageChars: number;
  /** Rough tokens the model reads: text content / 4 (images not counted). */
  estTokens: number;
  lockWaitMs?: number;
  gateWaitMs?: number;
  phases?: Record<string, number>;
}

/**
 * Options whose string value is a short enum, worth keeping: which variant of a tool is used is
 * the question the log is for. Anything else that is a string is logged as its length only.
 */
const ENUM_ARGS = new Set([
  'filter',
  'target',
  'scope',
  'mode',
  'source',
  'compiler',
  'engine',
  'conflictDetail',
  'warningsFilterMode',
  'format',
]);
const ENUM_VALUE_MAX = 24;

/** The shape of a tool's arguments, never their content (see the module comment). */
export function argShape(args: unknown): Record<string, unknown> {
  const out = Object.create(null) as Record<string, unknown>;
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return out;
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (key === 'project') continue; // logged as `project`
    if (typeof value === 'boolean' || typeof value === 'number') out[key] = value;
    else if (typeof value === 'string') {
      out[key] =
        ENUM_ARGS.has(key) && value.length <= ENUM_VALUE_MAX && /^[\w.-]+$/.test(value)
          ? value
          : `str(${value.length})`;
    } else if (Array.isArray(value)) out[key] = `arr(${value.length})`;
    else if (value === null) out[key] = null;
    else if (typeof value === 'object') out[key] = 'obj';
  }
  return out;
}

interface ResultLike {
  isError?: boolean;
  content?: Array<{ type?: string; text?: string; data?: string }>;
  structuredContent?: unknown;
}

function jsonLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

/** Sizes of a tool result, as the record stores them. */
export function resultSizes(
  result: unknown,
): Pick<
  CallRecord,
  'error' | 'outTextChars' | 'outStructChars' | 'images' | 'imageChars' | 'estTokens'
> {
  const r = (result ?? {}) as ResultLike;
  let outTextChars = 0;
  let images = 0;
  let imageChars = 0;
  for (const item of Array.isArray(r.content) ? r.content : []) {
    if (item?.type === 'text' && typeof item.text === 'string') outTextChars += item.text.length;
    else if (item?.type === 'image' && typeof item.data === 'string') {
      images++;
      imageChars += item.data.length;
    }
  }
  return {
    error: r.isError === true,
    outTextChars,
    outStructChars: r.structuredContent === undefined ? 0 : jsonLength(r.structuredContent),
    images,
    imageChars,
    estTokens: Math.ceil(outTextChars / 4),
  };
}

/** Past this size the log is rotated to `.1`. */
export const MAX_LOG_BYTES = 20 * 1024 * 1024;
/** How many writes between size checks. */
const SIZE_CHECK_EVERY = 100;

export function callLogPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.logs', 'tool-calls.jsonl');
}

/** Appends records to one log file, in order, off the call's path. */
export class CallLogSink {
  private chain: Promise<void> = Promise.resolve();
  private disabled = false;
  private writes = 0;

  constructor(
    readonly file: string,
    private readonly maxBytes = MAX_LOG_BYTES,
  ) {}

  write(record: CallRecord): void {
    if (this.disabled) return;
    const line = `${JSON.stringify(record)}\n`;
    this.chain = this.chain.then(() => this.append(line));
  }

  /** Resolves once every queued record is written (tests, shutdown). */
  flush(): Promise<void> {
    return this.chain;
  }

  private async append(line: string): Promise<void> {
    if (this.disabled) return;
    try {
      if (this.writes++ === 0) await mkdir(path.dirname(this.file), { recursive: true });
      if (this.writes % SIZE_CHECK_EVERY === 0) await this.rotateIfLarge();
      await appendFile(this.file, line, { encoding: 'utf8', mode: 0o600 });
    } catch (err) {
      this.disabled = true;
      console.error(
        `[web-latex-mcp] tool-call log disabled for this process: cannot write ` +
          `${JSON.stringify(this.file)} (${(err as NodeJS.ErrnoException).code ?? String(err)})`,
      );
    }
  }

  private async rotateIfLarge(): Promise<void> {
    try {
      if ((await stat(this.file)).size < this.maxBytes) return;
      await rename(this.file, `${this.file}.1`);
    } catch {
      // Gone (another process rotated it) or unreadable: the append below says which.
    }
  }
}

const sinks = new Map<string, CallLogSink>();

/** The process's sink for a workspace's log: one per file, shared by every session scope. */
export function callLogSink(workspaceRoot: string): CallLogSink {
  const file = callLogPath(workspaceRoot);
  let sink = sinks.get(file);
  if (!sink) {
    sink = new CallLogSink(file);
    sinks.set(file, sink);
  }
  return sink;
}

/** See `installToolCallProbe` (`src/lib/sessionProbe.ts`) for why the wrapper is typed loosely. */
type AnyRegisterTool = (
  name: string,
  config: unknown,
  cb: (...cbArgs: unknown[]) => unknown,
) => unknown;

export interface CallLogContext {
  sink: Pick<CallLogSink, 'write'>;
  session: string;
  mode: string;
  defaultProject?: () => string | undefined;
  now?: () => number;
}

/**
 * Wrap `server.registerTool` so every tool registered afterwards logs its calls. Install it
 * before the registrations, like the session probe; tools registered earlier are not wrapped.
 */
export function installCallLog(server: McpServer, log: CallLogContext): void {
  const now = log.now ?? Date.now;
  const target = server as unknown as { registerTool: AnyRegisterTool };
  const original = target.registerTool.bind(server);
  target.registerTool = (name, config, cb) =>
    original(name, config, (...cbArgs: unknown[]) => {
      // A tool with an input schema gets (args, extra); one without gets (extra) alone.
      const args = cbArgs.length >= 2 ? cbArgs[0] : undefined;
      const timings: CallTimings = { lockWaitMs: 0, gateWaitMs: 0, phases: {} };
      const start = now();
      const finish = (result: unknown, threw: boolean): void => {
        try {
          const given = (args as { project?: unknown } | undefined)?.project;
          const project = typeof given === 'string' ? given : log.defaultProject?.();
          const record: CallRecord = {
            v: 1,
            ts: new Date(start).toISOString(),
            tool: name,
            session: log.session,
            mode: log.mode,
            ...(project !== undefined ? { project } : {}),
            ms: now() - start,
            ...resultSizes(result),
            ...(threw ? { error: true, threw: true } : {}),
            argShape: argShape(args),
            inChars: args === undefined ? 0 : jsonLength(args),
            ...(timings.lockWaitMs > 0 ? { lockWaitMs: timings.lockWaitMs } : {}),
            ...(timings.gateWaitMs > 0 ? { gateWaitMs: timings.gateWaitMs } : {}),
            ...(Object.keys(timings.phases).length > 0 ? { phases: timings.phases } : {}),
          };
          log.sink.write(record);
        } catch {
          /* logging never fails a call */
        }
      };
      return current.run(timings, async () => {
        try {
          const result = await cb(...cbArgs);
          finish(result, false);
          return result;
        } catch (err) {
          finish(undefined, true);
          throw err;
        }
      });
    });
}

/** `WEB_LATEX_MCP_CALL_LOG`: on unless set to an off word. */
export function parseCallLog(value: string | undefined): { enabled: boolean; invalid?: string } {
  const v = value?.trim().toLowerCase();
  if (!v) return { enabled: true };
  if (['0', 'off', 'false', 'no'].includes(v)) return { enabled: false };
  if (['1', 'on', 'true', 'yes'].includes(v)) return { enabled: true };
  return { enabled: true, invalid: value };
}
