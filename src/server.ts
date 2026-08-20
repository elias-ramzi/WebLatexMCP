import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from './context.js';
import { registerListProjects } from './tools/listProjects.js';
import { registerProjectSync } from './tools/projectSync.js';
import { registerRegisterProject } from './tools/registerProject.js';
import { registerSetCredential } from './tools/setCredential.js';
import { registerCredentialPortal } from './tools/credentialPortal.js';
import { registerListFiles } from './tools/listFiles.js';
import { registerReadFile } from './tools/readFile.js';
import { registerWriteFile } from './tools/writeFile.js';
import { registerEditFile } from './tools/editFile.js';
import { registerCompile } from './tools/compile.js';
import { registerViewer } from './tools/viewer.js';
import { registerListComments } from './tools/listComments.js';
import { registerResolveComments } from './tools/resolveComments.js';
import { registerStatus } from './tools/status.js';
import { registerDiff } from './tools/diff.js';
import { registerCommit } from './tools/commit.js';
import { registerPush } from './tools/push.js';
import { registerDeleteFile } from './tools/deleteFile.js';
import { registerDiscard } from './tools/discard.js';
import { registerResetToRemote } from './tools/resetToRemote.js';
import { registerSearchReferences } from './tools/searchReferences.js';
import { registerAddCitation } from './tools/addCitation.js';
import { registerServerInfo } from './tools/serverInfo.js';
import { registerListSkills } from './tools/listSkills.js';
import { registerDoctor } from './tools/doctor.js';
import { registerWritingGuide } from './resources/writingGuide.js';
import { registerConcurrencyGuide } from './resources/concurrencyGuide.js';
import { registerSkillPrompts } from './prompts/skills.js';
import { buildInstructions } from './lib/writingGuide.js';
import { getServerVersion } from './lib/version.js';
import type { Skill } from './lib/skills.js';

/**
 * Create the MCP server and register all tools against the given context.
 *
 * Each provided guide (`writingGuide`, `concurrencyGuide`) reaches the client two
 * ways: folded into the MCP `instructions` hint (advertised at initialization, so
 * clients add it to the model's context automatically) and as a fetchable resource
 * (for on-demand re-reading and clients that ignore `instructions`).
 *
 * `skills` are the bundled `.claude/skills` procedures. They are surfaced twice: as MCP prompts
 * for the user to invoke (see ./prompts/skills.ts) and through the `list_skills` tool so the model
 * can discover and follow one on its own.
 */
export function createServer(
  ctx: AppContext,
  writingGuide?: string,
  concurrencyGuide?: string,
  skills: Skill[] = [],
): McpServer {
  const instructions = buildInstructions(writingGuide, concurrencyGuide);
  const server = new McpServer(
    {
      name: 'web-latex-mcp',
      version: getServerVersion(),
    },
    instructions ? { instructions } : undefined,
  );

  registerListProjects(server, ctx);
  registerProjectSync(server, ctx);
  registerRegisterProject(server, ctx);
  registerSetCredential(server, ctx);
  registerCredentialPortal(server, ctx);
  registerListFiles(server, ctx);
  registerReadFile(server, ctx);
  registerWriteFile(server, ctx);
  registerEditFile(server, ctx);
  registerDeleteFile(server, ctx);
  registerCompile(server, ctx);
  registerViewer(server, ctx);
  registerListComments(server, ctx);
  registerResolveComments(server, ctx);
  registerStatus(server, ctx);
  registerDiff(server, ctx);
  registerCommit(server, ctx);
  registerPush(server, ctx);
  registerDiscard(server, ctx);
  registerResetToRemote(server, ctx);
  registerSearchReferences(server, ctx);
  registerAddCitation(server, ctx);
  registerServerInfo(server, ctx);
  registerListSkills(server, skills);
  registerDoctor(server, ctx);

  if (writingGuide) registerWritingGuide(server, writingGuide);
  if (concurrencyGuide) registerConcurrencyGuide(server, concurrencyGuide);
  registerSkillPrompts(server, skills);

  return server;
}
