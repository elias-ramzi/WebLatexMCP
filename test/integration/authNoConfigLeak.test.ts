import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createFakeRemote, pushCommit } from './helpers/bareRepo.js';
import { serveWithAuth } from './helpers/authHttpRemote.js';
import { GitService, gitCredentialConfig } from '../../src/services/gitService.js';
import { execCapture } from '../../src/lib/exec.js';

/**
 * CLAUDE.md: "never write credentials into `.git/config`". `withAuth` used to do exactly that for
 * the length of every fetch/pull/push — `git remote set-url origin https://user:TOKEN@host/…`,
 * run the command, set it back — and `clone` cloned from the token-bearing URL and reset origin
 * afterwards. A process killed inside either window (a client timeout, a crash, a Ctrl-C) left
 * the token in plain text in the clone's config, and the `set-url` argv exposed it in the process
 * list for every call.
 *
 * The remote here is a real smart-HTTP server that answers 401 until it gets the right Basic
 * credential, and it reads the clone's `.git/config` at the start of EVERY request — while the
 * client's git command is in flight, which is the window a kill would freeze. So one test proves
 * both halves: the operations authenticate (they succeed against a remote that checks), and the
 * token was never on disk while they did.
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

const TOKEN = 'tok-3f9aSECRETe1c7';
const AUTH = { username: 'git', token: TOKEN };

async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}

async function setup(): Promise<{
  dir: string;
  url: string;
  leaks: string[];
  counts: { authorized: number; refused: number };
  remote: Awaited<ReturnType<typeof createFakeRemote>>;
}> {
  const remote = await createFakeRemote({ 'main.tex': 'alpha\nbeta\n' });
  cleanups.push(remote.cleanup);
  const dir = path.join(await tmp('ovl-auth-'), 'demo');
  const leaks: string[] = [];
  const server = await serveWithAuth(remote, { username: 'git', password: TOKEN }, async () => {
    const cfg = await readFile(path.join(dir, '.git', 'config'), 'utf8').catch(() => '');
    if (cfg.includes(TOKEN)) leaks.push(cfg);
  });
  cleanups.push(server.close);
  return { dir, url: server.url, leaks, counts: server.counts, remote };
}

async function exercise(git: GitService, env: Awaited<ReturnType<typeof setup>>): Promise<void> {
  await git.clone(env.url, env.dir, AUTH);
  // Move the remote so the sync genuinely fetches and fast-forwards.
  await pushCommit(env.remote, { 'other.tex': 'upstream\n' }, 'upstream edit');
  const sync = await git.syncPull(env.url, env.dir, AUTH);
  expect(sync.action).toBe('pulled');
  await writeFile(path.join(env.dir, 'main.tex'), 'alpha\nbeta-local\n');
  await git.commit(env.dir, { message: 'local edit' });
  const pushed = await git.safePush(env.dir, env.url, AUTH);
  expect(pushed.status).toBe('pushed');
}

describe('git credentials are never written to .git/config', () => {
  it('clone, sync and push authenticate against a remote that checks, with the token never on disk', async () => {
    const env = await setup();
    await exercise(new GitService(), env);

    // The remote really did demand and receive the credential.
    expect(env.counts.authorized).toBeGreaterThan(0);
    // Mid-operation: not one request saw the token in the clone's config.
    expect(env.leaks).toEqual([]);
    // Afterwards: origin is the tokenless URL, and no credential config was persisted either.
    const cfg = await readFile(path.join(env.dir, '.git', 'config'), 'utf8');
    expect(cfg).not.toContain(TOKEN);
    expect(cfg).toContain(env.url);
    expect(cfg).not.toMatch(/\[credential/);
  });

  it('a wrong token is refused — the remote in the test above really checks', async () => {
    const env = await setup();
    await expect(
      new GitService().clone(env.url, env.dir, { username: 'git', token: 'wrong-token' }),
    ).rejects.toThrow();
    expect(env.counts.authorized).toBe(0);
    expect(env.counts.refused).toBeGreaterThan(0);
  });

  // simple-git vets a child's inherited environment once one is set explicitly, and refuses an
  // operation per category it has not been told to allow. The credentialed operations used to
  // run through simple-git with a hand-kept list of those opt-outs, so a user whose own
  // environment carried a config entry outside the list (here `protocol.allow`, set through
  // `GIT_CONFIG_COUNT` — harmless, and ordinary in a CI job) had EVERY authenticated clone,
  // fetch, pull and push refused before git ran, and so would anyone the day a simple-git minor
  // added a category. The operations now spawn git directly; this is that user.
  it('a user environment carrying its own git config does not break an authenticated operation', async () => {
    const env = await setup();
    const saved = {
      GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT,
      GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0,
      GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0,
    };
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'protocol.allow';
    process.env.GIT_CONFIG_VALUE_0 = 'always';
    try {
      await exercise(new GitService(), env);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    expect(env.counts.authorized).toBeGreaterThan(0);
    expect(env.leaks).toEqual([]);
  });

  // The recording shim is a POSIX shell script; the property it checks (argv) is platform-neutral.
  describe.skipIf(process.platform === 'win32')('argv', () => {
    it('no git invocation carries the token on its command line', async () => {
      const env = await setup();
      const invocations = await recordGitArgv(() => exercise(new GitService(), env));
      expect(invocations.length).toBeGreaterThan(3);
      for (const args of invocations) {
        for (const a of args) expect(a).not.toContain(TOKEN);
      }
    });
  });
});

/**
 * Run `fn` with a recording `git` earlier on `PATH` than the real one and return every
 * invocation's argv — one file per invocation (see `pathspecBatchingCommitDiscard.test.ts` for why
 * never a shared append log).
 */
async function recordGitArgv(fn: () => Promise<void>): Promise<string[][]> {
  const which = await execCapture('sh', ['-c', 'command -v git']);
  expect(which.code).toBe(0);
  const realGit = which.stdout.trim();
  const shimDir = await tmp('ovl-auth-shim-');
  const logDir = path.join(shimDir, 'argv');
  await mkdir(logDir, { recursive: true });
  await writeFile(
    path.join(shimDir, 'git'),
    `#!/bin/sh\nprintf '%s\\0' "$@" > "$(mktemp "$WLM_ARGV_DIR/argv.XXXXXXXX")"\nexec "$WLM_REAL_GIT" "$@"\n`,
  );
  await chmod(path.join(shimDir, 'git'), 0o755);
  const prevPath = process.env.PATH;
  process.env.WLM_ARGV_DIR = logDir;
  process.env.WLM_REAL_GIT = realGit;
  process.env.PATH = `${shimDir}${path.delimiter}${prevPath ?? ''}`;
  try {
    await fn();
  } finally {
    process.env.PATH = prevPath;
    delete process.env.WLM_ARGV_DIR;
    delete process.env.WLM_REAL_GIT;
  }
  return Promise.all(
    (await readdir(logDir))
      .sort()
      .map(async (name) =>
        (await readFile(path.join(logDir, name), 'utf8')).split('\0').filter(Boolean),
      ),
  );
}

/**
 * The resolved token must be the one git uses for the project's remote, so the user's own
 * credential helpers are reset for the duration of the operation — but ONLY for that host. A
 * private submodule or LFS store on another host still needs the user's helper; the unscoped
 * `credential.helper=` reset used to clear it for every host. Judged by real git's own credential
 * lookup (`git credential fill`), with a user helper configured AHEAD of ours the way a
 * `~/.gitconfig` entry precedes command-line `-c` options.
 */
describe('the credential reset is scoped to the remote host', () => {
  const USER_HELPER =
    '!f() { test "$1" = get || return 0; printf \'username=me\\npassword=user-helper-secret\\n\'; }; f';

  async function fill(host: string): Promise<{ code: number | null; stdout: string }> {
    const injected = gitCredentialConfig('https://remote.example/repo.git', AUTH);
    expect(injected).not.toBeNull();
    const res = await execCapture(
      'git',
      [
        '-c',
        `credential.helper=${USER_HELPER}`,
        ...injected!.config.flatMap((c) => ['-c', c]),
        'credential',
        'fill',
      ],
      {
        input: `protocol=https\nhost=${host}\n\n`,
        env: { ...process.env, ...injected!.env, GIT_TERMINAL_PROMPT: '0' },
      },
    );
    return { code: res.code, stdout: res.stdout };
  }

  it('the remote host gets the resolved token, and never the user helper', async () => {
    const res = await fill('remote.example');
    expect(res.code).toBe(0);
    expect(res.stdout).toContain(`password=${TOKEN}`);
    expect(res.stdout).not.toContain('user-helper-secret');
  });

  it('another host still gets the user helper', async () => {
    const res = await fill('other.example');
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('password=user-helper-secret');
    expect(res.stdout).not.toContain(TOKEN);
  });
});
