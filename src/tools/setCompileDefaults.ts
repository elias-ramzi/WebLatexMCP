import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import { compileDefaultsSchema } from '../lib/compileDefaults.js';
import type { CompileDefaults } from '../lib/compileDefaults.js';

const inputSchema = {
  project: z.string().optional(),
  defaults: compileDefaultsSchema
    .optional()
    .describe(
      'The defaults to store, REPLACING whatever was stored (fields left out are no longer ' +
        'defaulted). compiler (an assertion, as a per-call compiler is: a missing backend is an ' +
        'error, never substituted), engine, timeoutSec, warningsFilter — the same shapes compile ' +
        'takes. Omit to report what is stored.',
    ),
  clear: z
    .boolean()
    .optional()
    .describe('Remove the stored defaults. Not together with `defaults`.'),
};

const outputSchema = {
  defaults: compileDefaultsSchema
    .nullable()
    .describe('The defaults in effect after this call, or null when none are stored.'),
  previous: compileDefaultsSchema
    .nullable()
    .describe('What was stored just before this call (read under the same lock as the write).'),
  changed: z.boolean().describe('False when the call only reported the stored defaults.'),
};

function describe(d: CompileDefaults | null): string {
  if (!d || Object.keys(d).length === 0) return 'none';
  return Object.entries(d)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(', ');
}

export function registerSetCompileDefaults(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'set_compile_defaults',
    {
      title: 'Set per-project compile defaults',
      description:
        'Store the compile arguments this project always uses — compiler, engine, timeoutSec, ' +
        'warningsFilter — so compile (and edit_file/write_file with compile: true) stop needing ' +
        'them on every call. Per field, an argument a call passes still wins. Stored per project, ' +
        'shared by every session and kept across restarts. Omit `defaults` to report what is ' +
        'stored; pass clear: true to remove it.',
      inputSchema,
      outputSchema,
    },
    async ({ project, defaults, clear }) => {
      try {
        if (defaults !== undefined && clear) {
          throw new Error('Pass either `defaults` or clear: true, not both.');
        }
        const { id } = await ctx.projectManager.requireProjectDir(project);
        if (defaults === undefined && !clear) {
          const stored = await ctx.compileDefaults.get(id);
          return {
            content: [{ type: 'text', text: `${id}: compile defaults: ${describe(stored)}` }],
            structuredContent: { defaults: stored, previous: stored, changed: false },
          };
        }
        return await ctx.projectManager.runExclusive(id, async () => {
          const previous = await ctx.compileDefaults.get(id);
          if (clear || Object.keys(defaults ?? {}).length === 0) {
            await ctx.compileDefaults.clear(id);
          } else if (defaults) {
            await ctx.compileDefaults.set(id, defaults);
          }
          const now = await ctx.compileDefaults.get(id);
          return {
            content: [
              {
                type: 'text',
                text:
                  `${id}: compile defaults set to: ${describe(now)}` +
                  ` (was: ${describe(previous)}).`,
              },
            ],
            structuredContent: { defaults: now, previous, changed: true },
          };
        });
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}
