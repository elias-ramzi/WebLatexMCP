import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, readFile, writeFile, readlink, lstat, stat } from 'node:fs/promises';
import { symlink, unlink } from 'node:fs/promises';
import { simpleGit, type SimpleGit } from 'simple-git';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import { createFakeRemote, type FakeRemote } from './helpers/bareRepo.js';
import type { ServerConfig } from '../../src/types.js';
import { MAX_BINARY_READ_BYTES } from '../../src/lib/assets.js';
import { MAX_READ_BYTES } from '../../src/services/fileService.js';

/**
 * `revert` undoes one or more commits INTO THE WORKING TREE and commits nothing
 * (`git revert --no-commit`, then unstage). Every assertion below is made twice — once on
 * `structuredContent`, once on real on-disk state through `node:fs`/git — because the whole
 * value of the tool is the tree it leaves behind, and a report that says "reverted" over an
 * untouched (or half-reverted, or still-staged, or mid-revert) clone is the failure mode.
 *
 * Refusal precedence under test (first wins): merge commit → symlinked path → `.bib` without
 * `confirmBibEdit` → dirty touched path, with `requireGitProject` refusing a local project
 * ahead of all of them.
 */

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function structured(res: unknown): Record<string, unknown> {
  return (res as { structuredContent?: Record<string, unknown> }).structuredContent ?? {};
}
function isError(res: unknown): boolean {
  return (res as { isError?: boolean }).isError === true;
}
/** The result's text as a client renders it (never JSON-encoded — a Windows path keeps its `\`). */
function plainText(res: unknown): string {
  const content = (res as { content?: Array<{ text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? '').join('\n');
}

/**
 * A refusal reaches a caller by one of two routes and the test must not care which: a guard
 * inside the handler comes back as an `isError` result, while a **schema** rejection
 * (`confirm: z.literal(true)` omitted) is an McpError the SDK throws before the handler runs.
 * Both are "the call was refused"; what each test then pins is the MESSAGE, so that "tool not
 * found" can never be mistaken for the guard actually firing.
 */
interface Outcome {
  threw: boolean;
  message: string;
}
async function attempt(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Outcome> {
  try {
    const res = await client.callTool({ name, arguments: args });
    return { threw: false, message: isError(res) ? plainText(res) : '' };
  } catch (err) {
    return { threw: true, message: err instanceof Error ? err.message : String(err) };
  }
}
function wasRefused(o: Outcome): boolean {
  return o.threw || o.message !== '';
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}

async function connect(config: ServerConfig, workspace: string): Promise<Client> {
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
  return client;
}

interface Harness {
  client: Client;
  clone: string;
  git: SimpleGit;
  remote: FakeRemote;
  /** HEAD of the clone right after `project_sync` — the state every seeded commit builds on. */
  base: string;
}

async function setup(files: Record<string, string>): Promise<Harness> {
  const remote = await createFakeRemote(files);
  cleanups.push(remote.cleanup);
  const workspace = await tmp('ovl-revert-ws-');
  const config: ServerConfig = {
    workspaceRoot: workspace,
    sessionId: 'test',
    projects: [{ id: 'demo', gitUrl: remote.url }],
    defaultProject: 'demo',
  };
  const client = await connect(config, workspace);
  await client.callTool({ name: 'project_sync', arguments: { project: 'demo', mode: 'clone' } });

  const clone = path.join(workspace, 'demo');
  const git = simpleGit(clone);
  await git.addConfig('user.email', 'local@example.com');
  await git.addConfig('user.name', 'Local');
  await git.addConfig('core.autocrlf', 'false');
  const base = (await git.revparse(['HEAD'])).trim();
  return { client, clone, git, remote, base };
}

/** Commit `files` straight into the clone (the history `revert` is asked to undo). */
async function commitInClone(
  h: Harness,
  files: Record<string, string>,
  message: string,
): Promise<string> {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(h.clone, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  await h.git.add('.');
  await h.git.commit(message);
  return (await h.git.revparse(['HEAD'])).trim();
}

const porcelain = (git: SimpleGit): Promise<string> => git.raw(['status', '--porcelain']);
const staged = (git: SimpleGit): Promise<string> => git.raw(['diff', '--cached', '--name-only']);
const revertHeadPath = (clone: string): string => path.join(clone, '.git', 'REVERT_HEAD');

describe('revert (git project)', () => {
  // 1. The whole contract on the happy path: the bytes come back, nothing is committed, nothing
  //    is left staged (`git revert -n` stages by default), and no revert is left in progress
  //    (git writes `.git/REVERT_HEAD` even for a successful `--no-commit`, and only
  //    `revert --quit`/`--abort` clears it — leaving it behind wedges the clone for the next
  //    `git commit`, which would silently attribute this revert's message to it).
  it('reverts one commit into the working tree, unstaged, uncommitted, with matchesRef true', async () => {
    const h = await setup({ 'main.tex': 'alpha\nbeta\n' });
    const sha = await commitInClone(h, { 'main.tex': 'alpha\nbeta\ngamma\ndelta\n' }, 'add lines');

    const res = await h.client.callTool({
      name: 'revert',
      arguments: { project: 'demo', commits: [sha], confirm: true, expectRef: h.base },
    });

    expect(isError(res)).toBe(false);
    const sc = structured(res);
    expect(sc.status).toBe('reverted');
    expect(sc.reverted).toBe(true);
    expect(sc.commits).toEqual([sha]);
    expect(sc.expectRef).toBe(h.base);
    expect(sc.matchesRef).toBe(true);
    expect(sc.mismatchedFiles).toEqual([]);
    expect(sc.filesChanged).toBe(1);
    // Asymmetric on purpose: the seeded commit ADDED two lines, so undoing it removes two and
    // adds none. A test built on a one-for-one line change cannot catch added/removed swapped.
    const files = sc.files as Array<Record<string, unknown>>;
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ path: 'main.tex', added: 0, removed: 2 });

    // On disk: byte-identical to the content before the reverted commit.
    expect(await readFile(path.join(h.clone, 'main.tex'), 'utf8')).toBe('alpha\nbeta\n');
    // Not committed.
    expect((await h.git.revparse(['HEAD'])).trim()).toBe(sha);
    // Not staged.
    expect((await staged(h.git)).trim()).toBe('');
    // Not mid-revert.
    expect(await exists(revertHeadPath(h.clone))).toBe(false);
  });

  // 2. `expectRef` is a REPORT, not a precondition: the revert still happens and the call still
  //    succeeds when the resulting tree does not match. The field must be present and exactly
  //    `false` — an omitted field is falsy too, and would let "matchesRef was never computed"
  //    pass as "matchesRef said no".
  it('reports matchesRef false with the mismatching file, and does not throw', async () => {
    const h = await setup({ 'main.tex': 'alpha\nbeta\n' });
    const sha = await commitInClone(h, { 'main.tex': 'alpha\nbeta\ngamma\ndelta\n' }, 'add lines');

    const res = await h.client.callTool({
      name: 'revert',
      // The reverted commit's own tree: undoing it is precisely what makes the tree differ.
      arguments: { project: 'demo', commits: [sha], confirm: true, expectRef: sha },
    });

    expect(isError(res)).toBe(false);
    const sc = structured(res);
    expect(sc.status).toBe('reverted');
    expect(sc.reverted).toBe(true);
    expect(sc).toHaveProperty('matchesRef');
    expect(sc.matchesRef).toBe(false);
    expect(sc.expectRef).toBe(sha);
    const mismatched = sc.mismatchedFiles as Array<Record<string, unknown>>;
    expect(mismatched.length).toBeGreaterThan(0);
    expect(mismatched.map((f) => f.path)).toContain('main.tex');

    // The revert itself still landed.
    expect(await readFile(path.join(h.clone, 'main.tex'), 'utf8')).toBe('alpha\nbeta\n');
    expect((await h.git.revparse(['HEAD'])).trim()).toBe(sha);
  });

  // 3. A conflicting revert must abort completely. Reporting `conflict` while leaving
  //    `<<<<<<<` markers on disk would put marker text into a .tex the caller then compiles or
  //    pushes; leaving `.git/REVERT_HEAD` wedges the clone. And the abort must be surgical — a
  //    whole-tree reset would destroy a peer session's uncommitted work, which is the thing the
  //    shadow store exists to protect.
  it('aborts a conflicting revert: no markers, tree byte-identical, peer dirt survives', async () => {
    const h = await setup({ 'main.tex': 'alpha\nbeta\ngamma\n', 'other.tex': 'untouched\n' });
    const shaA = await commitInClone(h, { 'main.tex': 'alpha\nB1\ngamma\n' }, 'A: beta -> B1');
    const shaB = await commitInClone(h, { 'main.tex': 'alpha\nB2\ngamma\n' }, 'B: B1 -> B2');

    // A peer session's in-flight edit to a file the revert does not touch.
    await writeFile(path.join(h.clone, 'other.tex'), 'peer work in flight\n');

    const beforeMain = await readFile(path.join(h.clone, 'main.tex'), 'utf8');
    const beforeStatus = await porcelain(h.git);

    const res = await h.client.callTool({
      name: 'revert',
      arguments: { project: 'demo', commits: [shaA], confirm: true },
    });

    expect(isError(res)).toBe(false);
    const sc = structured(res);
    expect(sc.status).toBe('conflict');
    expect(sc.reverted).toBe(false);
    expect(sc.conflictPaths).toContain('main.tex');
    expect(sc.oursRef).not.toBeNull();
    expect(sc.theirsRef).not.toBeNull();
    expect(typeof sc.oursRef).toBe('string');
    expect(typeof sc.theirsRef).toBe('string');
    // No expectRef was passed, so there is nothing to compare against.
    expect(sc.expectRef).toBeNull();
    expect(sc.matchesRef).toBeNull();

    const afterMain = await readFile(path.join(h.clone, 'main.tex'), 'utf8');
    expect(afterMain).not.toContain('<<<<<<<');
    expect(afterMain).not.toContain('=======');
    expect(afterMain).not.toContain('>>>>>>>');
    expect(afterMain).toBe(beforeMain);
    expect(await porcelain(h.git)).toBe(beforeStatus);
    expect((await h.git.revparse(['HEAD'])).trim()).toBe(shaB);
    expect(await exists(revertHeadPath(h.clone))).toBe(false);
    // The abort was not a whole-tree reset.
    expect(await readFile(path.join(h.clone, 'other.tex'), 'utf8')).toBe('peer work in flight\n');
  });

  // 4. `confirm: z.literal(true)` — omitting it is rejected by the SCHEMA, before the handler
  //    runs. Pinning the message keeps this from passing for the wrong reason: pre-implementation
  //    the same call is refused with "Tool revert not found", which is not the guard firing.
  it('refuses a call with confirm absent, and changes nothing', async () => {
    const h = await setup({ 'main.tex': 'alpha\nbeta\n' });
    const sha = await commitInClone(h, { 'main.tex': 'alpha\nbeta\ngamma\n' }, 'add gamma');

    const outcome = await attempt(h.client, 'revert', { project: 'demo', commits: [sha] });

    expect(wasRefused(outcome)).toBe(true);
    expect(outcome.message).toMatch(/confirm/i);
    expect(outcome.message).not.toMatch(/not found/i);

    expect(await readFile(path.join(h.clone, 'main.tex'), 'utf8')).toBe('alpha\nbeta\ngamma\n');
    expect((await h.git.revparse(['HEAD'])).trim()).toBe(sha);
    expect((await porcelain(h.git)).trim()).toBe('');
    expect(await exists(revertHeadPath(h.clone))).toBe(false);
  });
});

describe('revert (local project)', () => {
  // 5. `requireGitProject` first: a local project is a directory inside the USER's own repo, so
  //    a git revert there would rewrite their working tree, not the document's. The refusal must
  //    be the server's sentence, not a raw git error that leaked out of a spawn.
  it('refuses a mode: local project with the requireGitProject message, not a git error', async () => {
    const workspace = await tmp('ovl-revert-localws-');
    const userDir = await tmp('ovl-revert-userdir-');
    await writeFile(path.join(userDir, 'main.tex'), '\\documentclass{article}\n');
    await writeFile(path.join(userDir, 'notes.md'), 'notes\n');

    const config: ServerConfig = { workspaceRoot: workspace, sessionId: 'test', projects: [] };
    const client = await connect(config, workspace);
    await client.callTool({
      name: 'register_project',
      arguments: { project: 'paper', path: userDir },
    });

    const outcome = await attempt(client, 'revert', {
      project: 'paper',
      commits: ['HEAD'],
      confirm: true,
    });

    expect(wasRefused(outcome)).toBe(true);
    expect(outcome.message).toContain('is local (edited in place at');
    expect(outcome.message).toContain(userDir);
    // Not a raw git error, and not "no such tool".
    expect(outcome.message).not.toMatch(/fatal:|not a git repository|bad revision/i);
    expect(outcome.message).not.toMatch(/not found/i);

    expect(await readFile(path.join(userDir, 'main.tex'), 'utf8')).toBe(
      '\\documentclass{article}\n',
    );
    expect(await readFile(path.join(userDir, 'notes.md'), 'utf8')).toBe('notes\n');
    expect(await exists(path.join(userDir, '.git'))).toBe(false);
  });
});

describe('revert and the .bib guard', () => {
  // 6. A `.bib` in the reverted set needs `confirmBibEdit`, exactly as write/edit/delete do —
  //    and the second half is the half that matters: the guard is a GATE (acknowledged, it
  //    proceeds), not a wall that makes a bibliography permanently un-revertable.
  it('refuses a reverted set containing a .bib, then performs it with confirmBibEdit', async () => {
    const h = await setup({
      'main.tex': 'alpha\n',
      'refs.bib': '@article{a, title={A}}\n',
    });
    const sha = await commitInClone(
      h,
      {
        'main.tex': 'alpha\nbeta\n',
        'refs.bib': '@article{a, title={A}}\n@article{b, title={B}}\n',
      },
      'cite b',
    );

    const blocked = await attempt(h.client, 'revert', {
      project: 'demo',
      commits: [sha],
      confirm: true,
    });
    expect(wasRefused(blocked)).toBe(true);
    expect(blocked.message).toContain('refs.bib');
    expect(blocked.message).toMatch(/confirmBibEdit/);
    expect(blocked.message).not.toMatch(/not found/i);

    // Nothing moved: the bibliography (and the .tex alongside it) is exactly as committed.
    expect(await readFile(path.join(h.clone, 'refs.bib'), 'utf8')).toBe(
      '@article{a, title={A}}\n@article{b, title={B}}\n',
    );
    expect(await readFile(path.join(h.clone, 'main.tex'), 'utf8')).toBe('alpha\nbeta\n');
    expect((await porcelain(h.git)).trim()).toBe('');

    const allowed = await h.client.callTool({
      name: 'revert',
      arguments: { project: 'demo', commits: [sha], confirm: true, confirmBibEdit: true },
    });
    expect(isError(allowed)).toBe(false);
    const sc = structured(allowed);
    expect(sc.status).toBe('reverted');
    expect(sc.reverted).toBe(true);
    expect((sc.files as Array<Record<string, unknown>>).map((f) => f.path)).toContain('refs.bib');

    expect(await readFile(path.join(h.clone, 'refs.bib'), 'utf8')).toBe('@article{a, title={A}}\n');
    expect(await readFile(path.join(h.clone, 'main.tex'), 'utf8')).toBe('alpha\n');
    expect((await h.git.revparse(['HEAD'])).trim()).toBe(sha);
    expect((await staged(h.git)).trim()).toBe('');
    expect(await exists(revertHeadPath(h.clone))).toBe(false);
  });
});

// Symlink creation needs a privilege Windows does not grant by default (EPERM), so this is an
// explicit platform skip — the repo idiom (see linkCommit/resolvePushLinks) — never a try/catch
// that would let the guard go untested while the suite stays green.
describe.skipIf(process.platform === 'win32')('revert and symlinked paths (posix only)', () => {
  // 7. A revert writes file CONTENT. Writing through a tracked symlink writes wherever the link
  //    points — outside the project, or into a .bib past the name-based gate — so a symlinked
  //    path anywhere in the reverted set is refused outright, ahead of the .bib and dirty checks.
  it('refuses when the reverted commit touches a symlinked path, leaving link and target intact', async () => {
    const h = await setup({ 'main.tex': 'alpha\n', 'real.tex': 'real\n', 'other.tex': 'other\n' });

    // A collaborator's committed symlink (git stores it as mode 120000).
    await symlink('real.tex', path.join(h.clone, 'link.tex'));
    await h.git.add('.');
    await h.git.commit('add link.tex -> real.tex');

    // The commit to be reverted re-points that link — so `link.tex` is in the reverted set.
    await unlink(path.join(h.clone, 'link.tex'));
    await symlink('other.tex', path.join(h.clone, 'link.tex'));
    await h.git.add('.');
    await h.git.commit('repoint link.tex -> other.tex');
    const sha = (await h.git.revparse(['HEAD'])).trim();

    const outcome = await attempt(h.client, 'revert', {
      project: 'demo',
      commits: [sha],
      confirm: true,
    });

    expect(wasRefused(outcome)).toBe(true);
    expect(outcome.message).toContain('link.tex');
    expect(outcome.message).toMatch(/symlink|symbolic link/i);
    expect(outcome.message).not.toMatch(/not found/i);

    // The link is still a link, still pointing where the last commit put it, and neither
    // endpoint's bytes were written through.
    const link = path.join(h.clone, 'link.tex');
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readlink(link)).toBe('other.tex');
    expect(await readFile(path.join(h.clone, 'real.tex'), 'utf8')).toBe('real\n');
    expect(await readFile(path.join(h.clone, 'other.tex'), 'utf8')).toBe('other\n');
    expect((await h.git.revparse(['HEAD'])).trim()).toBe(sha);
    expect((await porcelain(h.git)).trim()).toBe('');
    expect(await exists(revertHeadPath(h.clone))).toBe(false);
  });
});

// Neither test below has anything to do with symlinks. They were written into the posix-only
// block above, where Windows CI would skip them and a green run would prove nothing about
// either guard — the auto-skipped-smoke failure mode CLAUDE.md warns about. Own block, no skip.
describe('revert, staged peer work, and session attribution', () => {
  // 8. A peer session's STAGED work anywhere in the clone blocks the revert outright.
  //    This is not fastidiousness: a conflicting revert can only be undone with
  //    `git revert --abort`, which is a `reset --merge` to the stored head and resets the WHOLE
  //    index. Verified against real git: a `git add`ed file on a path the revert never touches
  //    comes back at HEAD with its staged work destroyed — the same loss that makes a whole-tree
  //    `reset --hard` forbidden as a restore path here. The refusal has to happen up front,
  //    because once the conflict is known the damage is already unavoidable. The revert used
  //    here WOULD conflict, so without the guard this test loses the staged bytes for real.
  it("refuses while anything is staged, so a conflicting revert's abort cannot destroy it", async () => {
    const h = await setup({ 'main.tex': 'alpha\nbeta\n', 'peer.tex': 'peer-base\n' });
    const sha = await commitInClone(h, { 'main.tex': 'alpha\nCHANGED\n' }, 'change beta');
    await commitInClone(h, { 'main.tex': 'alpha\nDIVERGED\n' }, 'change it again');
    const head = (await h.git.revparse(['HEAD'])).trim();

    // A peer session stages work on a path this revert does not touch.
    await writeFile(path.join(h.clone, 'peer.tex'), 'peer-STAGED-WORK\n');
    await h.git.add('peer.tex');

    const outcome = await attempt(h.client, 'revert', {
      project: 'demo',
      commits: [sha],
      confirm: true,
    });

    expect(wasRefused(outcome)).toBe(true);
    expect(outcome.message).toContain('peer.tex');
    expect(outcome.message).toMatch(/staged/i);

    // The staged bytes survived, and are still staged — the guard refused, it did not "helpfully"
    // unstage or commit anything on the peer's behalf.
    expect(await readFile(path.join(h.clone, 'peer.tex'), 'utf8')).toBe('peer-STAGED-WORK\n');
    expect((await staged(h.git)).trim()).toBe('peer.tex');
    expect((await h.git.revparse(['HEAD'])).trim()).toBe(head);
    expect(await exists(revertHeadPath(h.clone))).toBe(false);
  });

  // 9. Reverting a commit that ADDED a file has to DELETE it — the case where the session's
  //    shadow must record a deletion (`after` is null) rather than content. Proved end to end by
  //    committing afterwards with the DEFAULT session scope: if the revert were owned by nobody,
  //    or recorded as content instead of a deletion, that commit would stage nothing and the file
  //    would still be in the new tree.
  it('reverting an add deletes the file, and a session-scoped commit lands that deletion', async () => {
    const h = await setup({ 'main.tex': 'alpha\n' });
    const sha = await commitInClone(h, { 'draft.tex': 'unwanted\n' }, 'add a draft');
    expect(await exists(path.join(h.clone, 'draft.tex'))).toBe(true);

    const res = await h.client.callTool({
      name: 'revert',
      arguments: { project: 'demo', commits: [sha], confirm: true, expectRef: h.base },
    });

    expect(isError(res)).toBe(false);
    const sc = structured(res);
    expect(sc.status).toBe('reverted');
    expect(sc.matchesRef).toBe(true);
    expect(sc.files).toEqual([{ path: 'draft.tex', added: 0, removed: 1 }]);
    // Gone from the working tree, not merely emptied, and not left staged.
    expect(await exists(path.join(h.clone, 'draft.tex'))).toBe(false);
    expect((await staged(h.git)).trim()).toBe('');
    expect((await h.git.revparse(['HEAD'])).trim()).toBe(sha);

    // An UNOWNED change sitting in the tree alongside the revert. It is what makes the commit
    // below discriminating: `scope: "session"` must take the revert and leave this behind. Without
    // it the test proves nothing, because `commit` with no scope falls back to `"all"`
    // (`commit.ts`: `scope ?? (hasChanges(id) ? 'session' : 'all')`) — so with the record loop
    // deleted entirely, `git add -A` would commit the deletion anyway and this test would still
    // pass. The explicit scope plus this file are what pin the session actually OWNING the revert.
    await writeFile(path.join(h.clone, 'main.tex'), 'alpha\nNOT-MINE\n');

    const committed = await h.client.callTool({
      name: 'commit',
      arguments: { project: 'demo', message: 'drop the draft', scope: 'session' },
    });
    expect(isError(committed)).toBe(false);
    expect(structured(committed).committed).toBe(true);
    // The deletion is in the new tree: `ls-tree` no longer lists it.
    const tracked = await h.git.raw(['ls-tree', '-r', '--name-only', 'HEAD']);
    expect(tracked.split('\n').map((l) => l.trim())).not.toContain('draft.tex');
    // ...and ONLY the revert was taken: the unowned edit is still uncommitted on disk.
    expect(await h.git.raw(['show', 'HEAD:main.tex'])).toBe('alpha\n');
    expect(await readFile(path.join(h.clone, 'main.tex'), 'utf8')).toBe('alpha\nNOT-MINE\n');
  });
  // 9b. The mirror image, and the case the reporting used to get wrong: reverting a DELETION.
  //     The scoped `git reset HEAD -- <paths>` that unstages the revert drops from the index
  //     every path HEAD does not have — and a restored file is exactly such a path, so it ends up
  //     untracked. `git diff <ref> -- <path>` ignores untracked files, so measuring after the
  //     unstage reported `files: []` ("reverted — 0 file(s)") over a file that HAD been restored,
  //     and reported `matchesRef: false` for a revert that was byte-exact. Both numbers are
  //     measured against the index now, while the revert still sits in it.
  it('reverting a deletion restores the file, and reports it as an addition that matches', async () => {
    const h = await setup({ 'main.tex': 'alpha\n', 'sec.tex': 'section one\nsection two\n' });
    await h.git.rm(['sec.tex']);
    await h.git.commit('drop the section');
    const sha = (await h.git.revparse(['HEAD'])).trim();
    expect(await exists(path.join(h.clone, 'sec.tex'))).toBe(false);

    const res = await h.client.callTool({
      name: 'revert',
      arguments: { project: 'demo', commits: [sha], confirm: true, expectRef: h.base },
    });

    expect(isError(res)).toBe(false);
    const sc = structured(res);
    expect(sc.status).toBe('reverted');
    // Asymmetric on purpose, as in test 1: restoring the file ADDS two lines and removes none.
    expect(sc.files).toEqual([{ path: 'sec.tex', added: 2, removed: 0 }]);
    expect(sc.filesChanged).toBe(1);
    // The revert IS exact, so the headline assertion must say so.
    expect(sc.matchesRef).toBe(true);
    expect(sc.mismatchedFiles).toEqual([]);
    // ...and the text the caller reads must not claim nothing happened.
    expect(plainText(res)).toContain('1 file(s)');
    expect(plainText(res)).toContain('sec.tex');
    // ...and it must not send the caller to `diff`, alone, for a file `diff` cannot show: a
    // restored path is untracked, and `git diff` ignores untracked files, so an empty diff would
    // read as "the revert did nothing" for exactly the case this test covers.
    expect(plainText(res)).toMatch(/untracked/i);
    expect(plainText(res)).toMatch(/read_file|status/);

    // On disk, byte-identical to the content before the deletion, and still uncommitted/unstaged.
    expect(await readFile(path.join(h.clone, 'sec.tex'), 'utf8')).toBe(
      'section one\nsection two\n',
    );
    expect((await staged(h.git)).trim()).toBe('');
    expect((await h.git.revparse(['HEAD'])).trim()).toBe(sha);
    expect(await exists(revertHeadPath(h.clone))).toBe(false);

    // And the session owns it: a session-scoped commit lands the restoration.
    const committed = await h.client.callTool({
      name: 'commit',
      arguments: { project: 'demo', message: 'restore the section', scope: 'session' },
    });
    expect(isError(committed)).toBe(false);
    expect(structured(committed).committed).toBe(true);
    expect(await h.git.raw(['show', 'HEAD:sec.tex'])).toBe('section one\nsection two\n');
  });

  // 10. A touched path with UNSTAGED local changes is refused. This is the guard that keeps a
  //     revert off another session's in-flight lines: git would refuse to overwrite them anyway
  //     ("Your local changes to the following files would be overwritten by merge"), and catching
  //     it here turns that raw git failure into server words AND is what lets the abort be exact.
  //     The peer's bytes must still be sitting there afterwards, untouched and still uncommitted.
  it('refuses when a reverted path has uncommitted changes, leaving them alone', async () => {
    const h = await setup({ 'main.tex': 'alpha\nbeta\n' });
    const sha = await commitInClone(h, { 'main.tex': 'alpha\nbeta\ngamma\n' }, 'add gamma');

    // A peer session is mid-edit on the very file the revert would rewrite.
    await writeFile(path.join(h.clone, 'main.tex'), 'alpha\nbeta\ngamma\nPEER-IN-FLIGHT\n');

    const outcome = await attempt(h.client, 'revert', {
      project: 'demo',
      commits: [sha],
      confirm: true,
    });

    expect(wasRefused(outcome)).toBe(true);
    expect(outcome.message).toContain('main.tex');
    expect(outcome.message).toMatch(/uncommitted/i);

    // Untouched: the peer's line is still there, still uncommitted, and no revert was started.
    expect(await readFile(path.join(h.clone, 'main.tex'), 'utf8')).toBe(
      'alpha\nbeta\ngamma\nPEER-IN-FLIGHT\n',
    );
    expect((await h.git.revparse(['HEAD'])).trim()).toBe(sha);
    expect((await staged(h.git)).trim()).toBe('');
    expect(await exists(revertHeadPath(h.clone))).toBe(false);
  });
});

// 11. Reverting a merge commit needs `-m` to say which parent is "the change", and `revert`
//     deliberately takes no mainline parameter rather than guessing for the user. Without this
//     guard the call reaches git, which fails `fatal: revert failed` — a raw git error naming
//     neither the tool's own limitation nor a way forward.
describe('revert and merge commits', () => {
  it('refuses a merge commit by sha instead of guessing a mainline', async () => {
    const h = await setup({ 'main.tex': 'alpha\n' });
    await commitInClone(h, { 'main.tex': 'alpha\nmaster-side\n' }, 'master side');
    const master = (await h.git.revparse(['HEAD'])).trim();

    await h.git.raw(['checkout', '-q', '-b', 'side', h.base]);
    await commitInClone(h, { 'other.tex': 'side\n' }, 'side branch');
    await h.git.raw(['checkout', '-q', 'master']);
    await h.git.raw(['merge', '--no-ff', '-m', 'merge side', 'side']);
    const mergeSha = (await h.git.revparse(['HEAD'])).trim();
    expect(mergeSha).not.toBe(master);

    const outcome = await attempt(h.client, 'revert', {
      project: 'demo',
      commits: [mergeSha],
      confirm: true,
    });

    expect(wasRefused(outcome)).toBe(true);
    expect(outcome.message).toContain(mergeSha);
    expect(outcome.message).toMatch(/merge/i);
    // Refused in server words, not by handing back git's own failure.
    expect(outcome.message).not.toMatch(/fatal:|revert failed/i);

    expect((await h.git.revparse(['HEAD'])).trim()).toBe(mergeSha);
    expect((await porcelain(h.git)).trim()).toBe('');
    expect(await exists(revertHeadPath(h.clone))).toBe(false);
  });
});

// 12. A revert whose read-back throws AT ALL must still succeed. The shadow record reads each
//     reverted path back through `FileService.readBytes` to attribute it to this session, and
//     that read throws above the BINARY cap (`MAX_BINARY_READ_BYTES` — the cap that exists so
//     every figure `add_asset` may import can be read back out again). By then the revert is
//     already on disk, so failing the call would report an error for a change that landed and
//     abandon every remaining path unrecorded. The tool logs, flags the path unrecorded (fail
//     closed, so a peer's `commit scope: "paths"` refuses it rather than treating it as owned by
//     nobody) and reports the revert it actually performed.
//
//     The cap is the ONLY route to this branch, which is why the fixture pays for an oversized
//     file at all. The obvious cheap alternative — a tracked link out of the project, which
//     `guardLinks(strictLinks: true)` refuses — never reaches it: `revertPreflight`'s `linksAmong`
//     scans HEAD, every reverted commit AND every parent for a mode-120000 entry among the
//     touched paths, and `revert` refuses on a non-empty `linkPaths` before `revertApply` runs.
//     A link the revert would RESTORE is in the parent tree by definition, so it is always in
//     that set. Probed, not assumed: the call comes back as an errorResult ("is a symbolic link
//     (or lies under one)"), with no shadow entry and no attribution failure to observe.
//
//     Exceeding the binary cap is pathological, not routine — which is exactly what the second
//     case pins. A 3 MiB figure is over the TEXT cap (`MAX_READ_BYTES`) and under the binary one,
//     and it used to land in the fail-closed branch above on every revert that restored a figure;
//     it must now be reverted AND attributed normally. The two cases are the two sides of that
//     boundary: the branch still fires when the read genuinely throws, and no longer fires for a
//     file the server itself was allowed to import.
describe('revert past the file read cap', () => {
  it('still reports success when a reverted file is too big to read back for attribution', async () => {
    const big = 'x'.repeat(MAX_BINARY_READ_BYTES + 1); // one byte over the binary read cap
    // The fixture is shaped to touch the oversized blob as few times as possible, because
    // `vitest.config.ts` is explicit that the per-platform timeout "buys tail headroom, not a
    // licence to make a fixture expensive". Seeding `big.dat` into the REMOTE would write it,
    // hash it, and then check it out again through `project_sync`; committing it in the clone
    // and having the reverted commit DELETE it costs one write, one hash, and the revert's own
    // checkout — for the same throw, since the revert restores the file either way. Note the cost
    // is tied to the constant: raising `MAX_ASSET_BYTES` for a genuine figure format raises this
    // fixture with it, silently and on the slowest runner. Re-measure this case if you do.
    const h = await setup({ 'main.tex': 'alpha\n' });
    const added = await commitInClone(h, { 'big.dat': big }, 'add the big file');
    await unlink(path.join(h.clone, 'big.dat'));
    const sha = await commitInClone(h, {}, 'drop the big file');

    const res = await h.client.callTool({
      name: 'revert',
      // `added`, not `h.base`: reverting the deletion returns the tree to the commit that added
      // the file, which is one commit ahead of the clone's starting point.
      arguments: { project: 'demo', commits: [sha], confirm: true, expectRef: added },
    });

    // The revert landed and is reported as landed — not an errorResult over a reverted tree.
    expect(isError(res)).toBe(false);
    expect(structured(res).status).toBe('reverted');
    expect(structured(res).matchesRef).toBe(true);
    expect(await readFile(path.join(h.clone, 'big.dat'), 'utf8')).toBe(big);
    expect((await h.git.revparse(['HEAD'])).trim()).toBe(sha);
    expect((await staged(h.git)).trim()).toBe('');
    expect(await exists(revertHeadPath(h.clone))).toBe(false);

    // The rare path must be shown to have FIRED, or a do-nothing record loop passes this too:
    // the entry is flagged `unrecorded` (and therefore `conflicted`), which is what makes a
    // peer's `commit scope: "paths"` refuse the path instead of reading it as owned by nobody.
    const shadowIndex = path.join(
      path.dirname(h.clone),
      '.sessions',
      'demo',
      'test',
      'shadow.json',
    );
    const index = JSON.parse(await readFile(shadowIndex, 'utf8')) as {
      entries: Record<string, { unrecorded?: boolean; conflicted?: boolean }>;
    };
    expect(index.entries['big.dat']?.unrecorded).toBe(true);
    expect(index.entries['big.dat']?.conflicted).toBe(true);
  });

  it('reverts and normally attributes a 3 MiB file — over the text cap, under the binary cap', async () => {
    // Issue #66 §7's actual case: `readBytes` was capped at the 2 MiB TEXT cap, so reverting a
    // 3 MiB figure this server itself imported threw on the attribution read and left the path
    // flagged `conflicted` + `unrecorded` for good. It must now be attributed like any other.
    const mid = 'y'.repeat(3 * 1024 * 1024) + '\n';
    expect(mid.length).toBeGreaterThan(MAX_READ_BYTES);
    expect(mid.length).toBeLessThan(MAX_BINARY_READ_BYTES);
    const h = await setup({ 'main.tex': 'alpha\n', 'mid.dat': mid });
    const sha = await commitInClone(h, { 'mid.dat': `${mid}appended\n` }, 'grow the mid file');

    const res = await h.client.callTool({
      name: 'revert',
      arguments: { project: 'demo', commits: [sha], confirm: true, expectRef: h.base },
    });

    expect(isError(res)).toBe(false);
    expect(structured(res).status).toBe('reverted');
    expect(structured(res).matchesRef).toBe(true);
    expect(await readFile(path.join(h.clone, 'mid.dat'), 'utf8')).toBe(mid);

    // Attributed, not abandoned: the session owns the path, with neither fail-closed flag set.
    const shadowIndex = path.join(
      path.dirname(h.clone),
      '.sessions',
      'demo',
      'test',
      'shadow.json',
    );
    const index = JSON.parse(await readFile(shadowIndex, 'utf8')) as {
      entries: Record<string, { unrecorded?: boolean; conflicted?: boolean }>;
    };
    expect(index.entries['mid.dat']).toBeDefined();
    expect(index.entries['mid.dat']?.unrecorded).toBeFalsy();
    expect(index.entries['mid.dat']?.conflicted).toBeFalsy();
  });
});

// 13. The cross-session half of the shadow decision, which CLAUDE.md calls load-bearing and which
//     nothing else here exercises: a revert settles the reverted paths in EVERY session's record,
//     and settles ONLY those paths.
//
//     Why it matters, concretely: a peer that still holds a shadow entry for a reverted path holds
//     the PRE-revert bytes, and `commit scope: "session"` stages shadow CONTENT through
//     `commitContents` — so that peer's next commit would silently re-install the lines the revert
//     just undid. A `--no-commit` revert never moves HEAD, so `refresh` cannot catch it either.
//     The other half is that it must be `settleAll` over the reverted paths and never `clearAll`:
//     dropping a peer's record for a file nothing happened to is what lets a later
//     `commit scope: "paths"` sweep up that peer's lines as if nobody owned them.
describe('revert across sessions', () => {
  it("settles the reverted paths in a peer's record, and leaves its unrelated record alone", async () => {
    const remote = await createFakeRemote({ 'main.tex': 'alpha\n', 'other.tex': 'other\n' });
    cleanups.push(remote.cleanup);
    const workspace = await tmp('ovl-revert-peer-');
    const base = {
      workspaceRoot: workspace,
      projects: [{ id: 'demo', gitUrl: remote.url }],
      defaultProject: 'demo',
    };
    const mine = await connect({ ...base, sessionId: 'mine' } as ServerConfig, workspace);
    await mine.callTool({ name: 'project_sync', arguments: { project: 'demo', mode: 'clone' } });
    const peer = await connect({ ...base, sessionId: 'peer' } as ServerConfig, workspace);

    const clone = path.join(workspace, 'demo');
    const git = simpleGit(clone);
    await git.addConfig('user.email', 'local@example.com');
    await git.addConfig('user.name', 'Local');

    // The peer edits BOTH files, so it owns a record for each.
    await peer.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'main.tex', content: 'alpha\nPEER-LINE\n' },
    });
    await peer.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'other.tex', content: 'other\nPEER-UNRELATED\n' },
    });
    // The peer's main.tex work lands in history (so the tree is clean and a revert is allowed),
    // while its record of that path stays behind — the stale entry this guard exists for.
    // ONLY main.tex — `commit -am` would sweep up the peer's unrelated other.tex edit too, and
    // that edit is precisely what must survive the revert further down.
    await git.raw(['--literal-pathspecs', 'commit', '-m', 'peer line', '--', 'main.tex']);
    const landed = (await git.revparse(['HEAD'])).trim();
    expect(await readFile(path.join(clone, 'main.tex'), 'utf8')).toBe('alpha\nPEER-LINE\n');

    // My session reverts it, then lands the revert — so HEAD now holds the REVERTED content while
    // the peer (if nothing settled it) still holds a shadow entry whose content is the pre-revert
    // line. That gap is the whole hazard: the peer's next session-scoped commit stages shadow
    // CONTENT, so it would put PEER-LINE straight back into history.
    const res = await mine.callTool({
      name: 'revert',
      arguments: { project: 'demo', commits: [landed], confirm: true },
    });
    if (isError(res)) throw new Error(`revert refused: ${plainText(res)}`);
    expect(await readFile(path.join(clone, 'main.tex'), 'utf8')).toBe('alpha\n');

    const mineCommitted = await mine.callTool({
      name: 'commit',
      arguments: { project: 'demo', message: 'land the revert', scope: 'session' },
    });
    if (isError(mineCommitted)) throw new Error(`my commit failed: ${plainText(mineCommitted)}`);
    // The revert is in history — and it got there through MY session's shadow, which is only
    // possible because `revert` recorded the reverted path as this session's.
    expect(await git.raw(['show', 'HEAD:main.tex'])).toBe('alpha\n');

    // Now the peer commits its own work.
    const committed = await peer.callTool({
      name: 'commit',
      arguments: { project: 'demo', message: 'peer commits its own work', scope: 'session' },
    });
    if (isError(committed)) throw new Error(`peer commit failed: ${plainText(committed)}`);

    // THE assertion: the reverted line did not come back. Without the cross-session settle the
    // peer's stale entry re-installs PEER-LINE here and the revert is silently undone.
    expect(await git.raw(['show', 'HEAD:main.tex'])).toBe('alpha\n');
    expect(await readFile(path.join(clone, 'main.tex'), 'utf8')).toBe('alpha\n');
    // ...and the peer's UNRELATED record survived the revert, so its other edit still lands.
    // This is the `clearAll` half: dropping that record would leave those lines owned by nobody.
    expect(await git.raw(['show', 'HEAD:other.tex'])).toBe('other\nPEER-UNRELATED\n');
  });
});

// 14. A multi-commit revert: applied in the order given, in one `git revert --no-commit`, so both
//     commits come out of the tree together. Nothing else pins the plural in `commits`.
describe('revert of several commits', () => {
  it('reverts two commits in one call, back to the state before both', async () => {
    const h = await setup({ 'main.tex': 'alpha\n' });
    const first = await commitInClone(h, { 'main.tex': 'alpha\nbeta\n' }, 'add beta');
    const second = await commitInClone(h, { 'main.tex': 'alpha\nbeta\ngamma\n' }, 'add gamma');

    // Newest first, which is the order `git revert` needs to unwind them.
    const res = await h.client.callTool({
      name: 'revert',
      arguments: { project: 'demo', commits: [second, first], confirm: true, expectRef: h.base },
    });

    if (isError(res)) throw new Error(`revert refused: ${plainText(res)}`);
    const sc = structured(res);
    expect(sc.status).toBe('reverted');
    expect(sc.commits).toEqual([second, first]);
    expect(sc.matchesRef).toBe(true);
    // Both lines gone — not just the newer commit's.
    expect(await readFile(path.join(h.clone, 'main.tex'), 'utf8')).toBe('alpha\n');
    expect((await h.git.revparse(['HEAD'])).trim()).toBe(second);
    expect((await staged(h.git)).trim()).toBe('');
    expect(await exists(revertHeadPath(h.clone))).toBe(false);
  });
});
// 15. The two post-revert bookkeeping steps are INDEPENDENT, and a failure of the first must not
//     skip the second. `sessions.touch` is this session's liveness heartbeat;
//     `shadows.settleAll` is what stops a PEER's stale shadow re-installing the reverted lines at
//     its next session-scoped commit (`commitContents` stages shadow CONTENT, and a `--no-commit`
//     revert never moves HEAD, so `refresh` cannot catch it either). Running both under one
//     try/catch made an unrelated heartbeat failure silently skip the settle — the exact hazard
//     the cross-session settle exists for. `createSessionRecorder` separates them for the same
//     reason, in its own words: "its own failure says nothing about the shadow".
//
//     The heartbeat is broken by injection rather than by breaking the filesystem, because
//     `SessionRegistry.touch` throttles itself (HEARTBEAT_THROTTLE_MS) and a filesystem break
//     would be silently skipped instead of failing — leaving the branch untested while the suite
//     stayed green.
describe('revert when the session heartbeat fails', () => {
  async function connectWithBrokenHeartbeat(
    config: ServerConfig,
    workspace: string,
  ): Promise<Client> {
    const ctx = createContext(
      config,
      new CredentialResolver({}),
      { name: 'Test', email: 'test@example.com' },
      new ProjectRegistry(workspace),
    );
    ctx.sessions.touch = (): Promise<void> => {
      throw new Error('injected: session heartbeat write failed');
    };
    const server = createServer(ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(() => client.close());
    return client;
  }

  it("still settles the peer's stale record, and still reports the revert it performed", async () => {
    const remote = await createFakeRemote({ 'main.tex': 'alpha\n' });
    cleanups.push(remote.cleanup);
    const workspace = await tmp('ovl-revert-hb-');
    const base = {
      workspaceRoot: workspace,
      projects: [{ id: 'demo', gitUrl: remote.url }],
      defaultProject: 'demo',
    };
    const peer = await connect({ ...base, sessionId: 'peer' } as ServerConfig, workspace);
    await peer.callTool({ name: 'project_sync', arguments: { project: 'demo', mode: 'clone' } });

    const clone = path.join(workspace, 'demo');
    const git = simpleGit(clone);
    await git.addConfig('user.email', 'local@example.com');
    await git.addConfig('user.name', 'Local');

    // The peer edits main.tex (so it owns a shadow entry for it) and lands that edit, leaving the
    // tree clean and its now-stale record behind.
    await peer.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'main.tex', content: 'alpha\nPEER-LINE\n' },
    });
    await git.raw(['--literal-pathspecs', 'commit', '-am', 'peer line']);
    const landed = (await git.revparse(['HEAD'])).trim();

    const peerShadow = path.join(workspace, '.sessions', 'demo', 'peer', 'shadow.json');
    const before = JSON.parse(await readFile(peerShadow, 'utf8')) as {
      entries: Record<string, unknown>;
    };
    // The precondition, asserted rather than assumed: without a stale entry to settle there is
    // nothing for this test to prove.
    expect(Object.keys(before.entries)).toContain('main.tex');

    const mine = await connectWithBrokenHeartbeat(
      { ...base, sessionId: 'mine' } as ServerConfig,
      workspace,
    );
    const res = await mine.callTool({
      name: 'revert',
      arguments: { project: 'demo', commits: [landed], confirm: true },
    });

    // The heartbeat failure must not fail a revert that landed...
    expect(isError(res)).toBe(false);
    expect(structured(res).status).toBe('reverted');
    expect(await readFile(path.join(clone, 'main.tex'), 'utf8')).toBe('alpha\n');

    // ...and the settle must have run anyway. This is THE assertion: coupled to the heartbeat,
    // the peer's stale entry is still here and its next commit puts PEER-LINE back.
    const after = JSON.parse(await readFile(peerShadow, 'utf8')) as {
      entries: Record<string, unknown>;
    };
    expect(Object.keys(after.entries)).not.toContain('main.tex');
  });
});

// 17. `matchesRef` must be `null`, never `true`, on a SUCCESSFUL revert with no `expectRef`.
//     Test 3 looks like it covers this and cannot: the conflict branch returns its own hard-coded
//     `matchesRef: null`, so dropping the null check on the success path left every test green
//     while a revert that compared nothing started reporting "verified exact".
describe('revert without an expectRef', () => {
  it('reports matchesRef null, never true, when there was nothing to compare', async () => {
    const h = await setup({ 'main.tex': 'alpha\n' });
    const sha = await commitInClone(h, { 'main.tex': 'alpha\nbeta\n' }, 'add beta');

    const res = await h.client.callTool({
      name: 'revert',
      arguments: { project: 'demo', commits: [sha], confirm: true },
    });

    expect(isError(res)).toBe(false);
    const sc = structured(res);
    // The SUCCESS branch, not the conflict one — otherwise this passes for the wrong reason.
    expect(sc.status).toBe('reverted');
    expect(sc.reverted).toBe(true);
    expect(await readFile(path.join(h.clone, 'main.tex'), 'utf8')).toBe('alpha\n');

    expect(sc).toHaveProperty('matchesRef');
    expect(sc.matchesRef).toBeNull();
    expect(sc.expectRef).toBeNull();
    expect(sc.mismatchedFiles).toEqual([]);
    // ...and the text claims no verdict either way.
    expect(plainText(res)).not.toMatch(/now match|do NOT match/);
  });
});

// 18. A reverted `.tex` must be recorded as TEXT. `ShadowStore.record` flags an entry `binary`
//     when either side arrives as a Buffer, stickily and for the life of the entry, and a binary
//     entry is never three-way merged — so handing it Buffers unconditionally wedges every
//     reverted `.tex` out of `scope: "session"` the moment a peer commit moves HEAD. Nothing
//     pinned `asShadowContent`: returning the Buffer unconditionally left the whole suite green.
describe('revert and the shadow content type', () => {
  it('records a reverted .tex as text, so it is never stickily flagged binary', async () => {
    const h = await setup({ 'main.tex': 'alpha\n' });
    const sha = await commitInClone(h, { 'main.tex': 'alpha\nbeta\n' }, 'add beta');

    const res = await h.client.callTool({
      name: 'revert',
      arguments: { project: 'demo', commits: [sha], confirm: true },
    });
    expect(isError(res)).toBe(false);

    const shadowIndex = path.join(
      path.dirname(h.clone),
      '.sessions',
      'demo',
      'test',
      'shadow.json',
    );
    const index = JSON.parse(await readFile(shadowIndex, 'utf8')) as {
      entries: Record<string, { binary?: boolean; conflicted?: boolean }>;
    };
    // The entry exists at all (the record loop ran)...
    expect(index.entries['main.tex']).toBeDefined();
    // ...and is text, and not already wedged.
    expect(index.entries['main.tex']?.binary).not.toBe(true);
    expect(index.entries['main.tex']?.conflicted).not.toBe(true);
  });
});

// 19. `ctx.files.resetBaselines(dir)` — the revert rewrites files the server itself has read, so
//     without the reset the next `edit_file` on a reverted path is refused with
//     `ExternalChangeError` for a change the SERVER made. Deleting the call left every test green.
describe('revert and the out-of-band-edit baselines', () => {
  it('lets an edit_file on a reverted path through, instead of refusing the server’s own change', async () => {
    const h = await setup({ 'main.tex': 'alpha\nbeta\n' });
    const sha = await commitInClone(h, { 'main.tex': 'alpha\nbeta\ngamma\n' }, 'add gamma');
    // `read_file` is what ARMS the guard: it records "the bytes the server last saw" for this
    // path — the post-commit ones, which the revert is about to change underneath it.
    const read = await h.client.callTool({
      name: 'read_file',
      arguments: { project: 'demo', path: 'main.tex' },
    });
    expect(isError(read)).toBe(false);

    const res = await h.client.callTool({
      name: 'revert',
      arguments: { project: 'demo', commits: [sha], confirm: true },
    });
    expect(isError(res)).toBe(false);
    expect(await readFile(path.join(h.clone, 'main.tex'), 'utf8')).toBe('alpha\nbeta\n');

    const edited = await h.client.callTool({
      name: 'edit_file',
      arguments: {
        project: 'demo',
        path: 'main.tex',
        edits: [{ oldString: 'alpha', newString: 'ALPHA' }],
      },
    });
    expect(isError(edited)).toBe(false);
    expect(plainText(edited)).not.toMatch(/changed on disk|externally/i);
    expect(await readFile(path.join(h.clone, 'main.tex'), 'utf8')).toBe('ALPHA\nbeta\n');
  });
});

// 20-23. `GitService.linksAmong` finds a link FOUR ways — mode 120000 in HEAD's tree, in a
//     reverted commit's tree or its parent's, an `lstat` on the path itself, and `linkedAncestor`
//     over its parent directories. The existing symlink test uses a path that is a link in all of
//     them at once, so each source could be deleted on its own with the suite still green. These
//     isolate them: in each case exactly ONE source can see the link.
describe.skipIf(process.platform === 'win32')('revert and each symlink source (posix only)', () => {
  it('refuses a link that only a reverted commit’s tree knows about', async () => {
    const h = await setup({ 'main.tex': 'alpha\n', 'real.tex': 'real\n' });
    // Commit A adds the link; commit B removes it again. At HEAD (= B) there is no `link.tex`,
    // A's parent has none, and the working tree has none — the only place it is mode 120000 is
    // A's own tree, so the `ls-tree` source is the only one that can fire.
    await symlink('real.tex', path.join(h.clone, 'link.tex'));
    await h.git.add('.');
    await h.git.commit('add link.tex -> real.tex');
    const addedLink = (await h.git.revparse(['HEAD'])).trim();
    await h.git.rm(['link.tex']);
    await h.git.commit('drop link.tex');
    expect(await exists(path.join(h.clone, 'link.tex'))).toBe(false);

    const outcome = await attempt(h.client, 'revert', {
      project: 'demo',
      commits: [addedLink],
      confirm: true,
    });

    expect(wasRefused(outcome)).toBe(true);
    expect(outcome.message).toContain('link.tex');
    expect(outcome.message).toMatch(/symbolic link/i);
    expect(outcome.message).not.toMatch(/not found/i);
    // Nothing was restored, and the clone is untouched.
    expect(await exists(path.join(h.clone, 'link.tex'))).toBe(false);
    expect((await porcelain(h.git)).trim()).toBe('');
  });

  it('refuses a link planted on disk where every tree has a regular file', async () => {
    const h = await setup({ 'main.tex': 'alpha\n' });
    const outside = await tmp('ovl-revert-outside-');
    const target = path.join(outside, 'target.txt');
    await writeFile(target, 'outside\n');
    const sha = await commitInClone(h, { 'main.tex': 'alpha\nbeta\n' }, 'add beta');

    // No tree anywhere calls `main.tex` a link, so only the path's own `lstat` can catch this —
    // and it must, because writing the reverted content here would write outside the project.
    await unlink(path.join(h.clone, 'main.tex'));
    await symlink(target, path.join(h.clone, 'main.tex'));

    const outcome = await attempt(h.client, 'revert', {
      project: 'demo',
      commits: [sha],
      confirm: true,
    });

    expect(wasRefused(outcome)).toBe(true);
    expect(outcome.message).toContain('main.tex');
    expect(outcome.message).toMatch(/symbolic link/i);
    // The LINK refusal, not the dirty-path one: precedence matters, because the dirty check would
    // send the caller to `discard`, which is not the problem here.
    expect(outcome.message).not.toMatch(/uncommitted changes/i);
    // The file outside the project was never written through.
    expect(await readFile(target, 'utf8')).toBe('outside\n');
    expect(await readlink(path.join(h.clone, 'main.tex'))).toBe(target);
  });

  it('refuses a path under a symlinked directory, which is a link nowhere itself', async () => {
    const h = await setup({ 'main.tex': 'alpha\n' });
    await commitInClone(h, { 'sub/a.tex': 'a\n' }, 'add sub/a.tex');
    const sha = await commitInClone(h, { 'sub/a.tex': 'a\nb\n' }, 'edit sub/a.tex');

    const outside = await tmp('ovl-revert-linkdir-');
    await mkdir(path.join(outside, 'real'), { recursive: true });
    await writeFile(path.join(outside, 'real', 'a.tex'), 'a\nb\n');
    // `sub/a.tex` is a regular file in every tree AND through the link on disk, so neither the
    // tree-mode check nor its own `lstat` fires. `linkedAncestor` is the only thing standing
    // between the revert and a write into a directory outside the project.
    await rm(path.join(h.clone, 'sub'), { recursive: true, force: true });
    await symlink(path.join(outside, 'real'), path.join(h.clone, 'sub'));
    expect((await lstat(path.join(h.clone, 'sub'))).isSymbolicLink()).toBe(true);
    expect((await lstat(path.join(h.clone, 'sub', 'a.tex'))).isSymbolicLink()).toBe(false);

    const outcome = await attempt(h.client, 'revert', {
      project: 'demo',
      commits: [sha],
      confirm: true,
    });

    expect(wasRefused(outcome)).toBe(true);
    expect(outcome.message).toContain('sub/a.tex');
    expect(outcome.message).toMatch(/symbolic link|lies under/i);
    // Byte-identical outside the project.
    expect(await readFile(path.join(outside, 'real', 'a.tex'), 'utf8')).toBe('a\nb\n');
  });

  it('refuses a .bib reached through an in-project link the literal name gate cannot see', async () => {
    const h = await setup({ 'main.tex': 'alpha\n', 'refs.bib': '@article{a, title={A}}\n' });
    // `notes.tex` points at the bibliography, and the reverted commit REPOINTS it — so the
    // touched set is `notes.tex` alone. `refs.bib` never appears in it, so the literal
    // `isBibFile` gate cannot see the bibliography at the far end at all: unlike
    // `write_file`/`edit_file`, `revert`'s .bib gate does not link-resolve. What protects the
    // bibliography here is the link refusal, and nothing else — so it is pinned here.
    await symlink('refs.bib', path.join(h.clone, 'notes.tex'));
    await h.git.add('.');
    await h.git.commit('add notes.tex -> refs.bib');
    await unlink(path.join(h.clone, 'notes.tex'));
    await symlink('main.tex', path.join(h.clone, 'notes.tex'));
    await h.git.add('.');
    await h.git.commit('repoint notes.tex -> main.tex');
    const sha = (await h.git.revparse(['HEAD'])).trim();

    // confirmBibEdit is deliberately NOT passed: it must not be what saves the bibliography, and
    // it must not be what the caller is told to set either.
    const outcome = await attempt(h.client, 'revert', {
      project: 'demo',
      commits: [sha],
      confirm: true,
    });

    expect(wasRefused(outcome)).toBe(true);
    expect(outcome.message).toContain('notes.tex');
    expect(outcome.message).toMatch(/symbolic link/i);
    // The bibliography is byte-unchanged and the link still points where it did.
    expect(await readFile(path.join(h.clone, 'refs.bib'), 'utf8')).toBe('@article{a, title={A}}\n');
    expect(await readlink(path.join(h.clone, 'notes.tex'))).toBe('main.tex');
    expect((await porcelain(h.git)).trim()).toBe('');
  });
});

// 24. A revert may be a session's FIRST mutation (`project_sync` -> `diff` -> `revert` touches
//     nothing else), and `SessionRegistry.touch` is the only thing that creates `session.json`
//     — `runExclusive`'s lock file does not. Without it this session owns a `shadow.json` with no
//     session record, `peers()` drops it, and a peer's `commit scope: "paths"` or `push` sweeps
//     up the reverted lines as owned by nobody. Deleting the `touch` call left every other test
//     green, including the heartbeat one, which injects a THROWING touch and so proves only the
//     decoupling, never that the call happens at all.
describe('revert as a session’s first mutation', () => {
  it('registers the session as live, so its reverted lines are not owned by nobody', async () => {
    const h = await setup({ 'main.tex': 'alpha\n' });
    const sha = await commitInClone(h, { 'main.tex': 'alpha\nbeta\n' }, 'add beta');
    const record = path.join(path.dirname(h.clone), '.sessions', 'demo', 'test', 'session.json');
    // The precondition, asserted rather than assumed: `project_sync` does not touch the registry,
    // so nothing has registered this session yet and the revert is genuinely its first mutation.
    expect(await exists(record)).toBe(false);

    const res = await h.client.callTool({
      name: 'revert',
      arguments: { project: 'demo', commits: [sha], confirm: true },
    });

    expect(isError(res)).toBe(false);
    expect(structured(res).status).toBe('reverted');
    expect(await exists(record)).toBe(true);
    const parsed = JSON.parse(await readFile(record, 'utf8')) as { sessionId?: string };
    expect(parsed.sessionId).toBe('test');
  });
});
