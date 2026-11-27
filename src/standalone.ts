import type { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport, serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './config.js';
import { CredentialResolver, loadIdentity } from './services/auth.js';
import { createSessionContext, createSharedServices } from './context.js';
import { createServer } from './server.js';
import { ProjectRegistry, countRegisteredProjects } from './services/projectRegistry.js';
import { legacyWorkspaceNote } from './lib/workspaceNote.js';
import { loadSessionGuides } from './lib/sessionGuides.js';
import {
  clientNameIn,
  outputSchemaMode,
  stripsOutputSchema,
  watchInbound,
} from './lib/outputSchemaCompat.js';
import { escapeInvisibleChars } from './lib/projectId.js';
import {
  createSessionProbe,
  installConnectionProbe,
  sessionProbeEnabled,
} from './lib/sessionProbe.js';

/**
 * One in-process server on stdio for one session: what `web-latex-mcp` always ran before the
 * shared server, and still runs with `--standalone`, `WEB_LATEX_MCP_STANDALONE=1`, or when the
 * proxy cannot reach or start a daemon (`daemonUnavailable` is then why, shown by `server_info`).
 */
export async function runStandalone(opts: { daemonUnavailable?: string } = {}): Promise<void> {
  // Fail fast instead of hanging on an interactive credential prompt when no token or
  // credential helper is available. Child git processes inherit these.
  process.env.GIT_TERMINAL_PROMPT ??= '0';
  process.env.GCM_INTERACTIVE ??= 'never';

  const config = loadConfig();
  if (config.legacyWorkspaceRoot) {
    const count = countRegisteredProjects(config.legacyWorkspaceRoot);
    console.error(
      `[web-latex-mcp] ${legacyWorkspaceNote(config.legacyWorkspaceRoot, count, config.workspaceRoot)}`,
    );
  }
  const credentials = new CredentialResolver(process.env);
  const identity = loadIdentity(process.env);
  const registry = new ProjectRegistry(config.workspaceRoot);
  // Read once: stdio serves one session (the daemon reads them per session, §7.3).
  const guides = await loadSessionGuides(process.env, config.extraWritingGuidePath);
  const { writingGuide, writingGuideHasExtra, concurrencyGuide, skills } = guides;
  // Set before the session scope is built: its `config` is a copy, taken then.
  config.extraWritingGuideLoaded = guides.extraWritingGuideLoaded;
  config.serverMode = 'stdio';
  if (opts.daemonUnavailable !== undefined) config.daemonUnavailable = opts.daemonUnavailable;
  // stdio serves one session: the shared services and one scope over them, the same code a
  // daemon runs once per connection (docs/design/shared-server.md §5.1).
  const shared = createSharedServices(config, credentials, identity, registry);
  const scope = createSessionContext(shared);
  const { ctx } = scope;
  // Opt-in session-identity instrumentation for #18's spike. Unset (the default) leaves `probe`
  // undefined, so nothing is installed anywhere and no line is written: see src/lib/sessionProbe.ts.
  const probe = sessionProbeEnabled(process.env)
    ? // Read lazily: the resolver learns a project's token when that project is first touched, so
      // a list snapshotted here would scrub almost nothing.
      createSessionProbe({ secrets: () => credentials.allSecrets() })
    : undefined;
  probe?.startup(config.sessionId);

  // stdio transport: stdout carries the JSON-RPC stream, so all logging goes to stderr. Ours, not
  // the entry's default, so the client's name is read off the opening message (a 2025
  // `initialize`, or a 2026-07-28 request's `_meta` envelope) before the server is built for it.
  const transport = new StdioServerTransport();
  let clientName: string | undefined;
  watchInbound(transport, (message) => {
    clientName ??= clientNameIn(message);
  });
  // Shape the tool schemas for the client: no `$schema` dialect stamp for anyone, and no
  // `outputSchema` for clients that can't handle it (Claude Desktop) or when the env asks for
  // none; see src/lib/outputSchemaCompat.ts.
  const schemaMode = outputSchemaMode();
  let announced = false;
  // `serveStdio` serves both eras from this factory (#288): a 2025 client opens with `initialize`
  // and keeps that era; a 2026-07-28 client opens with `server/discover`. It may build one more
  // instance than it keeps (the discarded probe), so the factory builds only — the session scope
  // is this process's, made once above.
  const build = (opening: { era: 'legacy' | 'modern' }): McpServer => {
    const strip = stripsOutputSchema(schemaMode, clientName);
    const server = createServer(
      ctx,
      writingGuide,
      concurrencyGuide,
      skills,
      writingGuideHasExtra,
      probe,
      { stripOutputSchema: strip },
    );
    if (!announced) {
      announced = true;
      console.error(
        `[web-latex-mcp] client ${clientName ?? 'unknown'} (` +
          `${opening.era === 'modern' ? 'protocol 2026-07-28' : '2025-era protocol'})` +
          `${strip ? ' — omitting outputSchema for compatibility' : ''}`,
      );
    }
    // Only a 2025 connection initializes; the probe counts those, as before.
    if (probe) installConnectionProbe(server.server, probe);
    return server;
  };
  // Retract this session's advertisement so peers stop seeing it as active. Best-effort: a
  // session that dies without this is detected as gone by pid instead.
  const release = (): void => {
    void scope.close();
  };
  process.once('SIGINT', release);
  process.once('SIGTERM', release);
  process.once('beforeExit', release);

  serveStdio(build, {
    transport,
    // The stdio transport closes when one inbound message passes its 10 MiB read cap, which ends
    // this server: say why on stderr rather than exit without a word (the proxy's relay logs its
    // own, `relay: stdin: …`). A JSON parse error quotes what the client sent, so the text is
    // escaped and cut like any client-supplied string.
    onerror: (err) => {
      console.error(`[web-latex-mcp] stdio: ${escapeInvisibleChars(err.message).slice(0, 300)}`);
    },
  });
  console.error(
    `[web-latex-mcp] server ready on stdio as session "${config.sessionId}"` +
      `${writingGuide ? ' (writing guide loaded)' : ''}` +
      `${config.extraWritingGuideLoaded ? ' (extra writing guide loaded)' : ''}` +
      `${concurrencyGuide ? ' (concurrency guide loaded)' : ''}` +
      `${skills.length > 0 ? ` (${skills.length} skills as prompts)` : ''}`,
  );
}
