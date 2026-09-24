import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { simpleGit } from 'simple-git';
import { createFakeRemote, pushCommit, type FakeRemote } from './helpers/bareRepo.js';
import { createContext } from '../../src/context.js';
import { createServer } from '../../src/server.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { GitService } from '../../src/services/gitService.js';
import type { ServerConfig } from '../../src/types.js';
import { expectNoUndeclaredKeys } from '../helpers/outputSchema.js';

/**
 * `unshelve` after HEAD moved under a shelved path — the co-author case: shelve `sections/b.tex`,
 * pull a commit that touches it, unshelve.
 *
 * Before this, `planUnshelveFile` compared HEAD's blob against the shelf's stored base and, once
 * they differed, refused as `head-moved` FOREVER: no tool can read a shelf's bytes, so the only
 * way out was to make the tree byte-equal to the shelved content — throwing away every line HEAD
 * had just gained. A text entry is now three-way merged (base -> shelved onto the tree, which the
 * dirty check has proved equals HEAD), and only a genuine collision refuses.
 */

const REL = 'sections/b.tex';
const BASE = [
  '\\section{B}',
  'Line one of the section.',
  'Line two of the section.',
  'Line three of the section.',
  'Line four of the section.',
  'Line five of the section.',
  'Line six of the section.',
  '',
].join('\n');
const SHELVED = BASE.replace('Line one of the section.', 'Line one, REWRITTEN by the shelf.');
const UPSTREAM_FAR = BASE.replace('Line six of the section.', 'Line six, CHANGED upstream.');
/**
 * A section long enough (~7k characters a side) that the conflict budget has to cut one side of
 * three: `theirs` must be the side that survives, because it is the only one no other tool can
 * read. Charged base-first, as it was, `theirs` was the one cut.
 */
const LONG_BASE =
  BASE +
  Array.from({ length: 130 }, (_, i) => `Filler sentence number ${i} keeps the section long.`).join(
    '\n',
  ) +
  '\n';
const LONG_SHELVED = LONG_BASE.replace(
  'Line one of the section.',
  'Line one, REWRITTEN by the shelf.',
);
const LONG_UPSTREAM = LONG_BASE.replace('Line one of the section.', 'Line one, CHANGED upstream.');
const IDENTITY = { name: 'Test', email: 'test@example.com' };

interface Session {
  client: Client;
}

describe('unshelve after HEAD moved under a shelved path', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  async function setup(base: string): Promise<{ remote: FakeRemote; dir: string; s: Session }> {
    const remote = await createFakeRemote({ [REL]: base, 'main.tex': 'main\n' });
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-unshelve-moved-'));
    cleanups.push(remote.cleanup, () =>
      rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
    );
    const dir = path.join(workspace, 'demo');
    await new GitService(IDENTITY).clone(remote.url, dir, { username: 'git' });
    const config: ServerConfig = {
      workspaceRoot: workspace,
      projects: [{ id: 'demo', gitUrl: remote.url }],
      defaultProject: 'demo',
      sessionId: 'a',
    };
    const ctx = createContext(config, new CredentialResolver({}), IDENTITY);
    const server = createServer(ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-a', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.unshift(() => client.close());
    return { remote, dir, s: { client } };
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

  const read = (dir: string, rel: string): Promise<string> => readFile(path.join(dir, rel), 'utf8');

  /** Shelve the edit, then land a co-author's commit on the same file and pull it. */
  async function shelveThenPull(
    base: string,
    shelvedEdit: string,
    upstream: string,
  ): Promise<{ dir: string; s: Session; id: string }> {
    const { remote, dir, s } = await setup(base);
    await call(s, 'write_file', { path: REL, content: shelvedEdit });
    const shelved = await call<{ shelf: { id: string } }>(s, 'shelve', { paths: [REL] });
    expect(await read(dir, REL)).toBe(base);

    await pushCommit(remote, { [REL]: upstream }, 'co-author edit');
    const sync = await call<{ action: string }>(s, 'project_sync', {});
    expect(sync.action).not.toBe('diverged');
    // The precondition that makes this the head-moved case and not the dirty one.
    expect(await read(dir, REL)).toBe(upstream);
    expect((await new GitService(IDENTITY).status(dir)).clean).toBe(true);
    return { dir, s, id: shelved.shelf.id };
  }

  it('merges a non-overlapping upstream change, removes the shelf, and commits only the shelved lines', async () => {
    const { dir, s, id } = await shelveThenPull(BASE, SHELVED, UPSTREAM_FAR);

    const out = await call<{
      restored: boolean;
      files?: string[];
      merged?: string[];
      conflicts?: unknown[];
    }>(s, 'unshelve', { id });
    expect(out.conflicts).toBeUndefined();
    expect(out.restored).toBe(true);
    expect(out.merged).toEqual([REL]);
    // `merged` is a new key: judged against the ADVERTISED schema off a listTools() round trip,
    // since an undeclared key makes the client reject the whole result.
    await expectNoUndeclaredKeys(s.client, 'unshelve', out);

    // Both changes, in one file: the shelf's line one and upstream's line six.
    const merged = await read(dir, REL);
    expect(merged).toContain('Line one, REWRITTEN by the shelf.');
    expect(merged).toContain('Line six, CHANGED upstream.');
    expect(merged).toBe(
      UPSTREAM_FAR.replace('Line one of the section.', 'Line one, REWRITTEN by the shelf.'),
    );
    expect((await call<{ shelves: unknown[] }>(s, 'list_shelves', {})).shelves).toEqual([]);

    // The lines are this session's, and ONLY the shelved ones: a session-scoped commit carries
    // the rewrite and nothing of upstream's (which is already in HEAD~1).
    const committed = await call<{ committed: boolean }>(s, 'commit', { message: 'unshelved' });
    expect(committed.committed).toBe(true);
    const patch = await simpleGit(dir).raw(['diff', '--unified=0', 'HEAD~1', 'HEAD', '--', REL]);
    const changed = patch
      .split('\n')
      .filter((l) => /^[+-][^+-]/.test(l))
      .sort();
    expect(changed).toEqual(['+Line one, REWRITTEN by the shelf.', '-Line one of the section.']);
    expect(await simpleGit(dir).show([`HEAD:${REL}`])).toBe(merged);
  });

  it('refuses an overlapping upstream change with theirs = the shelved bytes, and keeps the shelf', async () => {
    const { dir, s, id } = await shelveThenPull(LONG_BASE, LONG_SHELVED, LONG_UPSTREAM);

    const res = await s.client.callTool({ name: 'unshelve', arguments: { id } });
    expect(res.isError ?? false).toBe(false);
    const out = res.structuredContent as {
      restored: boolean;
      conflicts: Array<{
        path: string;
        reason: string;
        base: string | null;
        ours: string | null;
        theirs: string | null;
        elided?: { base?: number; ours?: number; theirs?: number };
      }>;
      conflictPaths: string[];
    };
    expect(out.restored).toBe(false);
    await expectNoUndeclaredKeys(s.client, 'unshelve', out);
    expect(out.conflictPaths).toEqual([REL]);
    expect(out.conflicts[0]!.reason).toBe('head-moved');
    // `theirs` is the one side no other tool can read — the shelf lives outside the sandbox —
    // so it is charged first and survives; `ours` is the tree (read_file) and survives next;
    // `base` (read_file at the shelf's headSha) is the side the budget cuts, with its size.
    expect(out.conflicts[0]!.theirs).toBe(LONG_SHELVED);
    expect(out.conflicts[0]!.ours).toBe(LONG_UPSTREAM);
    expect(out.conflicts[0]!.base).toBeNull();
    expect(out.conflicts[0]!.elided).toEqual({ base: LONG_BASE.length });

    // Nothing written: no markers, no half merge.
    expect(await read(dir, REL)).toBe(LONG_UPSTREAM);
    const shelves = await call<{ shelves: Array<{ id: string }> }>(s, 'list_shelves', {});
    expect(shelves.shelves.map((x) => x.id)).toEqual([id]);
  });
});
