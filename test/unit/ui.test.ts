import { describe, expect, it, afterEach } from 'vitest';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import {
  PaperMetaStore,
  UiInputError,
  orderedIds,
  parsePapersFile,
} from '../../src/ui/paperMeta.js';
import {
  clipInput,
  contextTokens,
  contextWindow,
  displayToolName,
  itemsFromMessage,
  summarizeToolInput,
  userItem,
  MAX_INPUT_VALUE_CHARS,
} from '../../src/ui/chatItems.js';
import { ChatStore } from '../../src/ui/chatStore.js';
import {
  ChatError,
  ChatManager,
  TOKEN_VAR,
  suggestionRules,
  uiSystemPrompt,
  type QueryLike,
  type StartArgs,
  type UserInput,
} from '../../src/ui/chatEngine.js';
import { UiServer, pageCsp, tokenMatches, type UiServerOptions } from '../../src/ui/uiServer.js';
import { DEV_CHAT } from '../../src/ui/devMode.js';
import { parseUiArgs } from '../../src/ui/uiCommand.js';
import { readUiInfo, removeUiInfo, writeUiInfo } from '../../src/ui/uiFiles.js';
import type { ToolAnswer } from '../../src/ui/daemonClient.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function tmp(): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), 'wlm-ui-'));
  dirs.push(d);
  return d;
}

describe('PaperMetaStore', () => {
  it('keeps titles, groups, labels and order in .ui/papers.json', async () => {
    const ws = await tmp();
    const store = new PaperMetaStore(ws);
    const g = await store.addGroup('  Thesis ');
    expect(g.name).toBe('Thesis');
    await store.setPaper('paper one', {
      title: 'My paper',
      group: g.id,
      labels: ['draft', 'draft', 'ICLR'],
    });
    await store.orderPapers(['b', 'paper one']);
    const again = await new PaperMetaStore(ws).read();
    expect(again.groups).toEqual([g]);
    expect(again.papers['paper one']).toEqual({
      title: 'My paper',
      group: g.id,
      labels: ['draft', 'ICLR'],
    });
    expect(again.order).toEqual(['b', 'paper one']);
  });

  it('keeps an id named __proto__ as a key, and a null-prototype map in memory', async () => {
    const ws = await tmp();
    const store = new PaperMetaStore(ws);
    await store.setPaper('__proto__', { labels: ['x'] });
    const text = await readFile(store.file, 'utf8');
    expect(JSON.parse(text).papers).toHaveProperty(['__proto__']);
    const state = await new PaperMetaStore(ws).read();
    expect(Object.getPrototypeOf(state.papers)).toBe(null);
    expect(state.papers['__proto__']?.labels).toEqual(['x']);
  });

  it('refuses control characters, empty names and too many labels', async () => {
    const store = new PaperMetaStore(await tmp());
    await expect(store.addGroup('a\nb')).rejects.toBeInstanceOf(UiInputError);
    await expect(store.addGroup('   ')).rejects.toThrow(/empty/);
    await expect(store.setPaper('p', { labels: ['a‮b'] })).rejects.toThrow(/control/);
    await expect(
      store.setPaper('p', { labels: Array.from({ length: 21 }, (_, i) => `l${i}`) }),
    ).rejects.toThrow(/at most 20/);
    await expect(store.setPaper('p', { group: 'g-nope' })).rejects.toThrow(/no such group/);
  });

  it('deletes a group without its papers, and reorders groups', async () => {
    const store = new PaperMetaStore(await tmp());
    const a = await store.addGroup('A');
    const b = await store.addGroup('B');
    await store.setPaper('p', { group: a.id });
    await store.orderGroups([b.id]);
    expect((await store.read()).groups.map((g) => g.name)).toEqual(['B', 'A']);
    await store.deleteGroup(a.id);
    const s = await store.read();
    expect(s.groups.map((g) => g.name)).toEqual(['B']);
    expect(s.papers.p?.group).toBeUndefined();
  });

  it('reads a damaged file for what is well formed', () => {
    const s = parsePapersFile(
      '{"groups":[{"id":"g1","name":"A"},{"id":"g1","name":"dup"},3],' +
        '"papers":{"p":{"group":"gone","labels":["x",4]}},"order":["p","p",1]}',
    );
    expect(s.groups).toEqual([{ id: 'g1', name: 'A' }]);
    expect(s.papers.p).toEqual({ labels: ['x'] });
    expect(s.order).toEqual(['p']);
    expect(parsePapersFile('not json').groups).toEqual([]);
  });

  it('orders ids: stored ones first, the rest by name', () => {
    expect(orderedIds(['c', 'a', 'b', 'z'], ['z', 'b'])).toEqual(['z', 'b', 'a', 'c']);
  });
});

describe('chat items', () => {
  const now = new Date('2026-11-14T10:00:00Z');

  it('turns an assistant message into text, thinking and tool items', () => {
    const items = itemsFromMessage(
      {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [
            { type: 'thinking', thinking: 'hmm' },
            { type: 'text', text: 'Compiling.' },
            {
              type: 'tool_use',
              id: 't1',
              name: 'mcp__web-latex-mcp__edit_file',
              input: {
                path: 'main.tex',
                edits: [{ oldString: 'a', newString: 'b' }],
                compile: true,
              },
            },
          ],
        },
      },
      now,
    );
    expect(items.map((i) => i.k)).toEqual(['thinking', 'text', 'tool']);
    expect(items[2]).toMatchObject({
      k: 'tool',
      id: 't1',
      name: 'edit_file',
      summary: 'main.tex · 1 edit · then compile',
    });
    expect((items[2] as unknown as { input: { edits: unknown[] } }).input.edits).toEqual([
      { oldString: 'a', newString: 'b' },
    ]);
  });

  it('turns tool results into result items, and leaves out a subagent’s own messages', () => {
    expect(
      itemsFromMessage({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'ok' }] },
            { type: 'tool_result', tool_use_id: 't2', content: 'boom', is_error: true },
          ],
        },
      }),
    ).toEqual([
      { k: 'result', id: 't1', text: 'ok', error: false },
      { k: 'result', id: 't2', text: 'boom', error: true },
    ]);
    expect(
      itemsFromMessage({
        type: 'assistant',
        parent_tool_use_id: 'agent-1',
        message: { content: [{ type: 'text', text: 'inner' }] },
      }),
    ).toEqual([]);
  });

  it('notes a failed turn, says nothing of a successful one', () => {
    expect(itemsFromMessage({ type: 'result', subtype: 'success', is_error: false })).toEqual([]);
    expect(
      itemsFromMessage({ type: 'result', subtype: 'error_during_execution', errors: ['x'] }, now),
    ).toEqual([{ k: 'note', text: 'x', t: now.toISOString() }]);
  });

  it('cuts long inputs, names tools and commands', () => {
    const big = clipInput({ content: 'x'.repeat(MAX_INPUT_VALUE_CHARS + 10), n: 2 });
    expect(String(big.content)).toMatch(/10 more characters not shown/);
    expect(big.n).toBe(2);
    expect(displayToolName('mcp__plugin_web-latex-mcp_web-latex-mcp__compile')).toBe('compile');
    expect(displayToolName('Bash')).toBe('Bash');
    expect(summarizeToolInput({ query: 'deep metric learning', maxResults: 5 })).toBe(
      'deep metric learning',
    );
    expect(userItem('/review-paper main.tex', now)).toMatchObject({ k: 'cmd' });
    expect(userItem('/ not a command', now)).toMatchObject({ k: 'user' });
  });

  it('reads the context from usage and the window from a result', () => {
    expect(
      contextTokens({
        type: 'assistant',
        message: { usage: { input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 5 } },
      }),
    ).toBe(115);
    expect(contextWindow({ modelUsage: { a: { contextWindow: 200000 } } })).toBe(200000);
    expect(contextWindow({})).toBeUndefined();
  });
});

describe('ChatStore', () => {
  it('reads from an offset, survives a reload, and restarts after a reset', async () => {
    const ws = await tmp();
    const store = new ChatStore(ws);
    await store.append('p', [userItem('hi'), { k: 'text', text: 'hello', t: 'x' }]);
    const first = await store.read('p', 0);
    expect(first.items).toHaveLength(2);
    expect((await store.read('p', 1, first.epoch)).items).toHaveLength(1);
    await store.setMeta('p', { sessionId: 's1', model: 'opus' });
    const again = new ChatStore(ws);
    expect((await again.read('p')).items).toHaveLength(2);
    expect(await again.meta('p')).toEqual({ paper: 'p', sessionId: 's1', model: 'opus' });
    await again.reset('p');
    const after = await again.read('p', 2, first.epoch);
    expect(after).toMatchObject({ items: [], next: 0, restart: true });
    expect((await again.meta('p')).sessionId).toBeUndefined();
    expect((await again.meta('p')).model).toBe('opus');
  });

  it('never takes another paper’s session from a meta file naming another paper', async () => {
    const ws = await tmp();
    const store = new ChatStore(ws);
    await store.setMeta('a', { sessionId: 'sa' });
    const file = (await import('node:fs/promises')).readdir;
    const names = await file(path.join(ws, '.ui', 'chats'));
    const meta = names.find((n) => n.endsWith('.json')) as string;
    const text = (await readFile(path.join(ws, '.ui', 'chats', meta), 'utf8')).replace(
      '"a"',
      '"b"',
    );
    await writeFile(path.join(ws, '.ui', 'chats', meta), text);
    expect((await new ChatStore(ws).meta('a')).sessionId).toBeUndefined();
  });
});

/** A stand-in for the SDK's query(): the test feeds it messages and reads what it was sent. */
class FakeQuery implements QueryLike {
  sent: UserInput[] = [];
  interrupted = 0;
  modes: string[] = [];
  private queue: Array<Record<string, unknown>> = [];
  private wake: (() => void) | undefined;
  private done = false;

  constructor(readonly args: StartArgs) {
    void (async () => {
      for await (const m of args.prompt) this.sent.push(m);
    })();
  }

  emit(msg: Record<string, unknown>): void {
    this.queue.push(msg);
    this.wake?.();
  }

  end(): void {
    this.done = true;
    this.wake?.();
  }

  async interrupt(): Promise<void> {
    this.interrupted++;
  }

  async setPermissionMode(mode: string): Promise<void> {
    this.modes.push(mode);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Record<string, unknown> & { type: string }> {
    for (;;) {
      const m = this.queue.shift();
      if (m) {
        yield m as Record<string, unknown> & { type: string };
        continue;
      }
      if (this.done) return;
      await new Promise<void>((r) => (this.wake = r));
    }
  }
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));
/** Wait (up to 5 s) until `check` holds: the engine works off a message pump. */
async function until(check: () => Promise<boolean> | boolean): Promise<void> {
  for (let i = 0; i < 250; i++) {
    if (await check()) return;
    await settle();
  }
  throw new Error('timed out waiting');
}

async function manager(): Promise<{ mgr: ChatManager; queries: FakeQuery[]; ws: string }> {
  const ws = await tmp();
  const queries: FakeQuery[] = [];
  const mgr = new ChatManager({
    workspaceRoot: ws,
    store: new ChatStore(ws),
    endpoint: async () => ({ url: 'http://127.0.0.1:1/mcp', token: 'secret-token' }),
    paperDir: async () => ws,
    loadQuery: async () => ({
      query: (args) => {
        const q = new FakeQuery(args);
        queries.push(q);
        return q;
      },
    }),
    log: () => undefined,
  });
  return { mgr, queries, ws };
}

describe('ChatManager', () => {
  it('starts a Claude in the paper’s folder, the token in its environment only', async () => {
    const { mgr, queries, ws } = await manager();
    await mgr.send('p', 'hello');
    const q = queries[0] as FakeQuery;
    await until(() => q.sent.length > 0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SDK's options, untyped here
    const o = q.args.options as Record<string, any>;
    expect(o.cwd).toBe(ws);
    expect(JSON.stringify(o.mcpServers)).not.toContain('secret-token');
    expect(o.mcpServers['web-latex-mcp'].headers.authorization).toBe(`Bearer \${${TOKEN_VAR}}`);
    expect(o.env[TOKEN_VAR]).toBe('secret-token');
    expect(o.mcpServers['web-latex-mcp'].headers['x-web-latex-mcp-default-project']).toBe('p');
    expect(o.allowedTools).toEqual(['mcp__web-latex-mcp__*']);
    expect(o.permissionMode).toBe('default');
    expect(q.sent.map((m) => m.message.content)).toEqual(['hello']);
    q.emit({ type: 'system', subtype: 'init', session_id: 'S1', model: 'opus' });
    q.emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hi.' }] } });
    q.emit({ type: 'result', subtype: 'success', session_id: 'S1', modelUsage: {} });
    await until(async () => (await mgr.snapshot('p')).status === 'idle');
    const snap = await mgr.snapshot('p');
    expect(snap.status).toBe('idle');
    expect((await mgr.store.read('p')).items.map((i) => i.k)).toEqual(['user', 'text']);
    expect((await mgr.store.meta('p')).sessionId).toBe('S1');
  });

  it('turns a permission request into a card, and "always" hands back Claude Code’s rule', async () => {
    const { mgr, queries } = await manager();
    await mgr.send('p', 'go');
    const q = queries[0] as FakeQuery;
    const suggestions = [
      {
        type: 'addRules',
        rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }],
        behavior: 'allow',
        destination: 'session',
      },
    ];
    const decision = q.args.options.canUseTool(
      'Bash',
      { command: 'ls' },
      { signal: new AbortController().signal, suggestions },
    );
    const snap = await mgr.snapshot('p');
    expect(snap.status).toBe('waiting');
    expect(snap.asks).toEqual([
      expect.objectContaining({ kind: 'permission', tool: 'Bash', always: ['Bash(ls:*)'] }),
    ]);
    await mgr.answer('p', snap.asks[0]!.id, { decision: 'always' });
    expect(await decision).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'ls' },
      updatedPermissions: suggestions,
    });
    expect((await mgr.snapshot('p')).asks).toEqual([]);
  });

  it('answers a question with the answers, denies with the user’s words, and switches mode on a plan', async () => {
    const { mgr, queries } = await manager();
    await mgr.send('p', 'go');
    const q = queries[0] as FakeQuery;
    const signal = new AbortController().signal;
    const asked = q.args.options.canUseTool(
      'AskUserQuestion',
      { questions: [{ question: 'Q?' }] },
      { signal },
    );
    const denied = q.args.options.canUseTool('Write', { file_path: '/x' }, { signal });
    const plan = q.args.options.canUseTool('ExitPlanMode', { plan: '# Plan' }, { signal });
    const asks = (await mgr.snapshot('p')).asks;
    expect(asks.map((a) => a.kind)).toEqual(['question', 'permission', 'plan']);
    await mgr.answer('p', asks[0]!.id, { decision: 'allow', answers: { 'Q?': 'yes' } });
    await mgr.answer('p', asks[1]!.id, { decision: 'deny', message: 'not there' });
    await mgr.answer('p', asks[2]!.id, { decision: 'allow', mode: 'acceptEdits' });
    expect(await asked).toEqual({
      behavior: 'allow',
      updatedInput: { questions: [{ question: 'Q?' }], answers: { 'Q?': 'yes' } },
    });
    expect(await denied).toEqual({ behavior: 'deny', message: 'not there' });
    expect(await plan).toMatchObject({ behavior: 'allow' });
    expect(q.modes).toEqual(['acceptEdits']);
    expect((await mgr.snapshot('p')).mode).toBe('acceptEdits');
    await expect(mgr.answer('p', asks[0]!.id, { decision: 'allow' })).rejects.toBeInstanceOf(
      ChatError,
    );
  });

  it('interrupts: the turn and every pending card', async () => {
    const { mgr, queries } = await manager();
    await mgr.send('p', 'go');
    const q = queries[0] as FakeQuery;
    q.emit({ type: 'system', subtype: 'init', session_id: 'S' });
    await until(async () => (await mgr.snapshot('p')).status === 'working');
    const pending = q.args.options.canUseTool(
      'Bash',
      { command: 'x' },
      { signal: new AbortController().signal },
    );
    await mgr.interrupt('p');
    expect(q.interrupted).toBe(1);
    expect(await pending).toMatchObject({ behavior: 'deny', interrupt: true });
    expect((await mgr.store.read('p')).items.at(-1)).toMatchObject({
      k: 'note',
      text: 'Interrupted',
    });
  });

  it('runs the dev chat in the checkout, with its own brief, in Auto mode and no default paper', async () => {
    const ws = await tmp();
    const queries: FakeQuery[] = [];
    const mgr = new ChatManager({
      workspaceRoot: ws,
      store: new ChatStore(ws),
      endpoint: async () => ({ url: 'http://127.0.0.1:1/mcp', token: 't' }),
      paperDir: async () => ws,
      dev: { repo: '/the/checkout', prompt: 'You are the developer.' },
      loadQuery: async () => ({
        query: (args) => {
          const q = new FakeQuery(args);
          queries.push(q);
          return q;
        },
      }),
      log: () => undefined,
    });
    await mgr.send(DEV_CHAT, 'make the button blue');
    const q = queries[0] as FakeQuery;
    await until(() => q.sent.length > 0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SDK's options, untyped here
    const o = q.args.options as Record<string, any>;
    expect(o.cwd).toBe('/the/checkout');
    expect(o.permissionMode).toBe('auto');
    expect(o.systemPrompt.append).toBe('You are the developer.');
    const headers = o.mcpServers['web-latex-mcp'].headers;
    expect(headers['x-web-latex-mcp-default-project']).toBeUndefined();
    expect(mgr.active()).toBe(true);
    q.emit({ type: 'result', subtype: 'success', session_id: 'S', modelUsage: {} });
    await until(() => !mgr.active());

    const plain = await manager();
    await expect(plain.mgr.send(DEV_CHAT, 'hi')).rejects.toThrow(/dev mode only/);
  });

  it('says why the chat is off when the SDK is missing', async () => {
    const ws = await tmp();
    const mgr = new ChatManager({
      workspaceRoot: ws,
      store: new ChatStore(ws),
      endpoint: async () => ({ url: 'u', token: 't' }),
      loadQuery: async () => ({ error: 'not installed' }),
      log: () => undefined,
    });
    expect(await mgr.unavailable()).toBe('not installed');
    await expect(mgr.send('p', 'hi')).rejects.toThrow('not installed');
    await expect(mgr.setMode('p', 'yolo')).rejects.toThrow(/mode must be/);
    await expect(mgr.settings('p', { effort: 'huge' })).rejects.toThrow(/effort must be/);
  });

  it('tells Claude the PDF is already shown, so it does not open the viewer again', () => {
    const p = uiSystemPrompt('thesis');
    expect(p).toContain('"thesis"');
    expect(p).toMatch(/Do not call the `viewer` tool/);
  });

  it('words a suggestion as rules', () => {
    expect(
      suggestionRules([
        { type: 'addRules', rules: [{ toolName: 'WebFetch', ruleContent: 'domain:arxiv.org' }] },
        { type: 'setMode', mode: 'acceptEdits' },
        { type: 'addDirectories', directories: ['/tmp/x'] },
      ]),
    ).toEqual(['WebFetch(domain:arxiv.org)', 'mode: acceptEdits', 'directory /tmp/x']);
  });
});

describe('UiServer', () => {
  async function server(
    extra: Partial<UiServerOptions> = {},
  ): Promise<{ srv: UiServer; port: number; ws: string; calls: string[] }> {
    const ws = await tmp();
    const staticDir = path.join(ws, 'static');
    await mkdir(path.join(staticDir, 'js'), { recursive: true });
    await writeFile(path.join(staticDir, 'index.html'), '<script nonce="__NONCE__"></script>');
    await writeFile(path.join(staticDir, 'js', 'app.js'), 'export {};');
    const calls: string[] = [];
    const store = new ChatStore(ws);
    const srv = new UiServer({
      token: 'tok',
      staticDir,
      workspaceRoot: ws,
      papers: new PaperMetaStore(ws),
      chats: new ChatManager({
        workspaceRoot: ws,
        store,
        endpoint: async () => ({ url: 'u', token: 't' }),
        loadQuery: async () => ({ error: 'no sdk here' }),
        log: () => undefined,
      }),
      backend: {
        async call(name, args) {
          calls.push(`${name} ${JSON.stringify(args ?? {})}`);
          if (name === 'list_projects') {
            return {
              structured: { projects: [{ project: 'p', path: ws, mode: 'local', cloned: true }] },
              text: '',
              isError: false,
            };
          }
          if (name === 'viewer') {
            return {
              structured: { url: 'http://127.0.0.1:9/p/p', rootFile: 'main.tex' },
              text: '',
              isError: false,
            };
          }
          return { structured: { project: 'new' }, text: 'Registered', isError: false };
        },
      },
      ...extra,
    });
    const port = await srv.start(0);
    return { srv, port, ws, calls };
  }

  function req(
    port: number,
    opts: { path: string; method?: string; headers?: Record<string, string>; body?: unknown },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON of any shape, or the page
  ): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
      const r = http.request(
        {
          host: '127.0.0.1',
          port,
          path: opts.path,
          method: opts.method ?? 'GET',
          headers: { host: `127.0.0.1:${port}`, ...(opts.headers ?? {}) },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- as above
            let body: any = data;
            try {
              body = JSON.parse(data);
            } catch {
              // the page
            }
            resolve({ status: res.statusCode ?? 0, body, headers: res.headers });
          });
        },
      );
      r.on('error', reject);
      if (opts.body !== undefined) r.end(JSON.stringify(opts.body));
      else r.end();
    });
  }

  const auth = { 'x-wlm-token': 'tok', 'content-type': 'application/json' };

  it('guards the page, the API and the listener', async () => {
    const { srv, port } = await server();
    try {
      expect((await req(port, { path: '/' })).status).toBe(401);
      const page = await req(port, { path: '/?token=tok' });
      expect(page.status).toBe(200);
      const nonce = /nonce="([^"]+)"/.exec(page.body)?.[1];
      expect(page.headers['content-security-policy']).toContain(`'nonce-${nonce}'`);
      expect((await req(port, { path: '/static/js/app.js' })).status).toBe(200);
      expect((await req(port, { path: '/static/..%2Findex.html' })).status).toBe(404);
      expect((await req(port, { path: '/api/state' })).status).toBe(401);
      expect(
        (await req(port, { path: '/api/state', headers: { 'x-wlm-token': 'tok2' } })).status,
      ).toBe(401);
      expect(
        (
          await req(port, {
            path: '/api/state',
            headers: { ...auth, host: `evil.example:${port}` },
          })
        ).status,
      ).toBe(421);
      const foreign = await req(port, {
        path: '/api/papers',
        method: 'POST',
        headers: { ...auth, origin: 'http://evil.example' },
        body: { op: 'group-add', name: 'x' },
      });
      expect(foreign.status).toBe(403);
      const form = await req(port, {
        path: '/api/papers',
        method: 'POST',
        headers: { 'x-wlm-token': 'tok', 'content-type': 'text/plain' },
        body: { op: 'group-add', name: 'x' },
      });
      expect(form.status).toBe(415);
    } finally {
      await srv.close();
    }
  });

  it('lists papers with their metadata, edits them, and opens the viewer through the tools', async () => {
    const { srv, port, calls } = await server();
    try {
      const g = await req(port, {
        path: '/api/papers',
        method: 'POST',
        headers: auth,
        body: { op: 'group-add', name: 'Thesis' },
      });
      await req(port, {
        path: '/api/papers',
        method: 'POST',
        headers: auth,
        body: { op: 'set', paper: 'p', group: g.body.group.id, labels: ['draft'] },
      });
      const st = await req(port, { path: '/api/state', headers: auth });
      expect(st.body).toMatchObject({
        papers: [{ id: 'p', group: g.body.group.id, labels: ['draft'], status: 'off' }],
        labels: ['draft'],
        sdk: { ok: false, error: 'no sdk here' },
      });
      const unknown = await req(port, {
        path: '/api/papers',
        method: 'POST',
        headers: auth,
        body: { op: 'set', paper: 'nope', labels: [] },
      });
      expect(unknown.status).toBe(404);
      const v = await req(port, { path: '/api/viewer?paper=p', headers: auth });
      expect(v.body).toEqual({ url: 'http://127.0.0.1:9/p/p', rootFile: 'main.tex' });
      expect(calls).toContain('viewer {"project":"p","target":"vscode"}');
      const chat = await req(port, { path: '/api/chat?paper=p', headers: auth });
      expect(chat.body).toMatchObject({ items: [], status: 'off', asks: [] });
      const send = await req(port, {
        path: '/api/chat',
        method: 'POST',
        headers: auth,
        body: { paper: 'p', text: 'hi' },
      });
      expect(send).toMatchObject({ status: 400, body: { error: 'no sdk here' } });
      const reg = await req(port, {
        path: '/api/register',
        method: 'POST',
        headers: auth,
        body: { path: '/x', project: 'new', junk: 1 },
      });
      expect(reg.body).toMatchObject({ ok: true, project: 'new' });
      expect(calls).toContain('register_project {"project":"new","path":"/x"}');
      expect(await srv.paperDir('p')).toBeTruthy();
    } finally {
      await srv.close();
    }
  });

  it('pulls a paper from its remote, and recompiles only when that brought commits', async () => {
    const calls: string[] = [];
    const answers: Record<string, ToolAnswer> = {
      project_sync: {
        structured: { action: 'pulled', behind: 0 },
        text: 'p: pulled',
        isError: false,
      },
      compile: { structured: { success: true }, text: 'ok', isError: false },
    };
    const { srv, port } = await server({
      backend: {
        async call(name, args) {
          calls.push(`${name} ${JSON.stringify(args ?? {})}`);
          if (name === 'list_projects') {
            return {
              structured: { projects: [{ project: 'p', path: '/x', mode: 'git', cloned: true }] },
              text: '',
              isError: false,
            };
          }
          return answers[name] ?? { structured: undefined, text: 'no', isError: true };
        },
      },
    });
    const pull = () =>
      req(port, { path: '/api/sync', method: 'POST', headers: auth, body: { paper: 'p' } });
    try {
      expect((await pull()).body).toEqual({ action: 'pulled', text: 'p: pulled', compiled: true });
      expect(calls).toContain('project_sync {"project":"p"}');
      expect(calls).toContain('compile {"project":"p"}');

      answers.compile = {
        structured: { success: false },
        text: 'Undefined control sequence\nmore',
        isError: false,
      };
      expect((await pull()).body).toMatchObject({
        compiled: false,
        compileText: 'Undefined control sequence',
      });

      calls.length = 0;
      answers.project_sync = {
        structured: { action: 'up-to-date' },
        text: 'p: up-to-date',
        isError: false,
      };
      expect((await pull()).body).toMatchObject({ action: 'up-to-date', compiled: null });
      expect(calls.some((c) => c.startsWith('compile'))).toBe(false);

      answers.project_sync = {
        structured: undefined,
        text: 'Not possible to fast-forward',
        isError: true,
      };
      expect(await pull()).toMatchObject({
        status: 400,
        body: { error: 'Not possible to fast-forward' },
      });

      const missing = await req(port, {
        path: '/api/sync',
        method: 'POST',
        headers: auth,
        body: { paper: 'nope' },
      });
      expect(missing.status).toBe(404);
    } finally {
      await srv.close();
    }
  });

  it('serves the dev chat and the build id in dev mode only', async () => {
    const plain = await server();
    const st = await req(plain.port, { path: '/api/state', headers: auth });
    expect(st.body.dev).toBeNull();
    expect(st.body.rev).toBeUndefined();
    const off = await req(plain.port, { path: `/api/chat?paper=${DEV_CHAT}`, headers: auth });
    expect(off.status).toBe(404);
    expect(off.body.error).toMatch(/dev mode only/);
    await plain.srv.close();

    let pending = false;
    const dev = await server({ rev: 'build-1', dev: { repo: '/r', pending: () => pending } });
    pending = true;
    const st2 = await req(dev.port, { path: '/api/state', headers: auth });
    expect(st2.body.rev).toBe('build-1');
    expect(st2.body.dev).toEqual({ chat: true, repo: '/r', pending: true, status: 'off' });
    const chat = await req(dev.port, { path: `/api/chat?paper=${DEV_CHAT}`, headers: auth });
    expect(chat.status).toBe(200);
    expect(chat.body.items).toEqual([]);
    expect(chat.body.mode).toBe('auto');
    const viewer = await req(dev.port, { path: `/api/viewer?paper=${DEV_CHAT}`, headers: auth });
    expect(viewer.status).toBe(404);
    expect(dev.calls.some((c) => c.startsWith('viewer'))).toBe(false);
    await dev.srv.close();

    const noRepo = await server({ dev: { problem: 'No checkout here.', pending: () => false } });
    const st3 = await req(noRepo.port, { path: '/api/state', headers: auth });
    expect(st3.body.dev).toMatchObject({ chat: false, problem: 'No checkout here.' });
    const refused = await req(noRepo.port, { path: `/api/chat?paper=${DEV_CHAT}`, headers: auth });
    expect(refused.body.error).toBe('No checkout here.');
    await noRepo.srv.close();
  });

  it('compares tokens exactly, and lets frames only on loopback', () => {
    expect(tokenMatches('abc', 'abc')).toBe(true);
    expect(tokenMatches('abd', 'abc')).toBe(false);
    expect(tokenMatches(undefined, 'abc')).toBe(false);
    expect(pageCsp('n')).toContain('frame-src http://127.0.0.1:* http://localhost:*');
  });
});

describe('web-latex-mcp ui', () => {
  it('parses its arguments', () => {
    expect(parseUiArgs([])).toEqual({ port: 0, open: true, dev: false });
    expect(parseUiArgs(['--no-open', '--port', '7778', '--to', 'ws'])).toEqual({
      port: 7778,
      open: false,
      to: 'ws',
      dev: false,
    });
    expect(parseUiArgs(['--dev', '--repo', '../wlm'])).toEqual({
      port: 0,
      open: true,
      dev: true,
      repo: '../wlm',
    });
    expect(parseUiArgs(['--repo', 'x'])).toMatch(/goes with --dev/);
    expect(parseUiArgs(['--port', 'x'])).toMatch(/not a port/);
    expect(parseUiArgs(['--what'])).toMatch(/Unknown argument/);
  });

  it('keeps ui.json 0600, and only while its process lives', async () => {
    const ws = await tmp();
    await writeUiInfo(ws, { pid: process.pid, port: 1, token: 't', startedAt: '' });
    expect(await readUiInfo(ws)).toMatchObject({ port: 1, token: 't' });
    if (process.platform !== 'win32') {
      const { stat } = await import('node:fs/promises');
      expect((await stat(path.join(ws, '.ui', 'ui.json'))).mode & 0o777).toBe(0o600);
    }
    await removeUiInfo(ws, process.pid + 1);
    expect(await readUiInfo(ws)).toBeDefined();
    await removeUiInfo(ws);
    expect(await readUiInfo(ws)).toBeUndefined();
    await writeUiInfo(ws, { pid: 2 ** 22 + 12345, port: 1, token: 't', startedAt: '' });
    expect(await readUiInfo(ws)).toBeUndefined();
  });
});
