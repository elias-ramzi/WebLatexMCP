import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { appendWritingConvention } from '../lib/writingConventions.js';
import { errorResult } from '../lib/errors.js';
import { toPosix } from '../lib/paths.js';

const inputSchema = {
  rule: z
    .string()
    .min(1)
    .describe(
      'One self-contained writing convention, phrased as an instruction (e.g. "Always write ' +
        "'lidar', never 'LiDAR'.\"). Appended as a bullet to the project's extra writing " +
        'guide file — do not include multiple unrelated rules in one call.',
    ),
};

const outputSchema = {
  path: z.string().describe('POSIX path of the writing-guide file the rule was appended to.'),
  created: z.boolean().describe('Whether this call created the file (it did not exist before).'),
  appliesFrom: z
    .string()
    .describe(
      'When the rule takes effect: only new sessions, since MCP `instructions` are fixed at ' +
        "server initialization and this running session's guide text is not live-updated.",
    ),
};

export function registerAddWritingConvention(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'add_writing_convention',
    {
      title: 'Add writing convention',
      description:
        'Remember a project-specific writing convention (e.g. "always write lidar, never ' +
        'LiDAR") by appending it to the user\'s configured extra writing-guide file ' +
        "(WEB_LATEX_MCP_WRITING_GUIDE_EXTRA), which is loaded into the server's instructions at " +
        'startup. Use this only when the user explicitly asks to remember or add a writing ' +
        "convention. The rule takes effect in NEW sessions only — this running session's own " +
        'guide text is not updated live, though it already has the rule in context since it just ' +
        'added it. Fails with an actionable error if no extra writing guide is configured.',
      inputSchema,
      outputSchema,
    },
    async ({ rule }) => {
      try {
        const result = await appendWritingConvention(ctx.config.extraWritingGuidePath, rule, {
          owner: ctx.config.sessionId,
        });
        const output = {
          path: toPosix(result.path),
          created: result.created,
          appliesFrom:
            'new sessions only — MCP instructions are fixed at initialization, so this running ' +
            "session's guide text is not updated; a sibling session picks it up on its next start.",
        };
        const text =
          `Added convention to ${output.path}${result.created ? ' (created new file)' : ''}. ` +
          `Takes effect in new sessions only — this session's own guide text is not live-updated.`;
        return {
          content: [{ type: 'text', text }],
          structuredContent: { ...output },
        };
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}
