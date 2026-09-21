import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { simpleGit } from 'simple-git';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFakeRemote, type FakeRemote } from './helpers/bareRepo.js';
import { createContext } from '../../src/context.js';
import { createServer } from '../../src/server.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { GitService } from '../../src/services/gitService.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * Issue #70, the last "not provable on Linux" checkbox: **does a path-limited `discard` remove an
 * UNTRACKED file the caller named in another case?**
 *
 * `GitService.discard` resolves requested paths onto the index's spelling (`canonicalNames`) and
 * uses those resolved names for `ls-files` and `checkout`, but the `clean -f` loop deliberately
 * iterates the caller's **raw** spelling — an untracked file has no index entry to resolve
 * against, so there is nothing else it could iterate. That leaves the untracked half of the call
 * matching by whatever rule git's own pathspec machinery applies, which is what this file
 * measures rather than assumes.
 *
 * **Measured on Linux** (git 2.46, ext4, `core.ignorecase` forced to `true` on a case-sensitive
 * filesystem, so git believes the repository folds while the two names really are two files):
 * `git --literal-pathspecs clean -f -- scratch.txt` does **not** remove an untracked `Scratch.txt`.
 * It exits 0, prints nothing, and the file stays. Only the exact spelling removes it, and with
 * both names present only the exactly-named one goes.
 *
 * **Also measured against a genuinely case-insensitive, case-preserving filesystem** (NTFS through
 * WSL2's DrvFs, where git auto-detects `core.ignorecase = true`): identical. `Scratch.txt` is the
 * only directory entry, `git status` reports `?? Scratch.txt`, and `clean -f -- scratch.txt`
 * removes nothing while `clean -f -- Scratch.txt` removes it. The whole suite below is green with
 * `TMPDIR` pointed at that mount, so the case-insensitive branch of the third case is exercised
 * rather than merely predicted. That is the same git matching code as the macOS/Windows legs run,
 * over storage that really does fold — but not those platforms' own builds, which is why the CI
 * legs still decide it.
 *
 * **Prediction for macOS and Windows: identical — the file survives there too.** `core.ignorecase`
 * governs how git compares names against the *index* and the *working tree listing*; it does not
 * make a pathspec case-insensitive. Pathspec folding is a separate, opt-in knob (`:(icase)` magic,
 * `--icase-pathspecs`, `GIT_ICASE_PATHSPECS`) — and `--literal-pathspecs`, which every path-taking
 * git call in this repo carries, is mutually exclusive with it ("fatal: global 'literal' pathspec
 * setting is incompatible with all other global pathspec settings"). `clean` enumerates untracked
 * entries from the directory, which on a case-preserving filesystem hands it `Scratch.txt`, and
 * then compares that against the pathspec byte-exactly. The existing case-fold work corroborates
 * this from the other side: `canonicalNames` exists in `discard`/`commit` precisely because a
 * literal pathspec does not fold on an ignorecase clone, and those tests are green on the macOS
 * and Windows legs.
 *
 * **A red macOS or Windows leg here is the finding, not a flake.** It would mean git's untracked
 * matching folds on a genuinely case-insensitive filesystem while it does not on Linux — i.e. the
 * server's most destructive call behaves differently per platform for the same arguments, and
 * the Linux suite can never see it.
 *
 * Anti-vacuity, which is the whole risk in a probe like this:
 *  - every case asserts the directory's contents **before** the destructive call, so a fixture
 *    that never materialised fails rather than satisfying an "it is gone" assertion for free;
 *  - each survival assertion is followed by a discard under the disk's own spelling that must
 *    remove the file, so "it did not fold" can never be a `clean` that reached nothing here;
 *  - **nothing in this file skips.** The one case a case-insensitive filesystem cannot express —
 *    two files differing only in case — is branched on what the disk actually did (never on
 *    `process.platform`) and asserted in both regimes, because a skip would be invisible: under
 *    the reporter `npm test` uses, a skipped test prints neither a `console.error` from its body
 *    nor a `skip()` note, so on the two legs that matter it would collapse to "1 skipped".
 */

const IDENTITY = { name: 'Test', email: 'test@example.com' };

interface Session {
  client: Client;
}

interface Harness {
  remote: FakeRemote;
  /** The clone. Every path this file touches is inside it. */
  dir: string;
  session: (id: string) => Promise<Session>;
  cleanups: Array<() => Promise<void>>;
}

async function setup(ignorecase: boolean): Promise<Harness> {
  const cleanups: Array<() => Promise<void>> = [];
  const remote = await createFakeRemote({ 'Notes.txt': 'a\nb\nc\n' });
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-discardcase-'));
  cleanups.push(remote.cleanup, () => rm(workspace, { recursive: true, force: true }));

  const dir = path.join(workspace, 'demo');
  await new GitService(IDENTITY).clone(remote.url, dir, { username: 'git' });
  // CLAUDE.md: `core.ignorecase` is the source of truth, never the filesystem. It defaults to
  // true on macOS/Windows, so an unpinned fixture would exercise a different branch per leg.
  await simpleGit(dir).raw(['config', 'core.ignorecase', ignorecase ? 'true' : 'false']);

  const baseConfig = {
    workspaceRoot: workspace,
    projects: [{ id: 'demo', gitUrl: remote.url }],
    defaultProject: 'demo',
  };
  const session = async (id: string): Promise<Session> => {
    const config: ServerConfig = { ...baseConfig, sessionId: id };
    const ctx = createContext(config, new CredentialResolver({}), IDENTITY);
    const server = createServer(ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: `test-${id}`, version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(() => client.close());
    return { client };
  };
  return { remote, dir, session, cleanups };
}

async function call(session: Session, name: string, args: Record<string, unknown>) {
  const res = await session.client.callTool({ name, arguments: args });
  return {
    isError: res.isError === true,
    text: (res.content as Array<{ type: string; text?: string }>)
      .map((c) => (c.type === 'text' ? (c.text ?? '') : ''))
      .join('\n'),
    sc: (res.structuredContent ?? {}) as Record<string, unknown>,
  };
}

/** The clone's top-level entries as the filesystem itself spells them, `.git` aside. */
async function entries(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((n) => n !== '.git').sort();
}

/**
 * Write both spellings and report what the filesystem actually did with them.
 *
 * A case-insensitive filesystem is case-PRESERVING, so the second write lands in the first
 * file instead of failing and the directory keeps one entry under whichever spelling created
 * it. The only reliable signal is reading the directory back — never `process.platform`, and
 * never the clone's `core.ignorecase`, which this fixture pins independently.
 *
 * This deliberately does NOT skip when the two names fold. A skip is the standing risk in this
 * lane and, under the reporter `npm test` actually uses, it prints nothing at all: neither a
 * `console.error` from the test body nor a `skip()` note reaches the output, so on the two legs
 * where the fold happens the case would vanish into "1 skipped". Both regimes get a real
 * assertion instead.
 */
async function writeBothSpellings(
  dir: string,
): Promise<{ separate: boolean; onDisk: string; other: string }> {
  await writeFile(path.join(dir, 'Scratch.txt'), 'upper\n', 'utf8');
  await writeFile(path.join(dir, 'scratch.txt'), 'lower\n', 'utf8');
  const names = (await entries(dir)).filter((n) => n.toLowerCase() === 'scratch.txt');
  if (names.length === 2) return { separate: true, onDisk: 'Scratch.txt', other: 'scratch.txt' };
  const [onDisk] = names;
  if (names.length !== 1 || onDisk === undefined) {
    // Neither "two files" nor "one file" — the fixture did not materialise, and every assertion
    // downstream would be measuring nothing. Fail here rather than let that pass as a result.
    throw new Error(`the fixture did not materialise: the clone holds ${JSON.stringify(names)}`);
  }
  return {
    separate: false,
    onDisk,
    other: onDisk === 'Scratch.txt' ? 'scratch.txt' : 'Scratch.txt',
  };
}

describe('discard and the case of an UNTRACKED path (issue #70)', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  async function harness(ignorecase: boolean): Promise<Harness> {
    const h = await setup(ignorecase);
    cleanups.push(...h.cleanups);
    return h;
  }

  it('control: the exact spelling removes the untracked file (proves the fixture and clean reach it here)', async () => {
    const h = await harness(true);
    const mine = await h.session('mine');
    await writeFile(path.join(h.dir, 'Scratch.txt'), 'scratch\n', 'utf8');
    expect(await entries(h.dir)).toEqual(['Notes.txt', 'Scratch.txt']);

    const res = await call(mine, 'discard', { paths: ['Scratch.txt'], confirm: true });
    expect(res.isError, res.text).toBe(false);
    expect(res.sc.discarded).toBe(true);
    expect(await entries(h.dir)).toEqual(['Notes.txt']);
  });

  it('the probe: naming the other case leaves the untracked file on disk, and still reports discarded', async () => {
    const h = await harness(true);
    const mine = await h.session('mine');
    await writeFile(path.join(h.dir, 'Scratch.txt'), 'scratch\n', 'utf8');
    // The fixture is real: the filesystem spells it `Scratch.txt`, and that is what `clean`
    // enumerates. Without this the assertion below could be satisfied by a file never created.
    expect(await entries(h.dir)).toEqual(['Notes.txt', 'Scratch.txt']);

    const res = await call(mine, 'discard', { paths: ['scratch.txt'], confirm: true });
    expect(res.isError, res.text).toBe(false);
    // `clean` matching nothing is a silent no-op (exit 0), so the tool reports success either
    // way — the caller is told the discard happened whatever the file did.
    expect(res.sc.discarded).toBe(true);

    // Measured on Linux; predicted identical on macOS/Windows (see the file header). A failure
    // here on one leg only IS the #70 finding: git folded an untracked pathspec on a genuinely
    // case-insensitive filesystem and did not on Linux.
    expect(
      await entries(h.dir),
      `filesystem reported ${JSON.stringify(await entries(h.dir))} on ${process.platform}`,
    ).toEqual(['Notes.txt', 'Scratch.txt']);
    expect(await readFile(path.join(h.dir, 'Scratch.txt'), 'utf8')).toBe('scratch\n');

    // And the same file IS removable here — so "not folded" cannot be a `clean` that reached
    // nothing at all on this platform.
    const exact = await call(mine, 'discard', { paths: ['Scratch.txt'], confirm: true });
    expect(exact.isError, exact.text).toBe(false);
    expect(await entries(h.dir)).toEqual(['Notes.txt']);
  });

  it('the destructive direction: writing both spellings, discard removes only what the pathspec names byte-exactly', async () => {
    const h = await harness(true);
    const mine = await h.session('mine');
    const fs = await writeBothSpellings(h.dir);

    if (fs.separate) {
      // Case-sensitive filesystem (the ubuntu leg): two genuinely different files. If git folded
      // untracked pathspecs under `core.ignorecase`, this call would destroy a file the caller
      // never named — in the server's most destructive call.
      expect(await entries(h.dir)).toEqual(['Notes.txt', 'Scratch.txt', 'scratch.txt']);
      const res = await call(mine, 'discard', { paths: ['scratch.txt'], confirm: true });
      expect(res.isError, res.text).toBe(false);
      expect(await entries(h.dir)).toEqual(['Notes.txt', 'Scratch.txt']);
      expect(await readFile(path.join(h.dir, 'Scratch.txt'), 'utf8')).toBe('upper\n');
      return;
    }

    // Case-insensitive filesystem (the macOS/Windows legs): the two writes are one file, kept
    // under the spelling that created it, holding the second write's bytes. Same question, and
    // the branch is chosen by what the disk did, never by `process.platform`.
    expect(await entries(h.dir)).toEqual(['Notes.txt', fs.onDisk].sort());
    expect(await readFile(path.join(h.dir, fs.onDisk), 'utf8')).toBe('lower\n');

    const res = await call(mine, 'discard', { paths: [fs.other], confirm: true });
    expect(res.isError, res.text).toBe(false);
    expect(
      await entries(h.dir),
      `discard(${fs.other}) against on-disk ${fs.onDisk} on ${process.platform}`,
    ).toEqual(['Notes.txt', fs.onDisk].sort());

    // …and the disk's own spelling does remove it, so the survival above is a non-match and not
    // a `clean` that reached nothing here.
    const exact = await call(mine, 'discard', { paths: [fs.onDisk], confirm: true });
    expect(exact.isError, exact.text).toBe(false);
    expect(await entries(h.dir)).toEqual(['Notes.txt']);
  });

  it('contrast: a TRACKED path named in the other case IS restored, because discard resolves it onto the index spelling', async () => {
    const h = await harness(true);
    const mine = await h.session('mine');
    // Out-of-band edit, so this case is about git alone and not about shadow bookkeeping.
    await writeFile(path.join(h.dir, 'Notes.txt'), 'CHANGED\n', 'utf8');
    expect((await simpleGit(h.dir).status()).isClean()).toBe(false);

    const res = await call(mine, 'discard', { paths: ['notes.txt'], confirm: true });
    expect(res.isError, res.text).toBe(false);
    // `canonicalNames` folds `notes.txt` onto the index's `Notes.txt`, so `checkout` restores it.
    expect(await readFile(path.join(h.dir, 'Notes.txt'), 'utf8')).toBe('a\nb\nc\n');
    expect((await simpleGit(h.dir).status()).isClean()).toBe(true);
  });

  it('just outside: with core.ignorecase=false that same tracked path is not folded and stays modified', async () => {
    const h = await harness(false);
    const mine = await h.session('mine');
    await writeFile(path.join(h.dir, 'Notes.txt'), 'CHANGED\n', 'utf8');

    const res = await call(mine, 'discard', { paths: ['notes.txt'], confirm: true });
    expect(res.isError, res.text).toBe(false);
    // The clone says it is case-sensitive, so no spelling is resolved — even on macOS/Windows,
    // where the filesystem would disagree. `core.ignorecase` is the source of truth.
    expect(await readFile(path.join(h.dir, 'Notes.txt'), 'utf8')).toBe('CHANGED\n');
  });
});
