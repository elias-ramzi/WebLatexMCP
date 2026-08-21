import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import { splitLines } from '../lib/lines.js';
import { resolveInside, toPosix } from '../lib/paths.js';

const inputSchema = {
  project: z.string().optional(),
  path: z.string().describe('Path relative to the project root.'),
  startLine: z.number().int().positive().optional().describe('1-based first line (inclusive).'),
  endLine: z.number().int().positive().optional().describe('1-based last line (inclusive).'),
  ref: z
    .string()
    .optional()
    .describe(
      'Read a committed version instead of the working tree, at this git ref — the remote default ' +
        'branch (e.g. "origin/master" or "origin/main"), a commit sha, or "HEAD~1". Use it to see ' +
        'the remote/other side of a conflict. Line range still applies; out-of-band-edit tracking ' +
        'does not (a ref read never updates baselines).',
    ),
};

const outputSchema = {
  path: z.string(),
  content: z.string(),
  totalLines: z.number(),
  truncated: z.boolean(),
  note: z.string().optional(),
  ref: z.string().optional(),
};

/** Slice a 1-based inclusive line range out of full content (both bounds optional). */
function sliceLines(content: string, startLine?: number, endLine?: number): string {
  if (startLine === undefined && endLine === undefined) return content;
  const lines = splitLines(content);
  const start = startLine ? startLine - 1 : 0;
  const end = endLine ?? lines.length;
  return lines.slice(start, end).join('\n');
}

export function registerReadFile(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'read_file',
    {
      title: 'Read a project file',
      description:
        'Read a text file from the project (optionally a line range). Pass `ref` to read a ' +
        'committed version at any git ref (e.g. the remote side of a conflict) instead of the ' +
        'working tree. Binary/large files are not returned inline — their path is reported instead.',
      inputSchema,
      outputSchema,
    },
    async ({ project, path: relPath, startLine, endLine, ref }) => {
      try {
        const { dir } = await ctx.projectManager.requireProjectDir(project);

        if (ref) {
          ctx.projectManager.requireGitProject(project, 'read a committed revision from');
          // Sandbox the path the same way FileService does, then read the blob at the ref.
          const abs = resolveInside(dir, relPath);
          const rel = toPosix(path.relative(dir, abs));
          const full = await ctx.git.showAtRef(dir, ref, rel);
          const totalLines = splitLines(full).length;
          const content = sliceLines(full, startLine, endLine);
          const truncated = content !== full;
          return {
            content: [{ type: 'text', text: content }],
            structuredContent: { path: relPath, content, totalLines, truncated, ref },
          };
        }

        // The one read whose bytes go back to the caller, so the one read that may claim the
        // out-of-band-edit baseline — see FileService.read.
        const result = await ctx.files.read(dir, {
          path: relPath,
          startLine,
          endLine,
          recordBaseline: true,
        });
        return {
          content: [{ type: 'text', text: result.note ?? result.content }],
          structuredContent: { ...result },
        };
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}
