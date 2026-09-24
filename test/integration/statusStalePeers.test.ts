import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFakeRemote, type FakeRemote } from './helpers/bareRepo.js';
import { createContext } from '../../src/context.js';
import { createServer } from '../../src/server.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { GitService } from '../../src/services/gitService.js';
import { sessionDir } from '../../src/lib/sessionPaths.js';
import { RECENT_HEARTBEAT_GRACE_MS } from '../../src/lib/peerSummary.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * `status` collapses a dead, change-free peer session into a count instead of listing it forever.
 *
 * A session record is only deleted on a clean shutdown (`SessionRegistry.release()`), so a killed
 * agent process leaves its record behind — `activeSessions` used to grow without bound with dead
 * sessions holding nothing. This is report-level only: nothing on disk is reaped (that would race
 * a peer's own in-flight `record()` and destroy the ownership proof `commit scope: "paths"`/`push`
 * depend on) — see `src/lib/peerSummary.ts`.
 *
 * A peer is faked "dead" the same way test/integration/multiSession.test.ts does it: register it
 * (a `status` call, or an edit, to create its session/shadow files), then hand-edit its
 * `session.json` to an unreachable pid and a heartbeat well past stale.
 */

const REL = 'sections/method.tex';
const BASE = ['\\section{Method}', 'The first paragraph opens the method.', ''].join('\n');
const IDENTITY = { name: 'Test', email: 'test@example.com' };

interface Session {
  client: Client;
  close: () => Promise<void>;
}

describe('status collapses stale, change-free peer sessions', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  async function setup(): Promise<{
    remote: FakeRemote;
    dir: string;
    workspace: string;
    session: (id: string) => Promise<Session>;
  }> {
    const remote = await createFakeRemote({ [REL]: BASE });
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-stalepeers-'));
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

    return { remote, dir, workspace, session };
  }

  async function call<T = Record<string, unknown>>(
    session: Session,
    name: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    const res = await session.client.callTool({ name, arguments: args });
    if (res.isError) throw new Error(`${name} failed: ${JSON.stringify(res.content)}`);
    return res.structuredContent as T;
  }

  /**
   * Overwrites a session's own `session.json` so it reads as dead: no live pid, stale heartbeat.
   *
   * `ageMs` is how long ago it last heartbeated, and it is load-bearing for every collapse
   * assertion in this file. Dead is not enough: `status` only collapses a dead, empty peer once it
   * has ALSO been quiet for `RECENT_HEARTBEAT_GRACE_MS`, because an empty shadow index cannot
   * distinguish "recorded nothing" from "the index write failed". The 60 minutes this helper used
   * to hardcode is dead (past `SessionRegistry`'s 30-minute `STALE_MS`) but comfortably INSIDE
   * that grace, so it would keep every such peer listed. The default is derived from the constant
   * rather than spelled out, so this file cannot drift out from under it if the window changes;
   * a caller that wants a dead-but-recent peer passes something strictly under it.
   */
  async function killSession(
    workspace: string,
    sessionId: string,
    ageMs: number = RECENT_HEARTBEAT_GRACE_MS * 2,
  ): Promise<void> {
    const recordPath = path.join(sessionDir(workspace, 'demo', sessionId), 'session.json');
    const record = JSON.parse(await readFile(recordPath, 'utf8')) as Record<string, unknown>;
    await writeFile(
      recordPath,
      JSON.stringify(
        {
          ...record,
          pid: 999999999,
          heartbeatAt: new Date(Date.now() - ageMs).toISOString(),
        },
        null,
        2,
      ),
      'utf8',
    );
  }

  interface ActiveSession {
    session: string;
    live: boolean;
    changes: string[] | null;
  }

  interface StatusOut {
    activeSessions: ActiveSession[];
    staleSessions: number;
  }

  it('still prints the other-sessions line when every peer is stale, so they do not vanish', async () => {
    const { workspace, session } = await setup();
    const alpha = await session('alpha');
    const beta = await session('beta');
    // Register both peers, then kill them holding nothing: the "none shown, some stale" branch,
    // where dropping the line entirely would report zero other sessions when two records exist.
    await call(beta, 'status', { project: 'demo' });
    await call(alpha, 'status', { project: 'demo' });
    await killSession(workspace, 'beta');

    const out = await call<StatusOut>(alpha, 'status', { project: 'demo' });
    expect(out.activeSessions).toHaveLength(0);
    expect(out.staleSessions).toBe(1);

    const res = await alpha.client.callTool({ name: 'status', arguments: { project: 'demo' } });
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    expect(text).toMatch(/other sessions: 1 session exited with nothing recorded/);
  });

  it('drops a dead+empty peer into staleSessions, keeps a dead-with-entries and an unreadable peer listed, and keeps a live-empty peer listed', async () => {
    const { workspace, session } = await setup();
    const alpha = await session('alpha');

    // Dead, and holds nothing: just a heartbeat, no edits ever recorded.
    const deadEmpty = await session('dead-empty');
    await call(deadEmpty, 'status', {});

    // Dead, but holds a real change — its last-known edit still matters.
    const deadEntries = await session('dead-entries');
    await call(deadEntries, 'edit_file', {
      path: REL,
      edits: [
        {
          oldString: 'The first paragraph opens the method.',
          newString: 'The first paragraph opens the method, per dead-entries.',
        },
      ],
    });

    // Dead, and its shadow index is corrupt — unreadable, never "owns nothing".
    const deadUnreadable = await session('dead-unreadable');
    await call(deadUnreadable, 'status', {});
    const shadowFile = path.join(sessionDir(workspace, 'demo', 'dead-unreadable'), 'shadow.json');
    await mkdir(path.dirname(shadowFile), { recursive: true });
    await writeFile(shadowFile, 'not json', 'utf8');

    // Live, but holds nothing yet — must never be collapsed, it may write any moment.
    const liveEmpty = await session('live-empty');
    await call(liveEmpty, 'status', {});

    await killSession(workspace, 'dead-empty');
    await killSession(workspace, 'dead-entries');
    await killSession(workspace, 'dead-unreadable');
    // live-empty is deliberately left alone — its pid is this very test process, so it reads live.

    const status = await call<StatusOut>(alpha, 'status', {});

    const byId = new Map(status.activeSessions.map((s) => [s.session, s]));
    expect(byId.has('dead-empty')).toBe(false);
    expect(byId.get('dead-entries')).toMatchObject({ live: false, changes: [REL] });
    expect(byId.get('dead-unreadable')).toMatchObject({ live: false, changes: null });
    expect(byId.get('live-empty')).toMatchObject({ live: true, changes: [] });

    // Only dead-empty is stale: dead-unreadable is NOT counted, since unreadable is never treated
    // as "owns nothing".
    expect(status.staleSessions).toBe(1);

    const res = await alpha.client.callTool({ name: 'status', arguments: {} });
    const text = (res.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n');
    expect(text).toMatch(/1 session exited with nothing recorded/);

    // The guard against "improving" this into a reaper. `status` takes no lock and `live` is
    // merely DERIVED, so deleting a peer's state while it races its own `record()` destroys the
    // ownership proof `commit scope: "paths"` and `push` refuse on. `SessionRegistry` has two
    // removal shapes and BOTH must stay uncalled from here — asserting only on the directory
    // catches one of them:
    //   - `collectGarbage()` rm's the whole session directory, recursively;
    //   - `release()` rm's only `session.json` and leaves the directory standing. That is the
    //     likelier reaper (someone answering "stale records grow without bound" by deleting the
    //     records `status` already knows are stale), and the more damaging one: the peer then
    //     vanishes from `peers()` entirely, its `shadow.json` is orphaned, and its dirty
    //     working-tree lines become unattributable — a peer that was only *derived* dead loses
    //     its ownership proof, silently.
    // So assert the files, not just the directory.
    for (const id of ['dead-empty', 'dead-entries', 'dead-unreadable', 'live-empty']) {
      const dir = sessionDir(workspace, 'demo', id);
      const st = await stat(dir).catch(() => null);
      expect(
        st?.isDirectory() ?? false,
        `status reaped ${id}'s session directory — it must never reap (collectGarbage-shaped)`,
      ).toBe(true);
      const record = await stat(path.join(dir, 'session.json')).catch(() => null);
      expect(
        record?.isFile() ?? false,
        `status deleted ${id}'s session.json — it must never reap (release-shaped): without the ` +
          'record the peer vanishes from peers(), its shadow is orphaned, and its lines become ' +
          'unattributable',
      ).toBe(true);
    }
    // Only the two sessions that actually have a shadow index are checked: `dead-empty` and
    // `live-empty` never wrote one (that ENOENT is exactly why they read back as `[]`), so
    // asserting one for them would be an assertion that can never hold.
    for (const id of ['dead-entries', 'dead-unreadable']) {
      const shadow = await stat(path.join(sessionDir(workspace, 'demo', id), 'shadow.json')).catch(
        () => null,
      );
      expect(
        shadow?.isFile() ?? false,
        `status deleted ${id}'s shadow.json — a peer's shadow index is its ownership proof and ` +
          'status must never remove it',
      ).toBe(true);
    }
    // And the corrupt index is left corrupt: a "repair the unreadable index" cleanup would turn
    // `entries: null` (unreadable) into `[]` (owns nothing), which is the one inference this
    // codebase refuses to make.
    expect(
      await readFile(
        path.join(sessionDir(workspace, 'demo', 'dead-unreadable'), 'shadow.json'),
        'utf8',
      ),
      'status rewrote dead-unreadable\'s corrupt shadow index — unreadable must stay unreadable, never be "repaired" into "owns nothing"',
    ).toBe('not json');
  });

  /**
   * The recent-heartbeat exemption (issue #78, finding 3).
   *
   * `ShadowStore.peerEntries` maps ENOENT and a readable-but-empty index to the same `[]`, so an
   * empty index cannot distinguish "this session recorded nothing" from "this session's index
   * write failed and its dirty lines are sitting in the working tree unattributed". While the
   * death is recent the peer therefore stays NAMED in `activeSessions`, so a human reading
   * `otherChanges` still has a suspect for those lines; once it has been quiet past
   * `RECENT_HEARTBEAT_GRACE_MS` the collapse from #75 takes over again, which is what keeps
   * `activeSessions` bounded. Both halves are asserted here so the test discriminates rather than
   * merely showing that nothing ever collapses.
   */
  it('keeps a dead peer listed while its heartbeat is recent, and collapses one past the grace', async () => {
    const { workspace, session } = await setup();
    const alpha = await session('alpha');

    // Dead, holding nothing, but quiet for only half the grace — dead by `STALE_MS` (30 minutes),
    // not yet old enough for "holds no changes" to be a safe claim.
    const justQuiet = await session('just-quiet');
    await call(justQuiet, 'status', {});
    await killSession(workspace, 'just-quiet', RECENT_HEARTBEAT_GRACE_MS / 2);

    const first = await call<StatusOut>(alpha, 'status', {});
    expect(
      new Map(first.activeSessions.map((s) => [s.session, s])).get('just-quiet'),
    ).toMatchObject({ live: false, changes: [] });
    expect(first.staleSessions).toBe(0);

    const firstRes = await alpha.client.callTool({ name: 'status', arguments: {} });
    const firstText = (firstRes.content as Array<{ text?: string }>)
      .map((c) => c.text ?? '')
      .join('\n');
    expect(firstText).not.toMatch(/exited with nothing recorded/);
    // And POSITIVELY: the preserved peer must be rendered as holding nothing *recorded*, not as
    // holding no changes. A negative assertion alone passes while the text channel says the very
    // thing the schema and the docs were narrowed to stop asserting — which is exactly how this
    // gap survived the first round: `peerDetail` spelled the same claim differently, so the
    // `not.toMatch` above was satisfied by a line reading `just-quiet (gone; no changes)`. Keeping
    // the two channels pinned together is the whole point.
    expect(firstText).toMatch(/just-quiet \(gone; nothing recorded\)/);
    expect(firstText).not.toMatch(/no changes/);

    // Same shape of peer, but long dead: the collapse #75 exists for still happens.
    const longDead = await session('long-dead');
    await call(longDead, 'status', {});
    await killSession(workspace, 'long-dead');

    const second = await call<StatusOut>(alpha, 'status', {});
    const byId = new Map(second.activeSessions.map((s) => [s.session, s]));
    expect(byId.has('long-dead')).toBe(false);
    expect(byId.get('just-quiet')).toMatchObject({ live: false, changes: [] });
    expect(second.staleSessions).toBe(1);
  });

  it('pluralizes the stale count and joins it onto the peers still shown', async () => {
    const { workspace, session } = await setup();
    const alpha = await session('alpha');

    // Two peers that register and then die holding nothing: the plural branch of
    // `session${n === 1 ? '' : 's'}`, which one stale session can never reach.
    for (const id of ['dead-empty-one', 'dead-empty-two']) {
      const peer = await session(id);
      await call(peer, 'status', {});
    }

    // One peer that stays shown, so the combined ", and N sessions exited with nothing recorded" join
    // is exercised rather than only the standalone clause.
    const holder = await session('holder');
    await call(holder, 'edit_file', {
      path: REL,
      edits: [
        {
          oldString: 'The first paragraph opens the method.',
          newString: 'The first paragraph opens the method, per holder.',
        },
      ],
    });

    await killSession(workspace, 'dead-empty-one');
    await killSession(workspace, 'dead-empty-two');
    // holder is deliberately left alive — its pid is this very test process.

    const status = await call<StatusOut>(alpha, 'status', {});
    expect(status.staleSessions).toBe(2);
    expect(status.activeSessions.map((s) => s.session)).toEqual(['holder']);

    const res = await alpha.client.callTool({ name: 'status', arguments: {} });
    const text = (res.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n');
    expect(text).toMatch(
      /other sessions: holder \([^)]*\), and 2 sessions exited with nothing recorded/,
    );
  });
});
