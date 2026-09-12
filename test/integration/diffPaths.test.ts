import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import { createFakeRemote } from './helpers/bareRepo.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * `diff`'s `files[].path` is driven by `GitService`'s private `numstat()` helper, which runs
 * `git -c core.quotePath=false diff --no-renames --numstat`. Without those two flags,
 * `--numstat` applies rename detection by default (a `b.tex` created from `a.tex`'s exact
 * content, with `a.tex` deleted, logs as one `{a.tex => b.tex}`-shaped entry that names no
 * real file), and `core.quotePath` (on by default) C-quotes any non-ASCII path rather than
 * emitting UTF-8, so "résumé.tex" comes back as the literal string `"r\303\251sum\303\251.tex"`
 * (quotes included) — neither is a path a caller can feed back into `read_file`. This mirrors
 * `commitLogPaths.test.ts`, which pins the analogous fix for `logCommits` (via `status`).
 */

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup(files: Record<string, string>) {
  const remote = await createFakeRemote(files);
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-diffpaths-'));
  cleanups.push(remote.cleanup, () =>
    rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  );

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
  return client;
}

interface DiffFile {
  path: string;
  added: number;
  removed: number;
}

interface DiffStructured {
  diff: string;
  files: DiffFile[];
}

const UNSAFE_CHARS = /["{]|=>|\\/;

describe('diff reports plain, unquoted paths', () => {
  it('reports a rename as two plain paths and a non-ASCII path unquoted, vs a ref', async () => {
    const client = await setup({ 'a.tex': 'one\n', 'résumé.tex': 'alpha\nbeta\n' });

    // Modify résumé.tex in place.
    await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'résumé.tex', content: 'alpha\nbeta\ngamma\n' },
    });

    // Rename a.tex -> b.tex as far as `git diff` with rename detection is concerned: a new
    // file with a.tex's exact content, plus a.tex's deletion.
    await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'b.tex', content: 'one\n' },
    });
    await client.callTool({
      name: 'delete_file',
      arguments: { project: 'demo', path: 'a.tex' },
    });

    // A plain `diff` against `ref: 'HEAD'` diffs the *working tree* against HEAD, and plain
    // `git diff` never reports an untracked file (b.tex here, never `git add`ed by write_file —
    // see CLAUDE.md: "Mutating tools ... FileService knows nothing about git") — so it alone
    // cannot exercise rename detection; only a's deletion and résumé's edit would show. Commit
    // the rename for real (scope "all" stages everything, `git add -A`, the same way a user
    // would before this diff finds anyone to compare against), then diff the resulting commit
    // against its parent — the same shape `git diff --no-renames --numstat HEAD~1..HEAD` needs
    // to exercise the rename-collapse this fix removes.
    await client.callTool({
      name: 'commit',
      arguments: {
        project: 'demo',
        message: 'rename a.tex to b.tex, edit résumé.tex',
        scope: 'all',
      },
    });

    const res = await client.callTool({
      name: 'diff',
      arguments: { project: 'demo', ref: 'HEAD~1..HEAD' },
    });
    const structured = res.structuredContent as unknown as DiffStructured;

    const paths = structured.files.map((f) => f.path).sort();
    expect(paths).toEqual(['a.tex', 'b.tex', 'résumé.tex']);
    for (const p of paths) {
      expect(p).not.toMatch(UNSAFE_CHARS);
    }
  });

  it('reports a non-ASCII path unquoted for a working-tree diff (no ref)', async () => {
    const client = await setup({ 'résumé.tex': 'alpha\nbeta\n' });

    await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'résumé.tex', content: 'alpha\nbeta\ngamma\n' },
    });

    const res = await client.callTool({ name: 'diff', arguments: { project: 'demo' } });
    const structured = res.structuredContent as unknown as DiffStructured;

    const paths = structured.files.map((f) => f.path);
    expect(paths).toEqual(['résumé.tex']);
    expect(paths[0]).not.toMatch(UNSAFE_CHARS);
  });
});
