import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { getServerVersion } from '../lib/version.js';
import { quoteId } from '../lib/projectId.js';
import { toPosix } from '../lib/paths.js';
import { REWRITE_MODES, DEFAULT_REWRITE_MODE } from '../lib/rewriteMode.js';
import type { RewriteMode } from '../lib/rewriteMode.js';
import { countWritingConventions } from '../lib/writingConventions.js';
import { REFERENCE_SOURCES } from '../lib/referenceKey.js';
import { errorResult } from '../lib/errors.js';
import { legacyWorkspaceNote } from '../lib/workspaceNote.js';
import { countRegisteredProjects } from '../services/projectRegistry.js';
import { quoteInvalidSource } from '../services/referenceResolver.js';

const outputSchema = {
  name: z.string(),
  version: z.string(),
  workspaceRoot: z.string(),
  legacyWorkspaceRoot: z
    .string()
    .optional()
    .describe(
      "An older version's workspace-local folder (<launch dir>/.web_latex_mcp) that still " +
        'registers projects this server does not see. Move them into the workspace in use with ' +
        '`web-latex-mcp migrate-workspace <that folder>`. Absent when there is none.',
    ),
  mode: z
    .enum(['stdio', 'daemon'])
    .describe(
      'How this session reaches the server: `stdio` (one server process for this session) or ' +
        '`daemon` (one shared server, `web-latex-mcp serve`, for every session on the workspace).',
    ),
  daemonUnavailable: z
    .string()
    .optional()
    .describe(
      'Why this session runs its own in-process server: the shared server could not be reached or ' +
        'started. Absent when it is used, or when in-process serving was asked for.',
    ),
  restartPending: z
    .boolean()
    .optional()
    .describe(
      'True when a newer build of the server is waiting: the shared server restarts as that ' +
        'build once every session on it has ended. Absent otherwise.',
    ),
  sessionId: z
    .string()
    .describe("This session's id: it names the session to its peers and keys its own changes."),
  sessionIdRequested: z
    .string()
    .optional()
    .describe(
      'The session id this client asked for, when another open session already held it and this ' +
        'one was given `sessionId` instead. Absent otherwise.',
    ),
  ignoredClientEnv: z
    .array(z.string())
    .optional()
    .describe(
      "Server-wide settings this client's environment set differently from the shared server's. " +
        "They do not apply here: set them in the shared server's own environment. Names only, " +
        'never values. Absent when there are none.',
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
  referenceSource: z
    .string()
    .optional()
    .describe(
      'The bibliography backend pinned by WEB_LATEX_MCP_REFERENCE_SOURCE, when one is. Absent ' +
        'means nothing is pinned: search_references tries DBLP, then Crossref, then OpenAlex, ' +
        'and substitutes one it cannot reach — a search result reports which actually answered. ' +
        'Pinned, a backend is never substituted and an unreachable one is an error. This field ' +
        'does not probe the network.',
    ),
  referenceSourceInvalid: z
    .string()
    .optional()
    .describe(
      'Set when WEB_LATEX_MCP_REFERENCE_SOURCE holds a value that names no backend — the value ' +
        'itself, so the typo is visible. Present means search_references REFUSES an unpinned ' +
        'search (it will not substitute a bibliography the user did not name); passing a ' +
        'per-call source: still works, and every other tool is unaffected. The server starts ' +
        'normally: this setting governs one tool, so a typo in it is not a startup failure. ' +
        'Unlike contactEmail, this is the user’s own typo rather than personal data, so the ' +
        'value itself is reported — elided past 120 characters with the true length ' +
        'appended, since it is echoed into a model’s context in three places (the stderr ' +
        'line, the search_references refusal, and here).',
    ),
  contactEmailConfigured: z
    .boolean()
    .describe(
      'Whether WEB_LATEX_MCP_CONTACT_EMAIL is set to a usable address. Crossref and OpenAlex ' +
        'give identified clients a faster "polite pool". The address itself is deliberately NOT ' +
        'reported — only whether one is configured — since it is the user’s personal data and ' +
        'this output is read by a model.',
    ),
  contactEmailInvalid: z
    .boolean()
    .optional()
    .describe(
      'Set when WEB_LATEX_MCP_CONTACT_EMAIL holds a value that is not a usable address: the ' +
        'polite pool is OFF, and off because of that value rather than because nothing was ' +
        'configured — which contactEmailConfigured alone cannot tell apart. Absent means the ' +
        'variable is unset or fine. Only the fact of the rejection is reported, never the ' +
        'value: unlike referenceSourceInvalid (the user’s own typo of a backend id), this one ' +
        'is an email address — personal data — and this output is read by a model.',
    ),
  rewriteMode: z
    .enum(REWRITE_MODES as unknown as [RewriteMode, ...RewriteMode[]])
    .describe(
      'The *configured default* rewrite-preservation mode for edit_file ' +
        '(WEB_LATEX_MCP_REWRITE_MODE, or the built-in "off" default — nothing is preserved ' +
        'unless configured), which is not ' +
        "necessarily what any given project uses: a project's own set_rewrite_mode setting " +
        'wins over it, and a per-call preserveOriginal wins over both. Read list_projects for ' +
        'the effective mode a specific project resolves to.',
    ),
  envConfigured: z
    .boolean()
    .describe(
      'Whether WEB_LATEX_MCP_REWRITE_MODE actually names a mode on this server, as opposed to ' +
        '`rewriteMode` merely holding the built-in "off" default. Without this, a deliberately ' +
        'configured `WEB_LATEX_MCP_REWRITE_MODE=off` is byte-identical to nobody having ' +
        'configured anything — both report `rewriteMode: "off"`. This is the only field that ' +
        'tells them apart.',
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
  writingGuideExtraRuleCount: z
    .number()
    .int()
    .optional()
    .describe(
      'The number of top-level bullets currently in the extra writing guide file — including any ' +
        'the user wrote by hand, not only rules add_writing_convention appended. Read live from ' +
        "the file on every call, so it reflects a rule appended during THIS session; the server's " +
        'MCP instructions and the guide://latex/writing-guide resource are both fixed at startup ' +
        'and do not. Absent when no guide is configured or the file cannot be read.',
    ),
};

export function registerServerInfo(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'server_info',
    {
      title: 'Server info',
      description:
        'Report the web-latex-mcp server version and runtime configuration (workspace root, ' +
        'an older workspace-local folder still registering projects, if any, the configured ' +
        'compiler — which is not necessarily the backend a ' +
        'compile runs, since an uninstalled default is substituted; doctor reports what is really ' +
        'there — and the configured rewrite-preservation default, which is not necessarily what ' +
        "a given project uses since a project's own set_rewrite_mode setting wins over it, plus " +
        'whether WEB_LATEX_MCP_REWRITE_MODE actually set that default or it is only the built-in ' +
        'one) plus ' +
        'whether a project-specific writing guide (WEB_LATEX_MCP_WRITING_GUIDE_EXTRA) is configured ' +
        'and, if so, whether it actually loaded — a typo in that path otherwise means the ' +
        "user's conventions are silently ignored forever with nothing to tell them — plus a live " +
        'count of the bullets currently in that file (writingGuideExtraRuleCount), which reflects a ' +
        'rule added during this session even though the loaded instructions and the ' +
        'guide://latex/writing-guide resource are both fixed at startup. It also reports when ' +
        'WEB_LATEX_MCP_REFERENCE_SOURCE holds a value that names no bibliography backend, which ' +
        'is the reason search_references would be refusing an unpinned search while every other ' +
        'tool works. Use this to confirm which ' +
        'version of the MCP server is running.',
      inputSchema: {},
      outputSchema,
    },
    async () => {
      try {
        const legacyCount = ctx.config.legacyWorkspaceRoot
          ? countRegisteredProjects(ctx.config.legacyWorkspaceRoot)
          : 0;
        const info = {
          name: 'web-latex-mcp',
          version: getServerVersion(),
          workspaceRoot: toPosix(ctx.config.workspaceRoot),
          // Counted per call, like list_projects: after an in-session migration the folder registers
          // nothing and is no longer named.
          legacyWorkspaceRoot:
            legacyCount > 0 && ctx.config.legacyWorkspaceRoot
              ? toPosix(ctx.config.legacyWorkspaceRoot)
              : undefined,
          mode: ctx.config.serverMode ?? 'stdio',
          daemonUnavailable: ctx.config.daemonUnavailable,
          restartPending: ctx.config.restartPending === true ? true : undefined,
          sessionId: ctx.config.sessionId,
          sessionIdRequested: ctx.config.sessionIdRequested,
          ignoredClientEnv:
            ctx.config.ignoredClientEnv && ctx.config.ignoredClientEnv.length > 0
              ? [...ctx.config.ignoredClientEnv]
              : undefined,
          compiler: ctx.config.compiler ?? 'latexmk',
          // Absent, not a default id: nothing is pinned unless the user pinned it, and reporting
          // "dblp" here would describe the fallback order's first try as a choice someone made.
          referenceSource: ctx.config.referenceSourceExplicit
            ? ctx.config.referenceSource
            : undefined,
          // Reported apart from `referenceSource`, never folded into it: the value is not a
          // backend id, and a rejected value is nobody's choice.
          referenceSourceInvalid: ctx.config.referenceSourceInvalid,
          contactEmailConfigured: ctx.config.contactEmail !== undefined,
          // The boolean, and only the boolean: `ctx.config` never holds the rejected address.
          contactEmailInvalid: ctx.config.contactEmailInvalid,
          rewriteMode: ctx.config.rewriteMode ?? DEFAULT_REWRITE_MODE,
          // Not `rewriteMode !== undefined`: loadConfig populates rewriteMode with the built-in
          // default when the env names nothing, so that form would call every default install
          // "configured". Matches listProjects.ts exactly.
          envConfigured: ctx.config.rewriteModeExplicit === true,
          writingGuideExtraPath: ctx.config.extraWritingGuidePath
            ? toPosix(ctx.config.extraWritingGuidePath)
            : undefined,
          writingGuideExtraLoaded: ctx.config.extraWritingGuidePath
            ? (ctx.config.extraWritingGuideLoaded ?? false)
            : undefined,
          writingGuideExtraRuleCount: await countWritingConventions(
            ctx.config.extraWritingGuidePath,
          ),
        };
        const legacyLine =
          legacyCount > 0 && ctx.config.legacyWorkspaceRoot
            ? `${legacyWorkspaceNote(ctx.config.legacyWorkspaceRoot, legacyCount, ctx.config.workspaceRoot)}\n`
            : '';
        // Three states matter here, and only three: not configured (say nothing); configured and
        // loaded (name the path, so a user can tell it took); configured but NOT loaded (name the
        // path AND say plainly that those conventions are not in effect — the state a typo produces
        // silently otherwise, forever, with no other signal).
        let writingGuideLine = '';
        if (info.writingGuideExtraPath) {
          const countClause =
            info.writingGuideExtraRuleCount !== undefined
              ? `, ${info.writingGuideExtraRuleCount} conventions`
              : '';
          writingGuideLine = info.writingGuideExtraLoaded
            ? `writing guide (project-specific): ${info.writingGuideExtraPath} — loaded${countClause}\n`
            : `writing guide (project-specific): ${info.writingGuideExtraPath} — NOT ` +
              `loaded${countClause}; these conventions are not in effect\n`;
        }
        // An unusable WEB_LATEX_MCP_REFERENCE_SOURCE REPLACES the unpinned description rather than
        // appending to it: search_references refuses in that state, so describing the fallback
        // order here would tell a user diagnosing that refusal exactly the wrong thing.
        const referencesDetail = info.referenceSourceInvalid
          ? `WEB_LATEX_MCP_REFERENCE_SOURCE is set to ${quoteInvalidSource(info.referenceSourceInvalid)}, which is ` +
            `not a backend (expected one of: ${REFERENCE_SOURCES.join(', ')}) — search_references ` +
            'REFUSES until it is fixed or unset, unless the call passes source:. Every other tool ' +
            'is unaffected'
          : info.referenceSource
            ? `${info.referenceSource} (WEB_LATEX_MCP_REFERENCE_SOURCE — never substituted)`
            : 'dblp, then crossref, then openalex (unpinned — an unreachable one is substituted)';
        // Same shape, and for the same reason: an unusable WEB_LATEX_MCP_CONTACT_EMAIL REPLACES
        // the reassuring clause instead of silently reading as "nobody configured a contact".
        // The address itself is never rendered — only that one was set and rejected.
        const contactDetail = info.contactEmailInvalid
          ? ', polite-pool contact IGNORED (WEB_LATEX_MCP_CONTACT_EMAIL is not a usable address)'
          : info.contactEmailConfigured
            ? ', polite-pool contact set'
            : '';
        const text =
          `web-latex-mcp v${info.version}\n` +
          `workspace: ${info.workspaceRoot}\n` +
          `session: ${quoteId(info.sessionId)} (${info.mode})` +
          (info.daemonUnavailable !== undefined
            ? ` — the shared server is unavailable: ${info.daemonUnavailable}`
            : '') +
          (info.sessionIdRequested !== undefined
            ? ` — asked for ${quoteId(info.sessionIdRequested)}, which another open session holds`
            : '') +
          (info.restartPending
            ? ' — a newer build replaces this shared server once its sessions end'
            : '') +
          '\n' +
          (info.ignoredClientEnv
            ? `ignored from this client's environment (server-wide settings): ${info.ignoredClientEnv.map((n) => quoteId(n)).join(', ')}\n`
            : '') +
          legacyLine +
          writingGuideLine +
          `compiler: ${info.compiler}\n` +
          `references: ${referencesDetail}${contactDetail}\n` +
          `rewrite mode (default): ${info.rewriteMode}` +
          (info.envConfigured ? ' (WEB_LATEX_MCP_REWRITE_MODE)' : ' (built-in)');
        return {
          content: [{ type: 'text', text }],
          structuredContent: { ...info },
        };
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}
