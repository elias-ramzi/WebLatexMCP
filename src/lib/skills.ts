import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

/**
 * Whether a skill's procedure acts on a registered project, declared by the SKILL.md
 * frontmatter `project:` key:
 *
 * - `none` — the procedure takes no project at all (`session-feedback` reports on the
 *   server and its skills, never on a paper).
 * - `optional` — it acts on a project but can ask which one.
 * - `required` — it cannot start without one.
 *
 * This is what decides whether the MCP prompt advertises a `project` argument, so it is a
 * guard, not documentation: a prompt that advertises an argument it does not use is one a
 * client can bind free text into positionally, and the first word of "please describe why…"
 * then arrives as a project id.
 */
export type SkillProjectUse = 'none' | 'optional' | 'required';

/**
 * What a SKILL.md with no `project:` key means, and what an unparseable value degrades to.
 *
 * `optional` is exactly today's behaviour — every prompt carried one optional `project`
 * argument — so a SKILL.md written before this key existed, or one in a user's own
 * `WEB_LATEX_MCP_SKILLS_DIR`, keeps working unchanged. Defaulting to `none` instead would
 * silently strip the scoping argument off every third-party skill that legitimately uses it,
 * and defaulting to `required` would make those skills un-invokable without an argument. The
 * declaration narrows; its absence never does.
 */
export const DEFAULT_SKILL_PROJECT_USE: SkillProjectUse = 'optional';

/** One bundled skill: its frontmatter identity plus the instruction body. */
export interface Skill {
  /** Slug from the frontmatter `name:` — also the MCP prompt name. */
  name: string;
  /** Frontmatter `description:` — what the skill does and when to reach for it. */
  description: string;
  /** The SKILL.md text with the frontmatter block removed. */
  body: string;
  /** Frontmatter `project:` — whether this procedure acts on a project. */
  project: SkillProjectUse;
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

/**
 * Read the frontmatter `project:` declaration. Returns `undefined` for a value that names
 * none of the three states, so the caller can warn about it; quotes are stripped and ASCII
 * case is ignored, since the file is hand-written YAML.
 */
export function parseProjectUse(raw: string | undefined): SkillProjectUse | undefined {
  if (raw === undefined) return undefined;
  const value = raw
    .trim()
    .replace(/^(['"])(.*)\1$/, '$2')
    .trim()
    .toLowerCase();
  return value === 'none' || value === 'optional' || value === 'required' ? value : undefined;
}

/**
 * Parse one SKILL.md. Returns `undefined` when it lacks a usable name/description/body.
 *
 * A missing or malformed `project:` is NOT a reason to drop a skill: SKILL.md files can come
 * from a user's own `WEB_LATEX_MCP_SKILLS_DIR` and are data, not trusted input, so a typo
 * there must cost a stderr line and today's behaviour (`DEFAULT_SKILL_PROJECT_USE`), never a
 * skill that silently vanishes from the prompt list. `onWarn` reports it — passed in rather
 * than logged here so this stays pure and the caller can name the file.
 */
export function parseSkill(text: string, onWarn?: (message: string) => void): Skill | undefined {
  const split = splitFrontmatter(text);
  if (!split) return undefined;
  const name = frontmatterValue(split.frontmatter, 'name');
  const description = frontmatterValue(split.frontmatter, 'description');
  if (!name || !description || split.body.length === 0) return undefined;
  const declared = frontmatterValue(split.frontmatter, 'project');
  const project = parseProjectUse(declared);
  if (declared !== undefined && project === undefined) {
    onWarn?.(
      `unrecognised project: "${declared.slice(0, 60)}" — expected none|optional|required, ` +
        `using "${DEFAULT_SKILL_PROJECT_USE}"`,
    );
  }
  return { name, description, body: split.body, project: project ?? DEFAULT_SKILL_PROJECT_USE };
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
    const skill = parseSkill(text, (message) =>
      console.error(`[web-latex-mcp] ${file}: ${message}`),
    );
    if (!skill) {
      console.error(`[web-latex-mcp] skipped ${file}: missing name/description frontmatter`);
      continue;
    }
    skills.push(skill);
  }
  return skills;
}
