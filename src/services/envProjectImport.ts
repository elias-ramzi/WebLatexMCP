import { parseProjects } from '../config.js';
import { isLocalProject } from '../lib/projectMode.js';
import { stripGitUrlCredentials } from '../lib/gitUrlCredentials.js';
import { projectIdFold, quoteId } from '../lib/projectId.js';
import { redact } from '../lib/redact.js';
import { ProjectManager } from './projectManager.js';
import { ProjectRegistry, readRawRegistryFile, registryPath } from './projectRegistry.js';
import type { ProjectConfig } from '../types.js';

/**
 * `web-latex-mcp import-env-projects [--to <workspace>]`: copy the projects configured in
 * `WEB_LATEX_MCP_PROJECTS` into a workspace's registry, so they no longer depend on one client's
 * environment once every session shares one server.
 *
 * Each project goes through `ProjectManager.registerAndPersist`, the path `register_project`
 * takes, and so through every guard a registration meets: an invalid id, a token as a path
 * segment (refused, nothing stored), a URL credential (stripped before it is persisted — the
 * report says so, since the token then has to come from `tokenEnv`, the environment or the
 * keychain), a directory another project already uses, an id differing from a known one only in
 * case. An id the registry already holds is never overwritten: the same registration is
 * `unchanged`, a different one is refused, so a project re-registered from the chat since keeps
 * what the user set there.
 */

export interface EnvImportReport {
  workspace: string;
  imported: string[];
  unchanged: string[];
  refused: Array<{ id: string; reason: string }>;
  /** Imported git projects whose URL carried a credential, which was not persisted. */
  credentialsStripped: string[];
}

/** The fields a registry entry stores, for comparing an env project with a registered one. */
function storedFields(cfg: ProjectConfig): string {
  if (isLocalProject(cfg)) {
    return JSON.stringify(['local', cfg.path, cfg.rootFile, cfg.followSymlinks]);
  }
  return JSON.stringify([
    'git',
    stripGitUrlCredentials(cfg.gitUrl).url,
    cfg.rootFile,
    cfg.branch,
    cfg.username,
    cfg.tokenEnv,
  ]);
}

export async function importEnvProjects(
  env: NodeJS.ProcessEnv,
  cwd: string,
  workspace: string,
): Promise<EnvImportReport> {
  const { projects, skipped } = parseProjects(env.WEB_LATEX_MCP_PROJECTS, cwd, workspace);
  const registry = new ProjectRegistry(workspace);
  const manager = new ProjectManager(
    { workspaceRoot: workspace, projects: [], sessionId: 'import-env-projects' },
    registry,
  );
  const report: EnvImportReport = {
    workspace,
    imported: [],
    unchanged: [],
    refused: skipped.map((s) => ({ id: s.id, reason: s.problem })),
    credentialsStripped: [],
  };
  for (const cfg of projects) {
    // Judged on the raw file, not the parsed list: an entry this version cannot use is skipped by
    // `read()`, and `upsert` would replace it — it is the user's, kept verbatim like any other.
    const raw = readRawRegistryFile(registryPath(workspace));
    if (!raw.ok) {
      report.refused.push({
        id: cfg.id,
        reason: `the registry ${quoteId(registryPath(workspace))} cannot be read: ${raw.reason}`,
      });
      continue;
    }
    const existing = registry.read().find((p) => p.id === cfg.id);
    // A case alias of an entry this version cannot read: `assertIdUnaliased` sees only parsed
    // entries, so it is judged here, on every key in the file.
    const alias = Object.keys(raw.raw).find(
      (key) => key !== cfg.id && projectIdFold(key) === projectIdFold(cfg.id),
    );
    if (alias !== undefined) {
      report.refused.push({
        id: cfg.id,
        reason:
          `it differs from ${quoteId(alias)}, already in the registry, only in letter case; on a ` +
          'case-insensitive disk both name one directory',
      });
      continue;
    }
    if (!existing && Object.hasOwn(raw.raw, cfg.id)) {
      report.refused.push({
        id: cfg.id,
        reason:
          `the registry already holds an entry for ${quoteId(cfg.id)} that this version cannot ` +
          'read; it was left as it is',
      });
      continue;
    }
    if (existing) {
      if (storedFields(existing) === storedFields(cfg)) report.unchanged.push(cfg.id);
      else
        report.refused.push({
          id: cfg.id,
          reason:
            `the registry already registers ${quoteId(cfg.id)} differently; it was left as it ` +
            'is (re-register it with register_project to change it)',
        });
      continue;
    }
    try {
      await manager.registerAndPersist(cfg);
      report.imported.push(cfg.id);
      if (!isLocalProject(cfg) && stripGitUrlCredentials(cfg.gitUrl).stripped) {
        report.credentialsStripped.push(cfg.id);
      }
    } catch (err) {
      // A refusal can quote the URL it refused; never let a token in it reach the terminal.
      report.refused.push({ id: cfg.id, reason: redact((err as Error).message, []) });
    }
  }
  return report;
}
