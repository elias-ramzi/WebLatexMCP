import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import { toPosix } from '../lib/paths.js';
import { quoteId } from '../lib/projectId.js';
import { INSTALL_KINDS } from '../lib/installKind.js';
import { BUNDLE_ASSET, isComparableVersion, manualUpdateAdvice } from '../services/updater.js';

const inputSchema = {
  install: z
    .boolean()
    .optional()
    .describe(
      'Also fetch the update (default false — only check). In the Claude Desktop extension this ' +
        'downloads the release bundle, verifies it against the SHA-256 digest GitHub publishes, ' +
        'and opens it, so Claude Desktop shows its own install prompt — the user confirms there. ' +
        'For an npm or source install nothing is downloaded; the result says what to run. When ' +
        'the running version cannot be compared with the latest (a pre-release build, or ' +
        '`unknown`), nothing is downloaded either and the result gives advice.',
    ),
};

const outputSchema = {
  currentVersion: z.string().describe('The version of the server answering this call.'),
  latestVersion: z.string().describe('The version of the latest GitHub release.'),
  updateAvailable: z
    .boolean()
    .describe(
      'Whether the latest release is newer. False also when the running version cannot be ' +
        'compared (unreadable, or a pre-release); `advice` then says how to update by hand.',
    ),
  installKind: z
    .enum(INSTALL_KINDS)
    .describe(
      'How this server was installed: the Claude Desktop extension (.mcpb), an npm package, or a ' +
        'git checkout. Only the extension is updated through this tool. The extension is ' +
        'recognised only because its manifest sets WEB_LATEX_MCP_INSTALL_KIND; without that ' +
        'variable, a git checkout is "source" and anything else "npm".',
    ),
  releaseUrl: z.string().describe('The release page on GitHub.'),
  action: z
    .enum(['none', 'opened', 'downloaded', 'manual'])
    .describe(
      '"none": no bundle was fetched (check only, already up to date, a running version newer ' +
        'than the latest release, or — when install was not asked for — one that cannot be ' +
        'compared). "opened": the OS accepted ' +
        'the request to open the verified bundle ' +
        '(normally in Claude Desktop, which asks the user to confirm) — not proof that Desktop ' +
        'received it: with no handler for .mcpb the OS may show an "Open with" dialog instead. ' +
        '"downloaded": it was verified and saved but could not be ' +
        'opened — install bundlePath by hand. "manual": install was asked for, but this install ' +
        'is not updated by the server (or its running version cannot be compared); follow ' +
        '`advice`.',
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
        'install, nothing is downloaded and the result says what to run. When the running ' +
        'version cannot be compared with the latest (a pre-release build, or `unknown`), ' +
        'nothing is downloaded either and the result gives advice. Reaches github.com, ' +
        'api.github.com and GitHub’s release-asset host; touches no project. Call without ' +
        'install first and ask the user before installing.',
      inputSchema,
      outputSchema,
    },
    async ({ install = false }) => {
      try {
        const { release, ...check } = await ctx.updater.check();
        const comparable = isComparableVersion(check.currentVersion);
        const running = comparable ? `v${check.currentVersion}` : quoteId(check.currentVersion);
        const head =
          `web-latex-mcp ${running} (${check.installKind}); latest release ` +
          `v${check.latestVersion} — ${check.releaseUrl}\n`;

        // Nothing is claimed about a version that cannot be compared, and nothing is downloaded
        // for it either: whether the release is an update is exactly what is unknown.
        if (!comparable) {
          const advice = manualUpdateAdvice(check.installKind, check.latestVersion);
          const text =
            head +
            `The running version ${running} cannot be compared with v${check.latestVersion}, so ` +
            `whether that release is newer is unknown. To install it anyway: ${advice}`;
          return {
            content: [{ type: 'text', text }],
            structuredContent: {
              ...check,
              action: install ? ('manual' as const) : ('none' as const),
              advice,
            },
          };
        }

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
        // It sits under the temp dir, which the environment names, so it is quoted and escaped.
        const shownPath = quoteId(bundlePath);
        const advice = bundle.opened
          ? 'Confirm the update in the Claude Desktop prompt. The extension restarts on the new ' +
            'version; call server_info afterwards to confirm it. ' +
            // The OS can accept the open without Claude Desktop handling it (no .mcpb handler:
            // an "Open with" dialog), so the by-hand route is named here too.
            `If no install prompt appears, drag ${shownPath} onto the Claude Desktop window ` +
            '(or Settings → Extensions → Install Extension).'
          : `Could not open it automatically: drag ${shownPath} onto the Claude Desktop window ` +
            '(or Settings → Extensions → Install Extension).';
        const text =
          head +
          `Downloaded and verified v${check.latestVersion} (sha256 ${bundle.sha256}) to ` +
          `${shownPath}.\n${advice}`;
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
