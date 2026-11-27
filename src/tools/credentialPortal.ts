import { z } from 'zod';
import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import { inputRequired, inputResponse } from '@modelcontextprotocol/server';
import { clientCanElicitUrl } from '../lib/approvals.js';
import type { PortalOutcome } from '../services/credentialPortal.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import { openBrowser } from '../lib/openBrowser.js';
import { toPosix } from '../lib/paths.js';
import { resolveCredentialTarget } from '../lib/credentialTarget.js';
import { OVERLEAF_TOKEN_URL } from '../services/auth.js';
import { describeHelpers, noHelperAdvice, onlyEphemeral } from '../lib/credentialHelpers.js';
import { isWsl } from '../lib/wsl.js';

const inputSchema = {
  project: z
    .string()
    .optional()
    .describe('Derive the host (and default username) from this registered project’s git URL.'),
  host: z
    .string()
    .min(1)
    .optional()
    .describe('Host to store the credential for, e.g. git.overleaf.com. Alternative to `project`.'),
  username: z
    .string()
    .min(1)
    .optional()
    .describe('HTTPS username. Defaults to the host convention (e.g. `git` for Overleaf).'),
  open: z.boolean().optional().describe('Also open the portal in the OS browser (default true).'),
};

const outputSchema = {
  host: z.string(),
  username: z.string(),
  status: z
    .enum(['awaiting-entry', 'stored', 'not-persisted', 'no-helper', 'declined'])
    .describe(
      '`declined`: the client showed the page to the user, who declined to open it (nothing was ' +
        'stored, and the page is closed).',
    ),
  storage: z.string().optional(),
  url: z.string().optional(),
  opened: z.boolean().optional(),
};

/** The key the portal's URL-mode elicitation is asked under (#291). */
const PORTAL_KEY = 'credentialPortal';
/**
 * How long a call that showed the page waits for the user to submit, so the outcome comes back in
 * the same call. Past it, the call reports `awaiting-entry` and a later call reads the outcome.
 */
export const PORTAL_WAIT_MS = 5 * 60 * 1000;
/** How often a waiting call reports progress, which keeps a client's idle timeout from firing. */
const PROGRESS_EVERY_MS = 10_000;

/** A recorded submission as this tool's result. */
function outcomeResult(outcome: PortalOutcome) {
  const status = outcome.persisted ? ('stored' as const) : ('not-persisted' as const);
  const text = outcome.persisted
    ? `Your credential for ${outcome.username}@${outcome.host} was stored in ${outcome.storage ?? 'your git credential helper'} — the token never went through the chat.`
    : `The token was submitted but no credential helper kept it (none appears configured). Configure one (e.g. libsecret on Linux) or set the token via an env var.`;
  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: {
      host: outcome.host,
      username: outcome.username,
      status,
      ...(outcome.storage !== undefined ? { storage: outcome.storage } : {}),
    },
  };
}

/**
 * Wait for the submission while reporting progress on the call's token, if it has one: the
 * client keeps the call open for as long as the user needs (getting a token from Overleaf takes a
 * minute or two). Progress is best-effort; a failed notification only stops further ones.
 */
async function waitWithProgress(
  ctx: AppContext,
  host: string,
  toolCtx: ServerContext,
): Promise<PortalOutcome | undefined> {
  const token = toolCtx.mcpReq._meta?.progressToken;
  let ticks = 0;
  const ticker =
    token === undefined
      ? undefined
      : setInterval(() => {
          ticks++;
          void toolCtx.mcpReq
            .notify({
              method: 'notifications/progress',
              params: {
                progressToken: token,
                progress: ticks,
                message: 'Waiting for the token to be entered on the credential page…',
              },
            })
            .catch(() => clearInterval(ticker));
        }, PROGRESS_EVERY_MS);
  try {
    return await ctx.credentialPortal.waitOutcome(host, {
      timeoutMs: PORTAL_WAIT_MS,
      signal: toolCtx.mcpReq.signal,
    });
  } finally {
    clearInterval(ticker);
  }
}

export function registerCredentialPortal(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'credential_portal',
    {
      title: 'Open a local portal to enter a git token',
      description:
        'Open a small loopback web page where the user types a git token, so the secret is entered ' +
        'on their machine and handed to git’s credential helper (usually the OS keychain) **without ' +
        'ever passing through the chat** ' +
        '(useful when the transcript is cloud-synced). Returns a 127.0.0.1 URL (and auto-opens the ' +
        'browser). The token is POSTed straight to this local server and never returned to Claude. ' +
        'Give a `host` (e.g. git.overleaf.com) or a `project`. When the client can send the user ' +
        'to a URL itself (URL-mode elicitation), it shows them the page and this call returns ' +
        'the outcome once they submit: `stored`, `not-persisted` (no credential helper kept it), ' +
        'or `declined`. Otherwise, after the user submits, **call this tool again** with the same ' +
        'host/project to read the result; it reports `awaiting-entry` if they haven’t yet. ' +
        'When git has no credential helper at all, no page is opened and the result is `no-helper` ' +
        'with the ways to configure one — ask the user which they want; do not pick for them.',
      inputSchema,
      outputSchema,
    },
    async ({ project, host, username, open = true }, toolCtx: ServerContext) => {
      try {
        const target = resolveCredentialTarget(ctx.projectManager, { project, host, username });
        // URL-mode elicitation (#291): the client shows the page with its own consent UI, and
        // this one call returns the outcome. Not when the session relies on flags alone
        // (WEB_LATEX_MCP_APPROVALS=flag): such a client declines questions without showing them.
        const elicit =
          (ctx.config?.approvals ?? 'ask') !== 'flag' && clientCanElicitUrl(server, toolCtx);
        const answer = elicit
          ? inputResponse(toolCtx.mcpReq.inputResponses, PORTAL_KEY)
          : { kind: 'missing' as const };
        if (answer.kind === 'elicit') {
          if (answer.action !== 'accept') {
            await ctx.credentialPortal.close();
            return {
              content: [
                {
                  type: 'text',
                  text:
                    `The user declined to open the credential page for ${target.username}@` +
                    `${target.host}; nothing was stored, and the page is closed.`,
                },
              ],
              structuredContent: {
                host: target.host,
                username: target.username,
                status: 'declined',
              },
            };
          }
          const waited = await waitWithProgress(ctx, target.host, toolCtx);
          if (waited) return outcomeResult(waited);
          return {
            content: [
              {
                type: 'text',
                text:
                  `The credential page for ${target.username}@${target.host} is still waiting ` +
                  'for the token. Once the user has submitted it, call credential_portal again ' +
                  'with the same host or project to confirm it landed.',
              },
            ],
            structuredContent: {
              host: target.host,
              username: target.username,
              status: 'awaiting-entry',
            },
          };
        }

        // A follow-up call after the user submits: report the recorded outcome (read-once).
        const outcome = ctx.credentialPortal.takeOutcome(target.host);
        if (outcome) return outcomeResult(outcome);

        // Ask before collecting a token: with no helper, `git credential approve` keeps nothing, and
        // the user would only learn that after typing it in. `undefined` (git could not be asked)
        // opens the page anyway — the follow-up call still reports `not-persisted` then.
        const helpers = await ctx.credentials.credentialHelpers(target.host);
        if (helpers !== undefined && helpers.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text:
                  `No credential page opened for ${target.username}@${target.host}. ` +
                  noHelperAdvice({ platform: process.platform, wsl: isWsl() }),
              },
            ],
            structuredContent: {
              host: target.host,
              username: target.username,
              status: 'no-helper',
            },
          };
        }
        const storage = helpers ? describeHelpers(helpers) : undefined;

        const url = await ctx.credentialPortal.open(
          {
            ...target,
            workspaceRoot: toPosix(ctx.config.workspaceRoot),
            ...(storage !== undefined ? { storage } : {}),
          },
          ctx.config.viewerPort,
        );
        if (!url) {
          return {
            content: [
              {
                type: 'text',
                text: 'Could not start the credential portal (no free loopback port). Set WEB_LATEX_MCP_VIEWER_PORT to a free port and retry, or use set_credential.',
              },
            ],
          };
        }
        if (elicit) {
          // The client puts the page in front of the user (with its own consent step) and
          // retries this call once they have opened it; the retry waits for their submission.
          return inputRequired({
            inputRequests: {
              [PORTAL_KEY]: inputRequired.elicitUrl({
                message:
                  `Enter your git token for ${target.username}@${target.host} on this local page. ` +
                  `It goes straight to ${storage ?? 'git’s credential helper on this machine'} ` +
                  'and never through the chat.' +
                  (target.host.includes('overleaf.com')
                    ? ` No token yet? Create one at ${OVERLEAF_TOKEN_URL}`
                    : ''),
                url,
              }),
            },
          });
        }
        const opened = open ? await openBrowser(url) : false;

        const text =
          `Opened a local credential page for ${target.username}@${target.host}: ${url}\n` +
          (opened ? 'It should have opened in your browser. ' : 'Open it in your browser. ') +
          `Enter your token there — it goes straight to ${storage ?? 'git’s credential helper on this machine'} and never through the chat. ` +
          (helpers && onlyEphemeral(helpers)
            ? 'Note: git’s only helper is `cache`, so the token will be forgotten after its timeout. '
            : '') +
          'Once you’ve submitted it, ask me to check and I’ll confirm it landed.' +
          (target.host.includes('overleaf.com')
            ? `\nDon’t have a token yet? Create one under Account Settings → Git integration: ${OVERLEAF_TOKEN_URL}`
            : '');
        return {
          content: [{ type: 'text', text }],
          structuredContent: {
            host: target.host,
            username: target.username,
            status: 'awaiting-entry',
            url,
            opened,
            ...(storage !== undefined ? { storage } : {}),
          },
        };
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}
