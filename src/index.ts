#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { CredentialResolver, loadIdentity } from './services/auth.js';
import { createContext } from './context.js';
import { createServer } from './server.js';
import { loadWritingGuide } from './lib/writingGuide.js';
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
      console.error(`[web-latex-mcp] excluded ${pattern} from the host repo's git`);
    }
  }
  const credentials = new CredentialResolver(process.env);
  const identity = loadIdentity(process.env);
  const ctx = createContext(config, credentials, identity);
  const writingGuide = await loadWritingGuide(process.env);
  const concurrencyGuide = await loadConcurrencyGuide(process.env);
  const skills = await loadSkills(process.env);
  const server = createServer(ctx, writingGuide, concurrencyGuide, skills);

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
  await server.connect(transport);
  console.error(
    `[web-latex-mcp] server ready on stdio${writingGuide ? ' (writing guide loaded)' : ''}` +
      `${concurrencyGuide ? ' (concurrency guide loaded)' : ''}` +
      `${skills.length > 0 ? ` (${skills.length} skills as prompts)` : ''}`,
  );
}

main().catch((err: unknown) => {
  console.error('[web-latex-mcp] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
