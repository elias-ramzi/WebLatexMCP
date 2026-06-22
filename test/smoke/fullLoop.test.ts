import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { simpleGit } from 'simple-git';
import { createFakeRemote } from '../integration/helpers/bareRepo.js';
import { GitService } from '../../src/services/gitService.js';
import { FileService } from '../../src/services/fileService.js';
import { ProjectManager } from '../../src/services/projectManager.js';
import { LatexmkCompiler } from '../../src/services/compiler.js';
import { parseLog } from '../../src/services/logParser.js';
import type { ServerConfig } from '../../src/types.js';

// Full MVP loop, gated on latexmk being installed (runs in the tex-smoke CI job).
const compiler = new LatexmkCompiler();
const available = await compiler.isAvailable();
const FIXTURE = fileURLToPath(new URL('../fixtures/sample-latex', import.meta.url));

async function fixtureFiles(): Promise<Record<string, string>> {
  const names = ['main.tex', 'sections/intro.tex', 'refs.bib'];
  const map: Record<string, string> = {};
  for (const name of names) {
    map[name] = await readFile(path.join(FIXTURE, name), 'utf8');
  }
  return map;
}

describe.skipIf(!available)('full loop: clone -> edit -> compile -> commit -> push', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  it('runs the complete loop against a bare remote', async () => {
    const remote = await createFakeRemote(await fixtureFiles());
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-loop-'));
    cleanups.push(remote.cleanup, () => rm(workspace, { recursive: true, force: true }));

    const config: ServerConfig = {
      workspaceRoot: workspace,
      projects: [{ id: 'demo', gitUrl: remote.url }],
      defaultProject: 'demo',
    };
    const pm = new ProjectManager(config);
    const git = new GitService();
    const files = new FileService();
    const dir = pm.projectPath('demo');

    // clone
    await git.clone(remote.url, dir, { username: 'git' });

    // edit
    await files.applyEdits(dir, 'main.tex', [
      { oldString: 'This minimal project', newString: 'This edited minimal project' },
    ]);

    // compile
    const outcome = await compiler.compile({ projectDir: dir, rootFile: 'main.tex' });
    expect(outcome.success).toBe(true);
    expect(parseLog(outcome.log).errors).toHaveLength(0);

    // commit + push
    await git.commit(dir, { message: 'edit and compile' });
    const pushed = await git.safePush(dir, remote.url, { username: 'git' });
    expect(pushed.status).toBe('pushed');
    expect(pushed.pushed).toBe(true);

    // verify the edit reached the remote
    const verify = await mkdtemp(path.join(os.tmpdir(), 'ovl-loop-verify-'));
    cleanups.push(() => rm(verify, { recursive: true, force: true }));
    await simpleGit(verify).clone(remote.url, verify);
    expect(await readFile(path.join(verify, 'main.tex'), 'utf8')).toContain(
      'This edited minimal project',
    );
  }, 90_000);
});
