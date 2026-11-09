import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { runCli, USAGE } from '../../src/cli.js';
import { importEnvProjects } from '../../src/services/envProjectImport.js';
import { registryPath } from '../../src/services/projectRegistry.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function readRegistry(workspace: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(registryPath(workspace), 'utf8')) as Record<string, unknown>;
}

function io(env: NodeJS.ProcessEnv = {}, cwd = os.tmpdir()) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { env, cwd, out: (t: string) => out.push(t), err: (t: string) => err.push(t) },
    out: () => out.join(''),
    err: () => err.join(''),
  };
}

describe('importEnvProjects', () => {
  it('registers env projects, stripping a URL credential before it is saved', async () => {
    const workspace = await tempDir('wlm-imp-');
    const draft = await tempDir('wlm-imp-draft-');
    const env = {
      WEB_LATEX_MCP_PROJECTS: JSON.stringify({
        thesis: { gitUrl: 'https://user:s3cr3t-token-value@git.example/thesis', branch: 'main' },
        notes: { mode: 'local', path: draft, rootFile: 'notes.md' },
      }),
    };

    const report = await importEnvProjects(env, '/', workspace);

    expect(report.imported.sort()).toEqual(['notes', 'thesis']);
    expect(report.credentialsStripped).toEqual(['thesis']);
    const saved = await readRegistry(workspace);
    expect(saved.thesis).toEqual({ gitUrl: 'https://user@git.example/thesis', branch: 'main' });
    expect(JSON.stringify(saved)).not.toContain('s3cr3t');
    expect(saved.notes).toEqual({ mode: 'local', path: draft, rootFile: 'notes.md' });

    // A second run finds them registered and changes nothing.
    const again = await importEnvProjects(env, '/', workspace);
    expect(again.imported).toEqual([]);
    expect(again.unchanged.sort()).toEqual(['notes', 'thesis']);
  });

  it('never overwrites a project the registry holds differently', async () => {
    const workspace = await tempDir('wlm-imp-');
    await mkdir(workspace, { recursive: true });
    await writeFile(
      registryPath(workspace),
      JSON.stringify({ thesis: { gitUrl: 'https://git.example/moved', rootFile: 'a.tex' } }),
    );
    const env = {
      WEB_LATEX_MCP_PROJECTS: JSON.stringify({ thesis: { gitUrl: 'https://git.example/thesis' } }),
    };

    const report = await importEnvProjects(env, '/', workspace);

    expect(report.imported).toEqual([]);
    expect(report.refused).toEqual([
      { id: 'thesis', reason: expect.stringMatching(/already registers "thesis" differently/) },
    ]);
    expect((await readRegistry(workspace)).thesis).toEqual({
      gitUrl: 'https://git.example/moved',
      rootFile: 'a.tex',
    });
  });

  it('refuses what a registration refuses: a token in the path, a case alias, a bad id', async () => {
    const workspace = await tempDir('wlm-imp-');
    await writeFile(
      registryPath(workspace),
      JSON.stringify({ Paper: { gitUrl: 'https://git.example/paper' } }),
    );
    const env = {
      WEB_LATEX_MCP_PROJECTS: JSON.stringify({
        leaky: { gitUrl: 'https://git.example/ghp_abcdefghijklmnopqrstuvwxyz0123456789/repo' },
        paper: { gitUrl: 'https://git.example/paper2' },
        '../escape': { gitUrl: 'https://git.example/x' },
      }),
    };

    const report = await importEnvProjects(env, '/', workspace);

    expect(report.imported).toEqual([]);
    const reasons = Object.fromEntries(report.refused.map((r) => [r.id, r.reason]));
    expect(Object.keys(reasons).sort()).toEqual(['../escape', 'leaky', 'paper']);
    expect(reasons.paper).toMatch(/only in letter case/);
    expect(reasons.leaky).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(Object.keys(await readRegistry(workspace))).toEqual(['Paper']);
  });
});

describe('importEnvProjects keeps what it cannot read', () => {
  it('never replaces a registry entry this version cannot parse', async () => {
    const workspace = await tempDir('wlm-imp-');
    const future = { mode: 'ssh', host: 'future-version', default: true };
    await writeFile(registryPath(workspace), JSON.stringify({ thesis: future }));
    const env = {
      WEB_LATEX_MCP_PROJECTS: JSON.stringify({ thesis: { gitUrl: 'https://git.example/t' } }),
    };

    const report = await importEnvProjects(env, '/', workspace);

    expect(report.imported).toEqual([]);
    expect(report.refused).toEqual([
      { id: 'thesis', reason: expect.stringMatching(/cannot read; it was left as it is/) },
    ]);
    expect((await readRegistry(workspace)).thesis).toEqual(future);
  });

  it('refuses a case alias of an entry this version cannot parse', async () => {
    const workspace = await tempDir('wlm-imp-');
    await writeFile(registryPath(workspace), JSON.stringify({ Thesis: { mode: 'ssh' } }));
    const env = {
      WEB_LATEX_MCP_PROJECTS: JSON.stringify({ thesis: { gitUrl: 'https://git.example/t' } }),
    };
    const report = await importEnvProjects(env, '/', workspace);
    expect(report.refused).toEqual([
      {
        id: 'thesis',
        reason: expect.stringMatching(
          /differs from "Thesis", already in the registry, only in letter case/,
        ),
      },
    ]);
    expect(Object.keys(await readRegistry(workspace))).toEqual(['Thesis']);
  });
});

describe('runCli', () => {
  it('leaves an argument-less start to the server', async () => {
    expect(await runCli([], io().io)).toBeUndefined();
  });

  it('starts the server, as before, when given only an option it does not know', async () => {
    const r = io();
    expect(await runCli(['--stdio'], r.io)).toBeUndefined();
    expect(r.err()).toContain('ignoring "--stdio"; starting the server');
    expect(r.out()).toBe('');
  });

  it('prints the usage on --help and refuses an unknown command', async () => {
    const help = io();
    expect(await runCli(['--help'], help.io)).toBe(0);
    expect(help.out()).toBe(USAGE);

    const unknown = io();
    expect(await runCli(['serve-forever'], unknown.io)).toBe(2);
    expect(unknown.err()).toContain('Unknown command or arguments: "serve-forever"');
    expect(unknown.err()).toContain('migrate-workspace <from>');

    const missing = io();
    expect(await runCli(['migrate-workspace'], missing.io)).toBe(2);
    expect(await runCli(['migrate-workspace', 'a', '--to'], missing.io)).toBe(2);
  });

  it('migrates into the workspace named by --to, and reports a refusal with status 1', async () => {
    const from = path.join(await tempDir('wlm-cli-'), '.web_latex_mcp');
    await mkdir(path.join(from, 'thesis', '.git'), { recursive: true });
    await writeFile(
      registryPath(from),
      JSON.stringify({ thesis: { gitUrl: 'https://git.example/thesis' } }),
    );
    const to = await tempDir('wlm-cli-to-');

    const ok = io();
    expect(await runCli(['migrate-workspace', from, '--to', to], ok.io)).toBe(0);
    expect(ok.out()).toContain('entries moved: "thesis"');
    expect(ok.out()).toContain('projects registered: "thesis"');
    expect(Object.keys(await readRegistry(to))).toEqual(['thesis']);

    const again = io();
    expect(await runCli(['migrate-workspace', from, '--to', to], again.io)).toBe(0);
    expect(again.out()).toContain('already migrated');

    const refused = io();
    const notAWorkspace = await tempDir('wlm-cli-docs-');
    expect(await runCli(['migrate-workspace', notAWorkspace, '--to', to], refused.io)).toBe(1);
    expect(refused.err()).toMatch(/^Nothing was moved:/);
  });

  it('defaults the destination to the configured workspace, refusing the retired "cwd"', async () => {
    const r = io({ WEB_LATEX_MCP_WORKSPACE: 'cwd' });
    expect(await runCli(['import-env-projects'], r.io)).toBe(1);
    expect(r.err()).toContain('WEB_LATEX_MCP_WORKSPACE=cwd is no longer supported');
  });

  it('imports env projects and exits 1 when one is refused', async () => {
    const workspace = await tempDir('wlm-cli-imp-');
    const env = {
      WEB_LATEX_MCP_WORKSPACE: workspace,
      WEB_LATEX_MCP_PROJECTS: JSON.stringify({
        thesis: { gitUrl: 'https://git.example/thesis' },
        '../x': { gitUrl: 'https://git.example/x' },
      }),
    };
    const r = io(env);
    expect(await runCli(['import-env-projects'], r.io)).toBe(1);
    expect(r.out()).toContain('imported: "thesis"');
    expect(r.err()).toContain('not imported "../x"');
  });
});
