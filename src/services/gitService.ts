import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { simpleGit, type SimpleGit } from 'simple-git';
import { authenticateUrl, type AuthConfig, type CommitIdentity } from './auth.js';

const DEFAULT_IDENTITY: CommitIdentity = { name: 'Overleaf MCP', email: 'overleaf-mcp@localhost' };

export type SyncAction = 'cloned' | 'pulled' | 'up-to-date' | 'diverged';

export interface SyncResult {
  action: SyncAction;
  ahead: number;
  behind: number;
  diverged: boolean;
}

export interface StatusResult {
  branch: string;
  ahead: number;
  behind: number;
  clean: boolean;
  staged: string[];
  unstaged: string[];
  untracked: string[];
}

export interface DiffFile {
  path: string;
  added: number;
  removed: number;
}

export interface DiffResult {
  diff: string;
  files: DiffFile[];
}

/**
 * Wraps git operations via the system `git` CLI (through simple-git). Auth is injected
 * in-memory per network call and never persisted to .git/config.
 */
export class GitService {
  constructor(private readonly identity: CommitIdentity = DEFAULT_IDENTITY) {}

  /** Stage and commit locally. Does not push. */
  async commit(
    dir: string,
    opts: { message: string; paths?: string[]; allowEmpty?: boolean },
  ): Promise<{ committed: boolean; sha: string; filesChanged: number }> {
    const git = simpleGit(dir);
    if (opts.paths && opts.paths.length > 0) {
      await git.add(opts.paths);
    } else {
      await git.add(['-A']);
    }
    const staged = (await git.diff(['--cached', '--name-only'])).split('\n').filter(Boolean);
    if (staged.length === 0 && !opts.allowEmpty) {
      throw new Error('Nothing to commit (no staged changes).');
    }
    // Identity is supplied per-invocation with -c, so we never mutate the repo config.
    const args = [
      '-c',
      `user.name=${this.identity.name}`,
      '-c',
      `user.email=${this.identity.email}`,
      'commit',
      '-m',
      opts.message,
    ];
    if (opts.allowEmpty) args.push('--allow-empty');
    await git.raw(args);
    const sha = (await git.revparse(['HEAD'])).trim();
    return { committed: true, sha, filesChanged: staged.length };
  }

  /** Discard uncommitted changes (working tree + untracked), optionally limited to paths. */
  async discard(dir: string, paths?: string[]): Promise<{ discarded: boolean }> {
    const git = simpleGit(dir);
    if (paths && paths.length > 0) {
      await git.checkout(['--', ...paths]);
      await git.clean('f', ['--', ...paths]);
    } else {
      await git.checkout(['--', '.']);
      await git.clean('fd');
    }
    return { discarded: true };
  }

  /** Push to the Overleaf remote. Refuses if local is behind/diverged (sync first). */
  async push(
    dir: string,
    gitUrl: string,
    auth: AuthConfig,
  ): Promise<{ pushed: boolean; remote: string; summary: string }> {
    const git = simpleGit(dir);
    await this.withAuth(git, gitUrl, auth, () => git.fetch(['origin']));
    const ab = await this.aheadBehindOf(git);
    if (ab.behind > 0) {
      throw new Error(
        `Refusing to push: local is behind remote by ${ab.behind} commit(s)` +
          (ab.ahead > 0 ? ` and has diverged (ahead ${ab.ahead})` : '') +
          '. Run project_sync (and resolve any divergence) first.',
      );
    }
    if (ab.ahead === 0) {
      return { pushed: false, remote: gitUrl, summary: 'Nothing to push; already up to date.' };
    }
    await this.withAuth(git, gitUrl, auth, () => git.push(['origin', ab.branch]));
    return {
      pushed: true,
      remote: gitUrl,
      summary: `Pushed ${ab.ahead} commit(s) to origin/${ab.branch}.`,
    };
  }

  /** Clone a project, then reset origin to the tokenless URL so no credential is persisted. */
  async clone(gitUrl: string, targetDir: string, auth: AuthConfig, branch?: string): Promise<void> {
    await mkdir(path.dirname(targetDir), { recursive: true });
    const authUrl = authenticateUrl(gitUrl, auth);
    // Keep repo line endings (LF) so edit_file's exact match is deterministic on Windows.
    const options = ['-c', 'core.autocrlf=false', ...(branch ? ['-b', branch] : [])];
    await simpleGit().clone(authUrl, targetDir, options);
    await simpleGit(targetDir).remote(['set-url', 'origin', gitUrl]);
  }

  /** Fetch and fast-forward (ff-only). Surfaces divergence instead of merging. */
  async syncPull(gitUrl: string, dir: string, auth: AuthConfig): Promise<SyncResult> {
    const git = simpleGit(dir);
    await this.withAuth(git, gitUrl, auth, () => git.fetch(['origin']));
    const ab = await this.aheadBehindOf(git);
    if (ab.behind === 0) {
      return { action: 'up-to-date', ahead: ab.ahead, behind: 0, diverged: false };
    }
    if (ab.ahead > 0) {
      return { action: 'diverged', ahead: ab.ahead, behind: ab.behind, diverged: true };
    }
    await git.merge(['--ff-only', `origin/${ab.branch}`]);
    const after = await this.aheadBehindOf(git);
    return { action: 'pulled', ahead: after.ahead, behind: after.behind, diverged: false };
  }

  /** Ahead/behind counts vs the upstream for a clone directory. */
  async aheadBehind(dir: string): Promise<{ branch: string; ahead: number; behind: number }> {
    return this.aheadBehindOf(simpleGit(dir));
  }

  async status(dir: string): Promise<StatusResult> {
    const git = simpleGit(dir);
    const s = await git.status();
    const ab = await this.aheadBehindOf(git);
    const staged = s.files.filter((f) => f.index !== ' ' && f.index !== '?').map((f) => f.path);
    const unstaged = s.files
      .filter((f) => f.working_dir !== ' ' && f.working_dir !== '?')
      .map((f) => f.path);
    return {
      branch: s.current ?? ab.branch,
      ahead: ab.ahead,
      behind: ab.behind,
      clean: s.isClean(),
      staged,
      unstaged,
      untracked: s.not_added,
    };
  }

  async diff(dir: string, opts: { path?: string; staged?: boolean }): Promise<DiffResult> {
    const git = simpleGit(dir);
    const base: string[] = [];
    if (opts.staged) base.push('--cached');
    const patchArgs = [...base];
    const numstatArgs = [...base, '--numstat'];
    if (opts.path) {
      patchArgs.push('--', opts.path);
      numstatArgs.push('--', opts.path);
    }
    const [diff, numstat] = await Promise.all([git.diff(patchArgs), git.diff(numstatArgs)]);
    const files = numstat
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [added, removed, ...rest] = line.split('\t');
        return {
          path: rest.join('\t'),
          added: added === '-' ? 0 : Number(added),
          removed: removed === '-' ? 0 : Number(removed),
        };
      });
    return { diff, files };
  }

  private async aheadBehindOf(
    git: SimpleGit,
  ): Promise<{ branch: string; ahead: number; behind: number }> {
    const branch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
    try {
      const out = await git.raw([
        'rev-list',
        '--left-right',
        '--count',
        `${branch}...origin/${branch}`,
      ]);
      const [ahead, behind] = out
        .trim()
        .split(/\s+/)
        .map((n) => Number(n));
      return { branch, ahead: ahead ?? 0, behind: behind ?? 0 };
    } catch {
      // No upstream tracking ref yet (e.g. before first fetch).
      return { branch, ahead: 0, behind: 0 };
    }
  }

  /** Run `fn` with origin temporarily pointed at the authenticated URL, then restore. */
  private async withAuth(
    git: SimpleGit,
    gitUrl: string,
    auth: AuthConfig,
    fn: () => Promise<unknown>,
  ): Promise<void> {
    const authUrl = authenticateUrl(gitUrl, auth);
    if (authUrl === gitUrl) {
      await fn();
      return;
    }
    await git.remote(['set-url', 'origin', authUrl]);
    try {
      await fn();
    } finally {
      await git.remote(['set-url', 'origin', gitUrl]);
    }
  }
}
