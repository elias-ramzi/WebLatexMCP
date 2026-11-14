import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { ensureUiDir, uiDir, writeFileAtomic } from './uiFiles.js';

/**
 * What the UI's sidebar adds to the registry: a title for a paper, the group it sits in, its
 * labels, and the order of groups and papers — `<workspace>/.ui/papers.json`.
 *
 * Kept **out of `registry.json`** on purpose: the registry decides registrations (pins,
 * `sameRegistration`, migration), and none of that should change because a paper was given a
 * label. A paper the registry no longer has keeps its entry here, harmlessly, and gets it back if
 * it is registered again.
 *
 * Paper ids and group ids are user-chosen names: every map is null-prototype (`__proto__`,
 * `constructor`); the file on disk stays plain JSON.
 */

export interface PaperMeta {
  title?: string;
  /** A group's id; absent: the paper is in no group. */
  group?: string;
  labels: string[];
}

export interface PaperGroup {
  id: string;
  name: string;
}

export interface PapersState {
  /** In display order. */
  groups: PaperGroup[];
  /** Null-prototype, keyed by project id. */
  papers: Record<string, PaperMeta>;
  /** Project ids in display order; a paper not listed sorts after, by id. */
  order: string[];
}

/** A request the UI cannot apply as given: answered 400 with the message. */
export class UiInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UiInputError';
  }
}

export const MAX_NAME_CHARS = 80;
export const MAX_LABEL_CHARS = 40;
export const MAX_LABELS = 20;
export const MAX_GROUPS = 200;

// Control characters, line/paragraph separators and bidi overrides: a name is one plain line.
// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

/** `value` as a one-line name of at most `max` characters, or a `UiInputError` saying why not. */
export function cleanName(value: unknown, what: string, max: number): string {
  if (typeof value !== 'string') throw new UiInputError(`${what} must be text.`);
  const s = value.trim();
  if (!s) throw new UiInputError(`${what} is empty.`);
  if (UNSAFE_TEXT.test(s)) throw new UiInputError(`${what} holds a control character.`);
  if ([...s].length > max) throw new UiInputError(`${what} is longer than ${max} characters.`);
  return s;
}

function emptyState(): PapersState {
  return { groups: [], papers: Object.create(null) as Record<string, PaperMeta>, order: [] };
}

/** The state a file holds, keeping whatever of it is well formed. */
export function parsePapersFile(text: string): PapersState {
  const out = emptyState();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return out;
  }
  if (typeof raw !== 'object' || raw === null) return out;
  const r = raw as Record<string, unknown>;
  const seenGroups = new Set<string>();
  for (const g of Array.isArray(r.groups) ? r.groups : []) {
    const gr = g as Record<string, unknown> | null;
    if (!gr || typeof gr.id !== 'string' || typeof gr.name !== 'string' || seenGroups.has(gr.id)) {
      continue;
    }
    seenGroups.add(gr.id);
    out.groups.push({ id: gr.id, name: gr.name });
  }
  const papers = r.papers;
  if (typeof papers === 'object' && papers !== null && !Array.isArray(papers)) {
    for (const [id, v] of Object.entries(papers as Record<string, unknown>)) {
      if (typeof v !== 'object' || v === null) continue;
      const p = v as Record<string, unknown>;
      const meta: PaperMeta = {
        labels: Array.isArray(p.labels)
          ? [...new Set(p.labels.filter((l): l is string => typeof l === 'string' && !!l))]
          : [],
      };
      if (typeof p.title === 'string' && p.title) meta.title = p.title;
      if (typeof p.group === 'string' && seenGroups.has(p.group)) meta.group = p.group;
      out.papers[id] = meta;
    }
  }
  const seen = new Set<string>();
  for (const id of Array.isArray(r.order) ? r.order : []) {
    if (typeof id === 'string' && !seen.has(id)) {
      seen.add(id);
      out.order.push(id);
    }
  }
  return out;
}

/** What the file holds: plain objects, in a stable key order. */
function serialize(state: PapersState): string {
  const papers: Record<string, PaperMeta> = {};
  for (const id of Object.keys(state.papers).sort()) {
    const m = state.papers[id] as PaperMeta;
    if (!m.title && !m.group && m.labels.length === 0) continue;
    // defineProperty, not assignment: an id named `__proto__` must stay a key.
    Object.defineProperty(papers, id, {
      value: {
        ...(m.title ? { title: m.title } : {}),
        ...(m.group ? { group: m.group } : {}),
        ...(m.labels.length ? { labels: m.labels } : {}),
      },
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return `${JSON.stringify({ v: 1, groups: state.groups, papers, order: state.order }, null, 2)}\n`;
}

/** One workspace's `papers.json`: read once, changed one request at a time, written after each. */
export class PaperMetaStore {
  private state: PapersState | undefined;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly workspaceRoot: string) {}

  get file(): string {
    return path.join(uiDir(this.workspaceRoot), 'papers.json');
  }

  async read(): Promise<PapersState> {
    if (!this.state) {
      let text = '';
      try {
        text = await readFile(this.file, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      this.state = parsePapersFile(text);
    }
    return this.state;
  }

  /** Apply `change` to the state and write it, after every change asked before it. */
  update<T>(change: (state: PapersState) => T): Promise<T> {
    const run = this.chain.then(async () => {
      const state = await this.read();
      const result = change(state);
      await ensureUiDir(this.workspaceRoot);
      await writeFileAtomic(this.file, serialize(state), 0o600);
      return result;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  async setPaper(
    id: string,
    patch: { title?: string | null; group?: string | null; labels?: unknown },
  ): Promise<PaperMeta> {
    // undefined: unchanged; null or '': back to the project id; else the new title.
    let title: string | null | undefined;
    if (patch.title === null || patch.title === '') title = null;
    else if (patch.title !== undefined) title = cleanName(patch.title, 'The title', MAX_NAME_CHARS);
    let labels: string[] | undefined;
    if (patch.labels !== undefined) {
      if (!Array.isArray(patch.labels)) throw new UiInputError('labels must be a list.');
      labels = [...new Set(patch.labels.map((l) => cleanName(l, 'A label', MAX_LABEL_CHARS)))];
      if (labels.length > MAX_LABELS) {
        throw new UiInputError(`A paper takes at most ${MAX_LABELS} labels.`);
      }
    }
    return this.update((state) => {
      if (patch.group && !state.groups.some((g) => g.id === patch.group)) {
        throw new UiInputError('There is no such group (it may have been deleted).');
      }
      const meta = state.papers[id] ?? { labels: [] };
      if (title === null) delete meta.title;
      else if (title !== undefined) meta.title = title;
      if (patch.group === null || patch.group === '') delete meta.group;
      else if (patch.group !== undefined) meta.group = patch.group;
      if (labels) meta.labels = labels;
      state.papers[id] = meta;
      return { ...meta, labels: [...meta.labels] };
    });
  }

  async addGroup(name: unknown): Promise<PaperGroup> {
    const clean = cleanName(name, 'The group name', MAX_NAME_CHARS);
    return this.update((state) => {
      if (state.groups.length >= MAX_GROUPS) {
        throw new UiInputError(`There are already ${MAX_GROUPS} groups.`);
      }
      const group = { id: `g-${randomBytes(5).toString('hex')}`, name: clean };
      state.groups.push(group);
      return { ...group };
    });
  }

  async renameGroup(id: string, name: unknown): Promise<void> {
    const clean = cleanName(name, 'The group name', MAX_NAME_CHARS);
    return this.update((state) => {
      const g = state.groups.find((x) => x.id === id);
      if (!g) throw new UiInputError('There is no such group (it may have been deleted).');
      g.name = clean;
    });
  }

  /** Delete a group; its papers stay, in no group. */
  async deleteGroup(id: string): Promise<void> {
    return this.update((state) => {
      state.groups = state.groups.filter((g) => g.id !== id);
      for (const m of Object.values(state.papers)) if (m.group === id) delete m.group;
    });
  }

  /** Put the groups in this order; groups not named keep their place after them. */
  async orderGroups(ids: unknown): Promise<void> {
    const list = stringList(ids, 'groups');
    return this.update((state) => {
      const at = new Map(list.map((id, i) => [id, i]));
      state.groups = state.groups
        .map((g, i) => [at.get(g.id) ?? list.length + i, g] as const)
        .sort((a, b) => a[0] - b[0])
        .map(([, g]) => g);
    });
  }

  /** Papers in this order (the whole list the sidebar shows, all groups together). */
  async orderPapers(ids: unknown): Promise<void> {
    const list = stringList(ids, 'papers');
    return this.update((state) => {
      const named = new Set(list);
      state.order = [...list, ...state.order.filter((id) => !named.has(id))];
    });
  }
}

function stringList(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new UiInputError(`${what} must be a list of ids.`);
  }
  if (value.length > 10_000) throw new UiInputError(`${what} is too long.`);
  return [...new Set(value as string[])];
}

/** `ids` in the stored order: listed ones first, in that order, then the rest by id. */
export function orderedIds(ids: readonly string[], order: readonly string[]): string[] {
  const at = new Map(order.map((id, i) => [id, i]));
  return [...ids].sort((a, b) => {
    const x = at.get(a);
    const y = at.get(b);
    if (x !== undefined && y !== undefined) return x - y;
    if (x !== undefined) return -1;
    if (y !== undefined) return 1;
    return a.localeCompare(b);
  });
}
