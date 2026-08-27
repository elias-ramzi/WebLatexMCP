import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { getServerVersion } from '../lib/version.js';
import { toPosix } from '../lib/paths.js';
import { REWRITE_MODES, DEFAULT_REWRITE_MODE } from '../lib/rewriteMode.js';
import type { RewriteMode } from '../lib/rewriteMode.js';

const outputSchema = {
  name: z.string(),
  version: z.string(),
  workspaceRoot: z.string(),
  workspaceLocal: z.boolean(),
  workspaceExcludePattern: z
    .string()
    .optional()
    .describe(
      'When the workspace is local to the launch dir and that dir is a git repo, the pattern the ' +
        "server added to the host repo's .git/info/exclude so the clones are not committed. Its " +
        'presence means the directory is already handled — do not add a .gitignore entry for it. ' +
        'Absent when nothing was excluded.',
    ),
  compiler: z
    .string()
    .describe(
      'The *configured* compile backend, which is not always the one that runs: when it is only ' +
        'the default (WEB_LATEX_MCP_COMPILER names no backend) and is not installed, compile ' +
        'substitutes a ' +
        'backend that is. This field does not probe PATH — run doctor for what is actually ' +
        "installed, or read a compile result's own `compiler` for what ran.",
    ),
  rewriteMode: z
    .enum(REWRITE_MODES as unknown as [RewriteMode, ...RewriteMode[]])
    .describe(
      'The *configured default* rewrite-preservation mode for edit_file ' +
        '(WEB_LATEX_MCP_REWRITE_MODE, or the built-in "prose" default), which is not ' +
        "necessarily what any given project uses: a project's own set_rewrite_mode setting " +
        'wins over it, and a per-call preserveOriginal wins over both. Read list_projects for ' +
        'the effective mode a specific project resolves to.',
    ),
  writingGuideExtraPath: z
    .string()
    .optional()
    .describe(
      'The path WEB_LATEX_MCP_WRITING_GUIDE_EXTRA names, if set. Absent when the var is unset. A ' +
        'typo in this path would otherwise mean the project-specific conventions are silently ' +
        'ignored forever with no way to tell — check writingGuideExtraLoaded alongside this to see ' +
        'whether the file actually read.',
    ),
  writingGuideExtraLoaded: z
    .boolean()
    .optional()
    .describe(
      'Whether the extra writing guide file actually read at startup. Present only when ' +
        'writingGuideExtraPath is set. false means the conventions in that file are NOT in effect ' +
        'for this session — the path is wrong or the file is unreadable.',
    ),
};

export function registerServerInfo(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'server_info',
    {
      title: 'Server info',
      description:
        'Report the web-latex-mcp server version and runtime configuration (workspace root, ' +
        'whether the workspace is local to the launch dir, whether the clone dir was git-excluded ' +
        'from the host repo, the configured compiler — which is not necessarily the backend a ' +
        'compile runs, since an uninstalled default is substituted; doctor reports what is really ' +
        'there — and the configured rewrite-preservation default, which is not necessarily what ' +
        "a given project uses since a project's own set_rewrite_mode setting wins over it) plus " +
        'whether a project-specific writing guide (WEB_LATEX_MCP_WRITING_GUIDE_EXTRA) is configured ' +
        'and, if so, whether it actually loaded — a typo in that path otherwise means the ' +
        "user's conventions are silently ignored forever with nothing to tell them. Use this to " +
        'confirm which version of the MCP server is running.',
      inputSchema: {},
      outputSchema,
    },
    async () => {
      const info = {
        name: 'web-latex-mcp',
        version: getServerVersion(),
        workspaceRoot: toPosix(ctx.config.workspaceRoot),
        workspaceLocal: ctx.config.workspaceIsLocal ?? false,
        workspaceExcludePattern: ctx.config.workspaceExcludePattern,
        compiler: ctx.config.compiler ?? 'latexmk',
        rewriteMode: ctx.config.rewriteMode ?? DEFAULT_REWRITE_MODE,
        writingGuideExtraPath: ctx.config.extraWritingGuidePath
          ? toPosix(ctx.config.extraWritingGuidePath)
          : undefined,
        writingGuideExtraLoaded: ctx.config.extraWritingGuidePath
          ? (ctx.config.extraWritingGuideLoaded ?? false)
          : undefined,
      };
      // Say it out loud: the exclude is real but lives in .git/info/exclude, which is invisible to
      // anyone who did not run this server — the user may still want a tracked .gitignore entry.
      const excludeLine = info.workspaceExcludePattern
        ? `git: clones are excluded from the host repo as "${info.workspaceExcludePattern}" via ` +
          '.git/info/exclude (local to this checkout only — collaborators will not see it)\n'
        : '';
      // Three states matter here, and only three: not configured (say nothing); configured and
      // loaded (name the path, so a user can tell it took); configured but NOT loaded (name the
      // path AND say plainly that those conventions are not in effect — the state a typo produces
      // silently otherwise, forever, with no other signal).
      let writingGuideLine = '';
      if (info.writingGuideExtraPath) {
        writingGuideLine = info.writingGuideExtraLoaded
          ? `writing guide (project-specific): ${info.writingGuideExtraPath} — loaded\n`
          : `writing guide (project-specific): ${info.writingGuideExtraPath} — NOT loaded; these ` +
            'conventions are not in effect\n';
      }
      const text =
        `web-latex-mcp v${info.version}\n` +
        `workspace: ${info.workspaceRoot} (${info.workspaceLocal ? 'local' : 'shared'})\n` +
        excludeLine +
        writingGuideLine +
        `compiler: ${info.compiler}\n` +
        `rewrite mode (default): ${info.rewriteMode}`;
      return {
        content: [{ type: 'text', text }],
        structuredContent: { ...info },
      };
    },
  );
}
