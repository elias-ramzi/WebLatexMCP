import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import { openBrowser } from '../lib/openBrowser.js';
import { resolveCredentialTarget } from '../lib/credentialTarget.js';

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
  status: z.enum(['awaiting-entry', 'stored', 'not-persisted']),
  url: z.string().optional(),
  opened: z.boolean().optional(),
};

export function registerCredentialPortal(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'credential_portal',
    {
      title: 'Open a local portal to enter a git token',
      description:
        'Open a small loopback web page where the user types a git token, so the secret is entered ' +
        'on their machine and stored in the OS keychain **without ever passing through the chat** ' +
        '(useful when the transcript is cloud-synced). Returns a 127.0.0.1 URL (and auto-opens the ' +
        'browser). The token is POSTed straight to this local server and never returned to Claude. ' +
        'Give a `host` (e.g. git.overleaf.com) or a `project`. After the user submits, **call this ' +
        'tool again** with the same host/project to read the result: it reports `stored`, ' +
        '`not-persisted` (no credential helper kept it), or `awaiting-entry` if they haven’t yet.',
      inputSchema,
      outputSchema,
    },
    async ({ project, host, username, open = true }) => {
      try {
        const target = resolveCredentialTarget(ctx.projectManager, { project, host, username });

        // A follow-up call after the user submits: report the recorded outcome (read-once).
        const outcome = ctx.credentialPortal.takeOutcome(target.host);
        if (outcome) {
          const status = outcome.persisted ? 'stored' : 'not-persisted';
          const text = outcome.persisted
            ? `Your credential for ${outcome.username}@${outcome.host} was stored in the OS keychain — the token never went through the chat.`
            : `The token was submitted but no credential helper kept it (none appears configured). Configure one (e.g. libsecret on Linux) or set the token via an env var.`;
          return {
            content: [{ type: 'text', text }],
            structuredContent: { host: outcome.host, username: outcome.username, status },
          };
        }

        const url = await ctx.credentialPortal.open(target, ctx.config.viewerPort);
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
        const opened = open ? await openBrowser(url) : false;

        const text =
          `Opened a local credential page for ${target.username}@${target.host}: ${url}\n` +
          (opened ? 'It should have opened in your browser. ' : 'Open it in your browser. ') +
          'Enter your token there — it goes straight to this machine’s keychain and never through the chat. ' +
          'Once you’ve submitted it, ask me to check and I’ll confirm it landed.';
        return {
          content: [{ type: 'text', text }],
          structuredContent: {
            host: target.host,
            username: target.username,
            status: 'awaiting-entry',
            url,
            opened,
          },
        };
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}
