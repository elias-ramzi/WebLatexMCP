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

/** The review agents, which must never write, compile, commit or push. */
const REVIEW_AGENTS = ['paper-reviewer', 'paper-devils-advocate', 'novelty-scout', 'review-triage'];

/** Every tool a review agent may hold: reads, searches, lookups — nothing that writes. */
const READ_ONLY_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'WebSearch',
  'WebFetch',
  `${MCP}read_file`,
  `${MCP}list_files`,
  `${MCP}search_files`,
  `${MCP}list_skills`,
  `${MCP}extract_text`,
  `${MCP}render_pages`,
  `${MCP}list_references`,
  `${MCP}check_citations`,
  `${MCP}search_references`,
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
        const serverTools = (tools ?? [])
          .filter((tool) => tool.startsWith(MCP))
          .map((tool) => tool.slice(MCP.length));
        expect(serverTools.filter((tool) => !registered.has(tool))).toEqual([]);
      });
    });
  }
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
