import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { execCapture } from '../../src/lib/exec.js';
import type { ExecResult } from '../../src/lib/exec.js';
import type { ProjectConfig, ServerConfig } from '../../src/types.js';
import { createFakeRemote } from './helpers/bareRepo.js';
import { serveWithAuth } from './helpers/authHttpRemote.js';

/**
 * A token pasted into a git URL, end to end against a smart-HTTP remote that really checks it:
 *
 * - `project_sync { gitUrl }` registers the URL without the token (as `register_project` does)
 *   and must SAY so — on success, and on the clone failure that a dropped token then causes;
 * - a token already sitting in an env-configured (or legacy registry) URL is never echoed back in
 *   `push`'s `remote` — `allSecrets()` knows resolved and env tokens, not a URL's own password,
 *   and `redact()`'s own URL pattern stops at the first `@` (see below).
 */

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

let prevPrompt: string | undefined;
beforeAll(() => {
  // What `src/index.ts` sets for the server process: fail on a missing credential, never prompt.
  prevPrompt = process.env.GIT_TERMINAL_PROMPT;
  process.env.GIT_TERMINAL_PROMPT = '0';
});
afterAll(() => {
  if (prevPrompt === undefined) delete process.env.GIT_TERMINAL_PROMPT;
  else process.env.GIT_TERMINAL_PROMPT = prevPrompt;
});

const TOKEN = 'tok-8c1dSECRETa77e';

/** No `gh`, no credential helper: the resolver finds only what `env` gives it. */
const noHelpers = async (): Promise<ExecResult> => ({
  code: 1,
  stdout: '',
  stderr: '',
  timedOut: false,
});

async function setup(
  env: NodeJS.ProcessEnv,
  projects: (url: string) => ProjectConfig[] = () => [],
): Promise<{ client: Client; workspace: string; url: string; tokenUrl: string }> {
  const remote = await createFakeRemote({ 'main.tex': 'alpha\n' });
  cleanups.push(remote.cleanup);
  const server = await serveWithAuth(remote, { username: 'git', password: TOKEN });
  cleanups.push(server.close);
  const tokenUrl = server.url.replace('http://', `http://git:${TOKEN}@`);
  const root = await mkdtemp(path.join(os.tmpdir(), 'ovl-urlcred-'));
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const workspace = path.join(root, 'ws');
  const config: ServerConfig = {
    workspaceRoot: workspace,
    sessionId: 'test',
    projects: projects(tokenUrl),
  };
  const ctx = createContext(config, new CredentialResolver(env, noHelpers), {
    name: 'Test',
    email: 'test@example.com',
  });
  const mcp = createServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(() => client.close());
  return { client, workspace, url: server.url, tokenUrl };
}

function textOf(res: unknown): string {
  const content = (res as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? '').join('\n');
}

describe('project_sync { gitUrl } says a pasted token was not stored', () => {
  it('on success: the clone authenticated some other way, and the text says the token was dropped', async () => {
    const { client, tokenUrl } = await setup({ WEB_LATEX_MCP_TOKEN: TOKEN });
    const res = await client.callTool({
      name: 'project_sync',
      arguments: { project: 'paper', gitUrl: tokenUrl },
    });
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as { action: string }).action).toBe('cloned');
    const text = textOf(res);
    expect(text).toMatch(/NOT stored/);
    expect(text).toMatch(/set_credential|tokenEnv/);
    expect(JSON.stringify(res)).not.toContain(TOKEN);
  });

  it('on a clone that then fails on auth, the error says why the pasted token was not used', async () => {
    const { client, tokenUrl } = await setup({});
    const res = await client.callTool({
      name: 'project_sync',
      arguments: { project: 'paper', gitUrl: tokenUrl },
    });
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toMatch(/NOT stored/);
    expect(text).not.toContain(TOKEN);
  });
});

describe('push never echoes a token already inside a configured gitUrl', () => {
  /**
   * `redact()` already masks `scheme://<userinfo>@` — but only up to the FIRST `@`, while a URL
   * parser (and `redactGitUrlCredentials`) takes the LAST one. A password holding a raw `@` left
   * everything after it on the wire: `http://***@ss-<token>@host`. That is the shape tested here;
   * a password without an `@` was masked before this change too.
   */
  const rawAtUrl = (url: string): string => url.replace('http://', `http://git:p@ss-${TOKEN}@`);

  async function clonedLegacyProject(): Promise<Awaited<ReturnType<typeof setup>>> {
    // A legacy/env configuration whose URL still embeds the credential. The clone itself is made
    // with a URL git can authenticate with (git reads userinfo up to the first `@`), so origin
    // works; the configured `gitUrl` is only reported, which is what is under test.
    let configured = '';
    const env = await setup({}, (tokenUrl) => {
      configured = tokenUrl;
      return [{ id: 'paper', gitUrl: rawAtUrl(tokenUrl.replace(`git:${TOKEN}@`, '')) }];
    });
    const dir = path.join(env.workspace, 'paper');
    await mkdir(env.workspace, { recursive: true });
    const cloned = await execCapture('git', [
      'clone',
      '-c',
      'core.autocrlf=false',
      configured,
      dir,
    ]);
    expect(cloned.code, cloned.stderr).toBe(0);
    await writeFile(path.join(dir, 'main.tex'), 'alpha\nbeta\n');
    return env;
  }

  it('review-branch mode reports the remote with the whole userinfo masked', async () => {
    const { client } = await clonedLegacyProject();
    const res = await client.callTool({
      name: 'push',
      arguments: {
        project: 'paper',
        mode: 'branch',
        branch: 'review',
        message: 'm',
        confirm: true,
      },
    });
    expect(res.isError, textOf(res)).toBeFalsy();
    expect(JSON.stringify(res)).not.toContain(TOKEN);
    expect((res.structuredContent as { remote: string }).remote).toMatch(
      /^http:\/\/\*\*\*@127\.0\.0\.1:/,
    );
  });

  it('direct mode reports the remote with the whole userinfo masked', async () => {
    const { client } = await clonedLegacyProject();
    const res = await client.callTool({
      name: 'push',
      arguments: { project: 'paper', message: 'm', confirm: true },
    });
    expect(res.isError, textOf(res)).toBeFalsy();
    expect((res.structuredContent as { status: string }).status).toBe('pushed');
    expect(JSON.stringify(res)).not.toContain(TOKEN);
    expect((res.structuredContent as { remote: string }).remote).toMatch(
      /^http:\/\/\*\*\*@127\.0\.0\.1:/,
    );
  });
});
