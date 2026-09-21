import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadSkills, parseSkill, parseProjectUse } from '../../src/lib/skills.js';
import { buildSkillMessage } from '../../src/prompts/skills.js';
import type { Skill } from '../../src/lib/skills.js';

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

  it('reads the project declaration', () => {
    expect(parseSkill('---\nname: a\ndescription: b\nproject: none\n---\n\nBody\n')?.project).toBe(
      'none',
    );
    expect(
      parseSkill('---\nname: a\ndescription: b\nproject: required\n---\n\nBody\n')?.project,
    ).toBe('required');
  });

  it('defaults to optional when the key is absent — a pre-existing SKILL.md keeps working', () => {
    const skill = parseSkill(SKILL);
    expect(skill?.project).toBe('optional');
  });

  it('degrades an unreadable value to the default and warns, keeping the skill', () => {
    const warnings: string[] = [];
    const skill = parseSkill(
      '---\nname: a\ndescription: b\nproject: yes please\n---\n\nBody\n',
      (m) => warnings.push(m),
    );
    // A typo in a user's own skills directory must cost a warning, never the skill.
    expect(skill?.name).toBe('a');
    expect(skill?.project).toBe('optional');
    expect(warnings[0]).toContain('yes please');
  });

  it('tolerates quotes and case in the value', () => {
    expect(parseProjectUse('"None"')).toBe('none');
    expect(parseProjectUse("  'Required' ")).toBe('required');
    expect(parseProjectUse('nope')).toBeUndefined();
    expect(parseProjectUse(undefined)).toBeUndefined();
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

  it('declares a project requirement on every bundled skill', async () => {
    const skills = await loadSkills({});
    const byName = new Map(skills.map((s) => [s.name, s.project]));
    // session-feedback reports on the server, not on a paper: its body says "No project id is
    // needed to run this", so its prompt must advertise no project argument to mis-bind.
    expect(byName.get('session-feedback')).toBe('none');
    for (const [name, use] of byName) {
      if (name === 'session-feedback') continue;
      expect([name, use]).toEqual([name, 'optional']);
    }
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
  const skill: Skill = { name: 'demo', description: 'd', body: 'BODY', project: 'optional' };

  it('scopes to a project when one is given', () => {
    const text = buildSkillMessage(skill, 'pictura');
    expect(text).toContain('`pictura`');
    expect(text).toContain('BODY');
  });

  it('tells the model to ask when no project is given', () => {
    expect(buildSkillMessage(skill)).toContain('Ask which project');
    expect(buildSkillMessage(skill, '  ')).toContain('Ask which project');
  });

  it('says nothing about a project for a skill that takes none', () => {
    const text = buildSkillMessage({ ...skill, project: 'none' }, 'please');
    expect(text).not.toContain('project');
    expect(text).toContain('BODY');
  });

  it('reports an unrecognised id instead of instructing the model to act on it', () => {
    const text = buildSkillMessage(skill, 'nope', 'unknown');
    expect(text).toContain('No project named `nope` is registered');
    expect(text).not.toContain('Apply it to the project');
  });

  it('separates a failed lookup from a project that is known not to exist', () => {
    const text = buildSkillMessage(skill, 'pictura', 'unverified');
    expect(text).toContain('could not be checked');
    expect(text).not.toContain('No project named');
  });
});
