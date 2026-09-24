/**
 * Multi-backend reference lookup, driven through a real MCP client.
 *
 * The unit suites cover each backend and the resolver in isolation. What only an integration
 * test can show is that the wiring in `src/context.ts` and the two tools actually carry the
 * resolution decision end to end: that a substitution reaches the caller as a reported hint
 * rather than silently, that a pinned backend's failure surfaces as an error, and that
 * `add_citation` refuses an OpenAlex record with no DOI instead of inventing an entry.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFakeRemote } from './helpers/bareRepo.js';
import { createServer } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { GitService } from '../../src/services/gitService.js';
import { FileService } from '../../src/services/fileService.js';
import { CompilerResolver } from '../../src/services/compilerResolver.js';
import { PdfRenderer } from '../../src/services/pdfRender.js';
import { ViewerService } from '../../src/services/viewer.js';
import { SyncTexService } from '../../src/services/synctex.js';
import { CommentStore } from '../../src/services/commentStore.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { DoctorService } from '../../src/services/doctor.js';
import { ProjectManager } from '../../src/services/projectManager.js';
import { SessionRegistry } from '../../src/services/sessionRegistry.js';
import { ShelfStore } from '../../src/services/shelfStore.js';
import { ShadowStore } from '../../src/services/shadowStore.js';
import { RewriteModeStore } from '../../src/services/rewriteModeStore.js';
import { CredentialPortal } from '../../src/services/credentialPortal.js';
import { ReferenceResolver, type ReferenceBackends } from '../../src/services/referenceResolver.js';
import { BackendUnavailableError } from '../../src/services/referenceBackend.js';
import type { ReferenceHit } from '../../src/services/referenceBackend.js';
import { REFERENCE_SOURCES } from '../../src/lib/referenceKey.js';
import type { ReferenceSourceId } from '../../src/lib/referenceKey.js';
import type { AppContext } from '../../src/context.js';
import type { ServerConfig } from '../../src/types.js';

const CROSSREF_BIBTEX = '@inproceedings{He_2016,\n  title={Deep Residual Learning}\n}';

function hit(source: string, key: string, title: string): ReferenceHit {
  return { key, source, title, authors: ['Kaiming He'], year: 2016 };
}

const unusable = (b: string) => new BackendUnavailableError(b, `${b} is behind a bot wall.`);

/** A backend set where anything not overridden refuses loudly if consulted. */
function backends(over: Partial<ReferenceBackends>): ReferenceBackends {
  const nope = (id: string) => () => Promise.reject(new Error(`${id} must not be consulted`));
  return {
    dblp: { search: nope('dblp'), fetchBibtex: nope('dblp') },
    crossref: { search: nope('crossref'), fetchBibtex: nope('crossref') },
    openalex: { search: nope('openalex'), resolveDoi: nope('openalex') },
    ...over,
  };
}

describe('multi-backend reference lookup through a real MCP client', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
    vi.restoreAllMocks();
  });

  async function setup(
    refBackends: ReferenceBackends,
    opts: { source?: ReferenceSourceId; explicit?: boolean; invalidSource?: string } = {},
    // Server-level config the resolver knows nothing about. Kept apart from `opts` so the
    // resolver keeps receiving exactly what it received before.
    serverOpts: {
      contactEmail?: string;
      /**
       * A RAW `WEB_LATEX_MCP_CONTACT_EMAIL` value, resolved through the real `loadConfig` so a
       * rejected address is dropped exactly the way the server drops it — the test never hands
       * the config a value `loadConfig` would have refused, nor derives "invalid" itself.
       */
      contactEmailEnv?: string;
      referenceSourceInvalid?: string;
      /** Pinned by `WEB_LATEX_MCP_REFERENCE_SOURCE` — server-level, apart from the resolver's. */
      referenceSource?: ReferenceSourceId;
    } = {},
  ): Promise<{ client: Client; dir: string }> {
    const remote = await createFakeRemote({ 'main.tex': 'x\n', 'refs.bib': '' });
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-refs-'));
    cleanups.push(remote.cleanup, () => rm(workspace, { recursive: true, force: true }));

    const contact = serverOpts.contactEmailEnv
      ? loadConfig(
          { WEB_LATEX_MCP_CONTACT_EMAIL: serverOpts.contactEmailEnv },
          workspace,
          () => false,
          () => [],
          () => undefined,
        )
      : undefined;

    const config: ServerConfig = {
      workspaceRoot: workspace,
      sessionId: 'test',
      projects: [{ id: 'demo', gitUrl: remote.url }],
      defaultProject: 'demo',
      ...(serverOpts.contactEmail ? { contactEmail: serverOpts.contactEmail } : {}),
      ...(contact
        ? { contactEmail: contact.contactEmail, contactEmailInvalid: contact.contactEmailInvalid }
        : {}),
      ...(serverOpts.referenceSource
        ? { referenceSource: serverOpts.referenceSource, referenceSourceExplicit: true }
        : {}),
      ...(serverOpts.referenceSourceInvalid
        ? { referenceSourceInvalid: serverOpts.referenceSourceInvalid }
        : {}),
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
      references: new ReferenceResolver(refBackends, opts),
      doctor: new DoctorService(),
      sessions: new SessionRegistry(workspace, config.sessionId),
      shelves: new ShelfStore(workspace, config.sessionId),
      shadows: new ShadowStore(workspace, config.sessionId, (d, rel) =>
        git.readAtRefBytes(d, 'HEAD', rel),
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
    return { client, dir };
  }

  it('substitutes Crossref when DBLP is walled, and SAYS SO in both channels', async () => {
    const { client } = await setup(
      backends({
        dblp: {
          search: () => Promise.reject(unusable('DBLP')),
          fetchBibtex: () => Promise.reject(unusable('DBLP')),
        },
        crossref: {
          search: () =>
            Promise.resolve([hit('crossref', 'crossref:10.1109/cvpr.2016.90', 'ResNet')]),
          fetchBibtex: () => Promise.resolve(CROSSREF_BIBTEX),
        },
      }),
    );

    const res = await client.callTool({
      name: 'search_references',
      arguments: { query: 'deep residual learning' },
    });
    const sc = res.structuredContent as Record<string, unknown>;

    expect(sc.source).toBe('crossref');
    expect(sc.fallbackFrom).toBe('dblp');
    expect(String(sc.hint)).toMatch(/dblp could not be reached/);
    // A caller reading only the text channel must learn it too, or the substitution is silent.
    expect(JSON.stringify(res.content)).toMatch(/dblp could not be reached/);
    expect(res.isError).toBeFalsy();
  });

  it('reports zero hits as an answer from the first backend, consulting no other', async () => {
    const { client } = await setup(
      backends({
        dblp: {
          search: () => Promise.resolve([]),
          fetchBibtex: () => Promise.reject(new Error('x')),
        },
      }),
    );

    const res = await client.callTool({
      name: 'search_references',
      arguments: { query: 'nothing at all' },
    });
    const sc = res.structuredContent as Record<string, unknown>;

    expect(res.isError).toBeFalsy();
    expect(sc.count).toBe(0);
    expect(sc.source).toBe('dblp');
    expect(sc.fallbackFrom).toBeUndefined();
  });

  it('errors instead of substituting when the call pins a backend that is down', async () => {
    const { client } = await setup(
      backends({
        dblp: {
          search: () => Promise.reject(unusable('DBLP')),
          fetchBibtex: () => Promise.reject(unusable('DBLP')),
        },
        crossref: {
          search: () => Promise.resolve([hit('crossref', 'crossref:10.1/x', 'other')]),
          fetchBibtex: () => Promise.resolve(CROSSREF_BIBTEX),
        },
      }),
    );

    const res = await client.callTool({
      name: 'search_references',
      arguments: { query: 'resnet', source: 'dblp' },
    });

    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/was requested, so no other backend was tried/);
  });

  it('refuses search_references when WEB_LATEX_MCP_REFERENCE_SOURCE holds an unusable value', async () => {
    // The server started — that is the point. The typo costs the one tool it governs, by name,
    // rather than every tool via a dead process whose only explanation went to stderr.
    const { client } = await setup(
      backends({
        dblp: {
          search: () => Promise.resolve([hit('dblp', 'dblp:conf/x/y', 'ResNet')]),
          fetchBibtex: () => Promise.resolve(CROSSREF_BIBTEX),
        },
      }),
      { invalidSource: 'crossreff' },
      { referenceSourceInvalid: 'crossreff' },
    );

    const res = await client.callTool({
      name: 'search_references',
      arguments: { query: 'deep residual learning' },
    });

    expect(res.isError).toBe(true);
    const text = JSON.stringify(res.content);
    expect(text).toMatch(/crossreff/);
    expect(text).toMatch(/dblp, crossref, openalex/);
    expect(text).toMatch(/unset WEB_LATEX_MCP_REFERENCE_SOURCE/);
  });

  it('still searches when the CALL names a backend, despite the unusable env value', async () => {
    const { client } = await setup(
      backends({
        crossref: {
          search: () =>
            Promise.resolve([hit('crossref', 'crossref:10.1109/cvpr.2016.90', 'ResNet')]),
          fetchBibtex: () => Promise.resolve(CROSSREF_BIBTEX),
        },
      }),
      { invalidSource: 'crossreff' },
      { referenceSourceInvalid: 'crossreff' },
    );

    const res = await client.callTool({
      name: 'search_references',
      arguments: { query: 'deep residual learning', source: 'crossref' },
    });
    const sc = res.structuredContent as Record<string, unknown>;

    expect(res.isError).toBeFalsy();
    expect(sc.source).toBe('crossref');
    expect(sc.count).toBe(1);
  });

  it('still adds a citation despite the unusable env value — fetchBibtex routes by the key', async () => {
    const { client, dir } = await setup(
      backends({
        crossref: {
          search: () => Promise.resolve([]),
          fetchBibtex: () => Promise.resolve(CROSSREF_BIBTEX),
        },
      }),
      { invalidSource: 'crossreff' },
      { referenceSourceInvalid: 'crossreff' },
    );

    const res = await client.callTool({
      name: 'add_citation',
      arguments: { key: 'crossref:10.1109/CVPR.2016.90' },
    });
    const sc = res.structuredContent as Record<string, unknown>;

    expect(res.isError).toBeFalsy();
    expect(sc.added).toBe(true);
    expect(await readFile(path.join(dir, 'refs.bib'), 'utf8')).toContain('@inproceedings{He_2016,');
  });

  it('server_info surfaces the unusable value in BOTH channels', async () => {
    // server_info is the one tool a user calls to ask "why does search_references refuse", so
    // the misconfiguration has to be visible there — in the text too, not only structured.
    const { client } = await setup(
      backends({}),
      { invalidSource: 'crossreff' },
      { referenceSourceInvalid: 'crossreff' },
    );

    const res = await client.callTool({ name: 'server_info', arguments: {} });
    const sc = res.structuredContent as Record<string, unknown>;

    expect(sc.referenceSourceInvalid).toBe('crossreff');
    // Not reported as a pinned backend: a rejected value is nobody's choice.
    expect(sc.referenceSource).toBeUndefined();
    const text = JSON.stringify(res.content);
    expect(text).toMatch(/references:/);
    expect(text).toMatch(/crossreff/);
    expect(text).toMatch(/WEB_LATEX_MCP_REFERENCE_SOURCE/);
  });

  it('server_info and search_references quote an elided value alike, the count outside the quotes', async () => {
    // config.ts cuts a long rejected value to `<head>… (N characters)`; the count is the server's
    // note, not part of the value, so neither message may put it inside the quotes.
    const elided = `${'x'.repeat(120)}… (300 characters)`;
    const { client } = await setup(
      backends({}),
      { invalidSource: elided },
      { referenceSourceInvalid: elided },
    );

    const info = await client.callTool({ name: 'server_info', arguments: {} });
    const search = await client.callTool({
      name: 'search_references',
      arguments: { query: 'deep residual learning' },
    });
    const shown = `"${'x'.repeat(120)}"… (300 characters)`;
    for (const res of [info, search]) {
      const text = (res.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n');
      expect(text).toContain(shown);
      expect(text).not.toContain('characters)"');
    }
  });

  it('server_info says nothing about an invalid source when there is none', async () => {
    const { client } = await setup(backends({}));

    const res = await client.callTool({ name: 'server_info', arguments: {} });
    const sc = res.structuredContent as Record<string, unknown>;

    expect(sc.referenceSourceInvalid).toBeUndefined();
    expect(JSON.stringify(res.content)).not.toMatch(/WEB_LATEX_MCP_REFERENCE_SOURCE/);
  });

  it('add_citation routes a crossref key to Crossref and writes its bytes verbatim', async () => {
    const { client, dir } = await setup(
      backends({
        crossref: {
          search: () => Promise.resolve([]),
          fetchBibtex: () => Promise.resolve(CROSSREF_BIBTEX),
        },
      }),
      // Pinned to DBLP on purpose: the key must still route to Crossref.
      { source: 'dblp', explicit: true },
    );

    const res = await client.callTool({
      name: 'add_citation',
      arguments: { key: 'crossref:10.1109/CVPR.2016.90' },
    });
    const sc = res.structuredContent as Record<string, unknown>;

    expect(res.isError).toBeFalsy();
    expect(sc.added).toBe(true);
    expect(sc.source).toBe('crossref');
    expect(sc.via).toBeUndefined();
    expect(await readFile(path.join(dir, 'refs.bib'), 'utf8')).toContain('@inproceedings{He_2016,');
  });

  it('add_citation bridges an OpenAlex key through its DOI to Crossref, and reports the hop', async () => {
    const { client, dir } = await setup(
      backends({
        openalex: {
          search: () => Promise.resolve([]),
          resolveDoi: () => Promise.resolve('10.1109/cvpr.2016.90'),
        },
        crossref: {
          search: () => Promise.resolve([]),
          fetchBibtex: () => Promise.resolve(CROSSREF_BIBTEX),
        },
      }),
    );

    const res = await client.callTool({
      name: 'add_citation',
      arguments: { key: 'openalex:W2194775991' },
    });
    const sc = res.structuredContent as Record<string, unknown>;

    expect(sc.added).toBe(true);
    expect(sc.source).toBe('openalex');
    expect(sc.via).toBe('crossref');
    expect(JSON.stringify(res.content)).toContain('openalex via crossref');
    expect(await readFile(path.join(dir, 'refs.bib'), 'utf8')).toContain('@inproceedings{He_2016,');
  });

  it('REFUSES an OpenAlex record with no DOI, and leaves the .bib untouched', async () => {
    // The user's explicit decision: no DOI means no canonical entry exists, and the server
    // never assembles one from metadata. The refusal must not write a byte.
    const { client, dir } = await setup(
      backends({
        openalex: { search: () => Promise.resolve([]), resolveDoi: () => Promise.resolve(null) },
      }),
    );

    const res = await client.callTool({
      name: 'add_citation',
      arguments: { key: 'openalex:W999' },
    });

    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/carries no DOI/);
    expect(await readFile(path.join(dir, 'refs.bib'), 'utf8')).toBe('');
  });

  it('still refuses a hand-written .bib write — the guard is untouched by the new backends', async () => {
    const { client, dir } = await setup(backends({}));

    const res = await client.callTool({
      name: 'write_file',
      arguments: { path: 'refs.bib', content: '@misc{evil, title={hand-written}}' },
    });

    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('add_citation');
    expect(await readFile(path.join(dir, 'refs.bib'), 'utf8')).toBe('');
  });

  it('server_info says a polite-pool contact IS configured without reporting the address', async () => {
    // The address is the user's personal data and this output is read by a model, so
    // server_info reports only the boolean. Nothing else pinned that, which meant adding
    // `contactEmail` to the info object for a "helpful" line passed the whole suite. Both
    // channels are checked: structuredContent and the rendered text each reach the model on
    // their own, so a leak into either is the whole leak.
    const address = 'polite.pool.tester@example.invalid';
    const localPart = 'polite.pool.tester';
    const { client } = await setup(backends({}), {}, { contactEmail: address });

    const res = await client.callTool({ name: 'server_info', arguments: {} });
    const sc = res.structuredContent as Record<string, unknown>;

    expect(res.isError).toBeFalsy();
    expect(sc.contactEmailConfigured).toBe(true);

    const textChannel = JSON.stringify(res.content);
    const structuredChannel = JSON.stringify(sc);
    expect(textChannel).not.toContain(address);
    expect(structuredChannel).not.toContain(address);
    // Not just the whole address: a local part on its own still identifies the user, and a
    // field holding one would pass an exact-string check against the full address.
    expect(textChannel).not.toContain(localPart);
    expect(structuredChannel).not.toContain(localPart);
    // The boolean is the only signal, and the text says it in words rather than an address.
    expect(textChannel).toContain('polite-pool contact set');
  });

  it('server_info reports contactEmailConfigured false when no contact is configured', async () => {
    const { client } = await setup(backends({}));

    const res = await client.callTool({ name: 'server_info', arguments: {} });
    const sc = res.structuredContent as Record<string, unknown>;

    expect(res.isError).toBeFalsy();
    expect(sc.contactEmailConfigured).toBe(false);
    expect(JSON.stringify(res.content)).not.toContain('polite-pool contact set');
  });
  it('server_info says a REJECTED polite-pool contact was ignored, not merely absent', async () => {
    // A malformed WEB_LATEX_MCP_CONTACT_EMAIL used to be byte-identical to never setting it:
    // contactEmailConfigured false, no clause in the text. The polite pool was silently off
    // with nothing a tool could reach to explain why — only one stderr line at startup, which
    // most MCP clients bury. The invalid state REPLACES the reassuring clause, as an unusable
    // WEB_LATEX_MCP_REFERENCE_SOURCE replaces the fallback-order description above.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = await setup(
      backends({}),
      {},
      // Rejected by parseContactEmail: no dot in the domain.
      { contactEmailEnv: 'polite.pool.tester@localhost' },
    );

    const res = await client.callTool({ name: 'server_info', arguments: {} });
    const sc = res.structuredContent as Record<string, unknown>;

    expect(res.isError).toBeFalsy();
    expect(sc.contactEmailInvalid).toBe(true);
    // Still not "configured": the polite pool really is off. The flag explains it, not undoes it.
    expect(sc.contactEmailConfigured).toBe(false);

    const textChannel = JSON.stringify(res.content);
    expect(textChannel).toMatch(/polite-pool contact IGNORED/);
    expect(textChannel).toMatch(/WEB_LATEX_MCP_CONTACT_EMAIL/);
    // The reassuring clause must not sit beside the refusal.
    expect(textChannel).not.toContain('polite-pool contact set');
  });

  it('never reports the rejected address itself, in either channel', async () => {
    // A rejected value is just as much personal data as an accepted one, and this output is
    // read by a model. The sibling test above pins the valid case; the tempting "helpful" fix
    // here is to echo the offending value the way referenceSourceInvalid does, which is exactly
    // what must not happen.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const address = 'polite.pool.tester@localhost';
    const localPart = 'polite.pool.tester';
    const { client } = await setup(backends({}), {}, { contactEmailEnv: address });

    const res = await client.callTool({ name: 'server_info', arguments: {} });
    const sc = res.structuredContent as Record<string, unknown>;

    // Guard against passing vacuously by reporting nothing at all: the state IS reported.
    expect(sc.contactEmailInvalid).toBe(true);

    const textChannel = JSON.stringify(res.content);
    const structuredChannel = JSON.stringify(sc);
    expect(textChannel).not.toContain(address);
    expect(structuredChannel).not.toContain(address);
    expect(textChannel).not.toContain(localPart);
    expect(structuredChannel).not.toContain(localPart);
  });

  it('search_references does NOT promise a fallback the env value has disabled', async () => {
    // The model reads the description first and always. Promising "tries DBLP, then Crossref,
    // then OpenAlex" while an unpinned call is refused sends it to recover from an error it was
    // told could not happen — the same wrong turn server_info already refuses to take.
    const { client } = await setup(
      backends({}),
      { invalidSource: 'crossreff' },
      { referenceSourceInvalid: 'crossreff' },
    );

    const tools = await client.listTools();
    const description = tools.tools.find((t) => t.name === 'search_references')?.description ?? '';

    expect(description).toMatch(/WEB_LATEX_MCP_REFERENCE_SOURCE/);
    expect(description).toMatch(/refus/i);
    expect(description).toMatch(/source:/);
    // Every valid id, since passing one is the only way to search in this state.
    for (const id of REFERENCE_SOURCES) expect(description).toContain(id);
    expect(description).not.toMatch(/tries DBLP, then Crossref, then OpenAlex/);
  });

  it('carries the same truth in the `source` FIELD, not only the tool description', async () => {
    // The field's own .describe() repeated the tool description's promise verbatim — "omit it and
    // the server substitutes one that is unreachable" — two fields away from the clause that was
    // fixed. A model reads the field text while filling the call in, so leaving it behind would
    // have moved the lie rather than removed it. Both are derived from `config` now.
    const { client } = await setup(
      backends({}),
      { invalidSource: 'crossreff' },
      { referenceSourceInvalid: 'crossreff' },
    );

    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === 'search_references');
    const field = JSON.stringify(tool?.inputSchema.properties ?? {});

    expect(field).toMatch(/WEB_LATEX_MCP_REFERENCE_SOURCE/);
    expect(field).toMatch(/REFUSED/);
    expect(field).not.toMatch(/substitute one that is unreachable/);
  });

  it('describes the `source` field as pinned when the env names a real backend', async () => {
    const { client } = await setup(
      backends({}),
      { source: 'crossref', explicit: true },
      { referenceSource: 'crossref' },
    );

    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === 'search_references');
    const field = JSON.stringify(tool?.inputSchema.properties ?? {});

    expect(field).toMatch(/pins it/);
    expect(field).toContain('crossref');
    expect(field).not.toMatch(/substitute one that is unreachable/);
  });

  it('search_references describes a server-pinned backend as pinned, not as a fallback order', async () => {
    const { client } = await setup(
      backends({}),
      { source: 'crossref', explicit: true },
      { referenceSource: 'crossref' },
    );

    const tools = await client.listTools();
    const description = tools.tools.find((t) => t.name === 'search_references')?.description ?? '';

    expect(description).toMatch(/WEB_LATEX_MCP_REFERENCE_SOURCE/);
    expect(description).toMatch(/crossref/);
    expect(description).not.toMatch(/tries DBLP, then Crossref, then OpenAlex/);
  });

  it('search_references keeps the fallback wording when nothing is configured', async () => {
    // CONTROL: passes before and after this change. It is here so the two variants above cannot
    // be satisfied by deleting the default wording outright.
    const { client } = await setup(backends({}));

    const tools = await client.listTools();
    const description = tools.tools.find((t) => t.name === 'search_references')?.description ?? '';

    expect(description).toMatch(/tries DBLP, then Crossref, then OpenAlex/);
    expect(description).not.toMatch(/WEB_LATEX_MCP_REFERENCE_SOURCE/);
  });
});
