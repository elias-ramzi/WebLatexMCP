import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { simpleGit } from 'simple-git';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext, type AppContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import { GitService } from '../../src/services/gitService.js';
import { createFakeRemote, type FakeRemote } from './helpers/bareRepo.js';
import type { ServerConfig } from '../../src/types.js';

/** Commit the working tree by hand, the way an external `push`/user edit would — never through
 * the server's own commit machinery, so these tests exercise a real out-of-band commit. */
async function handCommit(dir: string, message: string): Promise<string> {
  const git = simpleGit(dir);
  await git.add(['-A']);
  await git.raw([
    '-c',
    'user.name=Hand',
    '-c',
    'user.email=hand@example.com',
    'commit',
    '-m',
    message,
  ]);
  return (await git.revparse(['HEAD'])).trim();
}

/**
 * Regression test for the "an unrecorded entry never settles" finding: `ShadowStore.markUnrecorded`
 * writes no base/shadow, and `record`'s conflicted early return means the shadow can never be
 * updated again while the flag is set — so once a further edit lands on disk (the session keeps
 * working, unaware its record failed), the shadow is permanently desynced from whatever eventually
 * reaches HEAD. `refresh`'s natural settle check (`bytesEqual(head, shadow)`) can then never fire,
 * so the entry lingers in the shadow store forever. `commit`'s default (session) scope refuses with
 * "could not be recorded"; the *documented* remedy, `scope: "all"`, commits the working tree — but
 * before this fix nothing ever told the shadow store that the taken path was settled, so the entry
 * stayed there, still `conflicted`, and the very next default-scope commit refused the exact same
 * way — permanently wedging the session out of its own default commit path for that project.
 * `ShadowStore.settle` (called by `commit` after a "all"/"paths" commit lands) fixes this: those
 * scopes take the working tree deliberately, so whatever the entry said is superseded by that act.
 *
 * Driven through the MCP client (real write_file/commit tools), with `ctx.shadows.markUnrecorded`
 * called directly to simulate the one failure mode this targets: a mutation whose bytes reached the
 * working tree but whose shadow record itself threw (see `src/lib/mutationRecorder.ts`, and its own
 * tests, for that failure path in isolation).
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
function textOf(res: unknown): string {
  return JSON.stringify((res as { content?: unknown }).content ?? '');
}

async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}

async function setup(
  seed: Record<string, string>,
): Promise<{ client: Client; ctx: AppContext; remote: FakeRemote }> {
  const remote = await createFakeRemote(seed);
  cleanups.push(remote.cleanup);
  const workspace = await tmp('ovl-unrecorded-ws-');
  const config: ServerConfig = {
    workspaceRoot: workspace,
    sessionId: 'test',
    projects: [{ id: 'demo', gitUrl: remote.url }],
    defaultProject: 'demo',
  };
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
  await client.callTool({ name: 'project_sync', arguments: { project: 'demo', mode: 'clone' } });
  return { client, ctx, remote };
}

const IDENTITY = { name: 'Test', email: 'test@example.com' };

/**
 * Two sessions sharing one clone (mirrors `multiSession.test.ts`'s `session()` helper) — needed
 * to produce a genuine same-line collision, which `setup()` above (a single session) cannot.
 */
async function setupTwoSessions(
  seed: Record<string, string>,
): Promise<{ session: (id: string) => Promise<{ client: Client; ctx: AppContext }> }> {
  const remote = await createFakeRemote(seed);
  cleanups.push(remote.cleanup);
  const workspace = await tmp('ovl-unrecorded-multi-ws-');
  const dir = path.join(workspace, 'demo');
  await new GitService(IDENTITY).clone(remote.url, dir, { username: 'git' });

  const session = async (id: string): Promise<{ client: Client; ctx: AppContext }> => {
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
    cleanups.push(() => client.close());
    return { client, ctx };
  };

  return { session };
}

describe('an unrecorded shadow entry settles once deliberately taken', () => {
  it('scope "all" unwedges the default commit path (main.tex)', async () => {
    const { client, ctx } = await setup({
      'main.tex': '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n',
    });

    const wrote = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'main.tex', content: 'Hello, edited.\n' },
    });
    expect(isError(wrote), textOf(wrote)).toBe(false);

    // Simulate the recorder's own failure path (touch/record threw after the write already
    // landed) — see mutationRecorder.test.ts for that path in isolation.
    await ctx.shadows.markUnrecorded('demo', 'main.tex');

    // A further edit lands on disk after the entry is flagged: `record`'s conflicted early return
    // (see ShadowStore.record) never updates the shadow while `conflicted` is set, so the shadow
    // is now permanently desynced from what actually ends up in HEAD once "all" commits the
    // *current* working tree. Without this second write the shadow happens to already equal what
    // gets committed and the bug does not reproduce (refresh's own bytesEqual check settles it by
    // coincidence) — this step is what makes the reproduction real.
    const wroteAfterFail = await client.callTool({
      name: 'write_file',
      arguments: {
        project: 'demo',
        path: 'main.tex',
        content: 'Hello, edited after the failure.\n',
      },
    });
    expect(isError(wroteAfterFail), textOf(wroteAfterFail)).toBe(false);

    // 1. Default scope refuses: every change is unrecorded, so it cannot be staged from the shadow.
    const blocked = await client.callTool({
      name: 'commit',
      arguments: { project: 'demo', message: 'try default' },
    });
    expect(isError(blocked), textOf(blocked)).toBe(true);
    expect(textOf(blocked)).toMatch(/could not be recorded/);

    // 2. The documented remedy: take the working tree as it stands with scope "all".
    const taken = await client.callTool({
      name: 'commit',
      arguments: { project: 'demo', message: 'take it', scope: 'all' },
    });
    expect(isError(taken), textOf(taken)).toBe(false);
    expect(structured(taken).committed).toBe(true);

    // The direct proof, and the one that actually distinguishes pre-/post-fix: does the shadow
    // store still hold *anything* for this session on this project after the deliberate take?
    // Pre-fix it does — main.tex's entry, still conflicted, never dropped — because nothing ever
    // told the store the taken path was settled; the only thing that could have cleared it,
    // `refresh`'s own `bytesEqual(head, shadow)` check, can never fire once the shadow is
    // permanently stale (see the comment on the second write above). Post-fix, `commit` calls
    // `ctx.shadows.clear(id)` for scope "all" with no `paths`, so nothing is left.
    expect(await ctx.shadows.hasChanges('demo')).toBe(false);

    // 3. The wedge, made concrete: a *fresh* edit should commit normally through the default
    // (session) scope. Pre-fix, main.tex's entry is still sitting in the store (still conflicted),
    // so this refuses exactly the same way step 1 did — permanently, for every future commit on
    // this project by this session.
    const wroteAgain = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'main.tex', content: 'Hello, edited again.\n' },
    });
    expect(isError(wroteAgain), textOf(wroteAgain)).toBe(false);

    const committedAgain = await client.callTool({
      name: 'commit',
      arguments: { project: 'demo', message: 'now it works' },
    });
    expect(isError(committedAgain), textOf(committedAgain)).toBe(false);
    expect(structured(committedAgain).committed).toBe(true);
  });

  it('scope "all" with a "."-shaped paths list settles what git committed', async () => {
    // `git add -- .` / `./figures` commit everything under them, but `coversPath` treats "." as
    // covering nothing — so without normalisation the entry survived a deliberate take.
    const { client, ctx } = await setup({
      'main.tex': '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n',
      'figures/a.tex': 'original\n',
    });
    for (const [spelling, file] of [
      ['.', 'main.tex'],
      ['./figures', 'figures/a.tex'],
    ] as const) {
      const wrote = await client.callTool({
        name: 'write_file',
        arguments: { project: 'demo', path: file, content: `edited for ${spelling}\n` },
      });
      expect(isError(wrote), textOf(wrote)).toBe(false);
      await ctx.shadows.markUnrecorded('demo', file);
      const again = await client.callTool({
        name: 'write_file',
        arguments: { project: 'demo', path: file, content: `edited again for ${spelling}\n` },
      });
      expect(isError(again), textOf(again)).toBe(false);

      const taken = await client.callTool({
        name: 'commit',
        arguments: {
          project: 'demo',
          message: `take ${spelling}`,
          scope: 'all',
          paths: [spelling],
        },
      });
      expect(isError(taken), textOf(taken)).toBe(false);
      expect(structured(taken).conflicted).toEqual([]);
      expect(await ctx.shadows.hasChanges('demo'), spelling).toBe(false);
    }
  });

  it('scope "paths" settles an unrecorded entry under the covering directory', async () => {
    const { client, ctx } = await setup({
      'main.tex': '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n',
      'figures/a.tex': 'original\n',
    });

    const wrote = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'figures/a.tex', content: 'edited\n' },
    });
    expect(isError(wrote), textOf(wrote)).toBe(false);

    await ctx.shadows.markUnrecorded('demo', 'figures/a.tex');

    // See the sibling test above: a further edit after the flag is what actually desyncs the
    // shadow from what "paths" ends up committing (the shadow can no longer be updated while
    // `conflicted` is set — ShadowStore.record's early return).
    const wroteAfterFail = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'figures/a.tex', content: 'edited after failure\n' },
    });
    expect(isError(wroteAfterFail), textOf(wroteAfterFail)).toBe(false);

    const taken = await client.callTool({
      name: 'commit',
      arguments: {
        project: 'demo',
        message: 'take figures directory',
        scope: 'paths',
        paths: ['figures'],
      },
    });
    expect(isError(taken), textOf(taken)).toBe(false);
    expect(structured(taken).committed).toBe(true);
    expect(structured(taken).conflicted).toEqual([]);
    expect(textOf(taken)).not.toMatch(/excluded/);

    // Directory coverage: settle drops the entry even though `paths` named the directory, not the
    // exact file the entry tracks.
    expect(await ctx.shadows.hasChanges('demo')).toBe(false);
  });

  it('reports `unrecorded` as a subset of `conflicted` in structuredContent', async () => {
    const { client, ctx } = await setup({
      'main.tex': '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n',
      'notes.tex': 'original\n',
    });

    // main.tex: a normal, committable session edit.
    const wroteMain = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'main.tex', content: 'Hello, edited.\n' },
    });
    expect(isError(wroteMain), textOf(wroteMain)).toBe(false);

    // notes.tex: force the unrecorded failure mode (see the first test above for why the second
    // write matters — it is what actually desyncs the shadow from what ends up committed).
    const wroteNotes = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'notes.tex', content: 'edited\n' },
    });
    expect(isError(wroteNotes), textOf(wroteNotes)).toBe(false);
    await ctx.shadows.markUnrecorded('demo', 'notes.tex');
    const wroteNotesAgain = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'notes.tex', content: 'edited again\n' },
    });
    expect(isError(wroteNotesAgain), textOf(wroteNotesAgain)).toBe(false);

    // Default (session) scope commits main.tex and leaves notes.tex excluded — this is a
    // successful commit, not a refusal, so the result's structuredContent is what a caller reads.
    const committed = await client.callTool({
      name: 'commit',
      arguments: { project: 'demo', message: 'commit main.tex, leave notes.tex excluded' },
    });
    expect(isError(committed), textOf(committed)).toBe(false);
    const sc = structured(committed);
    expect(sc.conflicted).toEqual(['notes.tex']);
    // The field this test exists for: pre-fix, `unrecorded` is absent from structuredContent
    // entirely (the schema's description said "see the result text for which", which a
    // structured-only client cannot act on).
    expect(sc.unrecorded).toEqual(['notes.tex']);
    expect((sc.unrecorded as string[]).every((p) => (sc.conflicted as string[]).includes(p))).toBe(
      true,
    );
  });

  it('names both clauses when a commit excludes a collided file and an unrecorded file together', async () => {
    const REL_COLLIDE = 'sections/x.tex';
    const { session } = await setupTwoSessions({
      [REL_COLLIDE]: 'A sentence to collide on.\n',
      'notes.tex': 'original\n',
    });
    const alpha = await session('alpha');
    const beta = await session('beta');

    // beta rewrites the sentence first (its shadow now expects the base line as prior content).
    const editBeta = await beta.client.callTool({
      name: 'edit_file',
      arguments: {
        project: 'demo',
        path: REL_COLLIDE,
        edits: [
          { oldString: 'A sentence to collide on.', newString: 'Beta rewrites the sentence.' },
        ],
      },
    });
    expect(isError(editBeta), textOf(editBeta)).toBe(false);

    // alpha then rewrites the very same line, on the shared working tree beta just changed —
    // exactly the sequence multiSession.test.ts's collision test uses (there for session "B"):
    // alpha's own recorded shadow still expects the *original* line as its base, so the mutation
    // recorder's three-way merge of alpha's change against that base conflicts, and the entry is
    // flagged rather than guessed at.
    const editAlpha = await alpha.client.callTool({
      name: 'edit_file',
      arguments: {
        project: 'demo',
        path: REL_COLLIDE,
        edits: [
          { oldString: 'Beta rewrites the sentence.', newString: 'Alpha rewrites the sentence.' },
        ],
      },
    });
    expect(isError(editAlpha), textOf(editAlpha)).toBe(false);

    // alpha also edits notes.tex, then forces the unrecorded failure mode on it.
    const wroteNotes = await alpha.client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'notes.tex', content: 'edited\n' },
    });
    expect(isError(wroteNotes), textOf(wroteNotes)).toBe(false);
    await alpha.ctx.shadows.markUnrecorded('demo', 'notes.tex');
    const wroteNotesAgain = await alpha.client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'notes.tex', content: 'edited again\n' },
    });
    expect(isError(wroteNotesAgain), textOf(wroteNotesAgain)).toBe(false);

    // alpha's default-scope commit now excludes both files, for two different reasons — the
    // wording must name each file under the right clause, not lump them into one.
    const blocked = await alpha.client.callTool({
      name: 'commit',
      arguments: { project: 'demo', message: 'alpha tries to commit' },
    });
    expect(isError(blocked), textOf(blocked)).toBe(true);
    const text = textOf(blocked);
    // Each file is named under its own clause, not lumped together under the wrong one.
    expect(text).toMatch(/notes\.tex could not be recorded/);
    expect(text).toMatch(new RegExp(`changed the same lines of.*${REL_COLLIDE}`));
  });
});

/**
 * Regression tests for issue #66 item 2: an `unrecorded`/`conflicted` shadow entry whose working
 * tree already equals HEAD (a `push` with `message` committed it, or a hand revert) has no exit
 * before this fix. `scope: "session"` refuses ("could not be recorded", naming scope "all" as the
 * remedy); `scope: "all"` and `scope: "paths"` both refuse too, because `GitService.commit`
 * throws "Nothing to commit (no staged changes)" (or, for "paths", `commitPaths` refuses even
 * earlier with "Nothing to commit at: ... not changed in the working tree") before the handler
 * ever reaches its post-commit `settle`/`clear` step — leaving only `discard` or an empty junk
 * commit (`scope: "all", allowEmpty: true`) as a way out. Each test below asserts the *pre-fix*
 * failure in a comment, and was run against the pre-fix `commit.ts` to confirm it actually failed
 * there for the stated reason before the fix landed.
 */
describe('a wedged entry settles when the working tree already matches HEAD (issue #66 item 2)', () => {
  it('scope "all" settles the record without a commit when a hand commit already landed the content', async () => {
    const { client, ctx } = await setup({
      'main.tex': '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n',
    });
    const dir = ctx.projectManager.projectPath('demo');

    const wrote = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'main.tex', content: 'Hello, edited.\n' },
    });
    expect(isError(wrote), textOf(wrote)).toBe(false);
    await ctx.shadows.markUnrecorded('demo', 'main.tex');

    // A hand commit takes the current working tree (mirrors a `push` with `message` landing it,
    // or an out-of-band commit made outside this server) — HEAD now equals the working tree.
    const handSha = await handCommit(dir, 'hand-committed while wedged');

    // Pre-fix: this call throws "Nothing to commit (no staged changes)." — `git add -A` stages
    // nothing because the working tree already equals HEAD, and the handler never reaches its
    // settle/clear step because the error is thrown before that point.
    const taken = await client.callTool({
      name: 'commit',
      arguments: { project: 'demo', message: 'settle it', scope: 'all' },
    });
    expect(isError(taken), textOf(taken)).toBe(false);
    const sc = structured(taken);
    expect(sc.committed).toBe(false);
    expect(sc.settled).toEqual(['main.tex']);
    expect(sc.sha).toBe(handSha);
    expect(sc.filesChanged).toBe(0);
    expect(await ctx.shadows.hasChanges('demo')).toBe(false);

    // A further default-scope commit, with nothing left to settle and nothing dirty, errors with
    // the plain git wording — not "could not be recorded" (the entry is gone), and not a
    // settlement (there is nothing left this session tracks).
    const again = await client.callTool({
      name: 'commit',
      arguments: { project: 'demo', message: 'try default again' },
    });
    expect(isError(again), textOf(again)).toBe(true);
    expect(textOf(again)).toMatch(/Nothing to commit \(no staged changes\)/);
    expect(textOf(again)).not.toMatch(/could not be recorded/);
    expect(await ctx.shadows.changes('demo')).toEqual([]);
  });

  it('scope "paths" naming the wedged file settles it the same way', async () => {
    const { client, ctx } = await setup({
      'main.tex': '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n',
    });
    const dir = ctx.projectManager.projectPath('demo');

    const wrote = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'main.tex', content: 'Hello, edited.\n' },
    });
    expect(isError(wrote), textOf(wrote)).toBe(false);
    await ctx.shadows.markUnrecorded('demo', 'main.tex');
    const handSha = await handCommit(dir, 'hand-committed while wedged');

    // Pre-fix: `commitPaths` refuses even before reaching git, with "Nothing to commit at:
    // main.tex — not changed in the working tree" — the working tree has nothing dirty at that
    // path once the hand commit landed it, and pre-fix nothing consulted the shadow store to see
    // that this session still (stale-)tracks exactly that path.
    const taken = await client.callTool({
      name: 'commit',
      arguments: { project: 'demo', message: 'settle it', scope: 'paths', paths: ['main.tex'] },
    });
    expect(isError(taken), textOf(taken)).toBe(false);
    const sc = structured(taken);
    expect(sc.committed).toBe(false);
    expect(sc.settled).toEqual(['main.tex']);
    expect(sc.sha).toBe(handSha);
    expect(await ctx.shadows.hasChanges('demo')).toBe(false);
  });

  it('a hand revert (no new commit) settles the same way under scope "paths"', async () => {
    const { client, ctx } = await setup({
      'main.tex': '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n',
    });
    const dir = ctx.projectManager.projectPath('demo');
    const headBefore = (await simpleGit(dir).revparse(['HEAD'])).trim();
    const original = await ctx.git.showAtRef(dir, 'HEAD', 'main.tex');

    const wrote = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'main.tex', content: 'Hello, edited.\n' },
    });
    expect(isError(wrote), textOf(wrote)).toBe(false);
    await ctx.shadows.markUnrecorded('demo', 'main.tex');

    // Revert the working tree by hand to HEAD's content — no new commit, HEAD is unchanged.
    const overwritten = await client.callTool({
      name: 'write_file',
      arguments: {
        project: 'demo',
        path: 'main.tex',
        content: original,
        overrideExternalChanges: true,
      },
    });
    expect(isError(overwritten), textOf(overwritten)).toBe(false);

    const taken = await client.callTool({
      name: 'commit',
      arguments: { project: 'demo', message: 'settle it', scope: 'paths', paths: ['main.tex'] },
    });
    expect(isError(taken), textOf(taken)).toBe(false);
    const sc = structured(taken);
    expect(sc.committed).toBe(false);
    expect(sc.settled).toEqual(['main.tex']);
    expect(sc.sha).toBe(headBefore);
    expect(await ctx.shadows.hasChanges('demo')).toBe(false);
  });

  it('a landed commit reports `settled` too, alongside `committed: true`', async () => {
    const { client, ctx } = await setup({
      'main.tex': '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n',
    });

    const wrote = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'main.tex', content: 'Hello, edited.\n' },
    });
    expect(isError(wrote), textOf(wrote)).toBe(false);
    await ctx.shadows.markUnrecorded('demo', 'main.tex');

    const taken = await client.callTool({
      name: 'commit',
      arguments: { project: 'demo', message: 'take it', scope: 'all' },
    });
    expect(isError(taken), textOf(taken)).toBe(false);
    const sc = structured(taken);
    expect(sc.committed).toBe(true);
    expect(sc.settled).toEqual(['main.tex']);
  });

  it('never claims a settlement just outside the guard', async () => {
    const { client, ctx } = await setup({
      'main.tex': '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n',
      'other.tex': 'untouched\n',
    });
    const dir = ctx.projectManager.projectPath('demo');

    // (a) scope "all" on a clean tree with no shadow entries at all: still a plain refusal.
    const cleanAll = await client.callTool({
      name: 'commit',
      arguments: { project: 'demo', message: 'nothing here', scope: 'all' },
    });
    expect(isError(cleanAll), textOf(cleanAll)).toBe(true);
    expect(textOf(cleanAll)).toMatch(/Nothing to commit \(no staged changes\)/);

    // (b) scope "paths" naming a clean path this session never tracked: still refused by name.
    const cleanPaths = await client.callTool({
      name: 'commit',
      arguments: { project: 'demo', message: 'nothing here', scope: 'paths', paths: ['other.tex'] },
    });
    expect(isError(cleanPaths), textOf(cleanPaths)).toBe(true);
    expect(textOf(cleanPaths)).toMatch(/Nothing to commit at:/);

    // (c) wedge main.tex, then request only the untouched other.tex under scope "paths": still
    // refused by name, and main.tex's entry is left exactly as it was — a request that never
    // covered it settles nothing.
    const wrote = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'main.tex', content: 'Hello, edited.\n' },
    });
    expect(isError(wrote), textOf(wrote)).toBe(false);
    await ctx.shadows.markUnrecorded('demo', 'main.tex');
    await handCommit(dir, 'hand-committed while wedged');

    const namedElsewhere = await client.callTool({
      name: 'commit',
      arguments: { project: 'demo', message: 'nothing here', scope: 'paths', paths: ['other.tex'] },
    });
    expect(isError(namedElsewhere), textOf(namedElsewhere)).toBe(true);
    expect(textOf(namedElsewhere)).toMatch(/Nothing to commit at: other\.tex/);
    expect(await ctx.shadows.hasChanges('demo')).toBe(true);
    const remaining = await ctx.shadows.changes('demo');
    expect(remaining.map((c) => c.path)).toEqual(['main.tex']);
  });

  it('scope "all" with a paths list that covers nothing this session tracks rethrows plainly', async () => {
    // Regression test for the `dropped.length === 0` rethrow branch in the handler's catch (the
    // `settle(taken)` arm): a request whose `paths` never covers what this session tracks must
    // not claim a settlement it didn't make, and must leave the untouched wedge exactly as it was.
    const { client, ctx } = await setup({
      'main.tex': '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n',
      'other.tex': 'untouched\n',
    });

    await ctx.shadows.markUnrecorded('demo', 'main.tex');

    const result = await client.callTool({
      name: 'commit',
      arguments: {
        project: 'demo',
        message: 'try all with unrelated paths',
        scope: 'all',
        paths: ['other.tex'],
      },
    });
    expect(isError(result), textOf(result)).toBe(true);
    expect(textOf(result)).toMatch(/Nothing to commit \(no staged changes\)/);

    const remaining = await ctx.shadows.changes('demo');
    expect(remaining.map((c) => c.path)).toEqual(['main.tex']);
  });

  it('the "could not be recorded" refusal names the exact discard remedy', async () => {
    const { client, ctx } = await setup({
      'main.tex': '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n',
    });

    const wrote = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'main.tex', content: 'Hello, edited.\n' },
    });
    expect(isError(wrote), textOf(wrote)).toBe(false);
    await ctx.shadows.markUnrecorded('demo', 'main.tex');
    const wroteAgain = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'main.tex', content: 'Hello, edited again.\n' },
    });
    expect(isError(wroteAgain), textOf(wroteAgain)).toBe(false);

    const blocked = await client.callTool({
      name: 'commit',
      arguments: { project: 'demo', message: 'try default' },
    });
    expect(isError(blocked), textOf(blocked)).toBe(true);
    const text = textOf(blocked);
    expect(text).toMatch(/could not be recorded/);
    expect(text).toMatch(/discard/);
    expect(text).toMatch(/confirm: true/);
  });
});
