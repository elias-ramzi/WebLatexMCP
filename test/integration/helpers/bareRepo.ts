import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { rmSync, mkdtempSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm, cp } from 'node:fs/promises';
import { simpleGit } from 'simple-git';

// Windows keeps transient locks on freshly-used .git files (the OS/AV releases them a
// beat later), so a plain recursive rm can throw EBUSY/ENOTEMPTY. Retry to ride it out.
const rmDir = (dir: string): Promise<void> =>
  rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

// Identity and line-ending settings ride along as `-c` switches on every command this
// instance runs, rather than three `git config --local` processes per fixture. That was
// 1442 of the integration suite's ~11.8k git spawns doing nothing the tests assert on,
// and a git spawn is the unit windows-latest runs ~10x slower than linux (see
// vitest.config.ts's platform-scoped timeout). `src` never shells out to `git config`
// to set anything either -- GitService passes `-c core.autocrlf=false` the same way
// (src/services/gitService.ts) -- so the helper was the outlier, not the pattern.
const identity = (email: string, name: string): string[] => [
  `user.email=${email}`,
  `user.name=${name}`,
  'core.autocrlf=false',
];

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

// Seeding a remote costs 6 git spawns and ~0.4s on linux (~4s on windows), and the suite
// asks for the same handful of seeds over and over: 350 calls across the integration
// tests, but only 109 distinct (files, branch) pairs once keyed per test file. So build
// each distinct seed ONCE and hand out filesystem copies of the finished bare repo --
// ~69% of fixture builds become a recursive copy with no git process at all.
//
// The cache is deliberately per module registry, which under vitest's default isolation
// means per test FILE: that is the scope where reuse is already safe, since each caller
// still gets its own independent copy under its own temp dir and its own `cleanup`.
// Nothing is shared between tests but the bytes that were about to be recomputed
// identically. A template is never opened by a git process after it is built, so no lock
// can be held on it when the copy is taken.
const templates = new Map<string, Promise<string>>();
let templateRoot: string | undefined;

// Templates outlive every individual fixture, so they are cleaned on the way out rather
// than by a caller's `cleanup`. The registry hangs off `globalThis` so exactly ONE `exit`
// listener is installed per worker PROCESS: vitest reuses a worker across test files with
// a fresh module registry each time, so a listener registered at module scope would be
// added once per file -- 72 integration files over a 4-core runner's ~3 workers is two
// dozen listeners on one emitter, past node's 10-listener cap, and the
// MaxListenersExceededWarning lands on stderr where it reads as a test failure.
const ROOTS = Symbol.for('web-latex-mcp.bareRepo.templateRoots');
type RootRegistry = { [ROOTS]?: string[] };

function templatesDir(): string {
  if (templateRoot === undefined) {
    templateRoot = mkdtempSync(path.join(os.tmpdir(), 'ovl-tpl-'));
    const host = globalThis as RootRegistry;
    let roots = host[ROOTS];
    if (roots === undefined) {
      roots = [];
      host[ROOTS] = roots;
      const registered = roots;
      // `exit` cannot await, hence the sync rm.
      process.once('exit', () => {
        for (const dir of registered) {
          try {
            rmSync(dir, { recursive: true, force: true });
          } catch {
            // Best effort — a leftover directory under the OS temp dir is not worth a
            // crash in a test process that has already finished its work.
          }
        }
      });
    }
    roots.push(templateRoot);
  }
  return templateRoot;
}

async function buildTemplate(files: Record<string, string>, branch: string): Promise<string> {
  const dir = await mkdtemp(path.join(templatesDir(), 'seed-'));
  const bareDir = path.join(dir, 'remote.git');
  const seedDir = path.join(dir, 'seed');
  await mkdir(bareDir, { recursive: true });
  await mkdir(seedDir, { recursive: true });

  await simpleGit().raw(['init', '--bare', '-b', branch, bareDir]);

  const seed = simpleGit(seedDir, { config: identity('seed@example.com', 'Seed') });
  await seed.raw(['init', '-b', branch]);
  await writeFiles(seedDir, files);
  await seed.add('.');
  await seed.commit('initial commit');
  await seed.addRemote('origin', bareDir);
  await seed.push('origin', branch);
  // The seed working tree has done its job; only the bare repo gets copied from here on.
  await rmDir(seedDir);

  return bareDir;
}

/** Create a bare git repo seeded with `files` on the given default branch. */
export async function createFakeRemote(
  files: Record<string, string> = DEFAULT_FILES,
  branch = 'master',
): Promise<FakeRemote> {
  const key = JSON.stringify([branch, Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))]);
  let template = templates.get(key);
  if (template === undefined) {
    template = buildTemplate(files, branch);
    templates.set(key, template);
    // A failed build must not poison every later call with the same rejection. The
    // derived promise is handled here, so the original stays the caller's to await.
    void template.catch(() => templates.delete(key));
  }
  const source = await template;

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ovl-remote-'));
  const bareDir = path.join(tmp, 'remote.git');
  await cp(source, bareDir, { recursive: true });

  return {
    url: pathToFileURL(bareDir).href,
    bareDir,
    branch,
    cleanup: () => rmDir(tmp),
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
    const git = simpleGit(tmp, { config: identity('other@example.com', 'Other') });
    await git.clone(remote.url, tmp);
    await writeFiles(tmp, files);
    await git.add('.');
    await git.commit(message);
    await git.push('origin', remote.branch);
  } finally {
    await rmDir(tmp);
  }
}

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  }
}
