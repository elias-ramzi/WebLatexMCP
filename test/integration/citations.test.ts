import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFakeRemote, type FakeRemote } from './helpers/bareRepo.js';
import { createServer } from '../../src/server.js';
import { GitService } from '../../src/services/gitService.js';
import { FileService } from '../../src/services/fileService.js';
import { LatexmkCompiler } from '../../src/services/compiler.js';
import { ViewerService } from '../../src/services/viewer.js';
import { SyncTexService } from '../../src/services/synctex.js';
import { CommentStore } from '../../src/services/commentStore.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { DblpService, type FetchResponse } from '../../src/services/dblp.js';
import { ProjectManager } from '../../src/services/projectManager.js';
import { SessionRegistry } from '../../src/services/sessionRegistry.js';
import { ShadowStore } from '../../src/services/shadowStore.js';
import { CredentialPortal } from '../../src/services/credentialPortal.js';
import type { AppContext } from '../../src/context.js';
import type { ServerConfig } from '../../src/types.js';

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

interface Harness {
  client: Client;
  dir: string;
  remote: FakeRemote;
}

describe('citation tools + .bib guard against a bare-repo stand-in', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  async function setup(files: Record<string, string>): Promise<Harness> {
    const remote = await createFakeRemote(files);
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-cite-'));
    cleanups.push(remote.cleanup, () => rm(workspace, { recursive: true, force: true }));
    const config: ServerConfig = {
      workspaceRoot: workspace,
      sessionId: 'test',
      projects: [{ id: 'demo', gitUrl: remote.url }],
      defaultProject: 'demo',
    };
    const pm = new ProjectManager(config);
    const git = new GitService();
    const dir = pm.projectPath('demo');
    await git.clone(remote.url, dir, { username: 'git' });

    const ctx: AppContext = {
      config,
      projectManager: pm,
      git,
      files: new FileService(),
      compiler: new LatexmkCompiler(),
      viewer: new ViewerService({
        knownIds: () => [],
        resolvePdfPath: async () => null,
        addComment: async () => {
          throw new Error('not used');
        },
        listComments: () => [],
        updateComment: () => null,
        deleteComment: () => false,
        undoDelete: () => null,
        resolveComments: () => 0,
      }),
      synctex: new SyncTexService(),
      comments: new CommentStore(),
      credentials: new CredentialResolver({}),
      dblp: new DblpService(() => Promise.resolve(ok(BIBTEX))),
      sessions: new SessionRegistry(workspace, config.sessionId),
      shadows: new ShadowStore(workspace, config.sessionId, (d, rel) =>
        git.readAtRef(d, 'HEAD', rel),
      ),
      credentialPortal: new CredentialPortal(async () => ({ persisted: false })),
    };
    ctx.files.setMutationRecorder({
      record: (projectDir, relPath, before, after) =>
        ctx.shadows.record('demo', projectDir, relPath, before, after),
    });

    const server = createServer(ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(() => client.close());
    return { client, dir, remote };
  }

  it('blocks a direct .bib write but allows it with confirmBibEdit', async () => {
    const { client, dir } = await setup({ 'main.tex': 'x\n', 'refs.bib': '' });

    const blocked = await client.callTool({
      name: 'write_file',
      arguments: { path: 'refs.bib', content: '@misc{evil, title={hand-written}}' },
    });
    expect(blocked.isError).toBe(true);
    expect(JSON.stringify(blocked.content)).toContain('add_citation');
    // File untouched.
    expect(await readFile(path.join(dir, 'refs.bib'), 'utf8')).toBe('');

    const allowed = await client.callTool({
      name: 'write_file',
      arguments: {
        path: 'refs.bib',
        content: '@misc{ok2020, title={Approved}}',
        confirmBibEdit: true,
      },
    });
    expect(allowed.isError).toBeFalsy();
    expect(await readFile(path.join(dir, 'refs.bib'), 'utf8')).toContain('ok2020');
  });

  it('add_citation appends DBLP-fetched BibTeX and is idempotent', async () => {
    const { client, dir } = await setup({
      'main.tex': 'x\n',
      'refs.bib': '@misc{seed, title={Seed}}\n',
    });

    const added = await client.callTool({
      name: 'add_citation',
      arguments: { key: 'conf/cvpr/HeZRS16' },
    });
    expect(added.isError).toBeFalsy();
    const structured = added.structuredContent as { added: boolean; key: string; path: string };
    expect(structured.added).toBe(true);
    expect(structured.key).toBe('DBLP:conf/cvpr/HeZRS16');
    expect(structured.path).toBe('refs.bib');

    const onDisk = await readFile(path.join(dir, 'refs.bib'), 'utf8');
    expect(onDisk).toContain('seed');
    expect(onDisk).toContain('Deep Residual Learning');

    // Adding the same key again is a no-op.
    const again = await client.callTool({
      name: 'add_citation',
      arguments: { key: 'conf/cvpr/HeZRS16' },
    });
    const againStructured = again.structuredContent as { added: boolean; alreadyPresent: boolean };
    expect(againStructured.added).toBe(false);
    expect(againStructured.alreadyPresent).toBe(true);
    expect(await readFile(path.join(dir, 'refs.bib'), 'utf8')).toBe(onDisk);
  });

  it('errors clearly when the target .bib is ambiguous', async () => {
    const { client } = await setup({ 'a.bib': '', 'b.bib': '' });
    const res = await client.callTool({
      name: 'add_citation',
      arguments: { key: 'conf/cvpr/HeZRS16' },
    });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('Multiple .bib files');
  });
});
