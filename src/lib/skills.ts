import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

/** One bundled skill: its frontmatter identity plus the instruction body. */
export interface Skill {
  /** Slug from the frontmatter `name:` — also the MCP prompt name. */
  name: string;
  /** Frontmatter `description:` — what the skill does and when to reach for it. */
  description: string;
  /** The SKILL.md text with the frontmatter block removed. */
  body: string;
}

/** Path to the bundled skills, relative to this module (works from src/ and dist/). */
function bundledSkillsDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../.claude/skills');
}

/**
 * Split a SKILL.md into its YAML frontmatter block and the body below it. Returns
 * `undefined` when the file does not open with a `---` fence, since a skill without
 * frontmatter has no name or description to advertise.
 */
function splitFrontmatter(text: string): { frontmatter: string; body: string } | undefined {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return undefined;
  const end = lines.indexOf('---', 1);
  if (end === -1) return undefined;
  return {
    frontmatter: lines.slice(1, end).join('\n'),
    body: lines
      .slice(end + 1)
      .join('\n')
      .trim(),
  };
}

/**
 * Read a top-level scalar out of a frontmatter block. Deliberately minimal rather
 * than a YAML dependency: skill frontmatter is `key: value` one-liners plus nested
 * lists (`allowed-tools`), so indented and `-` lines are skipped and only the first
 * `:` splits a key from its value (descriptions contain colons).
 */
function frontmatterValue(frontmatter: string, key: string): string | undefined {
  for (const line of frontmatter.split('\n')) {
    if (/^[\s-]/.test(line)) continue;
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    if (line.slice(0, sep).trim() !== key) continue;
    return line.slice(sep + 1).trim();
  }
  return undefined;
}

/** Parse one SKILL.md. Returns `undefined` when it lacks a usable name/description/body. */
export function parseSkill(text: string): Skill | undefined {
  const split = splitFrontmatter(text);
  if (!split) return undefined;
  const name = frontmatterValue(split.frontmatter, 'name');
  const description = frontmatterValue(split.frontmatter, 'description');
  if (!name || !description || split.body.length === 0) return undefined;
  return { name, description, body: split.body };
}

/**
 * Load the bundled skills so they can be surfaced as MCP prompts — the only way a
 * plain MCP client (Claude Desktop, Cursor) reaches them, since `.claude/skills` is
 * read by Claude Code alone. Defaults to the bundled `.claude/skills`; override with
 * `WEB_LATEX_MCP_SKILLS_DIR`. Returns `[]` (logging to stderr) when the directory is
 * missing or unreadable, so a stripped install still starts. Sorted by name to keep
 * the advertised prompt list stable.
 */
export async function loadSkills(env: NodeJS.ProcessEnv = process.env): Promise<Skill[]> {
  const override = env.WEB_LATEX_MCP_SKILLS_DIR?.trim();
  const dir = override ? resolve(override) : bundledSkillsDir();
  let entries: string[];
  try {
    entries = (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (err) {
    console.error(
      `[web-latex-mcp] skills not loaded from ${dir}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }

  const skills: Skill[] = [];
  for (const entry of entries.sort()) {
    const file = join(dir, entry, 'SKILL.md');
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue; // a directory without a SKILL.md simply isn't a skill
    }
    const skill = parseSkill(text);
    if (!skill) {
      console.error(`[web-latex-mcp] skipped ${file}: missing name/description frontmatter`);
      continue;
    }
    skills.push(skill);
  }
  return skills;
}
