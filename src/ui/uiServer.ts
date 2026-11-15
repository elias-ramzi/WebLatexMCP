import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { browserRequestRefusal } from '../lib/loopbackHost.js';
import { getServerVersion } from '../lib/version.js';
import { ChatError, type ChatManager } from './chatEngine.js';
import { orderedIds, UiInputError, type PaperMetaStore } from './paperMeta.js';
import type { ToolAnswer } from './daemonClient.js';
import { DEV_CHAT } from './devMode.js';
import type { LiveStatus } from './liveMode.js';

/**
 * The web UI's listener (`web-latex-mcp ui`): the page, its static files, and a JSON API under
 * `/api/*`. Its own loopback listener, apart from the daemon's (which refuses every browser
 * request), on the same model as cc-servers and the credential portal:
 *
 * - bound to `127.0.0.1` only; `Host` must name this listener, and a non-GET request's `Origin`
 *   must be this listener (`browserRequestRefusal`) — DNS rebinding and other sites are refused;
 * - the page needs the token in its URL (`/?token=…`), and every `/api` call carries it in
 *   `X-WLM-Token`, compared in constant time; static files (no secret in them) need neither;
 * - the page runs under a nonce CSP; it may frame the viewer (a loopback page) and nothing else.
 *
 * Everything about projects goes through the daemon's own tools (`list_projects`,
 * `register_project`, `viewer`, `project_sync`, `compile`), so their guards apply here as for any client.
 */

export interface UiBackend {
  call(name: string, args?: Record<string, unknown>): Promise<ToolAnswer>;
}

export interface UiServerOptions {
  token: string;
  /** Where `index.html`, `app.css` and `js/` are. */
  staticDir: string;
  backend: UiBackend;
  papers: PaperMetaStore;
  chats: ChatManager;
  workspaceRoot: string;
  /** Which build the page belongs to: the page reloads itself when it changes (dev mode). */
  rev?: string;
  /** Dev mode (`ui --dev`): what the page shows of it. */
  dev?: UiDevState;
}

export interface UiDevState {
  /** The checkout the dev chat works in; absent, the dev chat is off and `problem` says why. */
  repo?: string;
  problem?: string;
  /** Why the build running now is not the newest (the newest did not start). */
  error?: string;
  /** A new build waits for the chats to finish their turns. */
  pending: () => boolean;
  /** Live mode (`--live`): what the worktree the UI runs from holds that is not shipped. */
  live?: () => Promise<LiveStatus>;
}

const MAX_BODY = 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

/** Answered with its status and message, never as a 500. */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function tokenMatches(given: string | undefined | null, token: string): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(token, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The page's CSP: its own scripts (and the nonce'd early one), and the viewer in a frame. */
export function pageCsp(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    'frame-src http://127.0.0.1:* http://localhost:*',
    // cc-servers may frame this page one day (it runs on loopback too); nothing else may.
    'frame-ancestors http://127.0.0.1:* http://localhost:*',
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join('; ');
}

interface PaperRow {
  id: string;
  title?: string;
  group?: string;
  labels: string[];
  mode: string;
  gitUrl?: string;
  cloned: boolean;
  status: string;
}

export class UiServer {
  private server: http.Server | undefined;
  private projectsCache: { at: number; rows: Array<Record<string, unknown>> } | undefined;

  constructor(private readonly opts: UiServerOptions) {}

  get port(): number {
    const a = this.server?.address();
    return typeof a === 'object' && a ? a.port : 0;
  }

  async start(port = 0): Promise<number> {
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((err: unknown) => {
        const status = err instanceof HttpError ? err.status : 500;
        if (status === 500) console.error(`[web-latex-mcp ui] ${(err as Error).stack ?? String(err)}`);
        send(res, status, { error: (err as Error).message });
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
    return this.port;
  }

  async close(): Promise<void> {
    const s = this.server;
    this.server = undefined;
    if (!s) return;
    s.closeAllConnections?.();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const refusal = browserRequestRefusal(
      { method: req.method, host: req.headers.host, origin: req.headers.origin },
      { port: this.port },
    );
    if (refusal) throw new HttpError(refusal.status, refusal.message);
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);
    if (url.pathname === '/' || url.pathname === '/index.html') {
      if (!tokenMatches(url.searchParams.get('token'), this.opts.token)) {
        throw new HttpError(
          401,
          'Open the address `web-latex-mcp ui` printed: it carries the page\'s token.',
        );
      }
      await this.page(res);
      return;
    }
    if (url.pathname.startsWith('/static/')) {
      await this.staticFile(url.pathname.slice('/static/'.length), res);
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      const given = req.headers['x-wlm-token'];
      if (!tokenMatches(Array.isArray(given) ? given[0] : given, this.opts.token)) {
        throw new HttpError(401, 'Missing or wrong token: reload the page from its address.');
      }
      const body = req.method === 'POST' ? await readJson(req) : {};
      send(res, 200, await this.api(req.method ?? 'GET', url, body));
      return;
    }
    throw new HttpError(404, 'Not found.');
  }

  private async page(res: http.ServerResponse): Promise<void> {
    const nonce = randomBytes(16).toString('base64');
    const html = (await readFile(path.join(this.opts.staticDir, 'index.html'), 'utf8')).replaceAll(
      '__NONCE__',
      nonce,
    );
    res.writeHead(200, {
      'content-type': CONTENT_TYPES['.html'] as string,
      'cache-control': 'no-store',
      'content-security-policy': pageCsp(nonce),
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    });
    res.end(html);
  }

  private async staticFile(rel: string, res: http.ServerResponse): Promise<void> {
    // One plain relative path under the static dir: no `..`, no absolute, no backslash.
    if (!/^[\w-]+(\/[\w-]+)*\.(css|js|svg|png)$/.test(rel)) throw new HttpError(404, 'Not found.');
    let data: Buffer;
    try {
      data = await readFile(path.join(this.opts.staticDir, ...rel.split('/')));
    } catch {
      throw new HttpError(404, 'Not found.');
    }
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[path.extname(rel)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    res.end(data);
  }

  /** The registered projects (list_projects), kept 2 s: the page polls. */
  private async projects(fresh = false): Promise<Array<Record<string, unknown>>> {
    const c = this.projectsCache;
    if (!fresh && c && Date.now() - c.at < 2000) return c.rows;
    const r = await this.opts.backend.call('list_projects');
    if (r.isError) throw new HttpError(502, r.text || 'list_projects failed.');
    const rows = Array.isArray(r.structured?.projects)
      ? (r.structured.projects as Array<Record<string, unknown>>)
      : [];
    this.projectsCache = { at: Date.now(), rows };
    return rows;
  }

  /** A paper's folder, from list_projects: where its Claude works. */
  async paperDir(paper: string): Promise<string | undefined> {
    const row = (await this.projects()).find((p) => p.project === paper);
    return row && row.cloned === true && typeof row.path === 'string' ? row.path : undefined;
  }

  private async requirePaper(value: unknown): Promise<string> {
    if (typeof value !== 'string' || !value) throw new HttpError(400, 'Name a paper.');
    if (value === DEV_CHAT) {
      if (!this.opts.dev?.repo) {
        throw new HttpError(404, this.opts.dev?.problem ?? 'The dev chat runs in dev mode only (ui --dev).');
      }
      return value;
    }
    let rows = await this.projects();
    if (!rows.some((p) => p.project === value)) rows = await this.projects(true);
    if (!rows.some((p) => p.project === value)) {
      throw new HttpError(404, 'There is no such paper (it may have been removed).');
    }
    return value;
  }

  private async api(method: string, url: URL, body: Record<string, unknown>): Promise<unknown> {
    const route = `${method} ${url.pathname}`;
    try {
      switch (route) {
        case 'GET /api/state':
          return await this.state();
        case 'GET /api/chat': {
          const paper = await this.requirePaper(url.searchParams.get('paper'));
          const offset = Number(url.searchParams.get('offset') ?? 0);
          const epoch = url.searchParams.get('epoch') ?? undefined;
          const read = await this.opts.chats.store.read(
            paper,
            Number.isInteger(offset) ? offset : 0,
            epoch || undefined,
          );
          return { ...read, ...(await this.opts.chats.snapshot(paper)) };
        }
        case 'POST /api/chat': {
          const paper = await this.requirePaper(body.paper);
          const chats = this.opts.chats;
          if (body.reset === true) await chats.reset(paper);
          else if (body.interrupt === true) await chats.interrupt(paper);
          else if (typeof body.text === 'string') await chats.send(paper, body.text);
          else if (typeof body.mode === 'string') await chats.setMode(paper, body.mode);
          else if (body.model !== undefined || body.effort !== undefined) {
            await chats.settings(paper, {
              ...(typeof body.model === 'string' ? { model: body.model } : {}),
              ...(typeof body.effort === 'string' ? { effort: body.effort } : {}),
            });
          } else {
            throw new HttpError(400, 'Nothing to do: send text, interrupt, reset, mode or settings.');
          }
          return { ok: true, ...(await chats.snapshot(paper)) };
        }
        case 'POST /api/answer': {
          const paper = await this.requirePaper(body.paper);
          if (typeof body.id !== 'string') throw new HttpError(400, 'Name the request.');
          const decision = body.decision;
          if (decision !== 'allow' && decision !== 'always' && decision !== 'deny') {
            throw new HttpError(400, 'decision must be allow, always or deny.');
          }
          let answers: Record<string, string> | undefined;
          if (body.answers !== undefined) {
            if (typeof body.answers !== 'object' || body.answers === null) {
              throw new HttpError(400, 'answers must map each question to its answer.');
            }
            answers = Object.create(null) as Record<string, string>;
            for (const [q, a] of Object.entries(body.answers as Record<string, unknown>)) {
              if (typeof a === 'string') answers[q] = a;
            }
          }
          await this.opts.chats.answer(paper, body.id, {
            decision,
            ...(typeof body.message === 'string' ? { message: body.message } : {}),
            ...(answers ? { answers } : {}),
            ...(typeof body.mode === 'string' ? { mode: body.mode } : {}),
          });
          return { ok: true };
        }
        case 'POST /api/papers':
          return await this.papersOp(body);
        case 'POST /api/register':
          return await this.register(body);
        case 'POST /api/sync':
          return await this.sync(await this.requirePaper(body.paper));
        case 'GET /api/viewer': {
          const paper = await this.requirePaper(url.searchParams.get('paper'));
          if (paper === DEV_CHAT) throw new HttpError(404, 'The dev chat has no paper to show.');
          const r = await this.opts.backend.call('viewer', { project: paper, target: 'vscode' });
          if (r.isError || typeof r.structured?.url !== 'string') {
            throw new HttpError(502, r.text || 'The viewer did not start.');
          }
          return { url: r.structured.url, rootFile: r.structured.rootFile ?? null };
        }
        case 'GET /api/commands':
          return { commands: await this.opts.chats.commands() };
        default:
          throw new HttpError(404, `No such call: ${route}`);
      }
    } catch (err) {
      if (err instanceof UiInputError || err instanceof ChatError) {
        throw new HttpError(400, err.message);
      }
      throw err;
    }
  }

  private async state(): Promise<unknown> {
    const [rows, meta, sdkError] = await Promise.all([
      this.projects(),
      this.opts.papers.read(),
      this.opts.chats.unavailable(),
    ]);
    const byId = new Map(rows.map((r) => [String(r.project), r]));
    const papers: PaperRow[] = orderedIds([...byId.keys()], meta.order).map((id) => {
      const r = byId.get(id) as Record<string, unknown>;
      const m = Object.hasOwn(meta.papers, id) ? meta.papers[id] : undefined;
      return {
        id,
        ...(m?.title ? { title: m.title } : {}),
        ...(m?.group ? { group: m.group } : {}),
        labels: m?.labels ?? [],
        mode: String(r.mode ?? 'git'),
        ...(typeof r.gitUrl === 'string' ? { gitUrl: r.gitUrl } : {}),
        cloned: r.cloned === true,
        status: this.opts.chats.status(id),
      };
    });
    const labels = [...new Set(papers.flatMap((p) => p.labels))].sort((a, b) => a.localeCompare(b));
    const dev = this.opts.dev;
    return {
      version: getServerVersion(),
      ...(this.opts.rev ? { rev: this.opts.rev } : {}),
      dev: dev
        ? {
            chat: Boolean(dev.repo),
            ...(dev.repo ? { repo: dev.repo } : {}),
            ...(dev.problem ? { problem: dev.problem } : {}),
            ...(dev.error ? { error: dev.error } : {}),
            pending: dev.pending(),
            status: dev.repo ? this.opts.chats.status(DEV_CHAT) : 'off',
            ...(dev.live ? { live: await dev.live() } : {}),
          }
        : null,
      workspace: this.opts.workspaceRoot,
      papers,
      groups: meta.groups,
      labels,
      sdk: sdkError ? { ok: false, error: sdkError } : { ok: true },
    };
  }

  private async papersOp(body: Record<string, unknown>): Promise<unknown> {
    const store = this.opts.papers;
    switch (body.op) {
      case 'set': {
        const paper = await this.requirePaper(body.paper);
        return {
          paper: await store.setPaper(paper, {
            ...(body.title !== undefined ? { title: body.title as string | null } : {}),
            ...(body.group !== undefined ? { group: body.group as string | null } : {}),
            ...(body.labels !== undefined ? { labels: body.labels } : {}),
          }),
        };
      }
      case 'group-add':
        return { group: await store.addGroup(body.name) };
      case 'group-rename':
        await store.renameGroup(String(body.id), body.name);
        return { ok: true };
      case 'group-delete':
        await store.deleteGroup(String(body.id));
        return { ok: true };
      case 'order':
        if (body.groups !== undefined) await store.orderGroups(body.groups);
        if (body.papers !== undefined) await store.orderPapers(body.papers);
        return { ok: true };
      default:
        throw new HttpError(400, 'Unknown op.');
    }
  }

  /**
   * The paper's "Pull" button: `project_sync` (ff-only, so it never merges over local work), then,
   * when it brought new commits, a `compile`, so the PDF beside the chat shows them. The compile's
   * failure does not make the pull fail: it is reported apart.
   */
  private async sync(paper: string): Promise<unknown> {
    if (paper === DEV_CHAT) throw new HttpError(404, 'The dev chat has no paper to pull.');
    const r = await this.opts.backend.call('project_sync', { project: paper });
    this.projectsCache = undefined;
    if (r.isError) throw new HttpError(400, r.text || 'project_sync failed.');
    const action = typeof r.structured?.action === 'string' ? r.structured.action : null;
    let compiled: boolean | null = null;
    let compileText: string | undefined;
    if (action === 'pulled' || action === 'cloned') {
      const c = await this.opts.backend
        .call('compile', { project: paper })
        .catch((err: unknown) => ({
          structured: undefined,
          text: err instanceof Error ? err.message : String(err),
          isError: true,
        }));
      compiled = !c.isError && c.structured?.success === true;
      if (!compiled) compileText = c.text.split('\n')[0]?.slice(0, 300) || 'The compile failed.';
    }
    return {
      action,
      text: r.text,
      compiled,
      ...(compileText ? { compileText } : {}),
    };
  }

  private async register(body: Record<string, unknown>): Promise<unknown> {
    const args: Record<string, unknown> = {};
    for (const k of ['project', 'gitUrl', 'path', 'rootFile', 'branch']) {
      if (typeof body[k] === 'string' && (body[k] as string).trim()) {
        args[k] = (body[k] as string).trim();
      }
    }
    if (!args.gitUrl && !args.path) throw new HttpError(400, 'Give a git URL or a local folder.');
    const r = await this.opts.backend.call('register_project', args);
    this.projectsCache = undefined;
    if (r.isError) throw new HttpError(400, r.text || 'register_project failed.');
    return { ok: true, text: r.text, project: r.structured?.project ?? args.project ?? null };
  }
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const type = req.headers['content-type'] ?? '';
  // A JSON body only: a cross-site form post (text/plain, urlencoded) is not even parsed.
  if (!/^application\/json\b/i.test(type)) throw new HttpError(415, 'Send JSON.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'The request is too large.');
    chunks.push(chunk as Buffer);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'The body is not a JSON object.');
  }
}
