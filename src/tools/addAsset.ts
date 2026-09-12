import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import { resolveAssetSource } from '../lib/assetImport.js';
import { isImportableAsset, assetLinkBlockedMessage } from '../lib/assets.js';

const inputSchema = {
  project: z.string().optional(),
  path: z
    .string()
    .describe(
      'Destination path relative to the project root. Must be a recognized binary asset type ' +
        '(e.g. .png, .jpg, .pdf, .svg) — not .tex, .bib, or another text file.',
    ),
  sourcePath: z
    .string()
    .optional()
    .describe(
      'An absolute path to the file ON THE MACHINE RUNNING THIS SERVER (a leading ~ is ' +
        'expanded). Preferred over contentBase64 when the file is already on disk: the bytes ' +
        "never cross the model's context. Give exactly one of sourcePath or contentBase64.",
    ),
  contentBase64: z
    .string()
    .optional()
    .describe(
      'The file bytes, base64-encoded, for a client with no filesystem access. Has a smaller ' +
        'size cap than sourcePath — prefer sourcePath when the file is on disk. Give exactly ' +
        'one of sourcePath or contentBase64.',
    ),
  createDirs: z
    .boolean()
    .optional()
    .describe(
      "Create missing parent directories. Defaults to TRUE for this tool (unlike write_file's " +
        'false): the destination for an asset is almost always a figures/ directory that may not ' +
        'exist yet, and this is a new tool with no existing callers to surprise.',
    ),
  overrideExternalChanges: z
    .boolean()
    .optional()
    .describe(
      'Overwrite even if the file changed on disk since it was last read through this server ' +
        '(e.g. edited directly by the user). Prefer re-reading first; only set this to ' +
        'deliberately discard those on-disk changes.',
    ),
};

const outputSchema = {
  path: z.string(),
  bytesWritten: z.number(),
  created: z.boolean(),
  source: z.string(),
  sha256: z.string(),
};

export function registerAddAsset(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'add_asset',
    {
      title: 'Import a binary asset (figure/image) into a project',
      description:
        'Copy a binary figure (PNG, JPEG, PDF, SVG, ...) into the project, from an absolute ' +
        'path on this machine or from inline base64. Text/.tex files use write_file instead.',
      inputSchema,
      outputSchema,
    },
    async ({
      project,
      path: relPath,
      sourcePath,
      contentBase64,
      createDirs,
      overrideExternalChanges,
    }) => {
      try {
        // requireProjectDir, not requireGitProject: a local (mode: 'local') project may receive
        // an asset too, exactly as write_file writes into one.
        const { id, dir } = await ctx.projectManager.requireProjectDir(project);
        return await ctx.projectManager.runExclusive(id, async () => {
          // Inside the lock, same reasoning as write_file/edit_file: closes the peer window at no
          // extra cost since every mutator already takes this lock.
          const target = await ctx.files.linkTarget(dir, relPath);
          if (target !== null && !isImportableAsset(target)) {
            throw new Error(assetLinkBlockedMessage(relPath, target));
          }
          const { bytes, origin, sha256 } = await resolveAssetSource({
            destPath: relPath,
            sourcePath,
            contentBase64,
          });
          const res = await ctx.files.writeBytes(dir, {
            path: relPath,
            bytes,
            createDirs: createDirs ?? true,
            overrideExternalChanges,
          });
          // Deliberately no diff here, unlike write_file/edit_file: a real binary asset only
          // ever gets "Binary files … differ" out of git diff (useless), and a text-ish asset
          // (.svg/.eps) would dump the WHOLE FILE into the model's context — including, for a
          // source that had somehow slipped an extension check, its contents. The headline
          // below (created/replaced, path, byte count, sha256, resolved source) is the correct
          // confirmation for an asset: it proves what was copied without echoing bytes back.
          const headline =
            `${res.created ? 'added' : 'replaced'} ${res.path} (${res.bytesWritten} bytes, ` +
            `sha256 ${sha256.slice(0, 12)}…) from ${origin}`;
          return {
            content: [{ type: 'text', text: headline }],
            structuredContent: { ...res, source: origin, sha256 },
          };
        });
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}
