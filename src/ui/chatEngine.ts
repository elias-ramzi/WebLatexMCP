import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { getServerVersion } from '../lib/version.js';
import {
  HEADER_DEFAULT_PROJECT,
  HEADER_SESSION,
} from '../daemon/sessionHeaders.js';
import {
  clipInput,
  contextTokens,
  contextWindow,
  displayToolName,
  itemsFromMessage,
  userItem,
  type ChatItem,
  type SdkMessageLike,
} from './chatItems.js';
import { chatKey, type ChatStore } from './chatStore.js';
import { uiDir } from './uiFiles.js';

/**
 * The UI's conversations: one Claude per paper, run through the Agent SDK
 * (`@anthropic-ai/claude-agent-sdk`, an **optional** dependency, loaded on first use — the MCP
 * server never imports it), with the web-latex-mcp tools of the shared server and nothing else.
 *
 * Each paper's Claude is one long-lived `query()` in streaming-input mode: a message sent while
 * Claude works goes in at once, and Claude reads it at its next step, as in claude.ai; Esc
 * interrupts. It connects to the daemon's `/mcp` with the daemon's bearer token and a session of
 * its own (`ui-<hash>`), the paper as its default project.
 *
 * It is a whole Claude Code: its own tools (Bash, Read, Edit, web search…), the user's settings,
 * CLAUDE.md files and hooks, run in the paper's folder. The web-latex-mcp tools are allowed
 * outright (they keep to the server's sandbox); any other call Claude Code would ask about comes
 * to the page as a card (`canUseTool`): allow, always allow (Claude Code's own suggested rule),
 * or deny with a word for Claude. `AskUserQuestion` and `ExitPlanMode` get their own cards. The
 * permission mode (Manual, Accept edits, Plan, Auto) is chosen per paper and applied live.
 *
 * The SDK session id is kept (`ChatStore`), and a new process resumes it: after a restart of the
 * UI, of the daemon (a new token), or a change of model or effort.
 */

/** The daemon a Claude talks to. */
export interface DaemonEndpoint {
  url: string;
  token: string;
}

/** What `query()` returns, as far as this file uses it. */
export interface QueryLike extends AsyncIterable<SdkMessageLike & Record<string, unknown>> {
  interrupt(): Promise<unknown>;
  setPermissionMode?(mode: string): Promise<void>;
  supportedCommands?(): Promise<Array<{ name: string; description?: string; argumentHint?: string }>>;
  close?(): void;
}

export interface UserInput {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
  uuid?: string;
}

type Permission =
  | { behavior: 'allow'; updatedInput: Record<string, unknown>; updatedPermissions?: unknown[] }
  | { behavior: 'deny'; message: string; interrupt?: boolean };

/** What `canUseTool` is told beside the call, as far as the cards use it. */
interface PermissionContext {
  signal: AbortSignal;
  suggestions?: unknown[];
  blockedPath?: string;
  decisionReason?: string;
}

export interface StartArgs {
  prompt: AsyncIterable<UserInput>;
  options: Record<string, unknown> & {
    canUseTool: (
      toolName: string,
      input: Record<string, unknown>,
      opts: PermissionContext,
    ) => Promise<Permission>;
  };
}

export type StartQuery = (args: StartArgs) => QueryLike;

export type ChatStatus = 'off' | 'starting' | 'idle' | 'working' | 'waiting';

/** A card the page shows until the user answers it. */
export interface PendingAsk {
  id: string;
  /** `question`: AskUserQuestion; `plan`: ExitPlanMode; `permission`: any other tool call. */
  kind: 'question' | 'plan' | 'permission';
  tool: string;
  input: Record<string, unknown>;
  /** What "always allow" would add: Claude Code's own suggestion, shown as rules. */
  always?: string[];
  blockedPath?: string;
  reason?: string;
}

/** The user's answer to a card. */
export interface AskAnswer {
  decision: 'allow' | 'always' | 'deny';
  /** deny: what Claude is told (why, or what to do instead). */
  message?: string;
  /** question: question text → answer. */
  answers?: Record<string, string>;
  /** plan: the permission mode to work in once the plan is approved. */
  mode?: string;
}

/** What `/api/chat` reports beside the items. */
export interface ChatSnapshot {
  status: ChatStatus;
  /** The text Claude is writing now, before its message is complete. */
  live: string;
  asks: PendingAsk[];
  busySince?: number;
  mode: string;
  model?: string;
  effort?: string;
  context?: { tokens: number; window: number };
  costUsd?: number;
  /** Messages sent during the current turn, that Claude has not taken in yet. */
  queued: string[];
  error?: string;
}

export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto'];
export const SERVER_NAME = 'web-latex-mcp';
/** The variable a UI Claude reads the daemon's token from (see the MCP config's header). */
export const TOKEN_VAR = 'WEB_LATEX_MCP_UI_DAEMON_TOKEN';

/** A queue the SDK reads its input from, one message at a time, as they are sent. */
export class InputQueue implements AsyncIterable<UserInput> {
  private items: UserInput[] = [];
  private waiting: ((r: IteratorResult<UserInput>) => void) | undefined;
  private closed = false;

  push(item: UserInput): void {
    if (this.closed) return;
    const w = this.waiting;
    if (w) {
      this.waiting = undefined;
      w({ value: item, done: false });
    } else this.items.push(item);
  }

  close(): void {
    this.closed = true;
    const w = this.waiting;
    this.waiting = undefined;
    w?.({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<UserInput> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

/** The package root: where `.claude-plugin/` sits in a checkout (src/ui or dist/ui, two up). */
export function packageRoot(): string {
  return fileURLToPath(new URL('../..', import.meta.url));
}

/**
 * The plugin a UI Claude loads its skills, commands and agents from: this package, when it holds
 * its plugin manifest (a checkout, the dev build). An npm install ships the skills only (as MCP
 * prompts, which Claude Code offers as `/mcp__web-latex-mcp__…` commands).
 */
export function pluginDir(root = packageRoot()): string | undefined {
  return existsSync(path.join(root, '.claude-plugin', 'plugin.json')) ? root : undefined;
}

/** The rules a permission suggestion would add, as `Tool(rule)` lines. */
export function suggestionRules(suggestions: unknown[] | undefined): string[] {
  const out: string[] = [];
  for (const s of suggestions ?? []) {
    const sug = s as {
      type?: string;
      rules?: Array<{ toolName?: string; ruleContent?: string }>;
      mode?: string;
      directories?: string[];
    };
    if (sug.type === 'addRules' || sug.type === 'replaceRules') {
      for (const r of sug.rules ?? []) {
        if (r.toolName) out.push(r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName);
      }
    } else if (sug.type === 'setMode' && sug.mode) out.push(`mode: ${sug.mode}`);
    else if (sug.type === 'addDirectories') {
      out.push(...(sug.directories ?? []).map((d) => `directory ${d}`));
    }
  }
  return out;
}

export function uiSessionId(paper: string): string {
  return `ui-${chatKey(paper).slice(0, 16)}`;
}

/** The instructions a UI Claude gets on top of Claude Code's own. */
export function uiSystemPrompt(paper: string): string {
  return (
    `You are helping the user with the LaTeX paper ${JSON.stringify(paper)}, in the WebLatexMCP ` +
    'web UI. It is the default project of your web-latex-mcp tools: leave `project` out unless ' +
    'the user names another paper. The user sees the compiled PDF beside this chat (the live ' +
    'viewer): after changing the source, compile, and the view refreshes. Do not call the ' +
    '`viewer` tool to show it: it is already open here. Call it only for a markdown `document`, ' +
    'or when the user asks for a separate browser tab. Prefer the ' +
    'web-latex-mcp tools for the paper (read_file, edit_file, compile, commit…): they keep ' +
    "parallel sessions' work apart and the viewer in step. Never commit or push unless the user " +
    'asks.'
  );
}

/** Load the Agent SDK's `query`, or say why it cannot be used. */
export async function loadSdkQuery(): Promise<{ query?: StartQuery; error?: string }> {
  // A variable specifier: TypeScript does not resolve it, so this builds without the package.
  const spec = '@anthropic-ai/claude-agent-sdk';
  try {
    const mod = (await import(spec)) as { query?: StartQuery };
    if (typeof mod.query !== 'function') return { error: `${spec} has no query() export` };
    return { query: mod.query };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      error:
        code === 'ERR_MODULE_NOT_FOUND'
          ? `${spec} is not installed. Install it next to web-latex-mcp (npm install ${spec}), ` +
            'then restart the UI.'
          : `${spec} could not be loaded: ${(err as Error).message}`,
    };
  }
}

export interface ChatManagerOptions {
  workspaceRoot: string;
  store: ChatStore;
  /** The daemon to connect to now (it may have been restarted, with a new token). */
  endpoint: () => Promise<DaemonEndpoint>;
  /** The paper's folder (its clone, or a local project's directory), where Claude works. */
  paperDir?: (paper: string) => Promise<string | undefined>;
  /** Test seam: the SDK's `query`, or why there is none. */
  loadQuery?: () => Promise<{ query?: StartQuery; error?: string }>;
  log?: (line: string) => void;
}

interface Ask extends PendingAsk {
  resolve: (p: Permission) => void;
  /** The call's input as Claude Code gave it (`input` is cut for the page). */
  full: Record<string, unknown>;
  suggestions?: unknown[];
}

/** One paper's Claude. */
class PaperChat {
  status: ChatStatus = 'off';
  live = '';
  liveBlock = -1;
  asks: Ask[] = [];
  busySince: number | undefined;
  context: { tokens: number; window: number } | undefined;
  window = 0;
  costUsd = 0;
  error: string | undefined;
  queued: Array<{ uuid: string; text: string }> = [];
  private q: QueryLike | undefined;
  private input: InputQueue | undefined;
  private abort: AbortController | undefined;
  private endpoint: DaemonEndpoint | undefined;
  private sawStateEvents = false;
  /** Close the query once the turn ends (a new model or effort, a new daemon). */
  private restartWhenIdle = false;

  constructor(
    readonly paper: string,
    private readonly mgr: ChatManager,
  ) {}

  snapshot(meta: { model?: string; effort?: string; mode?: string }): ChatSnapshot {
    return {
      status: this.status,
      live: this.live,
      asks: this.asks.map(({ resolve: _r, full: _f, suggestions: _s, ...a }) => a),
      mode: meta.mode ?? 'default',
      ...(this.busySince ? { busySince: this.busySince } : {}),
      ...(meta.model ? { model: meta.model } : {}),
      ...(meta.effort ? { effort: meta.effort } : {}),
      ...(this.context ? { context: this.context } : {}),
      ...(this.costUsd ? { costUsd: this.costUsd } : {}),
      queued: this.queued.map((q) => q.text),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  private get working(): boolean {
    return this.status === 'working' || this.status === 'waiting' || this.status === 'starting';
  }

  async send(text: string): Promise<void> {
    const query = await this.mgr.query();
    const endpoint = await this.mgr.endpointNow();
    if (this.q && this.endpoint && sameEndpoint(this.endpoint, endpoint) === false) {
      // The shared server was restarted: this Claude's MCP connection holds a dead token.
      if (this.working) this.restartWhenIdle = true;
      else this.stop();
    }
    await this.mgr.store.append(this.paper, [userItem(text)]);
    this.error = undefined;
    const uuid = randomUUID();
    if (!this.q) await this.start(query, endpoint);
    if (this.working && this.status !== 'starting') this.queued.push({ uuid, text });
    this.input?.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
      uuid,
    });
    if (!this.working) {
      this.status = 'working';
      this.busySince = Date.now();
    }
  }

  private async start(query: StartQuery, endpoint: DaemonEndpoint): Promise<void> {
    let meta = await this.mgr.store.meta(this.paper);
    let cwd = await this.mgr.paperDir(this.paper);
    if (!cwd) {
      cwd = path.join(uiDir(this.mgr.workspaceRoot), 'claude');
      await mkdir(cwd, { recursive: true, mode: 0o700 });
    }
    // Claude Code keeps a conversation by folder: one begun elsewhere cannot be resumed here.
    if (meta.sessionId && meta.cwd && meta.cwd !== cwd) {
      await this.mgr.store.append(this.paper, [
        {
          k: 'note',
          text: "The paper's folder moved: Claude starts a new conversation (this one stays above).",
          t: new Date().toISOString(),
        },
      ]);
      meta = await this.mgr.store.setMeta(this.paper, { sessionId: undefined });
    }
    if (meta.cwd !== cwd) meta = await this.mgr.store.setMeta(this.paper, { cwd });
    const plugin = pluginDir();
    this.input = new InputQueue();
    this.abort = new AbortController();
    this.endpoint = endpoint;
    this.status = 'starting';
    this.busySince = Date.now();
    this.sawStateEvents = false;
    const options = {
      cwd,
      abortController: this.abort,
      mcpServers: {
        [SERVER_NAME]: {
          type: 'http',
          url: endpoint.url,
          headers: {
            // Expanded by Claude Code from its environment: the SDK passes this config on the
            // command line, which any local user can read; the environment is the owner's alone.
            authorization: `Bearer \${${TOKEN_VAR}}`,
            [HEADER_SESSION]: uiSessionId(this.paper),
            [HEADER_DEFAULT_PROJECT]: this.paper,
          },
          alwaysLoad: true,
        },
      },
      allowedTools: [`mcp__${SERVER_NAME}__*`],
      permissionMode: meta.mode ?? 'default',
      settingSources: ['user', 'project', 'local'],
      includePartialMessages: true,
      ...(plugin ? { plugins: [{ type: 'local', path: plugin, skipMcpDiscovery: true }] } : {}),
      ...(meta.sessionId ? { resume: meta.sessionId } : {}),
      ...(meta.model ? { model: meta.model } : {}),
      ...(meta.effort ? { effort: meta.effort } : {}),
      systemPrompt: { type: 'preset', preset: 'claude_code', append: uiSystemPrompt(this.paper) },
      env: {
        ...process.env,
        [TOKEN_VAR]: endpoint.token,
        CLAUDE_AGENT_SDK_CLIENT_APP: `web-latex-mcp-ui/${getServerVersion()}`,
      },
      stderr: (line: string) => this.mgr.log(`[${this.paper}] ${line.trimEnd()}`),
      canUseTool: (toolName: string, input: Record<string, unknown>, opts: PermissionContext) =>
        this.permission(toolName, input, opts),
    };
    const q = query({ prompt: this.input, options });
    this.q = q;
    void this.pump(q);
  }

  private permission(
    toolName: string,
    input: Record<string, unknown>,
    ctx: PermissionContext,
  ): Promise<Permission> {
    return new Promise<Permission>((resolve) => {
      const id = randomUUID();
      const kind =
        toolName === 'AskUserQuestion'
          ? 'question'
          : toolName === 'ExitPlanMode'
            ? 'plan'
            : 'permission';
      const always = suggestionRules(ctx.suggestions);
      const ask: Ask = {
        id,
        kind,
        tool: displayToolName(toolName),
        input: kind === 'permission' ? clipInput(input) : input,
        full: input,
        ...(always.length ? { always } : {}),
        ...(ctx.blockedPath ? { blockedPath: ctx.blockedPath } : {}),
        ...(ctx.decisionReason ? { reason: ctx.decisionReason } : {}),
        ...(ctx.suggestions ? { suggestions: ctx.suggestions } : {}),
        resolve: (p) => {
          if (!this.asks.includes(ask)) return;
          this.asks = this.asks.filter((a) => a !== ask);
          if (this.status === 'waiting' && this.asks.length === 0) this.status = 'working';
          resolve(p);
        },
      };
      this.asks.push(ask);
      this.status = 'waiting';
      ctx.signal.addEventListener('abort', () =>
        ask.resolve({ behavior: 'deny', message: 'The request was cancelled.' }),
      );
    });
  }

  /** The user's answer to a card. */
  async answer(id: string, a: AskAnswer): Promise<void> {
    const ask = this.asks.find((x) => x.id === id);
    if (!ask) throw new ChatError('That request is no longer pending.');
    if (a.decision === 'deny') {
      ask.resolve({
        behavior: 'deny',
        message:
          a.message?.trim() ||
          (ask.kind === 'question'
            ? 'The user chose not to answer these questions.'
            : ask.kind === 'plan'
              ? 'The user wants to keep planning.'
              : 'The user denied this.'),
      });
      return;
    }
    if (ask.kind === 'question') {
      ask.resolve({ behavior: 'allow', updatedInput: { ...ask.full, answers: a.answers ?? {} } });
      return;
    }
    ask.resolve({
      behavior: 'allow',
      updatedInput: ask.full,
      ...(a.decision === 'always' && ask.suggestions
        ? { updatedPermissions: ask.suggestions }
        : {}),
    });
    if (ask.kind === 'plan') await this.setMode(a.mode && a.mode !== 'plan' ? a.mode : 'default');
  }

  /** Change the permission mode: kept for the paper, applied to a running Claude at once. */
  async setMode(mode: string): Promise<void> {
    await this.mgr.store.setMeta(this.paper, { mode });
    try {
      await this.q?.setPermissionMode?.(mode);
    } catch (err) {
      this.mgr.log(`[${this.paper}] could not switch to ${mode}: ${(err as Error).message}`);
    }
  }

  private denyAll(message: string, interrupt = false): void {
    for (const a of [...this.asks]) {
      a.resolve({ behavior: 'deny', message, ...(interrupt ? { interrupt } : {}) });
    }
  }

  private async pump(q: QueryLike): Promise<void> {
    try {
      for await (const msg of q) {
        if (q !== this.q) break;
        await this.onMessage(msg);
      }
    } catch (err) {
      if (q === this.q && !this.abort?.signal.aborted) {
        this.error = (err as Error).message;
        await this.mgr.store.append(this.paper, [
          { k: 'note', text: `Claude stopped: ${(err as Error).message}`, t: new Date().toISOString() },
        ]);
      }
    } finally {
      if (q === this.q) {
        this.q = undefined;
        this.input = undefined;
        this.status = 'off';
        this.live = '';
        this.busySince = undefined;
        this.queued = [];
        this.denyAll('The session ended.');
      }
    }
  }

  private async onMessage(msg: SdkMessageLike & Record<string, unknown>): Promise<void> {
    const sid = typeof msg.session_id === 'string' ? msg.session_id : undefined;
    if (msg.type === 'system' && msg.subtype === 'init') {
      if (this.status === 'starting') this.status = 'working';
      if (typeof msg.model === 'string') this.mgr.models.set(this.paper, msg.model);
      if (Array.isArray(msg.slash_commands)) this.mgr.noteCommands(msg.slash_commands as string[]);
    }
    if (sid && msg.type !== 'stream_event') {
      const meta = await this.mgr.store.meta(this.paper);
      if (meta.sessionId !== sid) await this.mgr.store.setMeta(this.paper, { sessionId: sid });
    }
    if (msg.type === 'system' && msg.subtype === 'session_state_changed') {
      this.sawStateEvents = true;
      if (msg.state === 'idle') this.turnOver();
      else if (msg.state === 'requires_action') this.status = 'waiting';
      else if (msg.state === 'running') {
        if (this.status !== 'waiting') this.status = 'working';
        this.busySince ??= Date.now();
      }
      return;
    }
    if (msg.type === 'stream_event') {
      this.onStream(msg.event as Record<string, unknown> | undefined, msg.parent_tool_use_id);
      return;
    }
    if (msg.type === 'assistant' && !msg.parent_tool_use_id) {
      this.live = '';
      this.liveBlock = -1;
      if (this.status === 'starting') this.status = 'working';
      const tokens = contextTokens(msg);
      if (tokens) this.context = { tokens, window: this.window || 200_000 };
    }
    if (msg.type === 'user' && !msg.parent_tool_use_id) this.takeQueued(msg);
    if (msg.type === 'result') {
      const w = contextWindow(msg);
      if (w) {
        this.window = w;
        if (this.context) this.context = { ...this.context, window: w };
      }
      if (typeof msg.total_cost_usd === 'number') this.costUsd += msg.total_cost_usd;
      const consumed = msg.user_message_uuids;
      if (Array.isArray(consumed)) {
        this.queued = this.queued.filter((q) => !consumed.includes(q.uuid));
      }
      if (!this.sawStateEvents) this.turnOver();
    }
    const items: ChatItem[] = itemsFromMessage(msg);
    await this.mgr.store.append(this.paper, items);
  }

  /** A message of ours echoed back: Claude has taken it in. */
  private takeQueued(msg: Record<string, unknown>): void {
    const uuid = msg.uuid;
    if (typeof uuid === 'string') this.queued = this.queued.filter((q) => q.uuid !== uuid);
  }

  private onStream(event: Record<string, unknown> | undefined, parent: unknown): void {
    if (!event || parent) return;
    if (event.type === 'message_start') {
      this.live = '';
      this.liveBlock = -1;
    } else if (event.type === 'content_block_start') {
      const block = event.content_block as { type?: string } | undefined;
      if (block?.type === 'text') {
        this.liveBlock = typeof event.index === 'number' ? event.index : -1;
        this.live = '';
      }
    } else if (event.type === 'content_block_delta') {
      const d = event.delta as { type?: string; text?: string } | undefined;
      if (d?.type === 'text_delta' && typeof d.text === 'string' && event.index === this.liveBlock) {
        this.live += d.text;
      }
    }
  }

  private turnOver(): void {
    this.status = this.q ? 'idle' : 'off';
    this.live = '';
    this.busySince = undefined;
    this.queued = [];
    if (this.restartWhenIdle) {
      this.restartWhenIdle = false;
      this.stop();
    }
  }

  async interrupt(): Promise<void> {
    this.denyAll('Interrupted by the user.', true);
    if (!this.q || !this.working) return;
    await this.mgr.store.append(this.paper, [
      { k: 'note', text: 'Interrupted', t: new Date().toISOString() },
    ]);
    try {
      await this.q.interrupt();
    } catch (err) {
      this.mgr.log(`[${this.paper}] interrupt failed: ${(err as Error).message}`);
      this.stop();
    }
  }

  /** Apply a new model or effort: now when idle, else after the turn (the next query resumes). */
  settingsChanged(): void {
    if (!this.q) return;
    if (this.working) this.restartWhenIdle = true;
    else this.stop();
  }

  /** End this Claude's process; the conversation stays and resumes on the next message. */
  stop(): void {
    const q = this.q;
    this.q = undefined;
    this.input?.close();
    this.input = undefined;
    this.abort?.abort();
    this.abort = undefined;
    try {
      q?.close?.();
    } catch {
      // already gone
    }
    this.status = 'off';
    this.live = '';
    this.busySince = undefined;
    this.queued = [];
    this.denyAll('The session ended.');
  }

  async commands(): Promise<Array<{ name: string; description?: string; argumentHint?: string }>> {
    if (!this.q?.supportedCommands) return [];
    return this.q.supportedCommands();
  }
}

/** A chat request the manager cannot do as asked (400). */
export class ChatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatError';
  }
}

function sameEndpoint(a: DaemonEndpoint, b: DaemonEndpoint): boolean {
  return a.url === b.url && a.token === b.token;
}

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

export class ChatManager {
  readonly workspaceRoot: string;
  readonly store: ChatStore;
  readonly models = new Map<string, string>();
  private readonly chats = new Map<string, PaperChat>();
  private sdk: Promise<{ query?: StartQuery; error?: string }> | undefined;
  private readonly opts: ChatManagerOptions;
  private knownCommands: string[] = [];

  constructor(opts: ChatManagerOptions) {
    this.opts = opts;
    this.workspaceRoot = opts.workspaceRoot;
    this.store = opts.store;
  }

  log(line: string): void {
    (this.opts.log ?? ((l: string) => console.error(`[web-latex-mcp ui] ${l}`)))(line);
  }

  private sdkState(): Promise<{ query?: StartQuery; error?: string }> {
    this.sdk ??= (this.opts.loadQuery ?? loadSdkQuery)();
    return this.sdk;
  }

  /** Why chatting is not possible, or undefined when it is. */
  async unavailable(): Promise<string | undefined> {
    return (await this.sdkState()).error;
  }

  async query(): Promise<StartQuery> {
    const s = await this.sdkState();
    if (!s.query) throw new ChatError(s.error ?? 'The Agent SDK is not available.');
    return s.query;
  }

  endpointNow(): Promise<DaemonEndpoint> {
    return this.opts.endpoint();
  }

  async paperDir(paper: string): Promise<string | undefined> {
    try {
      return (await this.opts.paperDir?.(paper)) ?? undefined;
    } catch {
      return undefined;
    }
  }

  private chat(paper: string): PaperChat {
    let c = this.chats.get(paper);
    if (!c) {
      c = new PaperChat(paper, this);
      this.chats.set(paper, c);
    }
    return c;
  }

  status(paper: string): ChatStatus {
    return this.chats.get(paper)?.status ?? 'off';
  }

  async snapshot(paper: string): Promise<ChatSnapshot> {
    const meta = await this.store.meta(paper);
    const model = meta.model ?? this.models.get(paper);
    return this.chat(paper).snapshot({
      ...(model ? { model } : {}),
      ...(meta.effort ? { effort: meta.effort } : {}),
      ...(meta.mode ? { mode: meta.mode } : {}),
    });
  }

  async send(paper: string, text: string): Promise<void> {
    if (!text.trim()) throw new ChatError('The message is empty.');
    if (text.length > 100_000) throw new ChatError('The message is longer than 100000 characters.');
    await this.chat(paper).send(text);
  }

  async interrupt(paper: string): Promise<void> {
    await this.chats.get(paper)?.interrupt();
  }

  async answer(paper: string, id: string, a: AskAnswer): Promise<void> {
    const c = this.chats.get(paper);
    if (!c) throw new ChatError('That request is no longer pending.');
    await c.answer(id, a);
  }

  async setMode(paper: string, mode: string): Promise<void> {
    if (!PERMISSION_MODES.includes(mode)) {
      throw new ChatError(`mode must be one of ${PERMISSION_MODES.join(', ')}.`);
    }
    await this.chat(paper).setMode(mode);
  }

  async settings(paper: string, patch: { model?: string; effort?: string }): Promise<void> {
    if (patch.effort !== undefined && patch.effort !== '' && !EFFORTS.includes(patch.effort)) {
      throw new ChatError(`effort must be one of ${EFFORTS.join(', ')}.`);
    }
    if (patch.model !== undefined && !/^[\w.[\]:-]{0,100}$/.test(patch.model)) {
      throw new ChatError('That is not a model name.');
    }
    await this.store.setMeta(paper, patch);
    if (patch.model !== undefined) this.models.delete(paper);
    this.chats.get(paper)?.settingsChanged();
  }

  /** A new conversation: the current one is set aside, its Claude stopped. */
  async reset(paper: string): Promise<void> {
    this.chats.get(paper)?.stop();
    await this.store.reset(paper);
  }

  noteCommands(names: string[]): void {
    this.knownCommands = names.filter((n) => typeof n === 'string');
  }

  /** The slash commands: from a running Claude when one is, else the names its init listed. */
  async commands(): Promise<Array<{ name: string; description?: string; argumentHint?: string }>> {
    for (const c of this.chats.values()) {
      try {
        const list = await c.commands();
        if (list.length) return list;
      } catch {
        // that Claude ended meanwhile
      }
    }
    return this.knownCommands.map((name) => ({ name }));
  }

  stopAll(): void {
    for (const c of this.chats.values()) c.stop();
  }
}
