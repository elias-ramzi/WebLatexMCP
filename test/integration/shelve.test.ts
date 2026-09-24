import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readFile, writeFile, stat, mkdir, readdir, symlink } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { simpleGit } from 'simple-git';
import { createFakeRemote, type FakeRemote } from './helpers/bareRepo.js';
import { createContext } from '../../src/context.js';
import { createServer } from '../../src/server.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { GitService } from '../../src/services/gitService.js';
import { SessionRegistry } from '../../src/services/sessionRegistry.js';
import { ShadowStore } from '../../src/services/shadowStore.js';
import { sessionStateDir } from '../../src/lib/sessionPaths.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * `shelve` / `unshelve` / `list_shelves` end to end (issue #86), driven through a real MCP client
 * against a real git clone of a local bare repo — no network, no secrets.
 *
 * The unit layers already cover the id, the manifest, the store and the git probes in isolation.
 * What only this layer can show is the part the feature is actually judged on: that the work
 * leaves the tree, survives outside the clone, and comes back byte-identical — and that every
 * refusal leaves BOTH sides untouched.
 */

const REL = 'sections/method.tex';
const BASE = ['\\section{Method}', 'The opening line.', ''].join('\n');
const IDENTITY = { name: 'Test', email: 'test@example.com' };

/** Probed by actually attempting one, at COLLECTION time, so `describe.skipIf` can mark the
 *  block visibly skipped rather than a `beforeAll` flag turning its tests into silent passes.
 *  Same shape as test/unit/shelveGit.test.ts and as test/smoke/** gating on latexmk. */
const symlinksWork = await (async () => {
  const probe = await mkdtemp(path.join(os.tmpdir(), 'wlm-shelve-symprobe-'));
  try {
    await writeFile(path.join(probe, 'target.txt'), 'x');
    await symlink('target.txt', path.join(probe, 'link.txt'));
    return true;
  } catch {
    return false;
  } finally {
    await rm(probe, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
})();

interface Session {
  client: Client;
  sessionId: string;
}

describe('shelve / unshelve / list_shelves', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  async function setup(files: Record<string, string> = { [REL]: BASE }): Promise<{
    remote: FakeRemote;
    dir: string;
    workspace: string;
    session: (id: string) => Promise<Session>;
  }> {
    const remote = await createFakeRemote(files);
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-shelve-'));
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
      cleanups.unshift(() => client.close());
      return { client, sessionId: id };
    };

    return { remote, dir, workspace, session };
  }

  async function call<T = Record<string, unknown>>(
    s: Session,
    name: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    const res = await s.client.callTool({ name, arguments: args });
    if (res.isError) throw new Error(`${name} failed: ${JSON.stringify(res.content)}`);
    return res.structuredContent as T;
  }

  /** The refusal's TEXT, not `JSON.stringify(content)`: the latter escapes every quote, so an
   *  assertion for a quoted session id silently never matches what the server actually said. */
  async function callExpectingError(
    s: Session,
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const res = await s.client.callTool({ name, arguments: args });
    expect(res.isError, `${name} was expected to fail`).toBe(true);
    return ((res.content ?? []) as Array<{ text?: string }>).map((b) => b.text ?? '').join('\n');
  }

  const read = (dir: string, rel: string): Promise<string> => readFile(path.join(dir, rel), 'utf8');
  const absent = async (dir: string, rel: string): Promise<boolean> =>
    stat(path.join(dir, rel)).then(
      () => false,
      () => true,
    );

  describe('the round trip', () => {
    it('takes a modification out of the tree and brings it back byte-identical', async () => {
      const { dir, session } = await setup();
      const s = await session('a');
      await call(s, 'write_file', { path: REL, content: `${BASE}A new sentence.\n` });

      const shelved = await call<{ shelf: { id: string; files: unknown[] }; restored: string[] }>(
        s,
        'shelve',
        { paths: [REL], label: 'mid-sentence' },
      );
      expect(shelved.shelf.id).toMatch(/^sh-[0-9a-f]{8}$/);
      expect(shelved.restored).toEqual([REL]);
      // The whole point: the tree is back at HEAD, so a push can now rebase.
      expect(await read(dir, REL)).toBe(BASE);

      const back = await call<{ restored: boolean }>(s, 'unshelve', { id: shelved.shelf.id });
      expect(back.restored).toBe(true);
      expect(await read(dir, REL)).toBe(`${BASE}A new sentence.\n`);
    });

    it('removes an untracked file and restores it, with lines counted from the bytes taken', async () => {
      const { dir, session } = await setup();
      const s = await session('a');
      await call(s, 'write_file', { path: 'notes.tex', content: 'one\ntwo\nthree\n' });

      const shelved = await call<{
        shelf: { id: string; files: Array<{ path: string; status: string; added: number }> };
      }>(s, 'shelve', { paths: ['notes.tex'] });
      const entry = shelved.shelf.files[0]!;
      expect(entry.status).toBe('added');
      // An untracked file never appears in `git diff HEAD`, so this count can only come from the
      // bytes shelve actually took. A zero here would mean the count was quietly made up.
      expect(entry.added).toBe(3);
      expect(await absent(dir, 'notes.tex')).toBe(true);

      await call(s, 'unshelve', { id: shelved.shelf.id });
      expect(await read(dir, 'notes.tex')).toBe('one\ntwo\nthree\n');
    });

    it('restores a deletion as a deletion', async () => {
      const { dir, session } = await setup({ [REL]: BASE, 'extra.tex': 'gone soon\n' });
      const s = await session('a');
      await call(s, 'delete_file', { path: 'extra.tex' });

      const shelved = await call<{ shelf: { id: string; files: Array<{ status: string }> } }>(
        s,
        'shelve',
        { paths: ['extra.tex'] },
      );
      expect(shelved.shelf.files[0]!.status).toBe('deleted');
      // Shelving a deletion puts HEAD's copy back...
      expect(await read(dir, 'extra.tex')).toBe('gone soon\n');
      // ...and unshelving it deletes the file again, rather than restoring empty bytes.
      await call(s, 'unshelve', { id: shelved.shelf.id });
      expect(await absent(dir, 'extra.tex')).toBe(true);
    });

    it('records a text file as TEXT, so a later peer edit still three-way merges', async () => {
      const { workspace, session } = await setup();
      const s = await session('a');
      await call(s, 'write_file', { path: REL, content: `${BASE}restored\n` });
      const shelved = await call<{ shelf: { id: string } }>(s, 'shelve', { paths: [REL] });
      await call(s, 'unshelve', { id: shelved.shelf.id });

      const index = JSON.parse(
        await readFile(path.join(sessionStateDir(workspace, 'demo'), 'a', 'shadow.json'), 'utf8'),
      ) as { entries: Record<string, { binary?: boolean }> };
      // Assert the entry EXISTS before asserting anything about it. Reading the wrong level of
      // this file made `index[REL]?.binary ?? false` come back false for an absent entry, so the
      // test passed against the unfixed code — the exact shape of vacuous assertion the rest of
      // this suite is written to avoid.
      expect(Object.keys(index.entries)).toContain(REL);
      // `ShadowStore.record` sets a STICKY binary flag for any Buffer argument, and a binary
      // entry is NEVER three-way merged. Handing it the shelf's raw Buffer therefore turned
      // every ordinary .tex into a file where a peer editing a different paragraph produces a
      // permanent `conflicted` entry instead of a silent merge — diagnosable only by reading
      // this file. `revert` avoids it with the same transform; unshelve had skipped it.
      expect(index.entries[REL]!.binary ?? false).toBe(false);
    });

    it('a successful unshelve removes the shelf; list_shelves shows it before and not after', async () => {
      const { session } = await setup();
      const s = await session('a');
      await call(s, 'write_file', { path: REL, content: `${BASE}x\n` });
      const shelved = await call<{ shelf: { id: string } }>(s, 'shelve', { paths: [REL] });

      const before = await call<{ shelves: Array<{ id: string; label: string | null }> }>(
        s,
        'list_shelves',
        {},
      );
      expect(before.shelves.map((x) => x.id)).toEqual([shelved.shelf.id]);
      expect(before.shelves[0]!.label).toBeNull();

      await call(s, 'unshelve', { id: shelved.shelf.id });
      // An outstanding-shelf list that still lists a reclaimed one is the stash@{0} problem
      // with extra steps.
      expect((await call<{ shelves: unknown[] }>(s, 'list_shelves', {})).shelves).toEqual([]);
    });
  });

  describe('refusals leave both sides exactly as they were', () => {
    it('refuses to unshelve over a dirty tree, writes nothing, and keeps the shelf', async () => {
      const { dir, session } = await setup();
      const s = await session('a');
      await call(s, 'write_file', { path: REL, content: `${BASE}shelved edit\n` });
      const shelved = await call<{ shelf: { id: string } }>(s, 'shelve', { paths: [REL] });
      // Someone (or this session) works on the same file again after the shelve.
      await call(s, 'write_file', { path: REL, content: `${BASE}a different, live edit\n` });

      const res = await s.client.callTool({
        name: 'unshelve',
        arguments: { id: shelved.shelf.id },
      });
      // A refusal is NOT a tool error: it is a reported outcome with both sides in it, the way
      // push reports a conflict.
      expect(res.isError ?? false).toBe(false);
      const out = res.structuredContent as {
        restored: boolean;
        conflicts: Array<{ path: string; reason: string; ours: string; theirs: string }>;
        conflictPaths: string[];
      };
      expect(out.restored).toBe(false);
      expect(out.conflicts[0]!.reason).toBe('dirty');
      expect(out.conflicts[0]!.ours).toBe(`${BASE}a different, live edit\n`);
      expect(out.conflicts[0]!.theirs).toBe(`${BASE}shelved edit\n`);
      expect(out.conflictPaths).toEqual([REL]);

      // Nothing written...
      expect(await read(dir, REL)).toBe(`${BASE}a different, live edit\n`);
      // ...and the shelf is intact, which is what makes every elided byte recoverable.
      expect(
        (await call<{ shelves: Array<{ id: string }> }>(s, 'list_shelves', {})).shelves[0]!.id,
      ).toBe(shelved.shelf.id);
    });

    it('refuses when HEAD moved under the shelved path, and says head-moved rather than dirty', async () => {
      const { dir, session, remote } = await setup();
      const s = await session('a');
      await call(s, 'write_file', { path: REL, content: `${BASE}shelved edit\n` });
      const shelved = await call<{ shelf: { id: string } }>(s, 'shelve', { paths: [REL] });

      // A commit lands on the same file, so the shelved edit no longer applies to the content it
      // was made against. The tree is CLEAN here, which is what separates this from the case
      // above: without a head-moved check this would restore and silently drop the new line.
      const git = new GitService(IDENTITY);
      await writeFile(path.join(dir, REL), `${BASE}a committed line.\n`);
      await git.commit(dir, { message: 'upstream work', paths: [REL] });
      expect((await git.status(dir)).clean).toBe(true);

      const res = await s.client.callTool({
        name: 'unshelve',
        arguments: { id: shelved.shelf.id },
      });
      const out = res.structuredContent as {
        restored: boolean;
        conflicts: Array<{ reason: string; base: string; ours: string }>;
      };
      expect(out.restored).toBe(false);
      expect(out.conflicts[0]!.reason).toBe('head-moved');
      // base is what the shelved edit was made against, ours is what is there now.
      expect(out.conflicts[0]!.base).toBe(BASE);
      expect(out.conflicts[0]!.ours).toBe(`${BASE}a committed line.\n`);
      expect(await read(dir, REL)).toBe(`${BASE}a committed line.\n`);
      void remote;
    });

    it('does NOT call a HEAD that moved elsewhere a conflict', async () => {
      const { dir, session } = await setup({ [REL]: BASE, 'other.tex': 'untouched\n' });
      const s = await session('a');
      await call(s, 'write_file', { path: REL, content: `${BASE}shelved edit\n` });
      const shelved = await call<{ shelf: { id: string } }>(s, 'shelve', { paths: [REL] });

      // HEAD advances, but not under the shelved path. Comparing against the manifest's recorded
      // headSha rather than per-file content would refuse this, wrongly.
      const git = new GitService(IDENTITY);
      await writeFile(path.join(dir, 'other.tex'), 'changed elsewhere\n');
      await git.commit(dir, { message: 'unrelated', paths: ['other.tex'] });

      const back = await call<{ restored: boolean }>(s, 'unshelve', { id: shelved.shelf.id });
      expect(back.restored).toBe(true);
      expect(await read(dir, REL)).toBe(`${BASE}shelved edit\n`);
    });

    it('refuses a path that is not changed in the working tree, and shelves nothing', async () => {
      const { dir, session } = await setup();
      const s = await session('a');
      await call(s, 'write_file', { path: REL, content: `${BASE}real edit\n` });

      const err = await callExpectingError(s, 'shelve', { paths: [REL, 'never-touched.tex'] });
      expect(err).toContain('never-touched.tex');
      expect(err).toContain('not changed in the working tree');
      // The refusal is all-or-nothing: the path that WAS dirty is still dirty.
      expect(await read(dir, REL)).toBe(`${BASE}real edit\n`);
      expect((await call<{ shelves: unknown[] }>(s, 'list_shelves', {})).shelves).toEqual([]);
    });

    it('refuses a STAGED path rather than reporting a shelve that did not happen', async () => {
      const { dir, session } = await setup();
      const s = await session('a');
      await call(s, 'write_file', { path: REL, content: `${BASE}staged work\n` });
      await simpleGit(dir).add([REL]);

      const err = await callExpectingError(s, 'shelve', { paths: [REL] });
      expect(err).toContain('Staged');
      // Pre-fix this returned success: `discard`'s path branch then checked out from the INDEX,
      // not HEAD, so the staged content stayed in the tree. The push this tool exists to unblock
      // still refused, the work was duplicated into a shelf, and unshelve then saw a dirty tree
      // — so the shelf could never be reclaimed without a hand `git reset`.
      expect(await read(dir, REL)).toBe(`${BASE}staged work\n`);
      expect((await call<{ shelves: unknown[] }>(s, 'list_shelves', {})).shelves).toEqual([]);
    });

    it('refuses a STAGED new file, which clean -f cannot remove either', async () => {
      const { dir, session } = await setup();
      const s = await session('a');
      await call(s, 'write_file', { path: 'brandnew.tex', content: 'new\n' });
      await simpleGit(dir).add(['brandnew.tex']);

      const err = await callExpectingError(s, 'shelve', { paths: ['brandnew.tex'] });
      expect(err).toContain('Staged');
      expect(await read(dir, 'brandnew.tex')).toBe('new\n');
    });

    it('folds case on the dirty check, so an ignorecase clone does not fail open', async () => {
      // `core.ignorecase` forced explicitly, the way test/integration/caseFoldCommit.test.ts
      // does it: it is git's DEFAULT on macOS and Windows and false on the Linux box this gate
      // runs on, so an assertion not driven through it passes against unfixed code — the same
      // vacuity trap as asserting POSIX paths where path.sep is already "/".
      //
      // GitService.isCaseInsensitive reads the clone's config, never the filesystem (CLAUDE.md
      // is explicit that this is the source of truth), so forcing it exercises the real
      // decision path even on a case-sensitive disk.
      const { dir, session } = await setup();
      await simpleGit(dir).raw(['config', 'core.ignorecase', 'true']);
      const s = await session('a');

      await call(s, 'write_file', { path: 'notes.tex', content: 'shelved\n' });
      const shelved = await call<{ shelf: { id: string } }>(s, 'shelve', { paths: ['notes.tex'] });

      // Live work lands under the other spelling. `git status` reports what is on disk, so an
      // unfolded lookup for the shelf's `notes.tex` finds nothing and the restore proceeds.
      await writeFile(path.join(dir, 'Notes.tex'), 'live work under the other spelling\n');

      const res = await s.client.callTool({
        name: 'unshelve',
        arguments: { id: shelved.shelf.id },
      });
      const out = res.structuredContent as { restored: boolean; conflicts?: Array<unknown> };
      expect(out.restored).toBe(false);
      expect(out.conflicts).toHaveLength(1);
      expect(await read(dir, 'Notes.tex')).toBe('live work under the other spelling\n');
    });

    it('refuses an unknown shelf id, and an id that is not a shelf id at all', async () => {
      const { session } = await setup();
      const s = await session('a');
      expect(await callExpectingError(s, 'unshelve', { id: 'sh-00000000' })).toContain(
        'No shelf "sh-00000000"',
      );
      // The id is interpolated into a filesystem path, so a traversal attempt must be refused by
      // the VALIDATOR, before any path join — not caught later by a directory that happens not
      // to exist. Asserting the validator's own words is what tells those two apart: "No shelf"
      // would mean the id reached the filesystem and simply missed.
      for (const bad of ['../../etc', 'sh-XXXXXXXX', 'sh-1a2b3c4', 'sh-1a2b3c4d5']) {
        const err = await callExpectingError(s, 'unshelve', { id: bad });
        expect(err, bad).toContain('is not a shelf id');
        expect(err, bad).not.toContain('No shelf');
      }
    });
  });

  describe('the guards hold', () => {
    it('refuses a .bib without confirmBibEdit, and takes it with', async () => {
      const { dir, session } = await setup({ [REL]: BASE, 'refs.bib': '@book{a,title={A}}\n' });
      const s = await session('a');
      await call(s, 'write_file', {
        path: 'refs.bib',
        content: '@book{a,title={B}}\n',
        confirmBibEdit: true,
      });

      const err = await callExpectingError(s, 'shelve', { paths: ['refs.bib'] });
      expect(err).toContain('bibliography');
      expect(await read(dir, 'refs.bib')).toBe('@book{a,title={B}}\n');

      const ok = await call<{ shelf: { id: string } }>(s, 'shelve', {
        paths: ['refs.bib'],
        confirmBibEdit: true,
      });
      expect(await read(dir, 'refs.bib')).toBe('@book{a,title={A}}\n');

      // The UNSHELVE side of the same gate. Covering only shelve left this call site free: the
      // helper looked tested while the wiring in the second handler was not, which is how a
      // shared guard quietly protects one operation and not the other.
      const err2 = await callExpectingError(s, 'unshelve', { id: ok.shelf.id });
      expect(err2).toContain('bibliography');
      expect(await read(dir, 'refs.bib')).toBe('@book{a,title={A}}\n');

      await call(s, 'unshelve', { id: ok.shelf.id, confirmBibEdit: true });
      expect(await read(dir, 'refs.bib')).toBe('@book{a,title={B}}\n');
    });

    it("refuses to unshelve over a live peer's path, and when its index is unreadable", async () => {
      const { dir, workspace, session } = await setup();
      const a = await session('a');
      await call(a, 'write_file', { path: REL, content: `${BASE}a's work\n` });
      const shelved = await call<{ shelf: { id: string } }>(a, 'shelve', { paths: [REL] });

      // b starts editing the same path while the shelf is outstanding.
      const b = await session('b');
      await call(b, 'write_file', { path: REL, content: `${BASE}b is mid-sentence\n` });

      const owned = await callExpectingError(a, 'unshelve', { id: shelved.shelf.id });
      expect(owned).toContain('Owned by a live session');
      expect(owned).toContain('"b"');
      expect(await read(dir, REL)).toBe(`${BASE}b is mid-sentence\n`);

      // And the fail-closed half, on the unshelve call site specifically: an index that cannot
      // be read is never "owns nothing".
      await writeFile(path.join(sessionStateDir(workspace, 'demo'), 'b', 'shadow.json'), '{ not');
      const unreadable = await callExpectingError(a, 'unshelve', { id: shelved.shelf.id });
      expect(unreadable).toContain('unreadable');
      expect(unreadable).toContain('"b"');
      expect(await read(dir, REL)).toBe(`${BASE}b is mid-sentence\n`);
      // Nothing was consumed by either refusal.
      expect(
        (await call<{ shelves: Array<{ id: string }> }>(a, 'list_shelves', {})).shelves[0]!.id,
      ).toBe(shelved.shelf.id);
    });

    it("refuses a live peer's path rather than taking its in-flight lines", async () => {
      const { dir, session } = await setup();
      const a = await session('a');
      const b = await session('b');
      // b is live and holds an edit on REL.
      await call(b, 'write_file', { path: REL, content: `${BASE}b is mid-sentence\n` });

      const err = await callExpectingError(a, 'shelve', { paths: [REL] });
      expect(err).toContain('Owned by a live session');
      expect(err).toContain('"b"');
      // b's work is untouched — which is the entire claim.
      expect(await read(dir, REL)).toBe(`${BASE}b is mid-sentence\n`);
    });

    it('refuses when a live peer\'s change index cannot be read — never reads that as "owns nothing"', async () => {
      const { dir, workspace, session } = await setup();
      const a = await session('a');
      const b = await session('b');
      await call(b, 'write_file', { path: REL, content: `${BASE}b edit\n` });

      // Corrupt b's index. `peerEntries` returns null for this, and the single most likely
      // defect in the whole feature is reading that null as "b owns nothing" and proceeding.
      await writeFile(path.join(sessionStateDir(workspace, 'demo'), 'b', 'shadow.json'), '{ not');

      const err = await callExpectingError(a, 'shelve', { paths: [REL] });
      expect(err).toContain('unreadable');
      expect(err).toContain('"b"');
      expect(await read(dir, REL)).toBe(`${BASE}b edit\n`);
    });
  });

  describe('the shelf lives beside the clone, and nothing else there minds', () => {
    it('writes nothing into the clone, and leaves no shelf trace in git', async () => {
      const { dir, session } = await setup();
      const s = await session('a');
      await call(s, 'write_file', { path: REL, content: `${BASE}x\n` });
      await call(s, 'shelve', { paths: [REL] });

      // If the shelf were inside the clone it would show up here, and could be committed.
      expect((await new GitService(IDENTITY).status(dir)).clean).toBe(true);
      expect(await absent(dir, 'shelves')).toBe(true);
      expect(await absent(dir, '.shelves')).toBe(true);
    });

    it('a shelves/ directory beside the session dirs breaks neither peers() nor settleAll()', async () => {
      // The spec calls this out explicitly, because `shelves/` sits in the same directory
      // SessionRegistry.peers() and ShadowStore.settleAll()/clearAll() iterate, treating each
      // subdirectory as a session id. If either mistook it for a session, the damage would be
      // quiet: a phantom peer in every status, or a settle that walked into the shelves.
      const { workspace, session } = await setup();
      const s = await session('a');
      await call(s, 'write_file', { path: REL, content: `${BASE}x\n` });
      await call(s, 'shelve', { paths: [REL] });

      const stateDir = sessionStateDir(workspace, 'demo');
      expect(await readdir(stateDir)).toContain('shelves');

      const registry = new SessionRegistry(workspace, 'probe');
      const peers = await registry.peers('demo');
      // peers() skips a directory with no session.json — asserted, not assumed.
      expect(peers.map((p) => p.sessionId)).not.toContain('shelves');

      // A HeadReader that is never consulted: settleAll and clearAll only remove entries, and
      // this store deliberately holds none. Reaching for HEAD here would mean the probe had
      // strayed from what it is testing.
      const shadows = new ShadowStore(workspace, 'probe', async () => {
        throw new Error('the settleAll/clearAll probe must not read HEAD');
      });
      await shadows.settleAll('demo', [REL]);
      await shadows.clearAll('demo');
      // The shelf survived both, which is what "outside the session machinery" has to mean.
      expect((await call<{ shelves: unknown[] }>(s, 'list_shelves', {})).shelves).toHaveLength(1);
    });

    it('a half-written shelf (no manifest) is invisible, not corrupt', async () => {
      const { workspace, session } = await setup();
      const s = await session('a');
      // A directory that looks like a shelf but has no shelf.json — what a crash between the
      // content writes and the manifest leaves behind. The manifest is written LAST precisely so
      // this case is skipped rather than half-read.
      const orphan = path.join(sessionStateDir(workspace, 'demo'), 'shelves', 'sh-deadbeef');
      await mkdir(path.join(orphan, 'content'), { recursive: true });
      await writeFile(path.join(orphan, 'content', 'x.tex'), 'partial\n');

      expect((await call<{ shelves: unknown[] }>(s, 'list_shelves', {})).shelves).toEqual([]);
      expect(await callExpectingError(s, 'unshelve', { id: 'sh-deadbeef' })).toContain('No shelf');
    });

    it('is project-scoped: a shelf taken by one session is visible and restorable by another', async () => {
      const { dir, session } = await setup();
      const a = await session('a');
      const b = await session('b');
      await call(a, 'write_file', { path: REL, content: `${BASE}a's work\n` });
      const shelved = await call<{ shelf: { id: string; sessionId: string } }>(a, 'shelve', {
        paths: [REL],
      });
      expect(shelved.shelf.sessionId).toBe('a');

      // The whole reason this is not a per-session stash: b can see it and reclaim it.
      const listed = await call<{ shelves: Array<{ id: string }> }>(b, 'list_shelves', {});
      expect(listed.shelves.map((x) => x.id)).toEqual([shelved.shelf.id]);
      await call(b, 'unshelve', { id: shelved.shelf.id });
      expect(await read(dir, REL)).toBe(`${BASE}a's work\n`);
    });
  });

  // Gated on the CAPABILITY, not the platform name, the same way test/unit/shelveGit.test.ts
  // does it and for the same reason: a Windows runner without symlink privilege cannot create
  // one at all, and every other symlink-using integration test in this repo is gated. The local
  // gate is Linux-only, so an ungated block here fails first in CI, on a machine nobody is
  // watching.
  describe.skipIf(!symlinksWork)('the symlink gate (needs symlink support)', () => {
    it('refuses a path that is a symbolic link in the working tree', async () => {
      const { dir, session } = await setup({ [REL]: BASE, 'draft.tex': 'real content\n' });
      const s = await session('a');
      // Target is deliberately NOT a .bib: the bibliography gate runs first by design, so a
      // link onto refs.bib would prove THAT gate fires, not this one.
      await symlink('draft.tex', path.join(dir, 'link.tex'));

      const err = await callExpectingError(s, 'shelve', { paths: ['link.tex'] });
      expect(err).toContain('Refusing a symbolic link');
      expect(err).toContain('link.tex');
      // Both the link and its target are untouched: shelving writes file CONTENT at a path, and
      // through a link those bytes land wherever it points.
      expect(await read(dir, 'draft.tex')).toBe('real content\n');
      expect((await call<{ shelves: unknown[] }>(s, 'list_shelves', {})).shelves).toEqual([]);
    });

    it('refuses a symlink planted at a shelved path while the shelf was outstanding', async () => {
      // The unshelve side of the gate, which nothing covered: a shelf is taken, and by the time
      // it is reclaimed the path has become a link. This is the case linkPathsAmong exists for
      // — restoring content here would write the bytes wherever the link points.
      const { dir, session } = await setup({ [REL]: BASE, 'draft.tex': 'real content\n' });
      const s = await session('a');
      await call(s, 'write_file', { path: REL, content: `${BASE}shelved\n` });
      const shelved = await call<{ shelf: { id: string } }>(s, 'shelve', { paths: [REL] });

      await rm(path.join(dir, REL));
      await symlink(path.join('..', 'draft.tex'), path.join(dir, REL));

      const err = await callExpectingError(s, 'unshelve', { id: shelved.shelf.id });
      expect(err).toContain('Refusing a symbolic link');
      // The link's target is untouched, and the shelf survives to be reclaimed properly.
      expect(await read(dir, 'draft.tex')).toBe('real content\n');
      expect(
        (await call<{ shelves: Array<{ id: string }> }>(s, 'list_shelves', {})).shelves[0]!.id,
      ).toBe(shelved.shelf.id);
    });
  });

  describe("push's dirty-tree refusal names the exit", () => {
    it('offers shelve between the publishing routes and the destructive one', async () => {
      const { session } = await setup();
      const s = await session('a');
      // The message itself is unit-tested (test/unit/shelveMessage.test.ts); what this pins is
      // that the tool it names is actually registered, so the refusal never points at nothing.
      const tools = await s.client.listTools();
      const names = tools.tools.map((t) => t.name);
      expect(names).toContain('shelve');
      expect(names).toContain('unshelve');
      expect(names).toContain('list_shelves');
    });
  });
});
