#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { CredentialResolver, loadIdentity } from './services/auth.js';
import { createContext } from './context.js';
import { createServer } from './server.js';
import { ProjectRegistry } from './services/projectRegistry.js';
import {
  loadWritingGuide,
  loadExtraWritingGuide,
  composeWritingGuide,
} from './lib/writingGuide.js';
import { loadConcurrencyGuide } from './lib/concurrencyGuide.js';
import { loadSkills } from './lib/skills.js';
import { excludeWorkspaceFromHostGit } from './lib/workspaceExclude.js';
import {
  installOutputSchemaCompat,
  isIncompatibleClient,
  outputSchemaMode,
} from './lib/outputSchemaCompat.js';

async function main(): Promise<void> {
  // Fail fast instead of hanging on an interactive credential prompt when no token or
  // credential helper is available. Child git processes inherit these.
  process.env.GIT_TERMINAL_PROMPT ??= '0';
  process.env.GCM_INTERACTIVE ??= 'never';

  const config = loadConfig();
  if (config.workspaceIsLocal) {
    const pattern = await excludeWorkspaceFromHostGit(config.workspaceRoot);
    if (pattern) {
      // Remember it so `server_info` and `register_project` can say the clone dir is already
      // handled — otherwise the calling agent has no way to know and may add a .gitignore entry.
      config.workspaceExcludePattern = pattern;
      console.error(`[web-latex-mcp] excluded ${pattern} from the host repo's git`);
    }
  }
  const credentials = new CredentialResolver(process.env);
  const identity = loadIdentity(process.env);
  const registry = new ProjectRegistry(config.workspaceRoot);
  const ctx = createContext(config, credentials, identity, registry);
  const baseWritingGuide = await loadWritingGuide(process.env);
  const extraWritingGuide = await loadExtraWritingGuide(config.extraWritingGuidePath);
  config.extraWritingGuideLoaded = extraWritingGuide !== undefined;
  const { text: writingGuide, hasExtra: writingGuideHasExtra } = composeWritingGuide(
    baseWritingGuide,
    extraWritingGuide,
  );
  const concurrencyGuide = await loadConcurrencyGuide(process.env);
  const skills = await loadSkills(process.env);
  const server = createServer(ctx, writingGuide, concurrencyGuide, skills, writingGuideHasExtra);

  // stdio transport: stdout carries the JSON-RPC stream, so all logging goes to stderr.
  const transport = new StdioServerTransport();
  // Shape outgoing tool schemas for clients that can't handle `outputSchema` (e.g. Claude Desktop);
  // see src/lib/outputSchemaCompat.ts. The default `auto` mode only affects known-incompatible clients.
  const schemaMode = outputSchemaMode();
  installOutputSchemaCompat(server, transport, schemaMode);
  const prevOnInitialized = server.server.oninitialized;
  server.server.oninitialized = () => {
    prevOnInitialized?.();
    const client = server.server.getClientVersion();
    const stripping = schemaMode === 'always' || isIncompatibleClient(client?.name);
    console.error(
      `[web-latex-mcp] client ${client?.name ?? 'unknown'} v${client?.version ?? '?'}` +
        `${stripping ? ' — omitting outputSchema for compatibility' : ''}`,
    );
  };
  // Retract this session's advertisement so peers stop seeing it as active. Best-effort: a
  // session that dies without this is detected as gone by pid instead.
  const release = (): void => {
    for (const id of ctx.sessions.trackedProjects()) void ctx.sessions.release(id).catch(() => {});
  };
  process.once('SIGINT', release);
  process.once('SIGTERM', release);
  process.once('beforeExit', release);

  await server.connect(transport);
  console.error(
    `[web-latex-mcp] server ready on stdio as session "${config.sessionId}"` +
      `${writingGuide ? ' (writing guide loaded)' : ''}` +
      `${config.extraWritingGuideLoaded ? ' (extra writing guide loaded)' : ''}` +
      `${concurrencyGuide ? ' (concurrency guide loaded)' : ''}` +
      `${skills.length > 0 ? ` (${skills.length} skills as prompts)` : ''}`,
  );
}

main().catch((err: unknown) => {
  console.error('[web-latex-mcp] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
