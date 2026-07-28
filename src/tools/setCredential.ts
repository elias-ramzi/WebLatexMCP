import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import { defaultUsernameForHost, hostFromGitUrl } from '../services/auth.js';

const inputSchema = {
  token: z
    .string()
    .min(1)
    .describe('The token / password to store (e.g. your Overleaf Git authentication token).'),
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
  confirm: z
    .boolean()
    .optional()
    .describe('Must be true — storing a secret in your OS keychain is an explicit action.'),
};

const outputSchema = {
  host: z.string(),
  username: z.string(),
  persisted: z.boolean(),
};

export function registerSetCredential(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'set_credential',
    {
      title: 'Store a git credential (OS keychain)',
      description:
        'Store a git token in your OS credential helper (macOS Keychain / Windows Credential Manager ' +
        '/ libsecret), so the server can authenticate without the token ever being written to its ' +
        'config or the project registry. Ideal for Claude Desktop: paste your Overleaf token here ' +
        'instead of editing the JSON config. Give a `host` (e.g. git.overleaf.com) or a `project` id ' +
        'to derive it from. Requires `confirm: true`. Reports whether a credential helper actually ' +
        'kept it (some Linux setups have none configured — set the token via an env var there).',
      inputSchema,
      outputSchema,
    },
    async ({ token, project, host, username, confirm }) => {
      try {
        if (!confirm) {
          throw new Error(
            'Set confirm: true to store this credential in your OS keychain (it is a real, ' +
              'out-of-band side effect).',
          );
        }

        let resolvedHost = host?.trim();
        let resolvedUsername = username?.trim();
        if (!resolvedHost) {
          if (!project) {
            throw new Error('Provide a `host` (e.g. git.overleaf.com) or a `project` id.');
          }
          const cfg = ctx.projectManager.getProjectConfig(project);
          resolvedHost = hostFromGitUrl(cfg.gitUrl);
          if (!resolvedHost) {
            throw new Error(`Could not determine a host from project "${cfg.id}" (${cfg.gitUrl}).`);
          }
          resolvedUsername = resolvedUsername || cfg.username;
        }
        resolvedUsername = resolvedUsername || defaultUsernameForHost(resolvedHost);

        const { persisted } = await ctx.credentials.storeCredential(
          resolvedHost,
          resolvedUsername,
          token,
        );

        const text = persisted
          ? `Stored the credential for ${resolvedUsername}@${resolvedHost} in your OS keychain. ` +
            'The server will use it automatically — the token is never written to any config.'
          : `Sent the credential for ${resolvedUsername}@${resolvedHost} to git, but no credential ` +
            'helper kept it (none appears configured). Configure one (e.g. libsecret on Linux) or ' +
            'set the token via an env var instead.';
        return {
          content: [{ type: 'text', text }],
          structuredContent: { host: resolvedHost, username: resolvedUsername, persisted },
        };
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}
