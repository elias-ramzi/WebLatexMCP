import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * What the Claude Code plugin ships out of `.claude/agents` and `.claude/commands` (#212).
 *
 * Those two directories hold two kinds of file: the paper-facing commands and the agents they
 * dispatch, which the plugin must ship, and this repository's own development tooling, which it
 * must NOT — pointing `plugin.json` at the directories would install `/implement` and
 * `implementer` into every user's Claude Code. So `plugin.json` lists the shipped files one by one,
 * and this test holds every file in the two directories to exactly one of two lists: the
 * manifest's, or the explicit DEV list below. A new file in neither fails here, which is the
 * point: a new paper agent cannot be left out of the plugin by forgetting it, and a new dev agent
 * cannot ship by forgetting it either.
 */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Development tooling: in the repository, never in the plugin. */
const DEV = {
  agents: ['implementer.md', 'plan-verifier.md'],
  commands: ['implement.md', 'implement-issue.md', 'review.md'],
} as const;

type Kind = keyof typeof DEV;

interface Manifest {
  name: string;
  agents?: unknown;
  commands?: unknown;
  mcpServers?: Record<string, unknown>;
}

function readManifest(): Manifest {
  return JSON.parse(
    readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'),
  ) as Manifest;
}

function dirFiles(kind: Kind): string[] {
  return readdirSync(path.join(ROOT, '.claude', kind), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort();
}

/**
 * The manifest's list for `kind`, as it is written. A string (one path) or a directory would
 * ship whatever the directory holds, dev tooling included, so only an array of files passes.
 */
function listed(manifest: Manifest, kind: Kind): string[] {
  const value = manifest[kind];
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry));
}

/** The `tools:` value of an agent file's frontmatter, split into names; `undefined` when absent. */
function frontmatterTools(text: string): string[] | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match?.[1]) throw new Error('agent file has no frontmatter block');
  const lines = match[1].split(/\r?\n/);
  const start = lines.findIndex((line) => /^tools:/.test(line));
  if (start === -1) return undefined;
  const value = [lines[start]!.slice('tools:'.length)];
  for (const line of lines.slice(start + 1)) {
    if (!/^\s+\S/.test(line)) break;
    value.push(line);
  }
  return value
    .join(' ')
    .split(',')
    .map((tool) => tool.trim())
    .filter((tool) => tool.length > 0);
}

/**
 * The name prefix Claude Code gives a tool of an MCP server the plugin itself declares:
 * `mcp__plugin_<plugin>_<server>__`, every character outside `[A-Za-z0-9_-]` replaced by `_`
 * (Claude Code's MCP docs, "Plugin MCP tool names").
 */
function pluginToolPrefix(plugin: string, server: string): string {
  const safe = (s: string): string => s.replace(/[^A-Za-z0-9_-]/g, '_');
  return `mcp__plugin_${safe(plugin)}_${safe(server)}__`;
}

describe('the plugin ships the paper commands and agents, and no dev tooling', () => {
  const manifest = readManifest();

  for (const kind of ['agents', 'commands'] as const) {
    describe(kind, () => {
      const files = dirFiles(kind);
      const entries = listed(manifest, kind);

      it('lists its files one by one, as an array', () => {
        expect(Array.isArray(manifest[kind])).toBe(true);
        expect(entries.length).toBeGreaterThan(0);
      });

      it('lists only ./-relative .md files inside the matching .claude directory', () => {
        for (const entry of entries) {
          expect(entry.startsWith(`./.claude/${kind}/`)).toBe(true);
          expect(entry.endsWith('.md')).toBe(true);
          // One level only: a subdirectory would change the agent's scoped name.
          expect(entry.slice(`./.claude/${kind}/`.length)).not.toContain('/');
        }
        expect(new Set(entries).size).toBe(entries.length);
      });

      it('lists only files that exist', () => {
        for (const entry of entries) {
          const abs = path.join(ROOT, entry);
          expect(existsSync(abs), entry).toBe(true);
          expect(statSync(abs).isFile(), entry).toBe(true);
        }
      });

      it('keeps the DEV list current (every DEV file exists)', () => {
        // A stale DEV entry would let the partition below pass over a file that is gone.
        for (const name of DEV[kind]) expect(files, name).toContain(name);
      });

      it('puts every file in exactly one of {plugin.json, DEV}', () => {
        const shipped = new Set(entries.map((entry) => path.posix.basename(entry)));
        const dev = new Set<string>(DEV[kind]);
        const neither = files.filter((name) => !shipped.has(name) && !dev.has(name));
        const both = files.filter((name) => shipped.has(name) && dev.has(name));
        expect(neither, `in neither list — ship it in plugin.json or add it to DEV`).toEqual([]);
        expect(both, `dev tooling shipped in plugin.json`).toEqual([]);
      });
    });
  }

  it('ships every agent a shipped command dispatches', () => {
    // A command names its agents in backticks (`paper-reviewer`); one naming a dev agent, or an
    // agent left out of the manifest, would dispatch something a plugin install does not have.
    const agentNames = new Set(dirFiles('agents').map((name) => name.replace(/\.md$/, '')));
    const shippedAgents = new Set(
      listed(manifest, 'agents').map((entry) => path.posix.basename(entry, '.md')),
    );
    const missing: string[] = [];
    let seen = 0;
    for (const entry of listed(manifest, 'commands')) {
      const text = readFileSync(path.join(ROOT, entry), 'utf8');
      for (const m of text.matchAll(/`([a-z][a-z-]*)`/g)) {
        const name = m[1]!;
        if (!agentNames.has(name)) continue;
        seen += 1;
        if (!shippedAgents.has(name)) missing.push(`${entry} -> ${name}`);
      }
    }
    // Guard against a regex that stopped matching: /review-paper alone names five agents.
    expect(seen).toBeGreaterThanOrEqual(5);
    expect(missing).toEqual([]);
  });
});

describe('shipped agents reach the server under either install', () => {
  /**
   * An agent's `tools:` list is an allowlist of exact names. A server configured by hand
   * (`claude mcp add web-latex-mcp …`) names its tools `mcp__web-latex-mcp__<tool>`; the same
   * server started by the plugin names them `mcp__plugin_web-latex-mcp_web-latex-mcp__<tool>`.
   * A list carrying only the first form gives a plugin-installed agent `Read` and nothing else —
   * it cannot even load its skill. Claude Code drops a name that resolves to no tool, so listing
   * both forms is safe, and each server tool must appear in both.
   */
  const manifest = readManifest();
  const servers = Object.keys(manifest.mcpServers ?? {});
  const MANUAL = 'mcp__web-latex-mcp__';

  it('declares exactly one MCP server, whose plugin prefix is the one the agents use', () => {
    expect(servers).toEqual(['web-latex-mcp']);
    expect(pluginToolPrefix(manifest.name, servers[0]!)).toBe(
      'mcp__plugin_web-latex-mcp_web-latex-mcp__',
    );
  });

  const prefix = pluginToolPrefix(manifest.name, servers[0] ?? '');
  for (const entry of listed(manifest, 'agents')) {
    const name = path.posix.basename(entry, '.md');
    const tools = frontmatterTools(readFileSync(path.join(ROOT, entry), 'utf8'));
    /**
     * A shipped agent without a `tools:` line inherits EVERY tool the user's session holds —
     * Bash, `commit`, `push`, `delete_file`, `compile` — whatever its prose promises. `formatter`
     * shipped that way, describing itself as never compiling. So every agent the plugin installs
     * must carry an explicit allowlist; a missing one fails here rather than being skipped.
     */
    it(`${name} declares a tools: allowlist (without one it inherits every tool)`, () => {
      expect(
        tools,
        `${entry} has no tools: line in its frontmatter, so it inherits Bash, commit, push and every other tool`,
      ).toBeDefined();
      expect(tools!.length).toBeGreaterThan(0);
    });
    if (tools === undefined) continue; // reported by the test above
    it(`${name} names each server tool in both forms`, () => {
      const manual = tools
        .filter((tool) => tool.startsWith(MANUAL))
        .map((tool) => tool.slice(MANUAL.length))
        .sort();
      const plugin = tools
        .filter((tool) => tool.startsWith(prefix))
        .map((tool) => tool.slice(prefix.length))
        .sort();
      expect(manual.length).toBeGreaterThan(0);
      expect(plugin).toEqual(manual);
    });
  }
});
