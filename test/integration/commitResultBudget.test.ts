import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFakeRemote } from './helpers/bareRepo.js';
import { createContext } from '../../src/context.js';
import { createServer } from '../../src/server.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { GitService } from '../../src/services/gitService.js';
import { COMMIT_CONTENT_BUDGET } from '../../src/lib/commitBudget.js';
import { expectNoUndeclaredKeys } from '../helpers/outputSchema.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * `commit`'s `files` and `leftUncommitted` are filled from the working tree, which the server does
 * not control, and both ship twice (text + `structuredContent`). A few thousand untracked files
 * used to make the result undeliverable AFTER the commit had already landed — the caller got no
 * sha, no counts and no reason. Both lists are now budgeted and the cuts counted.
 */

const IDENTITY = { name: 'Test', email: 'test@example.com' };
const MANY = 1500;

describe('commit bounds its path lists', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  async function setup(): Promise<{ client: Client; dir: string }> {
    const remote = await createFakeRemote({ 'main.tex': 'alpha\n' });
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-commitbudget-'));
    cleanups.push(remote.cleanup, () =>
      rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
    );
    const dir = path.join(workspace, 'demo');
    await new GitService(IDENTITY).clone(remote.url, dir, { username: 'git' });
    const config: ServerConfig = {
      workspaceRoot: workspace,
      projects: [{ id: 'demo', gitUrl: remote.url }],
      defaultProject: 'demo',
      sessionId: 'solo',
    };
    const ctx = createContext(config, new CredentialResolver({}), IDENTITY);
    const server = createServer(ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(() => client.close());
    return { client, dir };
  }

  async function untrackedTree(dir: string): Promise<void> {
    await mkdir(path.join(dir, 'generated'), { recursive: true });
    const names = Array.from(
      { length: MANY },
      (_, i) => `generated/figure-${String(i).padStart(4, '0')}.txt`,
    );
    for (let i = 0; i < names.length; i += 200) {
      await Promise.all(names.slice(i, i + 200).map((n) => writeFile(path.join(dir, n), `${n}\n`)));
    }
  }

  const textOf = (res: unknown): string =>
    ((res as { content: Array<{ text?: string }> }).content ?? [])
      .map((c) => c.text ?? '')
      .join('\n');

  /** Both channels, as the wire carries them. */
  const renderedSize = (res: unknown): number =>
    textOf(res).length +
    JSON.stringify((res as { structuredContent?: unknown }).structuredContent).length;

  it('session scope: a large untracked tree left behind is cut and counted', async () => {
    const { client, dir } = await setup();
    const wrote = await client.callTool({
      name: 'write_file',
      arguments: { path: 'main.tex', content: 'alpha\nbeta\n' },
    });
    expect(wrote.isError, JSON.stringify(wrote.content)).toBeFalsy();
    await untrackedTree(dir);

    const res = await client.callTool({ name: 'commit', arguments: { message: 'mine' } });
    expect(res.isError, textOf(res)).toBeFalsy();
    const sc = res.structuredContent as Record<string, unknown>;
    expect(sc.committed).toBe(true);
    expect(sc.scope).toBe('session');
    expect(sc.files).toEqual([{ path: 'main.tex', added: 1, removed: 0 }]);
    expect(sc.filesOmitted).toBe(0);

    const left = sc.leftUncommitted as string[];
    const leftOmitted = sc.leftUncommittedOmitted as number;
    expect(left.length).toBeGreaterThan(0);
    expect(leftOmitted).toBeGreaterThan(0);
    expect(left.length + leftOmitted).toBe(MANY);
    // The text is rendered from the cut list, and says what was cut.
    expect(textOf(res)).toContain(`${leftOmitted} more`);
    expect(textOf(res)).not.toContain(`generated/figure-${String(MANY - 1).padStart(4, '0')}.txt`);
    expect(renderedSize(res)).toBeLessThan(COMMIT_CONTENT_BUDGET + 3000);

    await expectNoUndeclaredKeys(client, 'commit', sc);
  });

  it('scope "all": a commit of a large tree lists a cut of the files it took, and counts the rest', async () => {
    const { client, dir } = await setup();
    await untrackedTree(dir);

    const res = await client.callTool({
      name: 'commit',
      arguments: { message: 'everything', scope: 'all' },
    });
    expect(res.isError, textOf(res)).toBeFalsy();
    const sc = res.structuredContent as Record<string, unknown>;
    expect(sc.committed).toBe(true);
    // `filesChanged` stays the true count; only the list is cut.
    expect(sc.filesChanged).toBe(MANY);
    // The headline's line totals are the whole commit's, not the listed cut's: every file is one
    // line, so the commit added MANY lines whatever `files` happens to list.
    expect(textOf(res).split('\n')[0]).toContain(`${MANY} file(s), +${MANY} -0,`);
    const files = sc.files as unknown[];
    const filesOmitted = sc.filesOmitted as number;
    expect(files.length).toBeGreaterThan(0);
    expect(filesOmitted).toBeGreaterThan(0);
    expect(files.length + filesOmitted).toBe(MANY);
    expect(sc.leftUncommitted).toEqual([]);
    expect(sc.leftUncommittedOmitted).toBe(0);
    expect(textOf(res)).toContain(`${filesOmitted} more`);
    expect(renderedSize(res)).toBeLessThan(COMMIT_CONTENT_BUDGET + 3000);

    await expectNoUndeclaredKeys(client, 'commit', sc);
  });
});
