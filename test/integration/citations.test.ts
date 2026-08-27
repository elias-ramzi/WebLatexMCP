import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFakeRemote, type FakeRemote } from './helpers/bareRepo.js';
import { createServer } from '../../src/server.js';
import { GitService } from '../../src/services/gitService.js';
import { FileService } from '../../src/services/fileService.js';
import { CompilerResolver } from '../../src/services/compilerResolver.js';
import { PdfRenderer } from '../../src/services/pdfRender.js';
import { ViewerService } from '../../src/services/viewer.js';
import { SyncTexService } from '../../src/services/synctex.js';
import { CommentStore } from '../../src/services/commentStore.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { DblpService, type FetchResponse } from '../../src/services/dblp.js';
import { DoctorService } from '../../src/services/doctor.js';
import { ProjectManager } from '../../src/services/projectManager.js';
import { SessionRegistry } from '../../src/services/sessionRegistry.js';
import { ShadowStore } from '../../src/services/shadowStore.js';
import { RewriteModeStore } from '../../src/services/rewriteModeStore.js';
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
      // Never used here (no compile in this suite) — the resolver is inert until `select` is called.
      compiler: new CompilerResolver('latexmk', false),
      pdfRenderer: new PdfRenderer(),
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
      doctor: new DoctorService(),
      sessions: new SessionRegistry(workspace, config.sessionId),
      shadows: new ShadowStore(workspace, config.sessionId, (d, rel) =>
        git.readAtRef(d, 'HEAD', rel),
      ),
      rewriteModes: new RewriteModeStore(workspace),
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

  it('a no-op add_citation does not re-arm the guard over a hand edit', async () => {
    // The read that decides "already present" happens before the early return, so recording a
    // baseline there re-filed the user's hand edit as seen — wiping out a refusal the caller's
    // own earlier read had correctly armed. Same shape as a compile arming the guard while only
    // sniffing for a root file: a path that writes nothing must claim nothing.
    const { client, dir } = await setup({
      'main.tex': 'x\n',
      'refs.bib': '@misc{DBLP:conf/cvpr/HeZRS16, title={Already here}}\n',
    });

    // The caller reads it, so the guard is armed on what it saw.
    await client.callTool({
      name: 'read_file',
      arguments: { project: 'demo', path: 'refs.bib' },
    });

    // The user edits the bibliography by hand, in Overleaf.
    const edited = '@misc{DBLP:conf/cvpr/HeZRS16, title={Edited by the user}}\n';
    await writeFile(path.join(dir, 'refs.bib'), edited, 'utf8');

    const noop = await client.callTool({
      name: 'add_citation',
      arguments: { key: 'conf/cvpr/HeZRS16' },
    });
    expect((noop.structuredContent as { added: boolean }).added).toBe(false);

    const write = await client.callTool({
      name: 'write_file',
      arguments: {
        project: 'demo',
        path: 'refs.bib',
        content: '@misc{other, title={From the agent}}\n',
        confirmBibEdit: true,
      },
    });
    expect(JSON.stringify(write.content)).toContain('changed on disk');
    expect(await readFile(path.join(dir, 'refs.bib'), 'utf8')).toBe(edited);
  });

  it('add_citation still appends onto a hand-edited .bib rather than refusing', async () => {
    // It only ever appends to the bytes it just read under the project lock, so a hand edit is
    // built on, never lost — the staleness check would refuse a write that is already safe.
    const { client, dir } = await setup({
      'main.tex': 'x\n',
      'refs.bib': '@misc{seed, title={Seed}}\n',
    });
    await client.callTool({ name: 'read_file', arguments: { project: 'demo', path: 'refs.bib' } });
    await writeFile(path.join(dir, 'refs.bib'), '@misc{seed, title={Edited by hand}}\n', 'utf8');

    const added = await client.callTool({
      name: 'add_citation',
      arguments: { key: 'conf/cvpr/HeZRS16' },
    });
    expect(added.isError).toBeFalsy();
    const onDisk = await readFile(path.join(dir, 'refs.bib'), 'utf8');
    expect(onDisk).toContain('Edited by hand');
    expect(onDisk).toContain('Deep Residual Learning');
  });

  it('check_citations does not claim the files it scans have been seen', async () => {
    // It returns keys, paths, lines and titles — no file content — and it scans every .tex in the
    // project. Recording a baseline for all of them would let the next write overwrite a hand
    // edit made before the scan, and would hide those files from status's externalChanges.
    const { client, dir } = await setup({
      'main.tex': 'Text \\cite{seed} more.\n',
      'refs.bib': '@misc{seed, title={Seed}}\n',
    });

    await client.callTool({ name: 'read_file', arguments: { project: 'demo', path: 'main.tex' } });
    const edited = 'Edited by the user \\cite{seed}.\n';
    await writeFile(path.join(dir, 'main.tex'), edited, 'utf8');

    await client.callTool({ name: 'check_citations', arguments: { project: 'demo' } });

    const write = await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'main.tex', content: 'From the agent.\n' },
    });
    expect(JSON.stringify(write.content)).toContain('changed on disk');
    expect(await readFile(path.join(dir, 'main.tex'), 'utf8')).toBe(edited);

    // …and the user's edit is still visible as one.
    const status = await client.callTool({ name: 'status', arguments: { project: 'demo' } });
    expect((status.structuredContent as { externalChanges?: string[] }).externalChanges).toContain(
      'main.tex',
    );
  });

  it('list_references arms the guard for the bibliography it hands back', async () => {
    // Its entries go back to the caller verbatim, so a later whole-file write has to be able to
    // tell that the file moved underneath it.
    const { client, dir } = await setup({
      'main.tex': 'x\n',
      'refs.bib': '@misc{seed, title={Seed}}\n',
    });

    await client.callTool({ name: 'list_references', arguments: { project: 'demo' } });
    await writeFile(path.join(dir, 'refs.bib'), '@misc{seed, title={Edited by hand}}\n', 'utf8');

    const write = await client.callTool({
      name: 'write_file',
      arguments: {
        project: 'demo',
        path: 'refs.bib',
        content: '@misc{seed, title={From the agent}}\n',
        confirmBibEdit: true,
      },
    });
    expect(JSON.stringify(write.content)).toContain('changed on disk');
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
