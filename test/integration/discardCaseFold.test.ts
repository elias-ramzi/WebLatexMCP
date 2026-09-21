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
 * Issue #70 (the probe) and issue #127 (the fix): **does a path-limited `discard` remove an
 * UNTRACKED file the caller named in another case, and what does it report when it does not?**
 *
 * `GitService.discard` resolved requested paths onto the index's spelling (`canonicalNames`) and
 * used those resolved names for `ls-files` and `checkout`, but the `clean -f` loop iterated the
 * caller's **raw** spelling — an untracked file has no index entry to resolve against. So one
 * call folded or did not fold depending on something the caller cannot see, and because `git
 * clean -f` matching nothing exits 0, both outcomes came back `discarded: true`.
 *
 * **What git itself does is unchanged, and is why the fix has to live in the server.** Measured
 * on Linux (git 2.46, ext4, `core.ignorecase` forced to `true` on a case-sensitive filesystem, so
 * git believes the repository folds while the two names really are two files):
 * `git --literal-pathspecs clean -f -- scratch.txt` does **not** remove an untracked
 * `Scratch.txt`. It exits 0, prints nothing, and the file stays. Measured again against a
 * genuinely case-insensitive, case-preserving filesystem (NTFS through WSL2's DrvFs, where git
 * auto-detects `core.ignorecase = true`): identical — `Scratch.txt` is the only directory entry,
 * `git status` reports `?? Scratch.txt`, and only the exact spelling removes it.
 *
 * `core.ignorecase` governs how git compares names against the *index* and the *working tree
 * listing*; it does not make a pathspec case-insensitive. Pathspec folding is a separate, opt-in
 * knob (`:(icase)` magic, `--icase-pathspecs`, `GIT_ICASE_PATHSPECS`) — and `--literal-pathspecs`,
 * which every path-taking git call in this repo carries so that `a[1].tex` never also means
 * `a1.tex`, is mutually exclusive with it ("fatal: global 'literal' pathspec setting is
 * incompatible with all other global pathspec settings"). Dropping it to buy the fold would
 * reintroduce globbing in the most destructive call in the server.
 *
 * **So #127 folds in the server instead**, against the other source of truth: `discard` resolves
 * each requested path against the working tree's untracked listing (`ls-files --others
 * --exclude-standard`) through the same exact-spelling-first `canonicalNames` machinery, on an
 * ignorecase clone only, with every pathspec still literal. And it stops swallowing the miss —
 * a requested path git can match nothing for comes back in `missed`, and a call that reached
 * nothing at all reports `discarded: false`.
 *
 * **A red macOS or Windows leg here is the finding, not a flake.** `core.ignorecase` defaults to
 * true on both, and the fixture pins it explicitly for exactly that reason; a divergence would
 * mean the server's most destructive call behaves differently per platform for the same
 * arguments, and the Linux suite can never see it.
 *
 * Anti-vacuity, which is the whole risk in a file like this:
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
    expect(res.sc.missed).toEqual([]);
    expect(await entries(h.dir)).toEqual(['Notes.txt']);
  });

  // Pre-#127 this was the probe, and it asserted the opposite: the file SURVIVED and the tool
  // still reported `discarded: true`. Both halves flipped with the fix.
  it('#127: naming the other case removes the untracked file on an ignorecase clone', async () => {
    const h = await harness(true);
    const mine = await h.session('mine');
    await writeFile(path.join(h.dir, 'Scratch.txt'), 'scratch\n', 'utf8');
    // The fixture is real: the filesystem spells it `Scratch.txt`, and that is what `clean`
    // enumerates. Without this the assertion below could be satisfied by a file never created.
    expect(await entries(h.dir)).toEqual(['Notes.txt', 'Scratch.txt']);

    const res = await call(mine, 'discard', { paths: ['scratch.txt'], confirm: true });
    expect(res.isError, res.text).toBe(false);
    expect(res.sc.discarded).toBe(true);
    expect(res.sc.missed).toEqual([]);

    // The server folded `scratch.txt` onto the untracked listing's `Scratch.txt` before handing
    // it to `clean`; git's own pathspec matching is byte-exact here and always was (see the file
    // header), so a failure on one leg only is a divergence in the SERVER's fold, not in git's.
    expect(
      await entries(h.dir),
      `filesystem reported ${JSON.stringify(await entries(h.dir))} on ${process.platform}`,
    ).toEqual(['Notes.txt']);
  });

  it('#127 twin, just outside: with core.ignorecase=false the untracked file survives and the miss is REPORTED', async () => {
    const h = await harness(false);
    const mine = await h.session('mine');
    await writeFile(path.join(h.dir, 'Scratch.txt'), 'scratch\n', 'utf8');
    expect(await entries(h.dir)).toEqual(['Notes.txt', 'Scratch.txt']);

    const res = await call(mine, 'discard', { paths: ['scratch.txt'], confirm: true });
    expect(res.isError, res.text).toBe(false);
    // The clone says it is case-sensitive, so nothing is folded — byte-exact behaviour, even on
    // macOS/Windows where the filesystem would disagree. `core.ignorecase` is the source of
    // truth, never the filesystem.
    expect(
      await entries(h.dir),
      `filesystem reported ${JSON.stringify(await entries(h.dir))} on ${process.platform}`,
    ).toEqual(['Notes.txt', 'Scratch.txt']);
    expect(await readFile(path.join(h.dir, 'Scratch.txt'), 'utf8')).toBe('scratch\n');
    // …but the caller is no longer told the file is gone. This is the half of #127 that holds
    // whether or not the fold applies.
    expect(res.sc.discarded).toBe(false);
    expect(res.sc.missed).toEqual(['scratch.txt']);
    expect(res.text).toContain('"scratch.txt"');

    // And the same file IS removable here — so "not folded" cannot be a `clean` that reached
    // nothing at all on this platform.
    const exact = await call(mine, 'discard', { paths: ['Scratch.txt'], confirm: true });
    expect(exact.isError, exact.text).toBe(false);
    expect(exact.sc.missed).toEqual([]);
    expect(await entries(h.dir)).toEqual(['Notes.txt']);
  });

  it('the destructive direction: writing both spellings, discard removes only what the pathspec names byte-exactly', async () => {
    const h = await harness(true);
    const mine = await h.session('mine');
    const fs = await writeBothSpellings(h.dir);

    if (fs.separate) {
      // Case-sensitive filesystem (the ubuntu leg): two genuinely different files, on a clone
      // whose `core.ignorecase` says they fold. THIS is what `canonicalNames`' exact-first rule
      // buys: the caller named `scratch.txt` verbatim, the untracked listing holds it verbatim,
      // so the fold never fires and the file the caller did not name survives. A fold that
      // resolved to "whichever entry sorted first" would destroy `Scratch.txt` here — in the
      // server's most destructive call.
      expect(await entries(h.dir)).toEqual(['Notes.txt', 'Scratch.txt', 'scratch.txt']);
      const res = await call(mine, 'discard', { paths: ['scratch.txt'], confirm: true });
      expect(res.isError, res.text).toBe(false);
      expect(res.sc.missed).toEqual([]);
      expect(await entries(h.dir)).toEqual(['Notes.txt', 'Scratch.txt']);
      expect(await readFile(path.join(h.dir, 'Scratch.txt'), 'utf8')).toBe('upper\n');
      return;
    }

    // Case-insensitive filesystem (the macOS/Windows legs): the two writes are one file, kept
    // under the spelling that created it, holding the second write's bytes. There is no second
    // file to destroy, and the one file IS what the caller named — the filesystem says so — so
    // #127's fold removes it. The branch is chosen by what the disk did, never by
    // `process.platform`.
    expect(await entries(h.dir)).toEqual(['Notes.txt', fs.onDisk].sort());
    expect(await readFile(path.join(h.dir, fs.onDisk), 'utf8')).toBe('lower\n');

    const res = await call(mine, 'discard', { paths: [fs.other], confirm: true });
    expect(res.isError, res.text).toBe(false);
    expect(res.sc.missed).toEqual([]);
    expect(
      await entries(h.dir),
      `discard(${fs.other}) against on-disk ${fs.onDisk} on ${process.platform}`,
    ).toEqual(['Notes.txt']);
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
    // And the tracked half reports its miss the same way the untracked half does: the edit is
    // still sitting there, so the answer is not "discarded".
    expect(res.sc.discarded).toBe(false);
    expect(res.sc.missed).toEqual(['notes.txt']);
  });

  // The reporting half of #127, which holds whatever the fold does: a path no fold can rescue,
  // because nothing of that name exists under any spelling.
  it('#127: a path that matches nothing at all is reported, not swallowed', async () => {
    const h = await harness(true);
    const mine = await h.session('mine');

    const res = await call(mine, 'discard', { paths: ['nothing-here.txt'], confirm: true });
    expect(res.isError, res.text).toBe(false);
    expect(res.sc.discarded).toBe(false);
    expect(res.sc.missed).toEqual(['nothing-here.txt']);
    // The text channel carries it too — an MCP client that shows only the text must not read
    // this as a completed discard.
    expect(res.text).toContain('nothing-here.txt');
    expect(res.text).toContain('still exactly as they were');
    // …and it must not open with the word the caller reads as "done".
    expect(res.text).toMatch(/^discarded NOTHING:/);
  });

  it('#127: a partial miss still reports what it DID discard, and names only the rest', async () => {
    const h = await harness(true);
    const mine = await h.session('mine');
    await writeFile(path.join(h.dir, 'Notes.txt'), 'CHANGED\n', 'utf8');
    await writeFile(path.join(h.dir, 'Scratch.txt'), 'scratch\n', 'utf8');
    expect(await entries(h.dir)).toEqual(['Notes.txt', 'Scratch.txt']);

    const res = await call(mine, 'discard', {
      paths: ['Notes.txt', 'Scratch.txt', 'nothing-here.txt'],
      confirm: true,
    });
    expect(res.isError, res.text).toBe(false);
    // Two of the three landed, so `discarded` is true — a bare boolean cannot say "one of the
    // three", which is why `missed` exists alongside it rather than instead of it.
    expect(res.sc.discarded).toBe(true);
    expect(res.sc.missed).toEqual(['nothing-here.txt']);
    expect(res.text).toMatch(/^discarded uncommitted changes, EXCEPT:/);
    expect(await entries(h.dir)).toEqual(['Notes.txt']);
    expect(await readFile(path.join(h.dir, 'Notes.txt'), 'utf8')).toBe('a\nb\nc\n');
  });

  it('#127: a whole-tree discard names no path, so it misses nothing', async () => {
    const h = await harness(true);
    const mine = await h.session('mine');
    await writeFile(path.join(h.dir, 'Notes.txt'), 'CHANGED\n', 'utf8');
    await writeFile(path.join(h.dir, 'Scratch.txt'), 'scratch\n', 'utf8');

    const res = await call(mine, 'discard', { confirm: true });
    expect(res.isError, res.text).toBe(false);
    expect(res.sc.discarded).toBe(true);
    expect(res.sc.missed).toEqual([]);
    expect(await entries(h.dir)).toEqual(['Notes.txt']);
  });

  // Issue #130: `structuredContent` alone pins the HANDLER, not the contract. The MCP SDK
  // validates the result against the outputSchema and then throws the parse result away, and a
  // zod object strips rather than rejects, so a key the schema never declares reaches the client
  // regardless — every assertion above would stay green with `missed` deleted from the schema,
  // while a model reading the tool's schema would never learn the field exists. Asserted off a
  // real `listTools()` round trip instead.
  it('#127/#130: `missed` is DECLARED in the advertised outputSchema, not merely emitted', async () => {
    const h = await harness(true);
    const mine = await h.session('mine');

    const advertised = (await mine.client.listTools()).tools.find((t) => t.name === 'discard');
    const props = (
      advertised?.outputSchema as { properties?: Record<string, { description?: string }> }
    )?.properties;
    expect(props?.missed).toBeDefined();
    // Declared as the thing it is: a list of paths the discard could NOT reach, not a second
    // list of what it removed.
    expect(props?.missed?.description ?? '').toMatch(/NOT gone/);
    expect(props?.discarded?.description ?? '').toMatch(/matched nothing/);
    // And required, so a client never has to tell "no misses" from "this server is older".
    expect((advertised?.outputSchema as { required?: string[] })?.required).toContain('missed');
  });
});
