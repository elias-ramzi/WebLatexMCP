import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { errorResult } from '../lib/errors.js';
import { buildSkillMessage } from '../prompts/skills.js';
import type { Skill } from '../lib/skills.js';

const inputSchema = {
  skill: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Name of one skill to fetch in full — the result then carries its complete procedure, ready ' +
        'to follow. Omit to get the catalogue (name + description) instead.',
    ),
  project: z
    .string()
    .min(1)
    .optional()
    .describe('With `skill`: the project id the procedure should be applied to.'),
};

const outputSchema = {
  skills: z
    .array(
      z.object({
        name: z.string(),
        description: z.string().describe('What the skill does and when to reach for it.'),
      }),
    )
    .describe('Every bundled skill, sorted by name.'),
  instructions: z
    .string()
    .optional()
    .describe('The full procedure for the requested skill. Absent when listing the catalogue.'),
};

/**
 * Expose the bundled skills as a *tool*, alongside the MCP prompts in `../prompts/skills.ts`.
 *
 * The two are for different callers, which is why both exist. Prompts are user-invoked: the client
 * lists them and a human picks one (in Claude Code they show up as slash commands). A tool is
 * model-invoked — it is the only route by which an agent working through this server can discover
 * that, say, a citation-verification procedure ships with it and then follow that procedure,
 * without the user knowing to ask. `.claude/skills` itself is read only by Claude Code, and only
 * for the *user's* project, never for a server's bundled directory.
 */
export function registerListSkills(server: McpServer, skills: Skill[]): void {
  server.registerTool(
    'list_skills',
    {
      title: 'List the bundled LaTeX skills',
      description:
        'List the LaTeX procedures bundled with this server — formatting a project, normalizing a ' +
        '.bib, verifying citations against DBLP, preparing an arXiv submission, summarizing a ' +
        'paper — each with what it does and when to use it. Pass `skill` to get one back in full ' +
        'and follow it. Worth calling when a request sounds like one of these: the bundled ' +
        'procedure knows this server’s tools and guardrails, so it beats improvising.',
      inputSchema,
      outputSchema,
    },
    ({ skill, project }) => {
      try {
        const catalogue = skills.map((s) => ({ name: s.name, description: s.description }));

        if (skill === undefined) {
          const text =
            skills.length === 0
              ? 'No skills are bundled with this server (or WEB_LATEX_MCP_SKILLS_DIR points ' +
                'somewhere without a SKILL.md).'
              : [
                  'Bundled skills — call list_skills({ skill: "<name>" }) to get one in full:',
                  ...skills.map((s) => `- ${s.name}: ${s.description}`),
                ].join('\n');
          return {
            content: [{ type: 'text', text }],
            structuredContent: { skills: catalogue },
          };
        }

        const found = skills.find((s) => s.name === skill);
        if (!found) {
          const known = skills.map((s) => s.name).join(', ') || '(none bundled)';
          throw new Error(`Unknown skill "${skill}". Available skills: ${known}.`);
        }

        // Same framing the prompt uses, so a skill reads as an instruction to follow now rather
        // than as reference material that happens to describe a procedure.
        const instructions = buildSkillMessage(found, project);
        return {
          content: [{ type: 'text', text: instructions }],
          structuredContent: { skills: catalogue, instructions },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
