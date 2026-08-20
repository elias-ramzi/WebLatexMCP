import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadSkills, parseSkill } from '../../src/lib/skills.js';
import { buildSkillMessage } from '../../src/prompts/skills.js';

const SKILL = `---
name: demo-skill
description: Do the demo thing. Use when the user says "demo".
allowed-tools:
  - Bash(echo:*)
---

# Demo

Step one.
`;

async function writeSkill(dir: string, name: string, text: string): Promise<void> {
  await mkdir(path.join(dir, name), { recursive: true });
  await writeFile(path.join(dir, name, 'SKILL.md'), text);
}

describe('parseSkill', () => {
  it('reads name and description and strips the frontmatter', () => {
    const skill = parseSkill(SKILL);
    expect(skill?.name).toBe('demo-skill');
    expect(skill?.description).toBe('Do the demo thing. Use when the user says "demo".');
    expect(skill?.body).toBe('# Demo\n\nStep one.');
    // The nested allowed-tools list must not leak into the body or be read as a scalar.
    expect(skill?.body).not.toContain('allowed-tools');
  });

  it('keeps colons inside a description', () => {
    const skill = parseSkill('---\nname: a\ndescription: Fix this: then that\n---\n\nBody\n');
    expect(skill?.description).toBe('Fix this: then that');
  });

  it('rejects a file with no frontmatter, no name, or no body', () => {
    expect(parseSkill('# Just a doc\n')).toBeUndefined();
    expect(parseSkill('---\ndescription: no name\n---\n\nBody\n')).toBeUndefined();
    expect(parseSkill('---\nname: a\ndescription: b\n---\n')).toBeUndefined();
  });
});

describe('loadSkills', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'skills-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('loads the bundled .claude/skills by default', async () => {
    const skills = await loadSkills({});
    expect(skills.map((s) => s.name)).toContain('verify-citations');
    expect(skills.map((s) => s.name)).toContain('session-feedback');
    expect(skills.every((s) => s.description.length > 0 && s.body.length > 0)).toBe(true);
  });

  it('parses every bundled skill — a malformed SKILL.md is dropped silently otherwise', async () => {
    const dir = path.resolve(import.meta.dirname, '../../.claude/skills');
    const dirs = (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    const skills = await loadSkills({});
    // Each directory must yield a skill, and its slug must match the directory name — the plugin
    // and the prompt list both address a skill by that name.
    expect(skills.map((s) => s.name)).toEqual(dirs);
  });

  it('reads an override dir, sorted by name', async () => {
    await writeSkill(tmp, 'zeta', SKILL.replace('demo-skill', 'zeta'));
    await writeSkill(tmp, 'alpha', SKILL.replace('demo-skill', 'alpha'));
    const skills = await loadSkills({ WEB_LATEX_MCP_SKILLS_DIR: tmp });
    expect(skills.map((s) => s.name)).toEqual(['alpha', 'zeta']);
  });

  it('skips directories without a SKILL.md and files with bad frontmatter', async () => {
    await writeSkill(tmp, 'good', SKILL);
    await mkdir(path.join(tmp, 'empty-dir'), { recursive: true });
    await writeSkill(tmp, 'bad', '# no frontmatter\n');
    const skills = await loadSkills({ WEB_LATEX_MCP_SKILLS_DIR: tmp });
    expect(skills.map((s) => s.name)).toEqual(['demo-skill']);
  });

  it('returns [] when the directory is missing', async () => {
    const skills = await loadSkills({ WEB_LATEX_MCP_SKILLS_DIR: path.join(tmp, 'nope') });
    expect(skills).toEqual([]);
  });
});

describe('buildSkillMessage', () => {
  const skill = { name: 'demo', description: 'd', body: 'BODY' };

  it('scopes to a project when one is given', () => {
    const text = buildSkillMessage(skill, 'pictura');
    expect(text).toContain('`pictura`');
    expect(text).toContain('BODY');
  });

  it('tells the model to ask when no project is given', () => {
    expect(buildSkillMessage(skill)).toContain('Ask which project');
    expect(buildSkillMessage(skill, '  ')).toContain('Ask which project');
  });
});
