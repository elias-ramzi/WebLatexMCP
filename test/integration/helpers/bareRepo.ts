import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { simpleGit } from 'simple-git';

export interface FakeRemote {
  /** file:// URL pointing at the bare repo — a stand-in for an Overleaf/GitHub remote. */
  url: string;
  bareDir: string;
  /** Default branch of the remote (e.g. master for Overleaf, main for GitHub). */
  branch: string;
  cleanup: () => Promise<void>;
}

const DEFAULT_FILES: Record<string, string> = {
  'main.tex': '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n',
};

/** Create a bare git repo seeded with `files` on the given default branch. */
export async function createFakeRemote(
  files: Record<string, string> = DEFAULT_FILES,
  branch = 'master',
): Promise<FakeRemote> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ovl-remote-'));
  const bareDir = path.join(tmp, 'remote.git');
  const seedDir = path.join(tmp, 'seed');
  await mkdir(bareDir, { recursive: true });
  await mkdir(seedDir, { recursive: true });

  await simpleGit().raw(['init', '--bare', '-b', branch, bareDir]);

  const seed = simpleGit(seedDir);
  await seed.raw(['init', '-b', branch]);
  await seed.addConfig('user.email', 'seed@example.com');
  await seed.addConfig('user.name', 'Seed');
  await writeFiles(seedDir, files);
  await seed.add('.');
  await seed.commit('initial commit');
  await seed.addRemote('origin', bareDir);
  await seed.push('origin', branch);

  return {
    url: `file://${bareDir}`,
    bareDir,
    branch,
    cleanup: () => rm(tmp, { recursive: true, force: true }),
  };
}

/** Clone the remote, add a commit with `files`, and push it back — simulating an upstream edit. */
export async function pushCommit(
  remote: FakeRemote,
  files: Record<string, string>,
  message: string,
): Promise<void> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ovl-push-'));
  try {
    const git = simpleGit(tmp);
    await git.clone(remote.url, tmp);
    await git.addConfig('user.email', 'other@example.com');
    await git.addConfig('user.name', 'Other');
    await writeFiles(tmp, files);
    await git.add('.');
    await git.commit(message);
    await git.push('origin', remote.branch);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  }
}
