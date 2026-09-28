import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSkill } from '../../src/lib/skills.js';

/**
 * Guards over the `/review-paper` agents and the bundled skill descriptions.
 *
 * The review agents are read-only by their `tools:` frontmatter, not by their prose: a tool
 * the list leaves out is one the agent cannot call. So the list is the contract, and it is
 * judged against an ALLOWLIST — a denylist of mutating tools would pass a new mutating tool
 * nobody thought to add to it. A missing `tools:` key is not an empty list either: Claude Code
 * gives an agent without one every tool, which is the failure this test exists to catch.
 */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MCP = 'mcp__web-latex-mcp__';
/**
 * The same server's tools when the Claude Code plugin starts it (#212): Claude Code names a
 * plugin-declared server's tools `mcp__plugin_<plugin>_<server>__<tool>`, so each agent lists
 * every server tool in both forms (test/unit/pluginManifest.test.ts pins the pairing).
 */
const PLUGIN_MCP = 'mcp__plugin_web-latex-mcp_web-latex-mcp__';
const SERVER_PREFIXES = [MCP, PLUGIN_MCP];

/** `name` under both server prefixes. */
const serverTool = (name: string): string[] => SERVER_PREFIXES.map((prefix) => `${prefix}${name}`);

/** The review agents, which must never write, compile, commit or push. */
const REVIEW_AGENTS = [
  'paper-reviewer',
  'paper-devils-advocate',
  'novelty-scout',
  'review-triage',
  'paper-typo-hunter',
];

/**
 * Every tool a review agent may hold: reads, searches, lookups — nothing that writes. `Grep` and
 * `Glob` are left out on purpose: they are not confined to the project, and a reviewer once
 * grepped another checkout of the same paper at a different commit. `search_files` and
 * `list_files` cover them inside the sandbox; `Read` stays, for the PDF, which the server does not
 * serve as pages.
 */
const READ_ONLY_TOOLS = new Set([
  'Read',
  'WebSearch',
  'WebFetch',
  ...[
    'read_file',
    'list_files',
    'search_files',
    'list_skills',
    'extract_text',
    'render_pages',
    'list_references',
    'check_citations',
    'search_references',
  ].flatMap(serverTool),
]);

/** The Agent Skills limit on a skill's `description`; longer ones are cut or dropped. */
const MAX_SKILL_DESCRIPTION = 1024;

/**
 * The `tools:` value of an agent file's frontmatter, split into names, or `undefined` when the
 * key is absent. The value may continue on indented lines, as the review agents' lists do.
 */
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

/** Tool names the server registers, read off `registerTool('<name>'` in `src/tools`. */
function registeredToolNames(): Set<string> {
  const dir = path.join(ROOT, 'src', 'tools');
  const names = new Set<string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(path.join(dir, file), 'utf8');
    for (const m of src.matchAll(/registerTool\(\s*'([a-z_]+)'/g)) names.add(m[1]!);
  }
  return names;
}

describe('frontmatterTools', () => {
  it('reads a list that continues on indented lines', () => {
    const text = '---\nname: x\ntools: Read, Grep,\n  Glob\nmodel: opus\n---\nbody\n';
    expect(frontmatterTools(text)).toEqual(['Read', 'Grep', 'Glob']);
  });

  it('reports an absent key as undefined, not as an empty list', () => {
    expect(frontmatterTools('---\nname: x\nmodel: opus\n---\nbody\n')).toBeUndefined();
  });
});

describe('review agents stay read-only', () => {
  const registered = registeredToolNames();

  it('finds the server tools it checks against', () => {
    // A regex that stopped matching would leave the existence check below vacuously green.
    expect(registered.size).toBeGreaterThanOrEqual(30);
    expect(registered.has('write_file')).toBe(true);
  });

  for (const agent of REVIEW_AGENTS) {
    describe(agent, () => {
      const text = readFileSync(path.join(ROOT, '.claude', 'agents', `${agent}.md`), 'utf8');
      const tools = frontmatterTools(text);

      it('declares its tools (an agent without a list gets every tool)', () => {
        expect(tools).toBeDefined();
        expect(tools!.length).toBeGreaterThan(0);
      });

      it('holds only read-only tools', () => {
        expect((tools ?? []).filter((tool) => !READ_ONLY_TOOLS.has(tool))).toEqual([]);
      });

      it('names only server tools that exist', () => {
        const serverTools = (tools ?? []).flatMap((tool) => {
          const prefix = SERVER_PREFIXES.find((p) => tool.startsWith(p));
          return prefix === undefined ? [] : [tool.slice(prefix.length)];
        });
        expect(serverTools.filter((tool) => !registered.has(tool))).toEqual([]);
      });
    });
  }
});

describe('corrector', () => {
  // /hunt-typo may authorize it to apply fixes, so it holds edit_file — and nothing else that
  // writes. /review-paper uses the read-only paper-typo-hunter instead.
  const text = readFileSync(path.join(ROOT, '.claude', 'agents', 'corrector.md'), 'utf8');
  const tools = frontmatterTools(text);

  it('declares its tools, and writes only through edit_file', () => {
    expect(tools).toBeDefined();
    const allowed = new Set([...READ_ONLY_TOOLS, ...serverTool('edit_file')]);
    expect((tools ?? []).filter((tool) => !allowed.has(tool))).toEqual([]);
  });
});

describe('bundled skill descriptions', () => {
  const dir = path.join(ROOT, '.claude', 'skills');
  const skillDirs = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory());

  it('finds the bundled skills', () => {
    expect(skillDirs.length).toBeGreaterThanOrEqual(5);
  });

  for (const entry of skillDirs) {
    it(`${entry.name} fits the ${MAX_SKILL_DESCRIPTION}-character description limit`, () => {
      const skill = parseSkill(readFileSync(path.join(dir, entry.name, 'SKILL.md'), 'utf8'));
      expect(skill).toBeDefined();
      expect([...skill!.description].length).toBeLessThanOrEqual(MAX_SKILL_DESCRIPTION);
    });
  }
});
