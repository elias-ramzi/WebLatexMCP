import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Skill } from '../lib/skills.js';

/** Optional scoping argument, so the skill starts on a known project instead of asking. */
const argsSchema = {
  project: z
    .string()
    .optional()
    .describe('Project id to apply the skill to (omit to be asked, or to pick later).'),
};

/**
 * Frame the skill body as an instruction the model is receiving now, rather than a
 * document it happens to be reading. Prompts arrive as an ordinary user message, so
 * without this the model can mistake a procedure for reference material.
 */
export function buildSkillMessage(skill: Skill, project?: string): string {
  const scope = project?.trim()
    ? `Apply it to the project \`${project.trim()}\`.`
    : 'Ask which project to apply it to if that is not already clear from the conversation.';
  return (
    `Follow the "${skill.name}" procedure below, using this server's tools. ${scope}\n\n` +
    `---\n\n${skill.body}`
  );
}

/**
 * Expose each bundled skill as an MCP prompt. `.claude/skills` is a Claude Code–only
 * mechanism, so this is how the same procedures reach every other MCP client (Claude
 * Desktop, Cursor, …) — they ship with the server rather than being uploaded per user.
 *
 * Unlike a real skill these are user-invoked, not model-invoked: the client lists them
 * and the user picks one. Keep the prompt name equal to the skill slug so it reads the
 * same in every client.
 */
export function registerSkillPrompts(server: McpServer, skills: Skill[]): void {
  for (const skill of skills) {
    server.registerPrompt(
      skill.name,
      {
        title: skill.name,
        description: skill.description,
        argsSchema,
      },
      ({ project }) => ({
        messages: [
          {
            role: 'user' as const,
            content: { type: 'text' as const, text: buildSkillMessage(skill, project) },
          },
        ],
      }),
    );
  }
}
