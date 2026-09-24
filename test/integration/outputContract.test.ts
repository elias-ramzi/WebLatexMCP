/**
 * The advertised output contract of the tools no other test audits.
 *
 * Issue #130 established that the MCP SDK does not protect this contract: `McpServer` validates a
 * result against the advertised `outputSchema`, reads `parseResult.success` and throws
 * `parseResult.data` away — and a zod object *strips* rather than *stricts*. A **missing
 * required** field is therefore caught, and a field **present in `structuredContent` but absent
 * from the schema** is forwarded to every client unvalidated, unstripped, and undocumented.
 *
 * PR #135 built `test/helpers/outputSchema.ts` for that, and found one real hole
 * (`list_references`' `entries[].fields`, now #137). But it found it by monkeypatching
 * `Client.prototype.callTool` across the suite in a throwaway run, which sees only the tools the
 * suite happens to call with a `structuredContent` result — a **floor** on the holes, never a
 * ceiling, and not something CI re-runs. Re-instrumenting the suite the same way on `dev`
 * (2922 tests) shows six registered tools no test calls at all or calls only into an error:
 * `credential_portal`, `list_comments`, `resolve_comments`, `set_credential`, `viewer` and
 * `reset_to_remote`. Nothing whatsoever pinned their published shape.
 *
 * So this file does two things the per-field helpers cannot:
 *
 *  - it drives those six end to end through a real MCP client, and
 *  - it asserts with `expectNoUndeclaredKeys` that **nothing** they emit is undeclared — a check
 *    over the payload rather than over a pointer somebody thought to name, which is the only
 *    shape of assertion that can catch a key nobody knew to look for.
 *
 * The same sweep then runs over the local-project read/write tools, the PDF readers, the
 * git-backed set and the four bibliography tools — **all 38 registered tools** — so the audit
 * that was a throwaway script becomes something CI re-runs on every commit. The last four in
 * (`list_references`, `check_citations`, `search_references`, `add_citation`) needed fixtures
 * rather than a decision: `list_references` was held back only until #137's fix landed (#142),
 * and `search_references`/`add_citation` cannot answer at all without a bibliography backend, so
 * they drive the real `DblpService`/`CrossrefService`/`OpenAlexService` over a canned `fetch`
 * (see `stubbedReferences`) — production mapping code, canned bytes, no network. That the list
 * stays at "all of them" is itself asserted, in the last describe.
 *
 * What would make these fail: adding a key to any of these handlers' `structuredContent` without
 * adding it to the tool's `outputSchema` (or deleting one from the schema while the handler still
 * emits it). That is exactly the change #128, #137 and #146 all were.
 *
 * What it cannot catch, and no amount of tools in the list would change:
 *
 *  - a key on a **branch no call here takes**. Declaredness is judged over the payload a call
 *    actually returned, so an undeclared key that only a conflict, a refusal or an exotic option
 *    produces is invisible until some test drives that branch. Hence the deliberate second calls
 *    below — `add_citation`'s already-present branch, `search_references`' substitution, and
 *    `check_citations`' cross-project one — each of which emits keys the first call does not.
 *  - an **empty array or an absent optional**: there is no element to judge and no key to check,
 *    which is why the fixtures here go out of their way to populate both.
 *  - the *reverse* hole — a field the schema declares that the handler never sends. The SDK
 *    accepts that silently too; `expectUndeclaredField` is the helper for pinning it, per field.
 */
import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext, type AppContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { GitService } from '../../src/services/gitService.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import { CompilerResolver } from '../../src/services/compilerResolver.js';
import { ReferenceResolver } from '../../src/services/referenceResolver.js';
import { DblpService } from '../../src/services/dblp.js';
import { CrossrefService } from '../../src/services/crossref.js';
import { OpenAlexService } from '../../src/services/openalex.js';
import { buildPdfPath, logBaseDir } from '../../src/services/compiler.js';
import { minimalPdf } from '../helpers/minimalPdf.js';
import {
  advertisedOutputSchema,
  expectNoUndeclaredKeys,
  undeclaredKeys,
} from '../helpers/outputSchema.js';
import { createFakeRemote } from './helpers/bareRepo.js';
import type { CompileOutcome, CompileRequest } from '../../src/services/compiler.js';
import type { ExecResult } from '../../src/lib/exec.js';
import type { FetchLike, FetchResponse } from '../../src/services/referenceBackend.js';
import type { ServerConfig } from '../../src/types.js';

const IDENTITY = { name: 'Test', email: 'test@example.com' };

const MAIN_TEX = [
  '\\documentclass{article}',
  '\\begin{document}',
  '\\section{Intro}',
  'The opening line mentions \\cite{knuth1984}.',
  'A second line, so a five-line snippet has something to clamp against.',
  '\\end{document}',
  '',
].join('\n');

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function structured(res: unknown): Record<string, unknown> | undefined {
  return (res as { structuredContent?: Record<string, unknown> }).structuredContent;
}

function isError(res: unknown): boolean {
  return (res as { isError?: boolean }).isError === true;
}

function textOf(res: unknown): string {
  return ((res as { content?: Array<{ text?: string }> }).content ?? [])
    .map((c) => c.text ?? '')
    .join('\n');
}

/**
 * A client used for nothing but reading advertised schemas.
 *
 * It has to be a separate one, and that is not tidiness. `Client.listTools()` compiles an ajv
 * validator per advertised `outputSchema` and `callTool` then checks every later result against
 * it — and since `zod`'s JSON Schema conversion marks every object `additionalProperties: false`,
 * an undeclared key makes the SDK *reject the whole result* client-side. Resolving the schema
 * through the same client that drives the calls would therefore arm that check half-way through a
 * test and turn "here is the undeclared key" into an opaque `-32602` from the call before it.
 * Which behaviour is under test is decided per test here (see `prime`), never as a side effect of
 * asking what the schema says. Built off a bare `createServer` — registration touches no context.
 */
const schemaClient = await (async () => {
  const server = createServer({} as unknown as AppContext);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'schema-only', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
})();

/**
 * Call a tool, insist it did not error, and check every key it emitted against the schema the
 * server publishes for it. The error check is not decoration: a refused call returns
 * `isError: true` with no `structuredContent`, and without this an argument that stopped being
 * valid would turn the audit into a test that cannot fail. It is the exact trap #135's throwaway
 * run walked into for `reset_to_remote` (one call, one error, zero contract coverage).
 */
async function auditCall(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  opts: { knownUndeclared?: string[] } = {},
): Promise<Record<string, unknown>> {
  const res = await client.callTool({ name, arguments: args });
  expect(isError(res), `\`${name}\` refused the call: ${textOf(res)}`).toBe(false);
  await expectNoUndeclaredKeys(schemaClient, name, structured(res), opts);
  return structured(res)!;
}

/**
 * List the tools, the way every real client does once at startup — which is what arms the SDK's
 * *client-side* result validator (see `schemaClient` above).
 *
 * Off by default in the harnesses here, deliberately. Once armed, an undeclared key surfaces as
 * an ajv `-32602` thrown out of `callTool`, which names the object that failed but not the key,
 * and never reaches `expectNoUndeclaredKeys`' message at all. Everything else that validator adds
 * — required fields, types — `McpServer` already enforces server-side against the same zod
 * schema, so priming buys `additionalProperties` and costs the one diagnostic worth having.
 * It is turned on where the rejection itself is the subject.
 */
async function prime(client: Client): Promise<void> {
  await client.listTools();
}

/** A stand-in engine that "produces" whatever PDF the test staged, so no TeX is needed. */
function stubCompiler(pdfPath: string) {
  return {
    isAvailable: async () => true,
    compile: async (req: CompileRequest): Promise<CompileOutcome> => ({
      success: true,
      pdfPath,
      durationSec: 0.1,
      // A log carrying one -file-line-error and one box warning, so `errors[]`/`warnings[]` are
      // both populated: an empty array declares nothing about its element shape.
      log: [
        './main.tex:4: Undefined control sequence.',
        'l.4 The opening line mentions \\cite',
        'Overfull \\hbox (12.0pt too wide) in paragraph at lines 4--5',
        'Output written on main.pdf (1 page).',
      ].join('\n'),
      timedOut: false,
      logBaseDir: logBaseDir(req.rootFile),
      rebuilt: true,
    }),
  };
}

interface LocalHarness {
  client: Client;
  ctx: AppContext;
  userDir: string;
}

async function localHarness(exec?: (cmd: string, args: string[]) => Promise<ExecResult>) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-contract-ws-'));
  const userDir = await mkdtemp(path.join(os.tmpdir(), 'wlm-contract-dir-'));
  cleanups.push(
    () => rm(workspace, { recursive: true, force: true }),
    () => rm(userDir, { recursive: true, force: true }),
  );
  await writeFile(path.join(userDir, 'main.tex'), MAIN_TEX);

  // Where `compile` would have left a PDF, so render_pages / extract_text / pdf_geometry find one.
  const pdfPath = buildPdfPath(userDir, 'main.tex');
  await mkdir(path.dirname(pdfPath), { recursive: true });
  await writeFile(pdfPath, minimalPdf(1, 200, 100));
  cleanups.push(() => rm(path.dirname(pdfPath), { recursive: true, force: true }));

  const config: ServerConfig = {
    workspaceRoot: workspace,
    sessionId: 'contract',
    projects: [{ id: 'doc', mode: 'local', path: userDir }],
    defaultProject: 'doc',
    // `add_writing_convention` is the one write in the server that lands outside every project
    // sandbox, and it refuses outright when no destination is configured. Point it at a file
    // under the (temporary) workspace so the call reaches its success branch — and so the one
    // test that makes it writes nowhere a developer would notice.
    extraWritingGuidePath: path.join(workspace, 'writing-guide-extra.md'),
  };
  const ctx = createContext(
    config,
    new CredentialResolver({}, exec),
    IDENTITY,
    new ProjectRegistry(workspace),
  );
  ctx.compiler = new CompilerResolver('latexmk', false, () => stubCompiler(pdfPath));
  const server = createServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'contract', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  // Both bind a loopback port on demand and keep the process alive until closed.
  cleanups.unshift(
    () => client.close(),
    () => ctx.viewer.close(),
    () => ctx.credentialPortal.close(),
  );
  return { client, ctx, userDir } satisfies LocalHarness;
}

describe('output contract: the tools no committed test audited', () => {
  it('viewer publishes every key it returns', async () => {
    const { client } = await localHarness();

    // target "vscode" returns the URL and never launches a browser, so this starts a loopback
    // server and nothing else — no window opens on a developer's machine or a CI runner.
    const out = await auditCall(client, 'viewer', { project: 'doc', target: 'vscode' });

    expect(out.target).toBe('vscode');
    expect(out.opened).toBe(false);
    expect(String(out.url)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
  });

  it('list_comments publishes every key it returns, snippet fields included', async () => {
    const { client, ctx } = await localHarness();
    // Seeded directly: the viewer's own POST path is covered in test/unit/viewerService.test.ts,
    // and what is under test here is the shape `list_comments` publishes. `file`/`line` point at
    // a real source file so the optional `snippet`/`snippetStartLine` are actually populated — an
    // absent optional key proves nothing about whether the schema declares it.
    ctx.comments.add('doc', {
      page: 1,
      x: 10,
      y: 20,
      note: 'tighten this',
      quote: 'The opening line',
      file: 'main.tex',
      line: 4,
    });

    const out = await auditCall(client, 'list_comments', { project: 'doc' });

    const comments = out.comments as Array<Record<string, unknown>>;
    expect(comments).toHaveLength(1);
    // The store's own record carries `project`, `order`, `x`, `y` and `rects`, none of which the
    // schema declares. They are absent because the handler rebuilds the object field by field;
    // a `{ ...comment }` spread here would be the #137 defect exactly, and is what the
    // declaredness check above would catch.
    expect(comments[0]!.snippet).toBeTypeOf('string');
    expect(comments[0]!.snippetStartLine).toBe(2);
    expect(Object.keys(comments[0]!)).not.toContain('project');
  });

  it('resolve_comments publishes every key it returns', async () => {
    const { client, ctx } = await localHarness();
    ctx.comments.add('doc', { page: 1, x: 1, y: 2, note: 'one' });
    ctx.comments.add('doc', { page: 1, x: 3, y: 4, note: 'two' });

    const out = await auditCall(client, 'resolve_comments', { project: 'doc' });

    expect(out.resolved).toBe(2);
  });

  it('credential_portal publishes every key it returns', async () => {
    const { client } = await localHarness();

    // `open: false` keeps it to a loopback page nobody opens; no token is entered, so the result
    // is the awaiting-entry branch — the one that carries the two optional keys (`url`,
    // `opened`) the stored/not-persisted branch omits.
    const out = await auditCall(client, 'credential_portal', {
      host: 'git.example.com',
      username: 'git',
      open: false,
    });

    expect(out.status).toBe('awaiting-entry');
    expect(out.opened).toBe(false);
    expect(String(out.url)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
  });

  it('set_credential publishes every key it returns', async () => {
    // The subprocess runner is injected, so nothing reaches a real keychain: `credential approve`
    // is accepted and `credential fill` reads the same value back, which is what makes
    // `persisted` true without this test storing anything on the machine running it.
    const TOKEN = 'not-a-real-token';
    const { client } = await localHarness(async (cmd, args) => {
      if (cmd === 'git' && args[0] === 'credential') {
        if (args[1] === 'approve') return { code: 0, stdout: '', stderr: '', timedOut: false };
        if (args[1] === 'fill') {
          return {
            code: 0,
            stdout: `protocol=https\nhost=git.example.com\nusername=git\npassword=${TOKEN}\n`,
            stderr: '',
            timedOut: false,
          };
        }
      }
      return { code: 1, stdout: '', stderr: 'not found', timedOut: false };
    });

    const out = await auditCall(client, 'set_credential', {
      token: TOKEN,
      host: 'git.example.com',
      username: 'git',
      confirm: true,
    });

    expect(out).toMatchObject({ host: 'git.example.com', username: 'git', persisted: true });
    // And the schema declares no field for it, so the declaredness check above would have named
    // one had the handler grown a `token` key — but say it outright too.
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });
});

describe('output contract: the local-project read and write tools', () => {
  it('publishes every key each of them returns', async () => {
    const { client, userDir } = await localHarness();

    await auditCall(client, 'server_info', {});
    await auditCall(client, 'list_projects', {});
    await auditCall(client, 'list_skills', {});
    await auditCall(client, 'list_files', { project: 'doc' });
    await auditCall(client, 'doctor', {});
    await auditCall(client, 'set_rewrite_mode', { project: 'doc', mode: 'prose' });
    await auditCall(client, 'read_file', { project: 'doc', path: 'main.tex' });
    await auditCall(client, 'search_files', { project: 'doc', pattern: 'opening' });
    await auditCall(client, 'write_file', {
      project: 'doc',
      path: 'notes.tex',
      content: 'a line\nanother line\n',
    });
    await auditCall(client, 'edit_file', {
      project: 'doc',
      path: 'notes.tex',
      edits: [{ oldString: 'a line', newString: 'a changed line' }],
    });
    await auditCall(client, 'delete_file', { project: 'doc', path: 'notes.tex', confirm: true });
    // Inline base64 rather than a `sourcePath`: the source-side allowlist is what makes reading
    // from outside every sandbox accountable, and this test has no business exercising it. The
    // four bytes are a PNG signature, which is all the destination check looks at.
    await auditCall(client, 'add_asset', {
      project: 'doc',
      path: 'figures/plot.png',
      contentBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
      createDirs: true,
    });
    // Re-registers `doc` itself: a second id for the same directory is refused (one directory,
    // one project — `ProjectManager.assertDirUnclaimed`), and the same id is an update.
    await auditCall(client, 'register_project', { project: 'doc', path: userDir });
    await auditCall(client, 'add_writing_convention', {
      rule: "Always write 'lidar', never 'LiDAR'.",
      confirmGuideEdit: true,
    });
  });

  it('publishes every key the PDF-reading tools return', async () => {
    const { client } = await localHarness();

    // `compile` first, both for its own contract and because the three below read the build dir
    // it leaves behind. The stubbed log carries a located error and a box warning, so `errors[]`
    // and `warnings[]` are non-empty and their element shape is actually judged.
    const compiled = await auditCall(client, 'compile', { project: 'doc' });
    expect((compiled.errors as unknown[]).length).toBeGreaterThan(0);
    expect((compiled.warnings as unknown[]).length).toBeGreaterThan(0);

    await auditCall(client, 'extract_text', { project: 'doc' });
    await auditCall(client, 'render_pages', { project: 'doc', pages: [1] });
    await auditCall(client, 'pdf_geometry', { project: 'doc', pages: [1] });
  });
});

describe('output contract: the git-backed tools', () => {
  async function gitHarness(opts: { prime?: boolean } = {}) {
    const remote = await createFakeRemote({ 'main.tex': MAIN_TEX });
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-contract-git-'));
    cleanups.push(remote.cleanup, () => rm(workspace, { recursive: true, force: true }));
    const dir = path.join(workspace, 'demo');
    await new GitService(IDENTITY).clone(remote.url, dir, { username: 'git' });

    const config: ServerConfig = {
      workspaceRoot: workspace,
      sessionId: 'contract-git',
      projects: [{ id: 'demo', gitUrl: remote.url }],
      defaultProject: 'demo',
    };
    const ctx = createContext(config, new CredentialResolver({}), IDENTITY);
    const server = createServer(ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'contract-git', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.unshift(() => client.close());
    if (opts.prime) await prime(client);
    return { client, dir };
  }

  it('reset_to_remote publishes every key it returns', async () => {
    const { client } = await gitHarness();
    // A local commit to discard, so `discardedCommits[]` is non-empty and its element shape is
    // judged rather than skipped over as an empty array.
    await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'main.tex', content: `${MAIN_TEX}local edit\n` },
    });
    await client.callTool({
      name: 'commit',
      arguments: { project: 'demo', message: 'local work' },
    });

    const out = await auditCall(client, 'reset_to_remote', { project: 'demo', confirm: true });

    expect(out.reset).toBe(true);
    expect((out.discardedCommits as unknown[]).length).toBe(1);
  });

  it('status, diff, commit, discard and revert publish every key they return', async () => {
    const { client } = await gitHarness();

    await auditCall(client, 'status', { project: 'demo' });
    await auditCall(client, 'project_sync', { project: 'demo' });

    await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'main.tex', content: `${MAIN_TEX}one more line\n` },
    });
    await auditCall(client, 'diff', { project: 'demo' });
    const committed = await auditCall(client, 'commit', {
      project: 'demo',
      message: 'a commit to revert',
    });
    expect(committed.committed).toBe(true);

    await auditCall(client, 'revert', {
      project: 'demo',
      commits: [String(committed.sha)],
      confirm: true,
    });
    await auditCall(client, 'discard', { project: 'demo', confirm: true });
  });

  it('push publishes every key it returns on a clean push', async () => {
    const { client } = await gitHarness();
    await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'main.tex', content: `${MAIN_TEX}pushed line\n` },
    });
    await client.callTool({ name: 'commit', arguments: { project: 'demo', message: 'to push' } });

    // The conflict branch of this payload is already budgeted and audited by
    // pushConflictBudget.test.ts; the ordinary success branch — a different set of keys — was
    // not, and it is the one every push takes.
    const out = await auditCall(client, 'push', { project: 'demo', confirm: true });

    expect(out.status).toBe('pushed');
    expect(out.pushed).toBe(true);
  });

  /**
   * `shelve`/`unshelve`/`list_shelves` publish every key they return, `version` included.
   *
   * `ShelfManifest` carries `version: 1` and all three handlers hand the manifest out with a
   * `{ ...manifest }` spread. `shelfShape` declared six fields and not that one (#146), so the
   * audit below ran with `knownUndeclared` pins; declaring `version` is what deleted them, and
   * the whole-set comparison in `expectNoUndeclaredKeys` is what forced that deletion rather
   * than letting a stale allow-list stand. Unlike `compile`'s `warnings[].snippet` (an explicit
   * `undefined`, which JSON drops before the wire — the non-hole #137 records), this is a number
   * and does reach the client.
   */
  it('shelve, unshelve and list_shelves publish every key they return', async () => {
    const { client } = await gitHarness();
    await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'main.tex', content: `${MAIN_TEX}shelf me\n` },
    });

    const shelved = await auditCall(client, 'shelve', { project: 'demo', paths: ['main.tex'] });
    const id = String((shelved.shelf as Record<string, unknown>).id);

    await auditCall(client, 'list_shelves', { project: 'demo' });
    await auditCall(client, 'unshelve', { project: 'demo', id });
  });

  /**
   * And what the hole cost, which is the part a "merely undocumented field" reading missed.
   *
   * `zod`'s JSON Schema conversion marks every object `additionalProperties: false` — all 38
   * advertised schemas, every nested object in them — and the SDK's own `Client` compiles an ajv
   * validator per schema during `listTools()` and checks every later `callTool` result against
   * it. So for any client built on the SDK (i.e. every one that lists tools at startup, which is
   * all of them) these three tools did not return a slightly-too-wide payload: they **failed**,
   * with `-32602` and no result at all. This is the test #145 wrote as
   * `rejects.toThrow(/must NOT have additional properties/)`, flipped by #146's fix — so it now
   * pins the callability, against a client primed exactly the way a real one is.
   */
  it('and an SDK client that listed tools first can call shelve and get a result', async () => {
    const { client } = await gitHarness({ prime: true });
    await client.callTool({
      name: 'write_file',
      arguments: { project: 'demo', path: 'main.tex', content: `${MAIN_TEX}shelf me\n` },
    });

    const shelved = await client.callTool({
      name: 'shelve',
      arguments: { project: 'demo', paths: ['main.tex'] },
    });
    expect(isError(shelved), textOf(shelved)).toBe(false);
    const shelf = structured(shelved)!.shelf as Record<string, unknown>;
    // The key the validator used to reject the whole result over, now arriving intact: asserting
    // its value (not merely that the promise resolved) is what shows the payload reached the
    // client rather than the field having been dropped to appease the schema.
    expect(shelf.version).toBe(1);
    const id = String(shelf.id);

    const listed = await client.callTool({ name: 'list_shelves', arguments: { project: 'demo' } });
    expect(isError(listed), textOf(listed)).toBe(false);
    const shelves = structured(listed)!.shelves as Array<Record<string, unknown>>;
    expect(shelves.map((s) => [s.id, s.version])).toEqual([[id, 1]]);

    // unshelve spreads the same manifest through a third site, so it gets the same check.
    const restored = await client.callTool({
      name: 'unshelve',
      arguments: { project: 'demo', id },
    });
    expect(isError(restored), textOf(restored)).toBe(false);
    expect((structured(restored)!.shelf as Record<string, unknown>).version).toBe(1);
  });

  it('reports a key shelve does not declare rather than letting an empty check stand in', async () => {
    // Guards the guard. `undeclaredKeys` returning [] is the pass condition for every audit in
    // this file, so a version of it that had stopped walking into a nested object would make the
    // whole file pass vacuously. `version` used to be the live finding here; now that it is
    // declared, the probe is a key the schema certainly does not declare, in the same nested
    // position, so the walk itself is still what is asserted.
    const schema = await advertisedOutputSchema(schemaClient, 'shelve');

    expect(
      undeclaredKeys(schema, {
        shelf: { id: 'sh-0', version: 1, notAField: 1, files: [] },
        restored: [],
      }),
    ).toEqual(['shelf.notAField']);
  });
});

/**
 * The bibliography tools' fixtures.
 *
 * `refs.bib` deliberately carries one of each finding `check_citations` reports — a cited entry,
 * an entry nothing cites, a key defined twice, and an entry missing fields its type requires — so
 * all four of its result arrays come back non-empty. An empty array declares nothing about its
 * element shape, which is the whole subject here.
 */
const REFS_BIB = [
  '@inproceedings{knuth1984,',
  '  author = {Donald E. Knuth},',
  '  title = {The {TeX}book},',
  '  booktitle = {Computers and Typesetting},',
  '  year = {1984},',
  '}',
  '',
  '@inproceedings{knuth1984,',
  '  author = {Donald E. Knuth},',
  '  title = {The {TeX}book, again},',
  '  booktitle = {Computers and Typesetting},',
  '  year = {1984},',
  '}',
  '',
  '@article{incomplete2021,',
  '  title = {An entry that never states who wrote it},',
  '}',
  '',
  '@book{uncited1999,',
  '  author = {A. N. Other},',
  '  title = {Nobody Cites This},',
  '  publisher = {A Press},',
  '  year = {1999},',
  '}',
  '',
].join('\n');

/** A `thebibliography`, so `entries[].format: "bibitem"` is exercised as well. */
const BIBLIST_TEX = [
  '\\begin{thebibliography}{9}',
  '\\bibitem{lamport1994} Leslie Lamport. LaTeX: A Document Preparation System. 1994.',
  '\\end{thebibliography}',
  '',
].join('\n');

/** A prose reference list, the third shape — its entries are labelled, not keyed. */
const PROSE_MD = [
  '# Notes',
  '',
  '## References',
  '',
  '1. Mittelbach, F. (2004). The LaTeX Companion. Addison-Wesley.',
  '',
].join('\n');

/** A second project's shared bibliography, for the `bibliographyProject` branch. */
const SHARED_BIB = [
  '@inproceedings{knuth1984,',
  '  title = {The {TeX}book, as the group keeps it},',
  '}',
  '',
  '@inproceedings{knuth1984,',
  '  title = {The {TeX}book, kept twice},',
  '}',
  '',
].join('\n');

const DBLP_SEARCH_JSON = JSON.stringify({
  result: {
    hits: {
      hit: [
        {
          info: {
            key: 'conf/cvpr/HeZRS16',
            title: 'Deep Residual Learning for Image Recognition.',
            year: '2016',
            venue: 'CVPR',
            type: 'Conference and Workshop Papers',
            doi: '10.1109/CVPR.2016.90',
            url: 'https://dblp.org/rec/conf/cvpr/HeZRS16',
            authors: {
              author: [
                { '@pid': '1', text: 'Kaiming He' },
                { '@pid': '2', text: 'Xiangyu Zhang' },
              ],
            },
          },
        },
      ],
    },
  },
});

const DBLP_BIBTEX = [
  '@inproceedings{DBLP:conf/cvpr/HeZRS16,',
  '  author    = {Kaiming He and Xiangyu Zhang},',
  '  title     = {Deep Residual Learning for Image Recognition},',
  '  booktitle = {CVPR},',
  '  year      = {2016},',
  '  doi       = {10.1109/CVPR.2016.90}',
  '}',
  '',
].join('\n');

const CROSSREF_SEARCH_JSON = JSON.stringify({
  message: {
    items: [
      {
        DOI: '10.1109/cvpr.2016.90',
        title: ['Deep Residual Learning for Image Recognition'],
        author: [{ given: 'Kaiming', family: 'He' }],
        issued: { 'date-parts': [[2016]] },
        'container-title': ['2016 IEEE Conference on Computer Vision and Pattern Recognition'],
        type: 'proceedings-article',
        URL: 'https://doi.org/10.1109/cvpr.2016.90',
      },
    ],
  },
});

const CROSSREF_BIBTEX = [
  '@inproceedings{He_2016,',
  '  author    = {He, Kaiming},',
  '  title     = {Deep Residual Learning for Image Recognition},',
  '  booktitle = {CVPR},',
  '  year      = {2016},',
  '  doi       = {10.1109/cvpr.2016.90}',
  '}',
  '',
].join('\n');

const OPENALEX_WORK_JSON = JSON.stringify({
  id: 'https://openalex.org/W2194775991',
  doi: 'https://doi.org/10.1109/cvpr.2016.90',
  publication_year: 2016,
});

function okBody(body: string): FetchResponse {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => body,
    json: async () => JSON.parse(body) as unknown,
  };
}

function unreachable(): FetchResponse {
  return {
    ok: false,
    status: 503,
    statusText: 'Service Unavailable',
    text: async () => '',
    json: async () => ({}),
  };
}

/**
 * A resolver over the **real** backend services, each with a canned `fetch`.
 *
 * Handing `ReferenceResolver` three hand-written fake backends would be shorter — that is what
 * `referenceBackends.test.ts` does, and it is right for a test about the resolver's *decision*.
 * It is the wrong instrument here: this file audits what the tools **emit**, and a hand-built
 * `ReferenceHit` carries exactly the keys the test author typed. Driving `DblpService` /
 * `CrossrefService` / `OpenAlexService` for real means `results[]` is assembled by the production
 * mapping code, so a field one of those clients grows is a field this audit sees.
 *
 * Each service gets its own stub, so nothing has to disambiguate one backend's `/works` from
 * another's, and an unexpected URL fails loudly rather than being answered by the wrong canned body.
 */
function stubbedReferences(opts: { dblpDown?: boolean } = {}): ReferenceResolver {
  const route =
    (name: string, table: Array<[string, string]>): FetchLike =>
    async (url: string) => {
      const match = table.find(([fragment]) => url.includes(fragment));
      if (!match) throw new Error(`the ${name} stub was asked for an unexpected URL: ${url}`);
      return okBody(match[1]);
    };
  return new ReferenceResolver({
    dblp: new DblpService(
      opts.dblpDown
        ? async () => unreachable()
        : route('DBLP', [
            ['/search/publ/api', DBLP_SEARCH_JSON],
            ['/rec/', DBLP_BIBTEX],
          ]),
    ),
    crossref: new CrossrefService(
      route('Crossref', [
        ['/transform', CROSSREF_BIBTEX],
        ['/works?', CROSSREF_SEARCH_JSON],
      ]),
    ),
    openalex: new OpenAlexService(
      route('OpenAlex', [
        ['/works?search=', '{"results":[]}'],
        ['/works/W', OPENALEX_WORK_JSON],
      ]),
    ),
  });
}

describe('output contract: the bibliography tools', () => {
  it('list_references publishes every key it returns, for all three bibliography shapes', async () => {
    const { client, userDir } = await localHarness();
    await writeFile(path.join(userDir, 'refs.bib'), REFS_BIB);
    await writeFile(path.join(userDir, 'biblist.tex'), BIBLIST_TEX);
    await writeFile(path.join(userDir, 'notes.md'), PROSE_MD);

    const out = await auditCall(client, 'list_references', { project: 'doc' });

    const entries = out.entries as Array<Record<string, unknown>>;
    // One of each shape: `entrySchema` is shared across the three, and each populates a
    // different corner of it (`key`+`fields` for bibtex, `label` for a numbered prose item).
    expect(new Set(entries.map((e) => e.format))).toEqual(new Set(['bibtex', 'bibitem', 'prose']));
    expect(entries.some((e) => e.fields !== undefined)).toBe(true);
    expect(entries.some((e) => e.label !== undefined)).toBe(true);
    expect((out.sources as unknown[]).length).toBeGreaterThan(0);
  });

  /**
   * And that a client which listed tools first can actually call it.
   *
   * `entries[].fields` was emitted undeclared from v0.6.0 (#137), which did not make
   * `list_references` a little too wide: it made it **uncallable** — the SDK's `Client` compiles
   * an ajv validator per advertised schema during `listTools()` and rejects the whole result with
   * `-32602 … must NOT have additional properties`. #142 declared the field; this pins the
   * callability against a client primed exactly the way a real one is, which the audit above
   * (deliberately unprimed, for the better diagnostic) does not.
   */
  it('and an SDK client that listed tools first can call list_references and get a result', async () => {
    const { client, userDir } = await localHarness();
    await writeFile(path.join(userDir, 'refs.bib'), REFS_BIB);
    await prime(client);

    const listed = await client.callTool({
      name: 'list_references',
      arguments: { project: 'doc' },
    });

    expect(isError(listed), textOf(listed)).toBe(false);
    const entries = structured(listed)!.entries as Array<Record<string, unknown>>;
    // Asserting the field's *value* arrived, not merely that the promise resolved: that is what
    // separates "the schema declares it" from "the handler stopped sending it to appease ajv".
    const knuth = entries.find((e) => e.key === 'knuth1984')!;
    expect((knuth.fields as Record<string, string>).title).toContain('TeX');
  });

  it('check_citations publishes every key it returns, in-project and across projects', async () => {
    const { client, userDir } = await localHarness();
    await writeFile(path.join(userDir, 'refs.bib'), REFS_BIB);
    // main.tex already cites knuth1984; this adds the key nothing defines.
    await writeFile(path.join(userDir, 'intro.tex'), 'An unknown source \\cite{ghost2020}.\n');

    const own = await auditCall(client, 'check_citations', { project: 'doc' });

    // All four finding arrays populated, so each element shape is judged rather than skipped.
    expect((own.undefinedCitations as unknown[]).length).toBeGreaterThan(0);
    expect((own.uncitedEntries as unknown[]).length).toBeGreaterThan(0);
    expect((own.duplicateKeys as unknown[]).length).toBeGreaterThan(0);
    expect((own.incompleteEntries as unknown[]).length).toBeGreaterThan(0);
    expect(own.bibliographyProject).toBeUndefined();

    // The cross-project branch, which is the one that emits `bibliographyProject` at all.
    const sharedDir = await mkdtemp(path.join(os.tmpdir(), 'wlm-contract-shared-'));
    cleanups.push(() => rm(sharedDir, { recursive: true, force: true }));
    await writeFile(path.join(sharedDir, 'shared.bib'), SHARED_BIB);
    const registered = await client.callTool({
      name: 'register_project',
      arguments: { project: 'group', path: sharedDir },
    });
    expect(isError(registered), textOf(registered)).toBe(false);

    const foreign = await auditCall(client, 'check_citations', {
      project: 'doc',
      bibliographyProject: 'group',
    });

    expect(foreign.bibliographyProject).toBe('group');
    // Narrowed to what this draft cites, as the cross-project rule requires — and still carrying
    // findings, so the audit above ran over populated arrays and not over four empty ones.
    expect(foreign.uncitedEntries).toEqual([]);
    expect((foreign.duplicateKeys as unknown[]).length).toBeGreaterThan(0);
  });

  it('search_references publishes every key it returns, pinned and on a substitution', async () => {
    const { client, ctx } = await localHarness();
    ctx.references = stubbedReferences();

    const pinned = await auditCall(client, 'search_references', {
      query: 'deep residual learning',
      source: 'dblp',
    });

    expect(pinned.source).toBe('dblp');
    const hits = pinned.results as Array<Record<string, unknown>>;
    expect(hits).toHaveLength(1);
    // Every optional field of `hitSchema` populated by the canned record, so none of them is
    // "declared but never seen" here.
    expect(hits[0]).toMatchObject({
      key: 'dblp:conf/cvpr/HeZRS16',
      source: 'dblp',
      year: 2016,
      venue: 'CVPR',
      doi: '10.1109/CVPR.2016.90',
    });
    expect(pinned.fallbackFrom).toBeUndefined();
    expect(pinned.hint).toBeUndefined();

    // Unpinned with DBLP unreachable: Crossref answers, and the two substitution-only keys
    // (`fallbackFrom`, `hint`) are the ones a pinned call never emits.
    ctx.references = stubbedReferences({ dblpDown: true });
    const swapped = await auditCall(client, 'search_references', {
      query: 'deep residual learning',
    });

    expect(swapped.source).toBe('crossref');
    expect(swapped.fallbackFrom).toBe('dblp');
    expect(swapped.hint).toBeTypeOf('string');
  });

  /**
   * `add_citation` runs against a git-backed project on purpose: on a local one `changeDiff`
   * returns `''` by design, so the `diff` key would be audited empty — and `diff` is the field
   * this tool's payload is mostly made of.
   */
  async function citationHarness() {
    const remote = await createFakeRemote({
      'main.tex': MAIN_TEX,
      'refs.bib': '@misc{seed2000,\n  title = {A seed entry so the file is tracked}\n}\n',
    });
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-contract-cite-'));
    cleanups.push(remote.cleanup, () => rm(workspace, { recursive: true, force: true }));
    const dir = path.join(workspace, 'demo');
    await new GitService(IDENTITY).clone(remote.url, dir, { username: 'git' });

    const config: ServerConfig = {
      workspaceRoot: workspace,
      sessionId: 'contract-cite',
      projects: [{ id: 'demo', gitUrl: remote.url }],
      defaultProject: 'demo',
    };
    const ctx = createContext(config, new CredentialResolver({}), IDENTITY);
    ctx.references = stubbedReferences();
    const server = createServer(ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'contract-cite', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.unshift(() => client.close());
    return { client };
  }

  it('add_citation publishes every key it returns, on a write, a no-op and a DOI bridge', async () => {
    const { client } = await citationHarness();

    const added = await auditCall(client, 'add_citation', {
      project: 'demo',
      key: 'dblp:conf/cvpr/HeZRS16',
    });

    expect(added).toMatchObject({ path: 'refs.bib', added: true, alreadyPresent: false });
    expect(added.source).toBe('dblp');
    expect(added.via).toBeUndefined();
    expect(String(added.diff)).toContain('HeZRS16');
    expect(added.line).toBeGreaterThan(1);

    // The already-present branch: same key set, different values, and a `diff` of ''.
    const again = await auditCall(client, 'add_citation', {
      project: 'demo',
      key: 'dblp:conf/cvpr/HeZRS16',
    });
    expect(again).toMatchObject({ added: false, alreadyPresent: true, diff: '' });

    // OpenAlex publishes no BibTeX, so this record is fetched from Crossref by DOI — the one
    // branch that emits `via`.
    const bridged = await auditCall(client, 'add_citation', {
      project: 'demo',
      key: 'openalex:W2194775991',
    });
    expect(bridged).toMatchObject({ added: true, source: 'openalex', via: 'crossref' });
  });
});

/**
 * Every registered tool is named in an audit call in this file.
 *
 * The file's claim is "all 38", and a claim like that goes stale the moment someone registers a
 * 39th tool — silently, because nothing else here would fail. Asserted against this file's own
 * source rather than against what the tests above happened to run, so it holds under
 * `vitest -t <one test>` too, and so a failure names the missing tool instead of depending on
 * which tests the runner selected.
 *
 * It says nothing about whether the call it finds reaches a real result — `auditCall`'s own
 * `isError` check is what covers that, per tool.
 */
describe('output contract: coverage of the tool list', () => {
  it('names every advertised tool in an auditCall', async () => {
    const source = await readFile(fileURLToPath(import.meta.url), 'utf8');
    const audited = new Set(
      [...source.matchAll(/auditCall\(\s*\w+,\s*'([a-z_]+)'/g)].map((m) => m[1]!),
    );
    const { tools } = await schemaClient.listTools();
    const missing = tools.map((t) => t.name).filter((name) => !audited.has(name));

    expect(
      missing.sort(),
      'these registered tools are audited by no call in outputContract.test.ts, so nothing ' +
        'checks that what they emit is what they advertise',
    ).toEqual([]);
  });
});
