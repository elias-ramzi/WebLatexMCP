import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { simpleGit } from 'simple-git';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFakeRemote, type FakeRemote } from './helpers/bareRepo.js';
import { createContext } from '../../src/context.js';
import { createServer } from '../../src/server.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { GitService } from '../../src/services/gitService.js';
import type { ServerConfig } from '../../src/types.js';
import { expectDeclaredField, expectNoUndeclaredKeys } from '../helpers/outputSchema.js';
import {
  STATUS_COMMIT_MESSAGE_CAP,
  STATUS_COMMIT_TEXT_BUDGET,
  STATUS_CONTENT_BUDGET,
} from '../../src/lib/statusBudget.js';

/**
 * `status`'s `otherChanges`/`sessionChanges` split used to be built from `unstaged + untracked`
 * only (`src/tools/status.ts`), so a path dirty only in the index — someone ran `git add` by hand,
 * or an interrupted `commitContents` left it staged and nothing since touched the working tree —
 * was invisible to both. `commit.ts`'s `commitPaths` already rescues exactly this case for its own
 * dirty set (`status.staged` joins it, with the same reasoning), and the peer-refusal guard
 * (`guardPeerWork`, in `src/lib/peerRefusal.ts`, used by push) is documented as building its
 * disputed set "exactly as otherChanges is" — so the two had already drifted apart before this
 * fix. Harness copied from test/integration/pushAttribution.test.ts (real MCP client, a local bare
 * repo, no network).
 */

const REL = 'sections/method.tex';

const BASE = ['\\section{Method}', 'The first paragraph opens the method.', ''].join('\n');

const IDENTITY = { name: 'Test', email: 'test@example.com' };

interface Session {
  client: Client;
  close: () => Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup(): Promise<{
  remote: FakeRemote;
  dir: string;
  session: (id: string) => Promise<Session>;
}> {
  const remote = await createFakeRemote({ [REL]: BASE });
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-statusstaged-'));
  cleanups.push(remote.cleanup, () => rm(workspace, { recursive: true, force: true }));

  const baseConfig = {
    workspaceRoot: workspace,
    projects: [{ id: 'demo', gitUrl: remote.url }],
    defaultProject: 'demo',
  };
  const dir = path.join(workspace, 'demo');
  await new GitService(IDENTITY).clone(remote.url, dir, { username: 'git' });

  const session = async (id: string): Promise<Session> => {
    const config: ServerConfig = { ...baseConfig, sessionId: id };
    const ctx = createContext(config, new CredentialResolver({}), IDENTITY);
    const server = createServer(ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: `test-${id}`, version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const close = (): Promise<void> => client.close();
    cleanups.push(close);
    return { client, close };
  };

  return { remote, dir, session };
}

/** The whole result — both channels — because a budget that bounds only one is half a fix. */
async function callFull(
  session: Session,
  name: string,
  args: Record<string, unknown>,
): Promise<{ structured: Record<string, unknown>; text: string }> {
  const res = await session.client.callTool({ name, arguments: args });
  if (res.isError) throw new Error(`${name} failed: ${JSON.stringify(res.content)}`);
  const content = res.content as Array<{ type: string; text?: string }>;
  return {
    structured: res.structuredContent as Record<string, unknown>,
    text: content.map((c) => c.text ?? '').join('\n'),
  };
}

async function call<T = Record<string, unknown>>(
  session: Session,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  return (await callFull(session, name, args)).structured as T;
}

interface StatusOut {
  otherChanges: string[];
  sessionChanges: string[];
}

describe('status includes index-only (staged) changes', () => {
  it('reports a path staged by hand only (no unstaged diff) under otherChanges', async () => {
    const { dir, session } = await setup();
    const alpha = await session('alpha');

    // Modify a tracked file directly on disk, bypassing the server, and stage it with a plain
    // `git add` — nothing since touched the working tree, so `git status` shows it staged only.
    await writeFile(
      path.join(dir, REL),
      BASE.replace('opens the method.', 'opens the method, hand-edited.'),
      'utf8',
    );
    await simpleGit(dir).add([REL]);

    const status = await call<StatusOut>(alpha, 'status', {});

    expect(status.otherChanges).toContain(REL);
    expect(status.sessionChanges).not.toContain(REL);
  });

  it("attributes a staged-only path to sessionChanges when this session's own shadow owns it", async () => {
    const { dir, session } = await setup();
    const alpha = await session('alpha');

    // alpha edits the file through the server (its shadow now owns REL), then the same content is
    // staged by hand — moving it from "unstaged" to "staged only" in git's status, exactly the
    // case that was previously invisible to the split.
    await call(alpha, 'edit_file', {
      path: REL,
      edits: [
        {
          oldString: 'The first paragraph opens the method.',
          newString: 'The first paragraph opens the method, per alpha.',
        },
      ],
    });
    await simpleGit(dir).add([REL]);

    const status = await call<StatusOut>(alpha, 'status', {});

    expect(status.sessionChanges).toContain(REL);
    expect(status.otherChanges).not.toContain(REL);
  });

  it('dedupes a path that is both staged and unstaged (staged once, then edited again)', async () => {
    const { dir, session } = await setup();
    const alpha = await session('alpha');

    // Stage a hand edit, then make a further hand edit on top without staging it — the same path
    // is now both staged (git's index vs HEAD) and unstaged (working tree vs index).
    await writeFile(
      path.join(dir, REL),
      BASE.replace('opens the method.', 'opens the method, staged edit.'),
      'utf8',
    );
    await simpleGit(dir).add([REL]);
    await writeFile(
      path.join(dir, REL),
      BASE.replace('opens the method.', 'opens the method, staged edit, then unstaged edit.'),
      'utf8',
    );

    const status = await call<StatusOut>(alpha, 'status', {});

    const occurrences = status.otherChanges.filter((p) => p === REL);
    expect(occurrences).toHaveLength(1);
  });
});

/**
 * The payload budget (#175). `status` was the last document-controlled payload in the server with no
 * bound of any kind, and it ships every path list twice — as JSON and `join(', ')`ed into the result
 * text — so a working tree with a large untracked tree produced the #68 shape exactly: a result past
 * the client's cap, rejected undelivered, from the tool an agent calls first and most.
 *
 * These run against a real MCP client over a real clone, because the two things most likely to go
 * wrong are only visible there: whether the ADVERTISED schema declares every counter the handler now
 * emits (an undeclared key is a -32602 at the client and no result at all), and whether the commit
 * lists in `structuredContent` really did stay complete while their text rendering was cut.
 */

/** One untracked file per name, in one directory — the ordinary shape that blows `status` up. */
function figureNames(n: number): string[] {
  return Array.from(
    { length: n },
    (_, i) => `figures/ablation-${String(i).padStart(4, '0')}-seed-precision-recall-curve.pdf`,
  );
}

interface BudgetedStatus {
  branch: string;
  clean: boolean;
  ahead: number;
  behind: number;
  syncState: string;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  otherChanges: string[];
  sessionChanges: string[];
  conflictedChanges: string[];
  externalChanges: string[];
  behindCommits: Array<{ hash: string; message: string; files: unknown[] }>;
  aheadCommits: unknown[];
  truncated: boolean;
  activeSessionsOmitted: number;
  pathsOmitted?: Record<string, number>;
  note?: string;
}

describe('status bounds its payload', () => {
  it('cuts both channels for a large untracked tree, and accounts for exactly what went', async () => {
    const { dir, session } = await setup();
    const alpha = await session('alpha');
    const names = figureNames(400);
    await mkdir(path.join(dir, 'figures'), { recursive: true });
    for (const name of names) await writeFile(path.join(dir, name), 'x', 'utf8');

    const { structured, text } = await callFull(alpha, 'status', {});
    const out = structured as unknown as BudgetedStatus;

    // The whole result, in both channels. Unbudgeted this was ~110k characters — 400 paths of ~65
    // characters, in `untracked` and `otherChanges`, each rendered twice.
    const rendered = JSON.stringify(structured).length + text.length;
    expect(rendered).toBeLessThan(STATUS_CONTENT_BUDGET * 2);
    // Neither channel alone may carry it: bounding only the JSON would leave the text unchanged.
    expect(text.length).toBeLessThan(STATUS_CONTENT_BUDGET);

    // Counted, never cut silently, and the arithmetic closes on the true total.
    expect(out.truncated).toBe(true);
    expect(out.pathsOmitted).toBeDefined();
    const omitted = out.pathsOmitted!;
    expect(out.untracked.length + omitted.untracked!).toBe(400);
    expect(out.otherChanges.length + omitted.otherChanges!).toBe(400);
    expect(out.note).toContain('path(s) omitted');

    // No lane is starved: one untracked tree lands in `externalChanges`, `otherChanges` and
    // `untracked` at once, and each still comes back with a useful sample rather than the single
    // path keep-at-least-one would have forced under strict priority alone.
    expect(out.otherChanges.length).toBeGreaterThan(10);
    expect(out.untracked.length).toBeGreaterThan(10);
    expect(out.externalChanges.length).toBeGreaterThan(10);
    // The surplus still goes by allocation order, so what a caller cannot act safely without keeps
    // more than the merely informational list.
    expect(out.externalChanges.length).toBeGreaterThan(out.untracked.length);

    // A cut list is a prefix of git's own order — never reordered, never cherry-picked.
    expect(out.untracked).toEqual(names.slice(0, out.untracked.length));

    // The invariants the budget must not touch: these come from git, never from the report.
    expect(out.clean).toBe(false);
    expect(out.ahead).toBe(0);
    expect(out.behind).toBe(0);
    expect(out.syncState).toBe('in-sync');
    expect(out.branch).toBe('master');
  });

  it('keeps behindCommits COMPLETE in structuredContent while the text renders a bounded block', async () => {
    const { remote, dir, session } = await setup();
    const alpha = await session('alpha');

    // Forty upstream commits, each with a message far longer than anything a human writes — the
    // remote is document-controlled input, and `renderCommitLines` caps the commit COUNT but not
    // the size of what each one renders to.
    const message = 'Update on Overleaf. '.repeat(100);
    const upstream = await mkdtemp(path.join(os.tmpdir(), 'wlm-upstream-'));
    cleanups.push(() => rm(upstream, { recursive: true, force: true }));
    const git = simpleGit(upstream);
    await git.clone(remote.url, upstream);
    await git.addConfig('user.email', 'other@example.com');
    await git.addConfig('user.name', 'Other');
    for (let i = 0; i < 40; i += 1) {
      await writeFile(path.join(upstream, `upstream-${i}.tex`), `% commit ${i}\n`, 'utf8');
      await git.add('.');
      await git.commit(`${message}${i}`);
    }
    await git.push('origin', remote.branch);
    // Refresh the clone's remote-tracking ref without moving HEAD, so `status` is genuinely behind.
    await simpleGit(dir).fetch();

    const { structured, text } = await callFull(alpha, 'status', {});
    const out = structured as unknown as BudgetedStatus;

    // THE invariant. `conflictBudget.ts` caps a conflict's own `remoteCommits` and points the
    // caller at `status.behindCommits` for the full list, so capping it here — or clipping the
    // messages in it — would falsify that pointer and leave a caller mid-conflict with no complete
    // list anywhere.
    expect(out.behind).toBe(40);
    expect(out.behindCommits).toHaveLength(40);
    expect(out.behindCommits[0]!.message.length).toBeGreaterThan(STATUS_COMMIT_MESSAGE_CAP);

    // The text channel, however, is bounded — and says where the rest is.
    const block = text.slice(text.indexOf('landed upstream:\n') + 'landed upstream:\n'.length);
    expect(block.length).toBeLessThanOrEqual(STATUS_COMMIT_TEXT_BUDGET);
    expect(block).toContain('more commit(s) (see structuredContent)');
    // The clip is visible where it happened, rather than silently shortening a subject.
    expect(block).toContain('…');
  });

  it('declares every counter it now emits in the schema it advertises', async () => {
    const { dir, session } = await setup();
    const alpha = await session('alpha');
    await mkdir(path.join(dir, 'figures'), { recursive: true });
    for (const name of figureNames(400)) await writeFile(path.join(dir, name), 'x', 'utf8');

    const { structured } = await callFull(alpha, 'status', {});

    // Named pointers first, for the fields whose contract is the point...
    await expectDeclaredField(alpha.client, 'status', 'truncated', { required: true });
    await expectDeclaredField(alpha.client, 'status', 'activeSessionsOmitted', { required: true });
    await expectDeclaredField(alpha.client, 'status', 'pathsOmitted.untracked');
    await expectDeclaredField(alpha.client, 'status', 'activeSessions[].changesOmitted');
    await expectDeclaredField(alpha.client, 'status', 'behindCommits', {
      description: /never\s+capped/,
    });
    // ...and then the whole payload, which is the only check that can catch the key nobody thought
    // to ask about — the failure mode adding a budget is most likely to cause (-32602 at the
    // client, and no result at all).
    await expectNoUndeclaredKeys(alpha.client, 'status', structured);
    expect((structured as unknown as BudgetedStatus).truncated).toBe(true);
  });
});
