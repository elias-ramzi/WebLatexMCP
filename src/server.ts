import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from './context.js';
import { registerListProjects } from './tools/listProjects.js';
import { registerProjectSync } from './tools/projectSync.js';
import { registerListFiles } from './tools/listFiles.js';
import { registerReadFile } from './tools/readFile.js';
import { registerWriteFile } from './tools/writeFile.js';
import { registerEditFile } from './tools/editFile.js';
import { registerCompile } from './tools/compile.js';
import { registerStatus } from './tools/status.js';
import { registerDiff } from './tools/diff.js';
import { registerCommit } from './tools/commit.js';
import { registerPush } from './tools/push.js';
import { registerDeleteFile } from './tools/deleteFile.js';
import { registerDiscard } from './tools/discard.js';
import { registerResetToRemote } from './tools/resetToRemote.js';
import { registerSearchReferences } from './tools/searchReferences.js';
import { registerAddCitation } from './tools/addCitation.js';
import { registerWritingGuide } from './resources/writingGuide.js';
import { registerConcurrencyGuide } from './resources/concurrencyGuide.js';
import { buildInstructions } from './lib/writingGuide.js';

/**
 * Create the MCP server and register all tools against the given context.
 *
 * Each provided guide (`writingGuide`, `concurrencyGuide`) reaches the client two
 * ways: folded into the MCP `instructions` hint (advertised at initialization, so
 * clients add it to the model's context automatically) and as a fetchable resource
 * (for on-demand re-reading and clients that ignore `instructions`).
 */
export function createServer(
  ctx: AppContext,
  writingGuide?: string,
  concurrencyGuide?: string,
): McpServer {
  const instructions = buildInstructions(writingGuide, concurrencyGuide);
  const server = new McpServer(
    {
      name: 'web-latex-mcp',
      version: '0.1.0',
    },
    instructions ? { instructions } : undefined,
  );

  registerListProjects(server, ctx);
  registerProjectSync(server, ctx);
  registerListFiles(server, ctx);
  registerReadFile(server, ctx);
  registerWriteFile(server, ctx);
  registerEditFile(server, ctx);
  registerDeleteFile(server, ctx);
  registerCompile(server, ctx);
  registerStatus(server, ctx);
  registerDiff(server, ctx);
  registerCommit(server, ctx);
  registerPush(server, ctx);
  registerDiscard(server, ctx);
  registerResetToRemote(server, ctx);
  registerSearchReferences(server, ctx);
  registerAddCitation(server, ctx);

  if (writingGuide) registerWritingGuide(server, writingGuide);
  if (concurrencyGuide) registerConcurrencyGuide(server, concurrencyGuide);

  return server;
}
