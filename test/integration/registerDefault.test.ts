import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, readFile, stat } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import {
  ProjectRegistry,
  readProjectRegistry,
  registryPath,
} from '../../src/services/projectRegistry.js';
import { sessionStateDir } from '../../src/lib/sessionPaths.js';
import type { ProjectConfig, ServerConfig } from '../../src/types.js';

/**
 * Regression coverage for the documented "make an existing project the default" flow:
 * `register_project { project, default: true }` with neither `gitUrl` nor `path` given.
 *
 * Before the fix this threw ("Give a gitUrl … or a path …") because the tool required one of
 * them unconditionally. The service-layer fix (`ProjectManager.setDefaultProject`) re-persists
 * the FULL existing config, so this also pins that a previously set `rootFile`/`branch`/
 * `tokenEnv` survive — a naive re-registration built from the tool's (empty) args would have
 * wiped them, since `ProjectRegistry.upsert` replaces the whole entry.
 */

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup(
  initialProjects: ProjectConfig[] = [],
): Promise<{ client: Client; workspace: string }> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-regdefault-'));
  cleanups.push(() => rm(workspace, { recursive: true, force: true }));

  const config: ServerConfig = {
    workspaceRoot: workspace,
    sessionId: 'test',
    projects: initialProjects,
  };
  const ctx = createContext(
    config,
    new CredentialResolver({}),
    { name: 'Test', email: 'test@example.com' },
    new ProjectRegistry(workspace),
  );
  const server = createServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(() => client.close());
  return { client, workspace };
}

/** Tool text, the way the other integration tests read it (the SDK result type is a union). */
function textOf(res: unknown): string {
  return JSON.stringify((res as { content?: unknown }).content ?? '');
}

describe('register_project { default: true } on an already-registered project', () => {
  it('succeeds with no gitUrl/path, and the registry keeps every other field', async () => {
    const { client, workspace } = await setup();

    // Register with a full set of fields, un-cloned (clone: false — no network in this test).
    await client.callTool({
      name: 'register_project',
      arguments: {
        project: 'paper',
        gitUrl: 'https://git.overleaf.com/def',
        rootFile: 'paper/main.tex',
        branch: 'main',
        tokenEnv: 'MY_TOKEN',
        clone: false,
      },
    });
    expect(readProjectRegistry(workspace)).toEqual([
      {
        id: 'paper',
        gitUrl: 'https://git.overleaf.com/def',
        rootFile: 'paper/main.tex',
        branch: 'main',
        username: undefined,
        tokenEnv: 'MY_TOKEN',
      },
    ]);

    const res = await client.callTool({
      name: 'register_project',
      arguments: { project: 'paper', default: true },
    });

    expect(res.isError).toBeFalsy();
    const structured = res.structuredContent as Record<string, unknown>;
    expect(structured).toMatchObject({
      project: 'paper',
      mode: 'git',
      persisted: true,
      default: true,
    });
    expect(textOf(res)).toContain('default project');

    // The other fields must still be there — the bug this test pins is upsert being handed a
    // config rebuilt from the tool's (empty) args, which would have wiped them.
    expect(readProjectRegistry(workspace)).toEqual([
      {
        id: 'paper',
        gitUrl: 'https://git.overleaf.com/def',
        rootFile: 'paper/main.tex',
        branch: 'main',
        username: undefined,
        tokenEnv: 'MY_TOKEN',
      },
    ]);
    const raw = JSON.parse(await readFile(registryPath(workspace), 'utf8'));
    expect(raw.paper.default).toBe(true);
    expect(raw.paper.rootFile).toBe('paper/main.tex');
    expect(raw.paper.tokenEnv).toBe('MY_TOKEN');
  });

  it('refuses when neither gitUrl/path nor default: true is given, and mentions the default: true form', async () => {
    const { client } = await setup();
    const res = await client.callTool({
      name: 'register_project',
      arguments: { project: 'ghost' },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('default: true');
  });

  it('names the known projects when default: true targets an unregistered project', async () => {
    const { client } = await setup();
    await client.callTool({
      name: 'register_project',
      arguments: { project: 'paper', gitUrl: 'https://git.overleaf.com/def', clone: false },
    });

    const res = await client.callTool({
      name: 'register_project',
      arguments: { project: 'ghost', default: true },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('Unknown project');
    expect(textOf(res)).toContain('paper');
  });

  it('refuses default: true with rootFile, since the default-only form drops it silently otherwise', async () => {
    const { client } = await setup();
    await client.callTool({
      name: 'register_project',
      arguments: { project: 'paper', gitUrl: 'https://git.overleaf.com/def', clone: false },
    });

    const res = await client.callTool({
      name: 'register_project',
      arguments: { project: 'paper', default: true, rootFile: 'main.tex' },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('rootFile');
  });

  it('creates no project lock dir for an unknown default-only id', async () => {
    const { client, workspace } = await setup();

    const res = await client.callTool({
      name: 'register_project',
      arguments: { project: 'ghost', default: true },
    });
    expect(res.isError).toBe(true);

    await expect(stat(sessionStateDir(workspace, 'ghost'))).rejects.toThrow();
  });
});

/**
 * Regression coverage for the silent-replace gap: `register_project` with `gitUrl`/`path` on an
 * id that already exists in the registry replaces the whole stored entry (`ProjectRegistry.upsert`
 * — "pass every field you want kept", per docs/configuration.md). That replace semantics is kept
 * on purpose, but before this fix nothing told the caller a re-registration had silently dropped
 * previously-stored optional fields.
 */
describe('register_project reports dropped fields on a silent re-registration', () => {
  it('names the dropped fields when a re-registration omits them', async () => {
    const { client } = await setup();

    await client.callTool({
      name: 'register_project',
      arguments: {
        project: 'paper',
        gitUrl: 'https://git.overleaf.com/def',
        rootFile: 'main.tex',
        branch: 'master',
        clone: false,
      },
    });

    const res = await client.callTool({
      name: 'register_project',
      arguments: { project: 'paper', gitUrl: 'https://git.overleaf.com/def', clone: false },
    });

    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('dropping its rootFile=main.tex, branch=master');
  });

  it('says nothing about dropped fields when the re-registration repeats them', async () => {
    const { client } = await setup();

    await client.callTool({
      name: 'register_project',
      arguments: {
        project: 'paper',
        gitUrl: 'https://git.overleaf.com/def',
        rootFile: 'main.tex',
        branch: 'master',
        clone: false,
      },
    });

    const res = await client.callTool({
      name: 'register_project',
      arguments: {
        project: 'paper',
        gitUrl: 'https://git.overleaf.com/def',
        rootFile: 'main.tex',
        branch: 'master',
        clone: false,
      },
    });

    expect(res.isError).toBeFalsy();
    expect(textOf(res)).not.toContain('dropping');
  });

  it('says nothing about dropped fields on a first-time registration', async () => {
    const { client } = await setup();

    const res = await client.callTool({
      name: 'register_project',
      arguments: {
        project: 'paper',
        gitUrl: 'https://git.overleaf.com/def',
        rootFile: 'main.tex',
        branch: 'master',
        clone: false,
      },
    });

    expect(res.isError).toBeFalsy();
    expect(textOf(res)).not.toContain('dropping');
  });

  it('names dropped fields for a local re-registration too', async () => {
    const { client, workspace } = await setup();
    const localDir = path.join(workspace, 'draft-source');
    await mkdir(localDir, { recursive: true });

    await client.callTool({
      name: 'register_project',
      arguments: { project: 'draft', path: localDir, followSymlinks: true },
    });

    const res = await client.callTool({
      name: 'register_project',
      arguments: { project: 'draft', path: localDir },
    });

    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('dropping its followSymlinks=true');
  });

  it('names dropped fields for a project configured in-process only, with no registry entry', async () => {
    // Mirrors a project configured via WEB_LATEX_MCP_PROJECTS, or registered in-session via
    // project_sync { gitUrl } — either way `ProjectManager` holds it in `this.projects` but it was
    // never written to the workspace registry, so `registryEntry` alone would find nothing and
    // the report would stay silent about the exact loss it exists to name (see
    // `ProjectManager.previousRegistration`).
    const { client, workspace } = await setup([
      {
        id: 'paper',
        gitUrl: 'https://git.overleaf.com/def',
        branch: 'master',
      },
    ]);

    expect(readProjectRegistry(workspace)).toEqual([]);

    const res = await client.callTool({
      name: 'register_project',
      arguments: { project: 'paper', gitUrl: 'https://git.overleaf.com/def', clone: false },
    });

    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('dropping its branch=master');
  });
});
