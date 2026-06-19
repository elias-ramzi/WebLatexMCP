#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { CredentialResolver, loadIdentity } from './services/auth.js';
import { createContext } from './context.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const credentials = new CredentialResolver(process.env);
  const identity = loadIdentity(process.env);
  const ctx = createContext(config, credentials, identity);
  const server = createServer(ctx);

  // stdio transport: stdout carries the JSON-RPC stream, so all logging goes to stderr.
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[latex-git-mcp] server ready on stdio');
}

main().catch((err: unknown) => {
  console.error('[latex-git-mcp] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
