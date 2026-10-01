import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import { toPosix } from '../lib/paths.js';
import { BUNDLE_ASSET, manualUpdateAdvice } from '../services/updater.js';

const inputSchema = {
  install: z
    .boolean()
    .optional()
    .describe(
      'Also fetch the update (default false — only check). In the Claude Desktop extension this ' +
        'downloads the release bundle, verifies it against the SHA-256 digest GitHub publishes, ' +
        'and opens it, so Claude Desktop shows its own install prompt — the user confirms there. ' +
        'For an npm or source install nothing is downloaded; the result says what to run.',
    ),
};

const outputSchema = {
  currentVersion: z.string().describe('The version of the server answering this call.'),
  latestVersion: z.string().describe('The version of the latest GitHub release.'),
  updateAvailable: z
    .boolean()
    .describe(
      'Whether the latest release is newer. False also when the running version is unreadable.',
    ),
  installKind: z
    .enum(['desktop-extension', 'npm', 'source'])
    .describe(
      'How this server was installed: the Claude Desktop extension (.mcpb), an npm package, or a ' +
        'git checkout. Only the extension is updated through this tool.',
    ),
  releaseUrl: z.string().describe('The release page on GitHub.'),
  action: z
    .enum(['none', 'opened', 'downloaded', 'manual'])
    .describe(
      '"none": nothing was fetched (check only, or already up to date). "opened": the verified ' +
        'bundle was handed to Claude Desktop, which asks the user to confirm. "downloaded": it ' +
        'was verified and saved but could not be opened — install bundlePath by hand. "manual": ' +
        'this install is not updated by the server; follow `advice`.',
    ),
  bundlePath: z
    .string()
    .optional()
    .describe('Where the verified bundle was saved, when one was downloaded.'),
  sha256: z.string().optional().describe('The verified SHA-256 of the downloaded bundle.'),
  advice: z.string().optional().describe('What to do next by hand, when anything is left to do.'),
};

export function registerUpdateServer(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'update_server',
    {
      title: 'Check for and install a server update',
      description:
        'Check whether a newer web-latex-mcp release exists on GitHub, and — with install: true — ' +
        'fetch it. In the Claude Desktop extension, install downloads the release’s ' +
        `${BUNDLE_ASSET}, verifies it (SHA-256 digest published by GitHub, size, zip signature; ` +
        'a release without a digest is refused) and opens it, so Claude Desktop shows its install ' +
        'prompt: the user confirms the update there, and the extension restarts on the new ' +
        'version. Nothing is installed without that confirmation. For an npm or git-checkout ' +
        'install, nothing is downloaded and the result says what to run. Reaches github.com; ' +
        'touches no project. Call without install first and ask the user before installing.',
      inputSchema,
      outputSchema,
    },
    async ({ install = false }) => {
      try {
        const { release, ...check } = await ctx.updater.check();
        const head =
          `web-latex-mcp v${check.currentVersion} (${check.installKind}); latest release ` +
          `v${check.latestVersion} — ${check.releaseUrl}\n`;

        if (!check.updateAvailable) {
          const text =
            head +
            (check.currentVersion === check.latestVersion
              ? 'Already up to date.'
              : `Not updating: the running version is not older than v${check.latestVersion}.`);
          return {
            content: [{ type: 'text', text }],
            structuredContent: { ...check, action: 'none' as const },
          };
        }

        if (check.installKind !== 'desktop-extension') {
          const advice = manualUpdateAdvice(check.installKind, check.latestVersion);
          return {
            content: [{ type: 'text', text: `${head}Update available. ${advice}` }],
            structuredContent: {
              ...check,
              action: install ? ('manual' as const) : ('none' as const),
              advice,
            },
          };
        }

        if (!install) {
          const advice =
            'Call update_server again with install: true to download and open it in Claude Desktop.';
          return {
            content: [{ type: 'text', text: `${head}Update available. ${advice}` }],
            structuredContent: { ...check, action: 'none' as const, advice },
          };
        }

        const bundle = await ctx.updater.downloadBundle(release);
        const bundlePath = toPosix(bundle.path);
        const advice = bundle.opened
          ? 'Confirm the update in the Claude Desktop prompt. The extension restarts on the new ' +
            'version; call server_info afterwards to confirm it.'
          : `Could not open it automatically: drag ${bundle.path} onto the Claude Desktop window ` +
            '(or Settings → Extensions → Install Extension).';
        const text =
          head +
          `Downloaded and verified v${check.latestVersion} (sha256 ${bundle.sha256}) to ` +
          `${bundle.path}.\n${advice}`;
        return {
          content: [{ type: 'text', text }],
          structuredContent: {
            ...check,
            action: bundle.opened ? ('opened' as const) : ('downloaded' as const),
            bundlePath,
            sha256: bundle.sha256,
            advice,
          },
        };
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}
