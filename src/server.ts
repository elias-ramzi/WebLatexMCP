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

/** Create the MCP server and register all tools against the given context. */
export function createServer(ctx: AppContext): McpServer {
  const server = new McpServer({
    name: 'overleaf-mcp',
    version: '0.1.0',
  });

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

  return server;
}
