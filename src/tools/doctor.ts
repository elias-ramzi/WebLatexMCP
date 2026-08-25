import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import type { DoctorCheck } from '../services/doctor.js';

const inputSchema = {
  checkRepository: z
    .boolean()
    .optional()
    .describe(
      'Also reach the package repository over the network to confirm it answers (default false — ' +
        'every other check is local). Worth it when an install failed and you need to know whether ' +
        'the repository itself is the problem; it times out after ~8s rather than hanging.',
    ),
};

const checkShape = z.object({
  name: z.string().describe('Stable slug, e.g. "engines" or "package-manager".'),
  status: z.enum(['ok', 'warn', 'fail']),
  detail: z.string(),
});

const outputSchema = {
  ok: z.boolean().describe('True when nothing the server needs is missing (warnings may remain).'),
  checks: z.array(checkShape),
  engines: z
    .array(z.string())
    .describe("LaTeX engines available on PATH, named as compile's `engine` argument expects."),
  hints: z.array(z.string()).describe('Concrete remedies for the findings, most important first.'),
};

/** Fixed-width status + name columns, so a long list of checks stays scannable. */
function renderCheck(check: DoctorCheck, nameWidth: number): string {
  return `${check.status.padEnd(4)} ${check.name.padEnd(nameWidth)}  ${check.detail}`;
}

export function registerDoctor(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'doctor',
    {
      title: 'Check the local LaTeX toolchain',
      description:
        'Report the local toolchain a compile depends on: the configured compiler — and, when it ' +
        'is missing, whether the other supported backend (latexmk/tectonic) is installed and ' +
        'whether compiles fall back to it — which engines are installed, the TeX distribution ' +
        'and its age, the package manager and the repository it would install from, where a ' +
        'package can be installed without root, git, and whether the workspace is writable. ' +
        'Read-only and local — pass checkRepository: true to also test ' +
        'the repository over the network. Call this when a compile fails for a reason that is ' +
        'about the machine rather than the document (missing package, unknown engine), instead of ' +
        'discovering each limitation by failing into it.',
      inputSchema,
      outputSchema,
    },
    async ({ checkRepository }) => {
      try {
        const result = await ctx.doctor.diagnose({
          compiler: ctx.config.compiler ?? 'latexmk',
          compilerExplicit: ctx.config.compilerExplicit ?? false,
          workspaceRoot: ctx.config.workspaceRoot,
          checkRepository,
        });

        const failed = result.checks.filter((c) => c.status === 'fail').length;
        const warned = result.checks.filter((c) => c.status === 'warn').length;
        const headline =
          `toolchain: ${failed > 0 ? `${failed} missing` : 'nothing missing'}` +
          `, ${warned} warning(s)`;
        const nameWidth = Math.max(...result.checks.map((c) => c.name.length));
        const text = [
          headline,
          ...result.checks.map((c) => renderCheck(c, nameWidth)),
          ...(result.hints.length > 0 ? ['', 'hints:', ...result.hints.map((h) => `- ${h}`)] : []),
        ].join('\n');

        return {
          content: [{ type: 'text', text }],
          structuredContent: { ...result },
        };
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}
