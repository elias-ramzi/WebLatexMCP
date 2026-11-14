import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getServerVersion } from '../lib/version.js';
import { credentialVarNames, daemonSpawnEnv, sessionRequestHeaders } from '../proxy/clientEnv.js';
import { autostartDaemon, findDaemon, type FoundDaemon } from '../proxy/discovery.js';
import { HEADER_SESSION } from '../daemon/sessionHeaders.js';
import type { DaemonEndpoint } from './chatEngine.js';

/**
 * The UI server's own MCP session on the shared server: it lists and registers projects and asks
 * for the viewer's URL through the same tools a client uses, so every guard of theirs applies.
 * The daemon is found as the proxy finds it (`daemon.json` + `/health`), started when none runs,
 * and found again after it restarts (new port, new token).
 */

export interface ToolAnswer {
  structured: Record<string, unknown> | undefined;
  text: string;
  isError: boolean;
}

export interface DaemonClientOptions {
  workspaceRoot: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Test seams. */
  find?: (workspaceRoot: string) => Promise<FoundDaemon | undefined>;
  start?: (workspaceRoot: string, env: NodeJS.ProcessEnv) => Promise<FoundDaemon>;
}

export const UI_SERVER_SESSION = 'ui-server';

export class DaemonClient {
  private found: FoundDaemon | undefined;
  private client: Client | undefined;
  private transport: StreamableHTTPClientTransport | undefined;
  private connecting: Promise<Client> | undefined;

  constructor(private readonly opts: DaemonClientOptions) {}

  /** The daemon answering now, started if none does. */
  async daemon(): Promise<FoundDaemon> {
    const find = this.opts.find ?? findDaemon;
    const now = await find(this.opts.workspaceRoot);
    if (now) {
      if (this.found && this.found.info.processNonce !== now.info.processNonce) this.drop();
      this.found = now;
      return now;
    }
    this.drop();
    const names = credentialVarNames(this.opts.env, this.opts.workspaceRoot);
    const env = daemonSpawnEnv(this.opts.env, this.opts.workspaceRoot, names, this.opts.cwd);
    const start =
      this.opts.start ??
      ((ws: string, e: NodeJS.ProcessEnv) => autostartDaemon({ workspaceRoot: ws, env: e }));
    this.found = await start(this.opts.workspaceRoot, env);
    return this.found;
  }

  async endpoint(): Promise<DaemonEndpoint> {
    const d = await this.daemon();
    return { url: `http://127.0.0.1:${d.info.port}/mcp`, token: d.info.token };
  }

  /**
   * Forget the connection; `end` also closes the session on the daemon (DELETE), which a plain
   * `close()` does not do — the daemon would count it open until its idle timeout.
   */
  private drop(end = false): Promise<void> {
    const c = this.client;
    const t = this.transport;
    this.client = undefined;
    this.transport = undefined;
    this.connecting = undefined;
    return (async () => {
      if (end && t) await t.terminateSession().catch(() => undefined);
      await c?.close().catch(() => undefined);
    })();
  }

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    this.connecting ??= (async () => {
      const ep = await this.endpoint();
      const names = credentialVarNames(this.opts.env, this.opts.workspaceRoot);
      const headers: Record<string, string> = {
        ...sessionRequestHeaders(this.opts.env, names),
        authorization: `Bearer ${ep.token}`,
        [HEADER_SESSION]: UI_SERVER_SESSION,
      };
      const transport = new StreamableHTTPClientTransport(new URL(ep.url), {
        requestInit: { headers },
      });
      const client = new Client({ name: 'web-latex-mcp-ui', version: getServerVersion() });
      await client.connect(transport);
      this.client = client;
      this.transport = transport;
      return client;
    })();
    try {
      return await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  /** Call a tool; once more on a fresh connection if the daemon went away meanwhile. */
  async call(name: string, args: Record<string, unknown> = {}): Promise<ToolAnswer> {
    for (let attempt = 0; ; attempt++) {
      try {
        const client = await this.connect();
        const res = (await client.callTool({ name, arguments: args })) as {
          content?: Array<{ type?: string; text?: string }>;
          structuredContent?: Record<string, unknown>;
          isError?: boolean;
        };
        return {
          structured: res.structuredContent,
          text: (res.content ?? [])
            .filter((c) => c.type === 'text')
            .map((c) => c.text ?? '')
            .join('\n'),
          isError: res.isError === true,
        };
      } catch (err) {
        this.drop();
        if (attempt >= 1) throw err;
      }
    }
  }

  /** End the session on the daemon and close the connection. */
  close(): Promise<void> {
    return this.drop(true);
  }
}
