import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { excludeWorkspaceFromHostGit } from '../../src/lib/workspaceExclude.js';

describe('excludeWorkspaceFromHostGit', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), 'wlm-exclude-'));
    await mkdir(path.join(repo, '.git', 'info'), { recursive: true });
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  async function exclude(): Promise<string> {
    return readFile(path.join(repo, '.git', 'info', 'exclude'), 'utf8');
  }

  it('excludes the workspace dir from the enclosing repo', async () => {
    const pattern = await excludeWorkspaceFromHostGit(path.join(repo, '.web_latex_mcp'));
    expect(pattern).toBe('/.web_latex_mcp/');
    expect(await exclude()).toContain('/.web_latex_mcp/');
  });

  it('anchors the pattern relative to the repo root for a nested workspace', async () => {
    const nested = path.join(repo, 'paper', 'sub');
    await mkdir(nested, { recursive: true });
    const pattern = await excludeWorkspaceFromHostGit(path.join(nested, '.web_latex_mcp'));
    expect(pattern).toBe('/paper/sub/.web_latex_mcp/');
    expect(await exclude()).toContain('/paper/sub/.web_latex_mcp/');
  });

  it('is idempotent — no duplicate entry on a second call', async () => {
    const ws = path.join(repo, '.web_latex_mcp');
    await excludeWorkspaceFromHostGit(ws);
    await excludeWorkspaceFromHostGit(ws);
    const occurrences = (await exclude()).split('/.web_latex_mcp/').length - 1;
    expect(occurrences).toBe(1);
  });

  it('preserves existing exclude content', async () => {
    await writeFile(path.join(repo, '.git', 'info', 'exclude'), '*.log\n', 'utf8');
    await excludeWorkspaceFromHostGit(path.join(repo, '.web_latex_mcp'));
    const content = await exclude();
    expect(content).toContain('*.log');
    expect(content).toContain('/.web_latex_mcp/');
  });

  it('does nothing when the workspace is not inside a git repo', async () => {
    const bare = await mkdtemp(path.join(os.tmpdir(), 'wlm-nogit-'));
    try {
      const pattern = await excludeWorkspaceFromHostGit(path.join(bare, '.web_latex_mcp'));
      expect(pattern).toBeUndefined();
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});
