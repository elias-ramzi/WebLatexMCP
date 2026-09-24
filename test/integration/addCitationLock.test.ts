import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import { DblpService, type FetchResponse } from '../../src/services/dblp.js';
import { ReferenceResolver } from '../../src/services/referenceResolver.js';
import { createFakeRemote } from './helpers/bareRepo.js';
import type { ServerConfig } from '../../src/types.js';

// Two add_citation findings:
//
// F1 — the bibliography fetch used to run INSIDE runExclusive. An openalex: key costs a DOI hop
// plus a Crossref fetch (15s timeout each), so the project lock could be held for ~30s — the
// file lock's own wait timeout — and a peer's write_file/commit/render_pages queued behind it
// could fail with LockTimeoutError. The fetch touches no project state, so it now runs before
// the lock is taken.
//
// F2 — resolveBibFile judged only the literal name. A committed in-project link
// `refs.bib -> main.tex` passed isBibFile and add_citation appended BibTeX into main.tex.

const BIBTEX =
  '@inproceedings{DBLP:conf/cvpr/HeZRS16,\n' +
  '  author = {Kaiming He and others},\n' +
  '  title = {Deep Residual Learning for Image Recognition},\n' +
  '  year = {2016}\n}';

function ok(body: string): FetchResponse {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => body,
    json: async () => ({}),
  };
}

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function isError(res: unknown): boolean {
  return (res as { isError?: boolean }).isError === true;
}

function plainText(res: unknown): string {
  const content = (res as { content?: Array<{ text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? '').join('\n');
}

/** A DBLP backend whose fetch blocks until `release()`; `started` resolves once it is called. */
function slowDblp(): {
  service: DblpService;
  started: Promise<void>;
  release: () => void;
  released: () => boolean;
} {
  let markStarted!: () => void;
  const started = new Promise<void>((r) => (markStarted = r));
  let unblock!: () => void;
  const gate = new Promise<void>((r) => (unblock = r));
  let done = false;
  const service = new DblpService(async () => {
    markStarted();
    await gate;
    return ok(BIBTEX);
  });
  return {
    service,
    started,
    release: () => {
      done = true;
      unblock();
    },
    released: () => done,
  };
}

/** Only DBLP answers; the other two throw if a routing regression ever consults them. */
function resolverWith(dblp: DblpService): ReferenceResolver {
  return new ReferenceResolver({
    dblp,
    crossref: {
      search: () => Promise.reject(new Error('crossref must not be consulted')),
      fetchBibtex: () => Promise.reject(new Error('crossref must not be consulted')),
    },
    openalex: {
      search: () => Promise.reject(new Error('openalex must not be consulted')),
      resolveDoi: () => Promise.reject(new Error('openalex must not be consulted')),
    },
  });
}

async function setup(
  files: Record<string, string>,
  dblp: DblpService,
): Promise<{ client: Client; clone: string }> {
  const remote = await createFakeRemote(files);
  cleanups.push(remote.cleanup);
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-citelock-'));
  cleanups.push(() => rm(workspace, { recursive: true, force: true }));
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
  ctx.references = resolverWith(dblp);
  const server = createServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(() => client.close());
  const synced = await client.callTool({
    name: 'project_sync',
    arguments: { project: 'demo', mode: 'clone' },
  });
  expect(isError(synced)).toBe(false);
  return { client, clone: path.join(workspace, 'demo') };
}

/** A local project (used in place) that opted into following its own links. */
async function setupLocal(
  files: Record<string, string>,
  dblp: DblpService,
): Promise<{ client: Client; userDir: string }> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-citelock-ws-'));
  const userDir = await mkdtemp(path.join(os.tmpdir(), 'ovl-citelock-local-'));
  cleanups.push(
    () => rm(workspace, { recursive: true, force: true }),
    () => rm(userDir, { recursive: true, force: true }),
  );
  for (const [rel, content] of Object.entries(files)) {
    await writeFile(path.join(userDir, rel), content);
  }
  const config: ServerConfig = {
    workspaceRoot: workspace,
    sessionId: 'test',
    projects: [{ id: 'loc', mode: 'local', path: userDir, followSymlinks: true }],
    defaultProject: 'loc',
  };
  const ctx = createContext(
    config,
    new CredentialResolver({}),
    { name: 'Test', email: 'test@example.com' },
    new ProjectRegistry(workspace),
  );
  ctx.references = resolverWith(dblp);
  const server = createServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(() => client.close());
  return { client, userDir };
}

describe('add_citation does not hold the project lock across the network fetch', () => {
  it('a concurrent write_file completes while the bibliography fetch is still pending', async () => {
    const slow = slowDblp();
    const { client, clone } = await setup(
      { 'main.tex': '\\documentclass{article}\n', 'refs.bib': '' },
      slow.service,
    );
    const citing = client.callTool({
      name: 'add_citation',
      arguments: { project: 'demo', key: 'dblp:conf/cvpr/HeZRS16' },
    });
    let write: Promise<{ res: unknown; fetchReleasedFirst: boolean }> | undefined;
    try {
      await slow.started;

      write = client
        .callTool({
          name: 'write_file',
          arguments: { project: 'demo', path: 'notes.tex', content: 'peer write\n' },
        })
        .then((res) => ({ res, fetchReleasedFirst: slow.released() }));
      const TIMEOUT = Symbol('timeout');
      const raced = await Promise.race([
        write,
        new Promise<typeof TIMEOUT>((r) => setTimeout(() => r(TIMEOUT), 3000)),
      ]);
      expect(raced, 'write_file waited on the lock held across the fetch').not.toBe(TIMEOUT);
      if (raced === TIMEOUT) return;
      expect(isError(raced.res)).toBe(false);
      expect(raced.fetchReleasedFirst).toBe(false);
      expect(await readFile(path.join(clone, 'notes.tex'), 'utf8')).toBe('peer write\n');

      slow.release();
      const cited = await citing;
      expect(isError(cited)).toBe(false);
      expect(await readFile(path.join(clone, 'refs.bib'), 'utf8')).toContain(
        'DBLP:conf/cvpr/HeZRS16',
      );
    } finally {
      // Never leave the gate shut, and let the citation settle before the workspace is removed:
      // a pre-fix run would otherwise still hold the lock (and its session dir) during cleanup.
      slow.release();
      await citing.catch(() => undefined);
      await write?.catch(() => undefined);
    }
  }, 20_000);

  it('a missing .bib is reported without asking the bibliography service', async () => {
    let fetched = false;
    const dblp = new DblpService(async () => {
      fetched = true;
      return ok(BIBTEX);
    });
    const { client } = await setup({ 'main.tex': '\\documentclass{article}\n' }, dblp);
    const res = await client.callTool({
      name: 'add_citation',
      arguments: { project: 'demo', key: 'dblp:conf/cvpr/HeZRS16' },
    });
    expect(isError(res)).toBe(true);
    expect(plainText(res)).toMatch(/No \.bib file in the project/);
    expect(fetched).toBe(false);
  });
});

describe.skipIf(process.platform === 'win32')(
  'add_citation judges the link-resolved name of its target (posix only)',
  () => {
    const MAIN = '\\documentclass{article}\n\\begin{document}\nhi\n\\end{document}\n';

    async function withLink(): Promise<{ client: Client; clone: string }> {
      const dblp = new DblpService(async () => ok(BIBTEX));
      const h = await setup({ 'main.tex': MAIN, 'refs.bib': '' }, dblp);
      // Stand-in for a committed mode-120000 entry: what matters to FileService is the link in
      // the working tree.
      await unlink(path.join(h.clone, 'refs.bib'));
      await symlink('main.tex', path.join(h.clone, 'refs.bib'));
      return h;
    }

    it('refuses a discovered refs.bib that links to main.tex', async () => {
      // Discovery only lists a link when the project follows its links (a git clone's walk skips
      // them), so the discovered route is reachable through a local followSymlinks project.
      const dblp = new DblpService(async () => ok(BIBTEX));
      const { client, userDir } = await setupLocal({ 'main.tex': MAIN }, dblp);
      await symlink('main.tex', path.join(userDir, 'refs.bib'));
      const res = await client.callTool({
        name: 'add_citation',
        arguments: { project: 'loc', key: 'dblp:conf/cvpr/HeZRS16' },
      });
      expect(isError(res)).toBe(true);
      expect(plainText(res)).toMatch(/is a link to "main\.tex"/);
      expect(await readFile(path.join(userDir, 'main.tex'), 'utf8')).toBe(MAIN);
    });

    it('refuses an explicit bibFile that links to main.tex', async () => {
      const { client, clone } = await withLink();
      const res = await client.callTool({
        name: 'add_citation',
        arguments: { project: 'demo', key: 'dblp:conf/cvpr/HeZRS16', bibFile: 'refs.bib' },
      });
      expect(isError(res)).toBe(true);
      expect(plainText(res)).toMatch(/is a link to "main\.tex"/);
      expect(await readFile(path.join(clone, 'main.tex'), 'utf8')).toBe(MAIN);
    });

    it('still appends through a link whose target is a .bib (control)', async () => {
      const dblp = new DblpService(async () => ok(BIBTEX));
      const { client, clone } = await setup(
        { 'main.tex': MAIN, 'shared.bib': '@misc{a, title={A}}\n' },
        dblp,
      );
      await symlink('shared.bib', path.join(clone, 'refs.bib'));
      const res = await client.callTool({
        name: 'add_citation',
        arguments: { project: 'demo', key: 'dblp:conf/cvpr/HeZRS16', bibFile: 'refs.bib' },
      });
      expect(isError(res)).toBe(false);
      expect(await readFile(path.join(clone, 'shared.bib'), 'utf8')).toContain(
        'DBLP:conf/cvpr/HeZRS16',
      );
    });
  },
);
