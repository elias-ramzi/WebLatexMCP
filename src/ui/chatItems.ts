/**
 * A conversation as the UI shows it: a list of items in cc-servers' shape (`{k: "text"|"thinking"|
 * "tool"|"result"|"user"|"cmd"|"note"}`), so its rendering code ports over as is. Built here from
 * the Agent SDK's messages — pure functions over plain objects, tested on canned messages, with no
 * import of the SDK (it is an optional dependency).
 */

export type ChatItem =
  | { k: 'user'; text: string; t: string }
  | { k: 'cmd'; text: string; t: string }
  | { k: 'text'; text: string; t: string }
  | { k: 'thinking'; text: string; t: string }
  | {
      k: 'tool';
      id: string;
      /** As the UI shows it: a web-latex-mcp tool without its `mcp__…__` prefix. */
      name: string;
      summary: string;
      input: Record<string, unknown>;
      t: string;
    }
  | { k: 'result'; id: string; text: string; error: boolean }
  | { k: 'note'; text: string; t: string };

/** Longest text kept of one tool result or one input value; the rest is counted, not stored. */
export const MAX_RESULT_CHARS = 20_000;
export const MAX_INPUT_VALUE_CHARS = 4_000;

const TOOL_PREFIXES = ['mcp__plugin_web-latex-mcp_web-latex-mcp__', 'mcp__web-latex-mcp__'];

export function displayToolName(name: string): string {
  for (const p of TOOL_PREFIXES) if (name.startsWith(p)) return name.slice(p.length);
  return name;
}

export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… (${text.length - max} more characters not shown)`;
}

/** Longest list kept of an input value (`edits`), and how deep objects are kept as such. */
export const MAX_INPUT_LIST = 50;
const MAX_INPUT_DEPTH = 3;

function clipValue(v: unknown, depth: number): unknown {
  if (typeof v === 'string') return clip(v, MAX_INPUT_VALUE_CHARS);
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return v;
  if (depth >= MAX_INPUT_DEPTH) return clip(JSON.stringify(v) ?? '', MAX_INPUT_VALUE_CHARS);
  if (Array.isArray(v)) {
    const kept = v.slice(0, MAX_INPUT_LIST).map((x) => clipValue(x, depth + 1));
    if (v.length > MAX_INPUT_LIST) kept.push(`… ${v.length - MAX_INPUT_LIST} more`);
    return kept;
  }
  if (typeof v === 'object') {
    const out = Object.create(null) as Record<string, unknown>;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = clipValue(x, depth + 1);
    return out;
  }
  return String(v);
}

/** The arguments of a call, each long string cut: what the step shows when opened. */
export function clipInput(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return Object.create(null) as Record<string, unknown>;
  }
  return clipValue(input, 0) as Record<string, unknown>;
}

/** Arguments that say best what a call is about, in the order they are looked for. */
const SUMMARY_KEYS = [
  'path',
  'paths',
  'file_path',
  'document',
  'rootFile',
  'query',
  'pattern',
  'message',
  'key',
  'keys',
  'pages',
  'gitUrl',
  'ref',
  'description',
  'prompt',
  'skill',
  'command',
];

/** One line saying what a call does (`main.tex`, `"deep metric learning"`), at most 120 chars. */
export function summarizeToolInput(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '';
  const r = input as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of SUMMARY_KEYS) {
    const v = r[k];
    if (typeof v === 'string' && v.trim()) parts.push(v.trim().split('\n')[0] as string);
    else if (Array.isArray(v) && v.length) parts.push(v.map((x) => String(x)).join(', '));
    else if (typeof v === 'number') parts.push(`${k} ${v}`);
    if (parts.length >= 2) break;
  }
  if (Array.isArray(r.edits)) parts.push(`${r.edits.length} edit${r.edits.length === 1 ? '' : 's'}`);
  if (r.compile === true) parts.push('then compile');
  const line = parts.join(' · ');
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

interface Block {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

/** The text of a tool result's content: a string, or text blocks (an image as `[image]`). */
export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b: Block) => (b?.type === 'text' ? (b.text ?? '') : b?.type === 'image' ? '[image]' : ''))
    .filter(Boolean)
    .join('\n');
}

/** A message of the SDK, as far as the items need it. */
export interface SdkMessageLike {
  type: string;
  subtype?: string;
  parent_tool_use_id?: string | null;
  message?: { content?: unknown; usage?: unknown; model?: string };
  is_error?: boolean;
  result?: string;
  errors?: string[];
  compact_metadata?: { trigger?: string };
}

/**
 * The items one SDK message adds to the conversation (often none). A subagent's own messages
 * (`parent_tool_use_id` set) are left out: its call shows as one step, with its report as result.
 */
export function itemsFromMessage(msg: SdkMessageLike, now = new Date()): ChatItem[] {
  const t = now.toISOString();
  if (msg.parent_tool_use_id) return [];
  if (msg.type === 'assistant') {
    const content = msg.message?.content;
    if (!Array.isArray(content)) return [];
    const out: ChatItem[] = [];
    for (const b of content as Block[]) {
      if (b?.type === 'text' && b.text?.trim()) out.push({ k: 'text', text: b.text, t });
      else if (b?.type === 'thinking' && b.thinking?.trim()) {
        out.push({ k: 'thinking', text: b.thinking, t });
      } else if (b?.type === 'tool_use' && typeof b.id === 'string') {
        out.push({
          k: 'tool',
          id: b.id,
          name: displayToolName(b.name ?? '?'),
          summary: summarizeToolInput(b.input),
          input: clipInput(b.input),
          t,
        });
      }
    }
    return out;
  }
  if (msg.type === 'user') {
    const content = msg.message?.content;
    if (!Array.isArray(content)) return [];
    const out: ChatItem[] = [];
    for (const b of content as Block[]) {
      if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        out.push({
          k: 'result',
          id: b.tool_use_id,
          text: clip(toolResultText(b.content), MAX_RESULT_CHARS),
          error: b.is_error === true,
        });
      }
    }
    return out;
  }
  if (msg.type === 'result') {
    if (msg.subtype === 'success' && !msg.is_error) return [];
    const why =
      msg.errors?.filter(Boolean).join('\n') ||
      (msg.subtype === 'error_max_turns'
        ? 'Claude stopped: it reached the limit of turns.'
        : msg.result || 'The turn ended with an error.');
    return [{ k: 'note', text: why, t }];
  }
  if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
    return [{ k: 'note', text: 'The conversation was compacted.', t }];
  }
  return [];
}

/** The tokens the context holds after an assistant message: its input, cached or not. */
export function contextTokens(msg: SdkMessageLike): number | undefined {
  if (msg.type !== 'assistant' || msg.parent_tool_use_id) return undefined;
  const u = msg.message?.usage as Record<string, unknown> | undefined;
  if (!u) return undefined;
  const n = (k: string): number => (typeof u[k] === 'number' ? (u[k] as number) : 0);
  const total =
    n('input_tokens') +
    n('cache_read_input_tokens') +
    n('cache_creation_input_tokens') +
    n('output_tokens');
  return total > 0 ? total : undefined;
}

/** The context window a `result` reports for the model, when it does. */
export function contextWindow(msg: unknown): number | undefined {
  const usage = (msg as { modelUsage?: Record<string, { contextWindow?: unknown }> }).modelUsage;
  if (!usage || typeof usage !== 'object') return undefined;
  const windows = Object.values(usage)
    .map((m) => m?.contextWindow)
    .filter((w): w is number => typeof w === 'number' && w > 0);
  return windows.length ? Math.max(...windows) : undefined;
}

/** What the user sent, as an item: a slash command shows as a command chip. */
export function userItem(text: string, now = new Date()): ChatItem {
  const t = now.toISOString();
  return /^\/[\w:-]+(\s|$)/.test(text.trim())
    ? { k: 'cmd', text: text.trim(), t }
    : { k: 'user', text, t };
}
