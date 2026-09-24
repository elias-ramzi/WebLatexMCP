import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry, readProjectRegistry } from '../../src/services/projectRegistry.js';
import { createFakeRemote } from './helpers/bareRepo.js';
import { GitService } from '../../src/services/gitService.js';
import type { FileService } from '../../src/services/fileService.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * "File paths are always POSIX (`/`-separated), on every OS" — the first line of docs/tools.md,
 * repeated in CLAUDE.md. `register_project` and `list_projects` were the two emitters PR #98 did
 * not own, and `register_project` contradicted itself inside one ternary
 * (`path: local ? toPosix(dir) : dir`): the same output field of the same tool came back POSIX for
 * a local project and native for a git one.
 *
 * The harness is the one from `test/integration/toolPathsPosix.test.ts`, for the same reason: on
 * Windows `path.sep` is genuinely `'\\'` and nothing has to be arranged, while on Linux and macOS
 * the conversion is the identity and every assertion would pass against the unfixed code. So the
 * server's own paths are made to contain a literal backslash (legal in a POSIX filename — see
 * `SEGMENT`) and the tool call runs inside `withWindowsSep`, which stubs `path.sep` over the
 * narrowest possible window. Patching `path.sep` does not disturb `path.join`/`resolve`/`relative`
 * — their POSIX implementations use a literal `'/'` internally — so real filesystem work keeps
 * working while the server's own `toPosix`/`toPosixOut` genuinely convert.
 *
 * What the POSIX'd value must NEVER reach is asserted directly rather than inferred: `git clone`
 * and `FileService.resetBaselines` are spied on and must be handed the host's own spelling, and
 * the `ProjectConfig` persisted to the workspace registry must keep it too, since that value is
 * read back and handed to `fs` in every later session.
 */

const cleanups: Array<() => Promise<unknown>> = [];

/**
 * Load Node's async recursive-remove implementation BEFORE any test stubs `path.sep`; see the
 * same warm-up in `test/integration/toolPathsPosix.test.ts`. `internal/fs/rimraf` captures
 * `path.sep` once, at module load, and is loaded lazily on the first recursive `fs.rm` — which a
 * tool call inside the stub window performs (`withFileLock` removes its lock file that way).
 * Loading it while the stub is live breaks recursive removal for every test in this worker.
 */
beforeAll(async () => {
  await rm(path.join(os.tmpdir(), 'web-latex-mcp-rimraf-warmup-does-not-exist'), {
    recursive: true,
    force: true,
  });
});

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const WINDOWS = process.platform === 'win32';

/**
 * The directory segment every path under test runs through. On POSIX a literal backslash is a
 * legal filename character, so this is what gives the stubbed separator something to convert. On
 * Windows a backslash cannot appear in a filename, and does not need to: the separators between
 * the real segments are already backslashes there.
 */
const SEGMENT = WINDOWS ? 'outdir' : 'out\\dir';

/** What the server must return for a native path, once the separator is converted. */
function posixOf(native: string): string {
  return native.split('\\').join('/');
}

/** Run `fn` with `path.sep` stubbed to a backslash, restoring the real descriptor in a `finally`. */
async function withWindowsSep<T>(fn: () => Promise<T>): Promise<T> {
  if (WINDOWS) return await fn();
  const original = Object.getOwnPropertyDescriptor(path, 'sep');
  Object.defineProperty(path, 'sep', { value: '\\', configurable: true, writable: true });
  try {
    return await fn();
  } finally {
    if (original) Object.defineProperty(path, 'sep', original);
  }
}

function textOf(res: unknown): string {
  const content = (res as { content?: Array<{ text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? '').join('\n');
}

function pathOf(res: unknown): string {
  return (res as { structuredContent: { path: string } }).structuredContent.path;
}

/** Windows keeps transient locks on freshly-used .git files, so retry the teardown. */
const rmDir = (dir: string): Promise<void> =>
  rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

interface Harness {
  client: Client;
  /** The workspace root, whose last segment is `SEGMENT` — so every clone dir carries it. */
  workspace: string;
  /** Every `targetDir` `GitService.clone` was handed, in call order. */
  cloneDirs: string[];
  /** Every directory `FileService.resetBaselines` was handed, in call order. */
  resetDirs: string[];
}

async function setup(): Promise<Harness> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'ovl-posixproj-'));
  cleanups.push(() => rmDir(base));
  // The workspace root itself ends in the backslash-bearing segment, so `projectPath` —
  // `<workspaceRoot>/<id>` for a git project — carries it into every clone dir the tools report.
  const workspace = path.join(base, SEGMENT);
  await mkdir(workspace, { recursive: true });

  const config: ServerConfig = { workspaceRoot: workspace, sessionId: 'test', projects: [] };
  const ctx = createContext(
    config,
    new CredentialResolver({}),
    { name: 'Test', email: 'test@example.com' },
    new ProjectRegistry(workspace),
  );

  // Spy without replacing: the real clone still runs, so a conversion moved above it would also
  // fail outright (git would be pointed at a directory whose parent does not exist). The recorded
  // arguments are what make the failure specific rather than incidental.
  const cloneDirs: string[] = [];
  const realClone = ctx.git.clone.bind(ctx.git);
  ctx.git.clone = async (...args: Parameters<GitService['clone']>): Promise<void> => {
    cloneDirs.push(args[1]);
    await realClone(...args);
  };
  const resetDirs: string[] = [];
  const realReset = ctx.files.resetBaselines.bind(ctx.files);
  ctx.files.resetBaselines = (...args: Parameters<FileService['resetBaselines']>): void => {
    resetDirs.push(args[0]);
    realReset(...args);
  };

  const server = createServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  // unshift, not push: close the client before the directories it was pointed at are removed.
  cleanups.unshift(() => client.close());
  return { client, workspace, cloneDirs, resetDirs };
}

/** A directory already on this machine, whose own basename carries the backslash segment. */
async function localProjectDir(): Promise<string> {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'ovl-posixlocal-'));
  cleanups.push(() => rmDir(parent));
  const dir = path.join(parent, SEGMENT);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'main.tex'),
    '\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n',
    'utf8',
  );
  return dir;
}

async function fakeRemoteUrl(): Promise<string> {
  const remote = await createFakeRemote();
  cleanups.push(() => remote.cleanup());
  return remote.url;
}

describe('register_project: paths at the response boundary', () => {
  it('returns a cloned git project’s path with POSIX separators, in both channels', async () => {
    const { client, workspace } = await setup();
    const url = await fakeRemoteUrl();
    const nativeDir = path.join(workspace, 'paper');

    const res = await withWindowsSep(() =>
      client.callTool({
        name: 'register_project',
        arguments: { project: 'paper', gitUrl: url },
      }),
    );

    expect(res.isError ?? false).toBe(false);
    expect(pathOf(res)).toBe(posixOf(nativeDir));
    expect(pathOf(res)).not.toContain('\\');
    const text = textOf(res);
    expect(text).toContain(`Cloned at ${posixOf(nativeDir)}.`);
    expect(text).not.toContain(nativeDir);
  });

  it('clones into, and resets baselines for, the NATIVE directory', async () => {
    // The consumer proof. `GitService.clone` spawns git and `FileService.resetBaselines` resolves
    // against the revision tracker's own (native) keys, so both must be handed the host's
    // spelling: the conversion belongs strictly BELOW them, at the response boundary.
    const { client, workspace, cloneDirs, resetDirs } = await setup();
    const url = await fakeRemoteUrl();
    const nativeDir = path.join(workspace, 'paper');

    const res = await withWindowsSep(() =>
      client.callTool({
        name: 'register_project',
        arguments: { project: 'paper', gitUrl: url },
      }),
    );

    expect(res.isError ?? false).toBe(false);
    expect(cloneDirs).toEqual([nativeDir]);
    expect(resetDirs).toEqual([nativeDir]);
    if (!WINDOWS) {
      // Spelled out so the failure is legible on the legs where the separator is stubbed: the
      // literal backslash in the directory NAME must have survived into both calls.
      expect(cloneDirs[0]).toContain('\\');
      expect(resetDirs[0]).toContain('\\');
    }
  });

  it('returns a local project’s path POSIX while persisting the NATIVE one', async () => {
    const { client, workspace } = await setup();
    const nativeDir = await localProjectDir();

    const res = await withWindowsSep(() =>
      client.callTool({
        name: 'register_project',
        arguments: { project: 'draft', path: nativeDir },
      }),
    );

    expect(res.isError ?? false).toBe(false);
    expect(pathOf(res)).toBe(posixOf(nativeDir));
    const text = textOf(res);
    expect(text).toContain(`Registered "draft" -> ${posixOf(nativeDir)} (local`);
    expect(text).not.toContain(nativeDir);

    // The `ProjectConfig` guard: the registry entry is read back and handed to `fs` in every
    // later session, so it must keep the host's own spelling whatever the response said.
    const stored = readProjectRegistry(workspace).find((p) => p.id === 'draft');
    expect(stored).toBeDefined();
    expect((stored as { path?: string }).path).toBe(nativeDir);
    if (!WINDOWS) expect((stored as { path?: string }).path).toContain('\\');
  });

  it('returns a POSIX path from the default-only form, for a git project', async () => {
    // The exact `local ? toPosix(dir) : dir` ternary: this branch reported a local project's path
    // POSIX and a git project's native, from one field of one tool.
    const { client, workspace } = await setup();
    await client.callTool({
      name: 'register_project',
      arguments: { project: 'paper', gitUrl: 'https://git.overleaf.com/abc', clone: false },
    });
    const nativeDir = path.join(workspace, 'paper');

    const res = await withWindowsSep(() =>
      client.callTool({
        name: 'register_project',
        arguments: { project: 'paper', default: true },
      }),
    );

    expect(res.isError ?? false).toBe(false);
    expect(pathOf(res)).toBe(posixOf(nativeDir));
    expect(pathOf(res)).not.toContain('\\');
  });
});

interface ListedProject {
  project: string;
  path: string;
}

function listedProjects(res: unknown): ListedProject[] {
  return (res as { structuredContent: { projects: ListedProject[] } }).structuredContent.projects;
}

describe('list_projects: paths at the response boundary', () => {
  it('returns every path POSIX and names the same spelling in the text', async () => {
    const { client, workspace } = await setup();
    const nativeLocalDir = await localProjectDir();
    const nativeCloneDir = path.join(workspace, 'paper');
    await client.callTool({
      name: 'register_project',
      arguments: { project: 'paper', gitUrl: 'https://git.overleaf.com/abc', clone: false },
    });
    await client.callTool({
      name: 'register_project',
      arguments: { project: 'draft', path: nativeLocalDir },
    });

    const res = await withWindowsSep(() =>
      client.callTool({ name: 'list_projects', arguments: {} }),
    );

    expect(res.isError ?? false).toBe(false);
    const listed = listedProjects(res);
    expect(listed.map((p) => p.project).sort()).toEqual(['draft', 'paper']);
    const byId = new Map(listed.map((p) => [p.project, p.path]));
    expect(byId.get('paper')).toBe(posixOf(nativeCloneDir));
    expect(byId.get('draft')).toBe(posixOf(nativeLocalDir));

    const text = textOf(res);
    for (const p of listed) {
      expect(p.path).not.toContain('\\');
      // One converted array feeds both channels, so the text line carries the identical string.
      expect(text).toContain(`-> ${p.path}`);
    }
    expect(text).not.toContain(nativeCloneDir);
    expect(text).not.toContain(nativeLocalDir);
  });
});

describe('project_sync: paths at the response boundary', () => {
  it('returns the clone path POSIX, and clones into the NATIVE directory', async () => {
    // Found by the review of this change, not by the issue: #99 names three emitters and
    // `project_sync` is a fourth. It matters more than a fourth entry sounds, because it reports
    // the SAME directory `register_project` does — so before this, one server spelled one
    // project's directory two ways across two calls, which is the exact defect #99 is about.
    const { client, workspace, cloneDirs, resetDirs } = await setup();
    const url = await fakeRemoteUrl();
    const nativeDir = path.join(workspace, 'paper');

    // Registered WITHOUT cloning, so the clone happens inside the `project_sync` call below and
    // its consumer arguments are attributable to this tool rather than to registration.
    await client.callTool({
      name: 'register_project',
      arguments: { project: 'paper', gitUrl: url, clone: false },
    });
    cloneDirs.length = 0;
    resetDirs.length = 0;

    const res = await withWindowsSep(() =>
      client.callTool({ name: 'project_sync', arguments: { project: 'paper' } }),
    );

    expect(res.isError ?? false).toBe(false);
    expect(pathOf(res)).toBe(posixOf(nativeDir));
    expect(pathOf(res)).not.toContain('\\');
    // The consumer proof, same shape as register_project's: `GitService.clone` spawns git at that
    // directory, so the conversion must sit below it.
    expect(cloneDirs).toEqual([nativeDir]);
    if (!WINDOWS) expect(cloneDirs[0]).toContain('\\');
  });
});

/**
 * `status` and `commit` — the second half of #148, and a different shape of the same rule.
 *
 * Both tools return several path lists, and before this some went through `toPosix` and some did
 * not (`status`'s `sessionChanges` did, its `staged`/`unstaged`/`untracked`/`externalChanges`/
 * `conflictedChanges`/`activeSessions[].changes` did not; `commit`'s `leftUncommitted` did, its
 * `files`/`conflicted`/`unrecorded`/`ignored`/`settled` did not), so one result could carry two
 * spellings of the same kind of data.
 *
 * What is testable here is narrower than the change, and the boundary is worth stating exactly:
 *
 *  - A list sourced from **git** (`staged`/`unstaged`/`untracked`, `files`, `conflictPaths`,
 *    every `revert` list) is already `/`-separated on every platform, and the only way to put a
 *    backslash in one is a filename literally containing one — which git C-quotes
 *    (`"out\\dir/notes.tex"`), so it never arrives as a separator anyway. Converting those is a
 *    no-op by construction; no assertion about them can fail, and none is written below.
 *  - A list sourced from the **shadow store** can be made to carry one, because a shadow key is
 *    a project-relative path this server composed, and it is read back out of a file another
 *    server process wrote. Those are the two lists asserted here, and they do fail against the
 *    unfixed code.
 *
 * Non-vacuous on the POSIX legs only, and by nature rather than by omission: a relative path on
 * Windows has no backslash in it to begin with, which is the mirror image of the absolute-path
 * tests above (where Windows is the real thing and POSIX needs the stub). The assertions still
 * run there, they just cannot discriminate — the two `if (!WINDOWS)` guards below mark exactly
 * where that is true.
 */

const IDENTITY = { name: 'Test', email: 'test@example.com' };

/** A project-relative path whose DIRECTORY name carries the backslash segment. */
const REL = `${SEGMENT}/notes.tex`;

interface GitHarness {
  /** Open a client for one session id, over the shared clone — as two agent sessions would. */
  session: (id: string) => Promise<Client>;
}

async function gitSessions(): Promise<GitHarness> {
  const remote = await createFakeRemote({ 'main.tex': 'x\n' });
  cleanups.push(() => remote.cleanup());
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-posixlists-'));
  cleanups.push(() => rmDir(workspace));
  const dir = path.join(workspace, 'demo');
  await new GitService(IDENTITY).clone(remote.url, dir, { username: 'git' });

  const session = async (id: string): Promise<Client> => {
    const config: ServerConfig = {
      workspaceRoot: workspace,
      sessionId: id,
      projects: [{ id: 'demo', gitUrl: remote.url }],
      defaultProject: 'demo',
    };
    const ctx = createContext(config, new CredentialResolver({}), IDENTITY);
    const server = createServer(ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: `test-${id}`, version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.unshift(() => client.close());
    return client;
  };
  return { session };
}

async function writeUnderSegment(client: Client, content: string): Promise<void> {
  const res = await client.callTool({
    name: 'write_file',
    arguments: { project: 'demo', path: REL, content, createDirs: true },
  });
  expect(res.isError ?? false).toBe(false);
}

interface StatusOut {
  activeSessions: Array<{ session: string; changes: string[] | null }>;
}

function statusOut(res: unknown): StatusOut {
  return (res as { structuredContent: StatusOut }).structuredContent;
}

describe('status: path lists at the response boundary', () => {
  it('reports a peer session’s changed paths with POSIX separators, in both channels', async () => {
    // `activeSessions[].changes` is read out of the PEER's `shadow.json` — a file another server
    // process wrote — so it is exactly the kind of value the boundary conversion is for.
    const { session } = await gitSessions();
    const mine = await session('sess-a');
    const peer = await session('sess-b');
    await writeUnderSegment(peer, 'peer line\n');

    const res = await withWindowsSep(() =>
      mine.callTool({ name: 'status', arguments: { project: 'demo' } }),
    );
    expect(res.isError ?? false).toBe(false);

    const out = statusOut(res);
    const listed = out.activeSessions.find((p) => p.session === 'sess-b');
    expect(listed).toBeDefined();
    expect(listed?.changes).toEqual([posixOf(REL)]);
    const text = textOf(res);
    // One converted value feeds both channels, so the peer line names the identical string.
    expect(text).toContain(posixOf(REL));
    if (!WINDOWS) {
      // Where the assertions above discriminate: the shadow key genuinely holds a backslash, so
      // the converted spelling differs from the raw one. On Windows a relative path has no
      // backslash to convert and both spellings are the same string — hence the guard.
      expect(REL).toContain('\\');
      expect(listed?.changes?.[0]).not.toContain('\\');
      expect(text).not.toContain(REL);
    }
  });
});

interface CommitOut {
  committed: boolean;
  settled: string[];
}

function commitOut(res: unknown): CommitOut {
  return (res as { structuredContent: CommitOut }).structuredContent;
}

describe('commit: path lists at the response boundary', () => {
  it('reports settled paths with POSIX separators', async () => {
    // `settled` is the shadow spelling of every entry a deliberate scope "all" take dropped
    // (`ShadowStore.settle`), so it comes from this session's own index rather than from git.
    const { session } = await gitSessions();
    const mine = await session('sess-a');
    await writeUnderSegment(mine, 'my line\n');

    const res = await withWindowsSep(() =>
      mine.callTool({
        name: 'commit',
        arguments: { project: 'demo', message: 'add a note', scope: 'all' },
      }),
    );
    expect(res.isError ?? false).toBe(false);

    const out = commitOut(res);
    expect(out.committed).toBe(true);
    expect(out.settled).toEqual([posixOf(REL)]);
    if (!WINDOWS) {
      expect(REL).toContain('\\');
      expect(out.settled[0]).not.toContain('\\');
    }
  });
});
