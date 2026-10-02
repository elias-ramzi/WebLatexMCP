import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { GitService } from '../../src/services/gitService.js';
import { execCapture } from '../../src/lib/exec.js';

/**
 * The origin ownership logic judges "carries a credential" with the same strip that registration
 * uses, so a credential outside an http(s) userinfo — a query token, a password in an ssh
 * userinfo, a token as a path segment — must never be written into `origin`, nor adopted from it
 * (`src/lib/originRepoint.ts`). Real git config in a temp repository; no remote is contacted.
 */

const OWNED = 'https://git.example/o/a.git';
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

const HERMETIC = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'] as const;
const prevEnv = new Map<string, string | undefined>();
let gitHome = '';
beforeAll(async () => {
  for (const key of HERMETIC) prevEnv.set(key, process.env[key]);
  gitHome = await mkdtemp(path.join(os.tmpdir(), 'wlm-origin-cred-git-'));
  const globalConfig = path.join(gitHome, 'gitconfig');
  await writeFile(globalConfig, '');
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
});
afterAll(async () => {
  for (const [key, value] of prevEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(gitHome, { recursive: true, force: true });
});

let dir = '';
const git = new GitService();

async function run(args: string[]): Promise<string> {
  const res = await execCapture('git', args, { cwd: dir });
  if (res.code !== 0 && res.code !== 1) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout;
}
const originUrls = async (): Promise<string[]> =>
  (await run(['config', '--get-all', 'remote.origin.url'])).split('\n').filter((l) => l !== '');
const localConfig = async (): Promise<string> => run(['config', '--local', '--list']);

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'wlm-origin-cred-'));
  await run(['init', '-q']);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('a held URL whose credential is outside an http(s) userinfo is never written to origin', () => {
  for (const held of [
    'https://git.example/o/b.git?private_token=XYZsecret',
    'ssh://git:XYZsecret@git.example/o/b.git',
    `https://git.example/${TOKEN}/b.git`,
  ]) {
    it(held.replace(/XYZsecret|ghp_\w+/, '<secret>'), async () => {
      // An origin the server owns: its record says it wrote exactly this.
      await run(['remote', 'add', 'origin', OWNED]);
      await run(['config', '--local', 'webLatexMcp.heldUrl', OWNED]);
      await run(['config', '--local', 'webLatexMcp.originUrl', OWNED]);
      await expect(git.reconcileOrigin(dir, held)).rejects.toThrow(/carries a password or token/);
      expect(await originUrls()).toEqual([OWNED]);
      const config = await localConfig();
      expect(config).not.toContain('XYZsecret');
      expect(config).not.toContain(TOKEN);
    });
  }
});

describe('an origin carrying such a credential is never adopted', () => {
  for (const origin of [
    'https://git.example/o/a.git?access_token=XYZsecret',
    'ssh://git:XYZsecret@git.example/o/a.git',
    `https://git.example/${TOKEN}/a.git`,
  ]) {
    it(origin.replace(/XYZsecret|ghp_\w+/, '<secret>'), async () => {
      // No record, and origin equal to the held URL: a clean one would be adopted and recorded.
      await run(['remote', 'add', 'origin', origin]);
      const r = await git.reconcileOrigin(dir, origin);
      expect(r).toMatchObject({ kind: 'unowned', credentialOnDisk: true });
      const config = await localConfig();
      expect(config).not.toMatch(/weblatexmcp/i);
      expect(await originUrls()).toEqual([origin]);
    });
  }
});

describe('a clone from a URL with a token in its path writes no ownership record', () => {
  it('clones, and leaves no webLatexMcp.* key: the origin carries a credential', async () => {
    // A local bare repository under a directory named like a token: its file:// URL carries a
    // token-like path segment, which `carriesCredential` judges as it would an https one.
    const root = await mkdtemp(path.join(os.tmpdir(), 'wlm-origin-pathtok-'));
    try {
      const bare = path.join(root, TOKEN, 'remote.git');
      await mkdir(bare, { recursive: true });
      const init = await execCapture('git', ['init', '-q', '--bare', bare]);
      expect(init.code, init.stderr).toBe(0);
      const url = pathToFileURL(bare).href;
      const target = path.join(root, 'clone');
      await git.clone(url, target, { username: 'git' });
      const res = await execCapture('git', ['config', '--local', '--list'], { cwd: target });
      expect(res.stdout).toContain('remote.origin.url=');
      expect(res.stdout).not.toMatch(/weblatexmcp/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
