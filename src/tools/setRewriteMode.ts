import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import { REWRITE_MODES, resolveRewriteMode, DEFAULT_REWRITE_MODE } from '../lib/rewriteMode.js';
import type { RewriteMode, RewriteModeSource } from '../lib/rewriteMode.js';

const modeEnum = z.enum(REWRITE_MODES as unknown as [RewriteMode, ...RewriteMode[]]);

/**
 * Where a resolved mode came from, shared with `list_projects` rather than each tool keeping a
 * private copy (the same reason `REWRITE_MODES` itself is shared). `'call'` is unreachable from
 * either tool's own source enum: neither takes a per-call `preserveOriginal`-equivalent, so a
 * mode reported by these two tools can only be `'project'` or `'default'`. It stays in the
 * vocabulary because it names a real value `resolveRewriteMode` can return (and `edit_file` does
 * report it) — narrowing it away here would make this a different type from the one
 * `resolveRewriteMode` actually produces.
 */
export const rewriteModeSourceEnum = z.enum([
  'call',
  'project',
  'default',
] as const satisfies readonly RewriteModeSource[]);

/**
 * Fail the build if `RewriteModeSource` ever gains a member this enum does not list. `satisfies`
 * above catches a value that stops being a source; this catches a source that stops being a
 * value. Without both directions the schema drifts silently from the type it claims to mirror,
 * and a tool would report a source no client's schema admits.
 */
type UnlistedSource = Exclude<RewriteModeSource, (typeof rewriteModeSourceEnum.options)[number]>;
const _sourcesAreExhaustive: UnlistedSource extends never ? true : never = true;
void _sourcesAreExhaustive;

const inputSchema = {
  project: z.string().optional(),
  mode: modeEnum
    .optional()
    .describe(
      'The mode to store for this project. Omit to report the current mode without changing it.',
    ),
};

const outputSchema = {
  mode: modeEnum.describe('The mode in effect after this call.'),
  source: rewriteModeSourceEnum.describe(
    'Where the reported mode came from: "project" if stored for this project, "default" if it ' +
      'is only the WEB_LATEX_MCP_REWRITE_MODE default (or the built-in one) and nothing is stored.',
  ),
  changed: z.boolean().describe('False when the call only reported the mode.'),
  previous: modeEnum.describe(
    'The mode that was in effect just before this call. When mode is omitted (a report-only ' +
      'call), equal to the reported mode. Read inside the same lock as the write, so it can ' +
      'never be a stale value from a peer session racing this one.',
  ),
};

export function registerSetRewriteMode(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'set_rewrite_mode',
    {
      title: 'Set rewrite preservation mode',
      description:
        'Choose what edit_file does with the text it replaces in a .tex file. "always": comment ' +
        'the original out above the replacement, the way Overleaf users do by hand. "prose": do ' +
        'that only for what looks like a prose rewrite, so a typo fix or a changed cite key is ' +
        'not preserved (the default). "off": replace outright. The choice is stored per project ' +
        "and outlives this session; edit_file's preserveOriginal overrides it for one call. " +
        'Omit `mode` to report the current setting. When setting a mode, the result reports ' +
        '`previous` (the mode in effect just before the call) alongside `mode`, so a caller can ' +
        'say what it changed from and to.',
      inputSchema,
      outputSchema,
    },
    async ({ project, mode }) => {
      try {
        // Not requireGitProject: the mode is about editing prose, which a local in-place draft
        // does as much as a clone does.
        const { id } = await ctx.projectManager.requireProjectDir(project);
        const envDefault = ctx.config.rewriteMode ?? DEFAULT_REWRITE_MODE;
        // Reporting takes no lock — it is a read, like every other read-only tool.
        if (mode === undefined) {
          const stored = await ctx.rewriteModes.get(id);
          const current = resolveRewriteMode({ stored, envDefault });
          return {
            content: [
              {
                type: 'text',
                text:
                  `${id}: rewrite mode is "${current.mode}"` +
                  (current.source === 'default' ? ' (the default — nothing stored)' : ''),
              },
            ],
            structuredContent: { ...current, changed: false, previous: current.mode },
          };
        }
        // Storing mutates per-project state, so it serialises with every other writer. The
        // "previous" read happens inside this same lock, so it cannot be a stale value raced by
        // a peer session's concurrent set_rewrite_mode call.
        return await ctx.projectManager.runExclusive(id, async () => {
          const storedBefore = await ctx.rewriteModes.get(id);
          const before = resolveRewriteMode({ stored: storedBefore, envDefault });
          await ctx.rewriteModes.set(id, mode);
          const transition = before.mode === mode ? '' : ` (was "${before.mode}")`;
          return {
            content: [{ type: 'text', text: `${id}: rewrite mode set to "${mode}"${transition}.` }],
            structuredContent: {
              mode,
              source: 'project' as const,
              changed: true,
              previous: before.mode,
            },
          };
        });
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}
