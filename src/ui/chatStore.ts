import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { appendFile, readFile, rename } from 'node:fs/promises';
import type { ChatItem } from './chatItems.js';
import { ensureUiDir, uiDir, writeFileAtomic } from './uiFiles.js';

/**
 * Each paper's conversation in the UI, under `<workspace>/.ui/chats/`:
 *
 * - `<key>.jsonl`: its items, one per line, appended as they come — what the page shows, read
 *   back from an offset (`read`), as cc-servers reads a transcript;
 * - `<key>.json`: the Agent SDK session it resumes, and the model and effort chosen.
 *
 * `<key>` is a hash of the project id: an id is a directory name, not always a safe file name on
 * every platform, and the id itself is kept inside the `.json`. `reset` sets the conversation
 * aside (`<key>.<time>.jsonl`) and starts a new one.
 */

export interface ChatMeta {
  paper: string;
  /** The SDK session to resume; absent until the first turn. */
  sessionId?: string;
  model?: string;
  effort?: string;
  /** Claude Code's permission mode for this paper. */
  mode?: string;
  /** The folder the session ran in: Claude Code resumes a conversation only from there. */
  cwd?: string;
}

export function chatKey(paper: string): string {
  return createHash('sha256').update(paper, 'utf8').digest('hex').slice(0, 24);
}

interface Loaded {
  items: ChatItem[];
  meta: ChatMeta;
  /** Changes when the conversation is reset: a page holding another epoch reads from 0 again. */
  epoch: string;
  /** Appends to the file, in order. */
  chain: Promise<void>;
}

export class ChatStore {
  private readonly chats = new Map<string, Promise<Loaded>>();

  constructor(private readonly workspaceRoot: string) {}

  private dir(): string {
    return path.join(uiDir(this.workspaceRoot), 'chats');
  }

  private paths(paper: string): { log: string; meta: string } {
    const key = chatKey(paper);
    return { log: path.join(this.dir(), `${key}.jsonl`), meta: path.join(this.dir(), `${key}.json`) };
  }

  private load(paper: string): Promise<Loaded> {
    let p = this.chats.get(paper);
    if (!p) {
      p = this.readFromDisk(paper);
      this.chats.set(paper, p);
      p.catch(() => this.chats.delete(paper));
    }
    return p;
  }

  private async readFromDisk(paper: string): Promise<Loaded> {
    const { log, meta } = this.paths(paper);
    const items: ChatItem[] = [];
    for (const line of (await readOrEmpty(log)).split('\n')) {
      if (!line.trim()) continue;
      try {
        const it = JSON.parse(line) as ChatItem;
        if (it && typeof it.k === 'string') items.push(it);
      } catch {
        // a line cut by a crash: skipped
      }
    }
    let m: ChatMeta = { paper };
    try {
      const raw = JSON.parse(await readOrEmpty(meta)) as Partial<ChatMeta>;
      // A hash collision, or a file copied by hand: never resume another paper's session.
      if (raw && raw.paper === paper) {
        m = {
          paper,
          ...(typeof raw.sessionId === 'string' ? { sessionId: raw.sessionId } : {}),
          ...(typeof raw.model === 'string' ? { model: raw.model } : {}),
          ...(typeof raw.effort === 'string' ? { effort: raw.effort } : {}),
          ...(typeof raw.mode === 'string' ? { mode: raw.mode } : {}),
          ...(typeof raw.cwd === 'string' ? { cwd: raw.cwd } : {}),
        };
      }
    } catch {
      // none yet
    }
    return { items, meta: m, epoch: newEpoch(), chain: Promise.resolve() };
  }

  /** Items from `offset` on, and the offset to ask from next time. */
  async read(
    paper: string,
    offset = 0,
    epoch?: string,
  ): Promise<{ items: ChatItem[]; next: number; epoch: string; restart: boolean }> {
    const c = await this.load(paper);
    const restart = (epoch !== undefined && epoch !== c.epoch) || offset > c.items.length;
    const from = restart || offset < 0 ? 0 : offset;
    return { items: c.items.slice(from), next: c.items.length, epoch: c.epoch, restart };
  }

  async count(paper: string): Promise<number> {
    return (await this.load(paper)).items.length;
  }

  /** Add items: at once in memory (the next `read` has them), then to the file, in order. */
  async append(paper: string, items: readonly ChatItem[]): Promise<void> {
    if (items.length === 0) return;
    const c = await this.load(paper);
    c.items.push(...items);
    const text = items.map((it) => `${JSON.stringify(it)}\n`).join('');
    const { log } = this.paths(paper);
    c.chain = c.chain.then(async () => {
      try {
        await ensureUiDir(this.workspaceRoot, 'chats');
        await appendFile(log, text, { encoding: 'utf8', mode: 0o600 });
      } catch (err) {
        console.error(`[web-latex-mcp ui] could not save the conversation: ${(err as Error).message}`);
      }
    });
    await c.chain;
  }

  async meta(paper: string): Promise<ChatMeta> {
    return { ...(await this.load(paper)).meta };
  }

  async setMeta(paper: string, patch: Partial<Omit<ChatMeta, 'paper'>>): Promise<ChatMeta> {
    const c = await this.load(paper);
    for (const [k, v] of Object.entries(patch) as Array<[keyof ChatMeta, string | undefined]>) {
      if (v === undefined || v === '') delete c.meta[k];
      else (c.meta as unknown as Record<string, string>)[k] = v;
    }
    c.meta.paper = paper;
    await ensureUiDir(this.workspaceRoot, 'chats');
    await writeFileAtomic(this.paths(paper).meta, `${JSON.stringify(c.meta, null, 2)}\n`);
    return { ...c.meta };
  }

  /** Set the conversation aside and start an empty one (the model and effort stay). */
  async reset(paper: string): Promise<void> {
    const c = await this.load(paper);
    await c.chain;
    const { log } = this.paths(paper);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    try {
      await rename(log, log.replace(/\.jsonl$/, `.${stamp}.jsonl`));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    c.items = [];
    c.epoch = newEpoch();
    await this.setMeta(paper, { sessionId: undefined });
  }
}

function newEpoch(): string {
  return randomBytes(6).toString('hex');
}

async function readOrEmpty(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}
