import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import type { AppContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import {
  BUNDLE_ASSET,
  MAX_BUNDLE_BYTES,
  UpdateError,
  UpdateService,
  detectInstallKind,
  isComparableVersion,
  isNewer,
  manualUpdateAdvice,
  parseLatestRelease,
  parseVersion,
  type UpdateFetch,
  type UpdateResponse,
  type UpdateServiceOptions,
} from '../../src/services/updater.js';
import { quoteId } from '../../src/lib/projectId.js';
import { climbsOut, toPosix } from '../../src/lib/paths.js';
import { expectNoUndeclaredKeys } from '../helpers/outputSchema.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('bundle bytes')]);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const ASSET_URL = (tag: string) =>
  `https://github.com/elias-ramzi/WebLatexMCP/releases/download/${tag}/${BUNDLE_ASSET}`;

function release(tag: string, asset: Record<string, unknown> | null = {}) {
  return {
    tag_name: tag,
    html_url: 'https://example.invalid/ignored',
    assets:
      asset === null
        ? []
        : [
            { name: 'other.zip', browser_download_url: 'https://elsewhere.invalid/x' },
            {
              name: BUNDLE_ASSET,
              browser_download_url: ASSET_URL(tag),
              size: ZIP.length,
              digest: `sha256:${sha(ZIP)}`,
              ...asset,
            },
          ],
  };
}

/** A body that yields `chunks` in order, then ends. */
function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

/** A JSON answer, or — for a Buffer — a download whose body streams those bytes. */
function response(body: unknown, init: { status?: number } = {}): UpdateResponse {
  const status = init.status ?? 200;
  return {
    ok: status < 400,
    status,
    statusText: status < 400 ? 'OK' : 'Forbidden',
    json: async () => body,
    body: Buffer.isBuffer(body) ? streamOf(body) : null,
  };
}

/**
 * Answers the release API with `rel` and the asset URL with `bytes` (or with what `download`
 * builds); records every URL asked.
 */
function fakeFetch(
  rel: unknown,
  bytes: Buffer = ZIP,
  download?: () => UpdateResponse,
): UpdateFetch & { urls: string[] } {
  const urls: string[] = [];
  const f: UpdateFetch = async (url) => {
    urls.push(url);
    if (url.endsWith('/releases/latest')) return response(rel);
    if (url.includes('/releases/download/')) return download ? download() : response(bytes);
    throw new Error(`unexpected URL ${url}`);
  };
  return Object.assign(f, { urls });
}

/**
 * A copy of the repository with no `.git`: what a GitHub "Source code" archive, degit or a Docker
 * image that drops `.git` leaves. It carries `manifest.json` (it sits at the repo root), so it is
 * exactly the tree that used to be taken for the Desktop extension.
 */
async function manifestOnlyRoot(): Promise<string> {
  const root = await tmp('wlm-upd-root-');
  await writeFile(path.join(root, 'manifest.json'), '{}');
  return root;
}

/**
 * Every service a test builds goes through here: an opener that only records (never the real
 * `xdg-open`/`open`/`start`) and a temp `tmpDir` (never the real temp dir), so a regression that
 * reaches the open or the write cannot leave this process. The install kind defaults to the
 * Desktop extension, ASSERTED as its manifest asserts it; a test that wants the server to work it
 * out passes `installKind: undefined` (and a `packageRoot`).
 */
async function makeService(
  opts: Omit<UpdateServiceOptions, 'open' | 'tmpDir'> & { tmpDir?: string; opens?: boolean },
) {
  const tmpDir = opts.tmpDir ?? (await tmp('wlm-upd-dl-'));
  const opened: string[] = [];
  const { opens = true, ...rest } = opts;
  const svc = new UpdateService({
    packageRoot: await tmp('wlm-upd-pkg-'),
    installKind: 'desktop-extension',
    currentVersion: '0.8.0',
    ...rest,
    tmpDir,
    open: async (p) => {
      opened.push(p);
      return opens;
    },
  });
  return { svc, opened, tmpDir };
}

describe('version comparison', () => {
  it('reads plain and v-prefixed versions, nothing else', () => {
    expect(parseVersion('0.8.0')).toEqual([0, 8, 0]);
    expect(parseVersion('v1.10.2')).toEqual([1, 10, 2]);
    expect(parseVersion('1.0.0-rc.1')).toBeNull();
    expect(parseVersion('unknown')).toBeNull();
  });

  it('validates the string it is given, never a trimmed copy, and caps each part at 9 digits', () => {
    expect(parseVersion('v1.2.3 ')).toBeNull();
    expect(parseVersion(' v1.2.3')).toBeNull();
    expect(parseVersion('v1.2.3\n')).toBeNull();
    expect(parseVersion('1234567890.0.0')).toBeNull();
    expect(parseVersion(`${'9'.repeat(200)}.0.0`)).toBeNull();
    expect(parseVersion('999999999.0.0')).toEqual([999999999, 0, 0]);
  });

  it('says whether a running version can be compared at all', () => {
    expect(isComparableVersion('0.8.0')).toBe(true);
    expect(isComparableVersion('unknown')).toBe(false);
    expect(isComparableVersion('0.9.0-rc.1')).toBe(false);
  });

  it('compares numerically and never claims an update it cannot read', () => {
    expect(isNewer('0.10.0', '0.9.9')).toBe(true);
    expect(isNewer('0.8.0', '0.8.0')).toBe(false);
    expect(isNewer('0.7.9', '0.8.0')).toBe(false);
    expect(isNewer('0.9.0', 'unknown')).toBe(false);
  });
});

describe('detectInstallKind', () => {
  it('never infers the Desktop extension from manifest.json (a copy of the repo without .git)', async () => {
    expect(detectInstallKind(await manifestOnlyRoot())).toBe('npm');
    expect(detectInstallKind(await manifestOnlyRoot(), undefined)).toBe('npm');
    expect(
      new UpdateService({
        packageRoot: await manifestOnlyRoot(),
        currentVersion: '0.8.0',
      }).installKind(),
    ).toBe('npm');
  });

  it('takes an asserted kind over anything on disk', async () => {
    const checkout = await tmp('wlm-upd-src-');
    await mkdir(path.join(checkout, '.git'));
    await writeFile(path.join(checkout, 'manifest.json'), '{}');
    expect(detectInstallKind(checkout, 'desktop-extension')).toBe('desktop-extension');
    expect(detectInstallKind(checkout, 'npm')).toBe('npm');
    const bare = await tmp('wlm-upd-npm-');
    expect(detectInstallKind(bare, 'source')).toBe('source');
    expect(detectInstallKind(await manifestOnlyRoot(), 'npm')).toBe('npm');
    expect(
      new UpdateService({ packageRoot: checkout, installKind: 'desktop-extension' }).installKind(),
    ).toBe('desktop-extension');
  });

  it('reads a git checkout — a .git directory, or a .git file as in a worktree — as source', async () => {
    const checkout = await tmp('wlm-upd-src-');
    await mkdir(path.join(checkout, '.git'));
    expect(detectInstallKind(checkout)).toBe('source');
    const worktree = await tmp('wlm-upd-wt-');
    await writeFile(path.join(worktree, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n');
    expect(detectInstallKind(worktree)).toBe('source');
    expect(detectInstallKind(await tmp('wlm-upd-npm-'))).toBe('npm');
  });
});

interface ManifestEnvs {
  server?: {
    mcp_config?: {
      env?: Record<string, string>;
      platform_overrides?: Record<string, { env?: Record<string, string> }>;
    };
  };
}

/**
 * Every env block Claude Desktop may launch the server with that does not assert the extension:
 * `base` for `mcp_config.env`, else the platform name. A platform override's `env` REPLACES the
 * base block (mcpb does not merge them), so each one must carry the key itself.
 */
function envsMissingInstallKind(manifest: ManifestEnvs): string[] {
  const config = manifest.server?.mcp_config;
  const blocks: Array<[string, Record<string, string> | undefined]> = [['base', config?.env]];
  for (const [platform, override] of Object.entries(config?.platform_overrides ?? {})) {
    if (override.env !== undefined) blocks.push([platform, override.env]);
  }
  return blocks
    .filter(([, env]) => env?.WEB_LATEX_MCP_INSTALL_KIND !== 'desktop-extension')
    .map(([name]) => name);
}

describe('the Desktop extension asserts its install kind', () => {
  it('sets WEB_LATEX_MCP_INSTALL_KIND=desktop-extension in every env block of manifest.json', async () => {
    // Only Claude Desktop launches the server through these env blocks; dropping the line would
    // make every extension install read as npm and stop update_server from installing.
    const manifest = JSON.parse(
      await readFile(new URL('../../manifest.json', import.meta.url), 'utf8'),
    ) as ManifestEnvs;
    expect(envsMissingInstallKind(manifest)).toEqual([]);
  });

  it('flags a platform override whose env would replace the base block without the key', () => {
    const asserted = { WEB_LATEX_MCP_INSTALL_KIND: 'desktop-extension' };
    expect(
      envsMissingInstallKind({
        server: {
          mcp_config: {
            env: asserted,
            platform_overrides: {
              win32: { env: { PATH: 'C:\\extra' } },
              darwin: { env: { ...asserted, PATH: '/extra' } },
              linux: {},
            },
          },
        },
      }),
    ).toEqual(['win32']);
    expect(envsMissingInstallKind({ server: { mcp_config: {} } })).toEqual(['base']);
  });
});

describe('createContext', () => {
  it("hands the config's asserted install kind to the updater", async () => {
    const workspace = await tmp('wlm-upd-ws-');
    // The package root this test runs from is a git checkout (or worktree), so without the
    // pass-through both of these would read as `source`.
    for (const installKind of ['desktop-extension', 'npm'] as const) {
      const ctx = createContext(
        { workspaceRoot: workspace, sessionId: 'test', projects: [], installKind },
        new CredentialResolver({}),
        { name: 'Test', email: 'test@example.com' },
      );
      expect(ctx.updater.installKind()).toBe(installKind);
    }
  });
});

describe('parseLatestRelease', () => {
  it('pins the bundle URL to this repository and tag', () => {
    expect(parseLatestRelease(release('v0.9.0'))).toMatchObject({
      version: '0.9.0',
      htmlUrl: 'https://github.com/elias-ramzi/WebLatexMCP/releases/tag/v0.9.0',
      asset: { url: ASSET_URL('v0.9.0'), size: ZIP.length, sha256: sha(ZIP) },
    });
    expect(() =>
      parseLatestRelease(
        release('v0.9.0', { browser_download_url: 'https://evil.invalid/web-latex-mcp.mcpb' }),
      ),
    ).toThrow(/points somewhere other than/);
  });

  it('refuses a release without a version tag', () => {
    expect(() => parseLatestRelease({ tag_name: 'nightly' })).toThrow(/version tag/);
    expect(() => parseLatestRelease('<html>')).toThrow(/version tag/);
  });

  it('refuses a tag that only parses once trimmed, or whose parts are too long to be numbers', () => {
    // The tag is put into URLs and messages as is, so the string validated must be that one.
    expect(() => parseLatestRelease(release('v1.2.3 '))).toThrow(/version tag/);
    expect(() => parseLatestRelease(release(' v1.2.3'))).toThrow(/version tag/);
    expect(() => parseLatestRelease(release('v1234567890.2.3'))).toThrow(/version tag/);
    expect(() => parseLatestRelease(release(`v${'1'.repeat(200)}.0.0`))).toThrow(/version tag/);
    expect(parseLatestRelease(release('v1.2.3')).version).toBe('1.2.3');
    expect(parseLatestRelease(release('1.2.3'))).toMatchObject({
      version: '1.2.3',
      htmlUrl: 'https://github.com/elias-ramzi/WebLatexMCP/releases/tag/1.2.3',
    });
  });

  it('reports a missing asset or digest rather than inventing one', () => {
    expect(parseLatestRelease(release('v0.9.0', null)).asset).toBeUndefined();
    expect(parseLatestRelease(release('v0.9.0', { digest: undefined })).asset?.sha256).toBe(
      undefined,
    );
  });
});

describe('UpdateService.downloadBundle', () => {
  async function service(rel: unknown, bytes?: Buffer) {
    const fetch = fakeFetch(rel, bytes);
    return { fetch, ...(await makeService({ fetch })) };
  }

  const askedForDownload = (urls: string[]) => urls.some((u) => u.includes('/releases/download/'));

  it('writes the verified bundle and opens it', async () => {
    const { svc, opened } = await service(release('v0.9.0'));
    const { release: rel, ...check } = await svc.check();
    expect(check).toMatchObject({
      currentVersion: '0.8.0',
      latestVersion: '0.9.0',
      updateAvailable: true,
      installKind: 'desktop-extension',
    });
    const got = await svc.downloadBundle(rel);
    expect(got).toMatchObject({ bytes: ZIP.length, sha256: sha(ZIP), opened: true });
    expect(path.basename(got.path)).toBe('web-latex-mcp-0.9.0.mcpb');
    expect(await readFile(got.path)).toEqual(ZIP);
    expect(opened).toEqual([got.path]);
  });

  it('refuses bytes that do not match the published digest, writing and opening nothing', async () => {
    const forged = Buffer.concat([ZIP.subarray(0, 4), Buffer.from('other bytes!')]);
    expect(forged.length).toBe(ZIP.length);
    const { svc, opened, tmpDir } = await service(release('v0.9.0'), forged);
    const { release: rel } = await svc.check();
    await expect(svc.downloadBundle(rel)).rejects.toThrow(/SHA-256/);
    expect(opened).toEqual([]);
    expect(await readdir(tmpDir)).toEqual([]);
  });

  it('refuses a release without a digest before downloading anything', async () => {
    const { svc, fetch, opened, tmpDir } = await service(release('v0.9.0', { digest: undefined }));
    const { release: rel } = await svc.check();
    await expect(svc.downloadBundle(rel)).rejects.toThrow(/cannot be verified/);
    expect(askedForDownload(fetch.urls)).toBe(false);
    expect(opened).toEqual([]);
    expect(await readdir(tmpDir)).toEqual([]);
  });

  it('refuses a release without the bundle before downloading anything', async () => {
    const { svc, fetch, opened, tmpDir } = await service(release('v0.9.0', null));
    const { release: rel } = await svc.check();
    await expect(svc.downloadBundle(rel)).rejects.toThrow(/nothing to install/);
    expect(askedForDownload(fetch.urls)).toBe(false);
    expect(opened).toEqual([]);
    expect(await readdir(tmpDir)).toEqual([]);
  });

  it('refuses a declared size over the cap before downloading anything', async () => {
    const { svc, fetch, opened, tmpDir } = await service(
      release('v0.9.0', { size: MAX_BUNDLE_BYTES + 1 }),
    );
    const { release: rel } = await svc.check();
    await expect(svc.downloadBundle(rel)).rejects.toThrow(/byte cap; not downloaded/);
    expect(askedForDownload(fetch.urls)).toBe(false);
    expect(opened).toEqual([]);
    expect(await readdir(tmpDir)).toEqual([]);
  });

  it('refuses a size mismatch and a non-zip, writing and opening nothing', async () => {
    const short = await service(release('v0.9.0', { size: ZIP.length + 1 }));
    await expect(short.svc.downloadBundle((await short.svc.check()).release)).rejects.toThrow(
      /Downloaded \d+ bytes, but the release declares/,
    );
    expect(short.opened).toEqual([]);
    expect(await readdir(short.tmpDir)).toEqual([]);

    const notZip = Buffer.from('not a zip archive');
    const plain = await service(
      release('v0.9.0', { size: notZip.length, digest: `sha256:${sha(notZip)}` }),
      notZip,
    );
    await expect(plain.svc.downloadBundle((await plain.svc.check()).release)).rejects.toThrow(
      /not a zip/,
    );
    expect(plain.opened).toEqual([]);
    expect(await readdir(plain.tmpDir)).toEqual([]);
  });

  describe('reading the body', () => {
    async function withBody(download: () => UpdateResponse) {
      const fetch = fakeFetch(release('v0.9.0'), ZIP, download);
      const made = await makeService({ fetch });
      const { release: rel } = await made.svc.check();
      return { ...made, rel };
    }

    it('stops reading at the declared size and discards a body that runs past it', async () => {
      // An endless body, pulled one 4-byte chunk per read. A real Response (which also has
      // `arrayBuffer`, the whole-body read) so a reader that buffers everything is caught too:
      // the stream errors once it has been read far past the declared size.
      const stats = { pulls: 0, cancelled: false };
      const endless = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            stats.pulls++;
            if (stats.pulls > 1000) {
              controller.error(new Error('test stream read far past the declared size'));
              return;
            }
            controller.enqueue(new Uint8Array(4).fill(0x50));
          },
          cancel() {
            stats.cancelled = true;
          },
        },
        { highWaterMark: 0 },
      );
      const { svc, opened, tmpDir, rel } = await withBody(() => new Response(endless));
      await expect(svc.downloadBundle(rel)).rejects.toThrow(
        `ran past the ${ZIP.length} bytes the release declares`,
      );
      // ZIP.length is 16: the fifth 4-byte chunk crosses it; one more pull is slack.
      expect(stats.pulls).toBeLessThanOrEqual(Math.ceil(ZIP.length / 4) + 2);
      expect(stats.cancelled).toBe(true);
      expect(opened).toEqual([]);
      expect(await readdir(tmpDir)).toEqual([]);
    });

    it('accepts a body of exactly the declared size, however it is chunked', async () => {
      const { svc, opened, rel } = await withBody(() => ({
        ...response({}),
        body: streamOf(ZIP.subarray(0, 3), ZIP.subarray(3, 9), ZIP.subarray(9)),
      }));
      const got = await svc.downloadBundle(rel);
      expect(got).toMatchObject({ bytes: ZIP.length, sha256: sha(ZIP), opened: true });
      expect(await readFile(got.path)).toEqual(ZIP);
      expect(opened).toEqual([got.path]);
    });

    it('refuses a body shorter than declared, writing and opening nothing', async () => {
      const { svc, opened, tmpDir, rel } = await withBody(() => ({
        ...response({}),
        body: streamOf(ZIP.subarray(0, 5), ZIP.subarray(5, 10)),
      }));
      await expect(svc.downloadBundle(rel)).rejects.toThrow(
        `Downloaded 10 bytes, but the release declares ${ZIP.length}`,
      );
      expect(opened).toEqual([]);
      expect(await readdir(tmpDir)).toEqual([]);
    });

    it('reads a missing body as no bytes at all, writing and opening nothing', async () => {
      const { svc, opened, tmpDir, rel } = await withBody(() => ({ ...response({}), body: null }));
      await expect(svc.downloadBundle(rel)).rejects.toThrow(
        `Downloaded 0 bytes, but the release declares ${ZIP.length}`,
      );
      expect(opened).toEqual([]);
      expect(await readdir(tmpDir)).toEqual([]);
    });

    it('names a timeout that fires mid-stream', async () => {
      const stalled = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(ZIP.subarray(0, 4));
        },
        pull(controller) {
          if (controller.desiredSize !== null && controller.desiredSize > 0) {
            controller.error(new DOMException('The operation timed out.', 'TimeoutError'));
          }
        },
      });
      const { svc, opened, tmpDir, rel } = await withBody(() => ({
        ...response({}),
        body: stalled,
      }));
      await expect(svc.downloadBundle(rel)).rejects.toThrow(
        `Downloading ${BUNDLE_ASSET} failed: timed out.`,
      );
      expect(opened).toEqual([]);
      expect(await readdir(tmpDir)).toEqual([]);
    });
  });

  it('saves under an absolute path when the temp dir is given relative', async () => {
    // `os.tmpdir()` returns a relative TMPDIR as is, and `openFile` refuses a relative path.
    let absolute = await tmp('wlm-upd-rel-');
    if (path.isAbsolute(path.relative(process.cwd(), absolute))) {
      // Windows, with the temp dir on another drive than the cwd: no relative path reaches it.
      const local = await mkdtemp(path.join(process.cwd(), '.wlm-upd-rel-'));
      cleanups.push(() => rm(local, { recursive: true, force: true }));
      absolute = local;
    }
    const relative = path.relative(process.cwd(), absolute);
    expect(path.isAbsolute(relative)).toBe(false);
    const { svc, opened } = await makeService({
      fetch: fakeFetch(release('v0.9.0')),
      tmpDir: relative,
    });
    const got = await svc.downloadBundle((await svc.check()).release);
    expect(path.isAbsolute(got.path)).toBe(true);
    expect(climbsOut(path.relative(absolute, got.path))).toBe(false);
    expect(opened).toEqual([got.path]);
    expect(await readFile(got.path)).toEqual(ZIP);
  });

  it('names an unsavable temp dir quoted, and opens nothing', async () => {
    // A path under a regular file: mkdtemp fails there on every platform (ENOTDIR or ENOENT).
    const parent = await tmp('wlm-upd-nosave-');
    const file = path.join(parent, 'a file‮');
    await writeFile(file, '');
    const tmpDir = path.join(file, 'sub');
    const { svc, opened } = await makeService({ fetch: fakeFetch(release('v0.9.0')), tmpDir });
    const err: unknown = await svc.downloadBundle((await svc.check()).release).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UpdateError);
    const message = (err as Error).message;
    expect(message).toContain(`Could not save ${BUNDLE_ASSET} under ${quoteId(toPosix(tmpDir))}: `);
    expect(message).not.toContain('‮');
    expect(opened).toEqual([]);
  });

  it('escapes the reason phrase of a refused request', async () => {
    const { svc } = await makeService({
      fetch: async () => ({ ...response({}, { status: 502 }), statusText: 'Bad‮Gateway' }),
    });
    const err: unknown = await svc.check().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UpdateError);
    const message = (err as Error).message;
    expect(message).toContain('GitHub answered 502 Bad\\u{202E}Gateway for ');
    expect(message).not.toContain('‮');
  });

  it('names the rate limit when GitHub answers 403', async () => {
    const { svc, opened } = await makeService({
      fetch: async () => response({}, { status: 403 }),
    });
    await expect(svc.check()).rejects.toThrow(/rate limit/);
    expect(opened).toEqual([]);
  });

  it("names the cause of Node's opaque `fetch failed`, escaped", async () => {
    const failing = (cause: unknown): UpdateFetch => {
      return async () => {
        throw new TypeError('fetch failed', { cause });
      };
    };
    const coded = Object.assign(new Error('getaddrinfo ENOTFOUND api.github.com'), {
      code: 'ENOTFOUND',
    });
    const a = await makeService({ fetch: failing(coded) });
    await expect(a.svc.check()).rejects.toThrow(/: fetch failed \(ENOTFOUND\)\.$/);

    const b = await makeService({ fetch: failing(new Error('connect refused\u202E')) });
    await expect(b.svc.check()).rejects.toThrow('fetch failed (connect refused\\u{202E}).');

    const timedOut = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    const c = await makeService({
      fetch: async () => {
        throw timedOut;
      },
    });
    await expect(c.svc.check()).rejects.toThrow(/: timed out\.$/);
  });

  it("escapes the error's own message, which can quote a proxy's response body", async () => {
    const { svc, opened } = await makeService({
      fetch: async () => ({
        ...response({}),
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON: "<p>‮gnp.exe</p>"');
        },
      }),
    });
    const err: unknown = await svc.check().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).not.toContain('‮');
    expect(message).toContain(
      'release listing could not be read: Unexpected token < in JSON: "<p>\\u{202E}gnp.exe</p>".',
    );
    expect(opened).toEqual([]);
  });
});

describe('update_server tool', () => {
  async function connect(updater: UpdateService): Promise<Client> {
    const ctx = { updater, credentials: { allSecrets: () => [] } } as unknown as AppContext;
    const server = createServer(ctx);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    cleanups.push(() => client.close());
    return client;
  }

  async function call(client: Client, args: Record<string, unknown>) {
    const res = await client.callTool({ name: 'update_server', arguments: args });
    const sc = (res as { structuredContent?: Record<string, unknown> }).structuredContent;
    await expectNoUndeclaredKeys(client, 'update_server', sc);
    const text = (res as { content: Array<{ type: string; text?: string }> }).content
      .map((c) => c.text ?? '')
      .join('\n');
    return { res, sc: sc!, text };
  }

  it('only checks unless install is passed', async () => {
    const { svc, opened } = await makeService({ fetch: fakeFetch(release('v0.9.0')) });
    const client = await connect(svc);
    const checked = await call(client, {});
    expect(checked.sc).toMatchObject({ updateAvailable: true, action: 'none' });
    expect(opened).toEqual([]);

    const installed = await call(client, { install: true });
    expect(installed.sc).toMatchObject({ action: 'opened', sha256: sha(ZIP) });
    expect(opened).toHaveLength(1);
  });

  it('reports up to date without downloading', async () => {
    const fetch = fakeFetch(release('v0.8.0'));
    const { svc, opened } = await makeService({ fetch });
    const { sc } = await call(await connect(svc), { install: true });
    expect(sc).toMatchObject({ updateAvailable: false, action: 'none' });
    expect(fetch.urls).toHaveLength(1);
    expect(opened).toEqual([]);
  });

  it('gives an npm install advice instead of downloading', async () => {
    const fetch = fakeFetch(release('v0.9.0'));
    const { svc, opened } = await makeService({ fetch, installKind: 'npm' });
    const { sc } = await call(await connect(svc), { install: true });
    expect(sc).toMatchObject({ installKind: 'npm', action: 'manual' });
    expect(String(sc.advice)).toContain('web-latex-mcp@0.9.0');
    expect(fetch.urls).toHaveLength(1);
    expect(opened).toEqual([]);
  });

  it('gives a copy of the repo without .git (manifest.json, nothing asserted) npm advice, never the bundle', async () => {
    const fetch = fakeFetch(release('v0.9.0'));
    const { svc, opened, tmpDir } = await makeService({
      fetch,
      packageRoot: await manifestOnlyRoot(),
      installKind: undefined,
    });
    const { sc, text } = await call(await connect(svc), { install: true });
    expect(sc).toMatchObject({
      installKind: 'npm',
      updateAvailable: true,
      action: 'manual',
      advice: manualUpdateAdvice('npm', '0.9.0'),
    });
    expect(text).not.toContain('Claude Desktop prompt');
    expect(fetch.urls.some((u) => u.includes('/releases/download/'))).toBe(false);
    expect(opened).toEqual([]);
    expect(await readdir(tmpDir)).toEqual([]);
  });

  it('surfaces a refused download as a tool error', async () => {
    const { svc, opened, tmpDir } = await makeService({
      fetch: fakeFetch(release('v0.9.0', { digest: undefined })),
    });
    const res = await (
      await connect(svc)
    ).callTool({
      name: 'update_server',
      arguments: { install: true },
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(opened).toEqual([]);
    expect(await readdir(tmpDir)).toEqual([]);
  });

  describe('a running version that cannot be compared', () => {
    for (const current of ['unknown', '0.9.0-rc.1']) {
      for (const install of [false, true]) {
        it(`says so for ${current}${install ? ' with install' : ''}, and downloads nothing`, async () => {
          const fetch = fakeFetch(release('v0.9.0'));
          // The extension install: the one kind that would otherwise download.
          const { svc, opened, tmpDir } = await makeService({ fetch, currentVersion: current });
          const { sc, text } = await call(await connect(svc), install ? { install } : {});
          const advice = manualUpdateAdvice('desktop-extension', '0.9.0');
          expect(sc).toMatchObject({
            currentVersion: current,
            updateAvailable: false,
            action: install ? 'manual' : 'none',
            advice,
          });
          expect(sc.bundlePath).toBeUndefined();
          expect(text).toContain(`${quoteId(current)} cannot be compared with v0.9.0`);
          expect(text).toContain(advice);
          expect(text).not.toMatch(/not older|up to date/);
          expect(text).not.toContain(`v${current}`);
          expect(fetch.urls).toHaveLength(1);
          expect(opened).toEqual([]);
          expect(await readdir(tmpDir)).toEqual([]);
        });
      }
    }

    it('gives an npm install its own advice', async () => {
      const { svc } = await makeService({
        fetch: fakeFetch(release('v0.9.0')),
        installKind: 'npm',
        currentVersion: 'unknown',
      });
      const { sc } = await call(await connect(svc), { install: true });
      expect(sc).toMatchObject({
        action: 'manual',
        advice: manualUpdateAdvice('npm', '0.9.0'),
      });
    });
  });

  it('tells the user what to do if the opened bundle shows no install prompt', async () => {
    // The OS can accept the open request without Claude Desktop handling it (no .mcpb handler:
    // an "Open with" dialog, exit 0), so the opened advice names the by-hand route too.
    const { svc, opened } = await makeService({ fetch: fakeFetch(release('v0.9.0')) });
    const { sc, text } = await call(await connect(svc), { install: true });
    expect(sc.action).toBe('opened');
    expect(opened).toHaveLength(1);
    const fallback =
      `If no install prompt appears, drag ${quoteId(toPosix(opened[0]!))} onto the Claude ` +
      'Desktop window (or Settings → Extensions → Install Extension).';
    expect(String(sc.advice)).toContain('Confirm the update in the Claude Desktop prompt.');
    expect(String(sc.advice)).toContain(fallback);
    expect(text).toContain(fallback);
  });

  it('shows the bundle path POSIX and quoted, in the text and the advice', async () => {
    // A space and an invisible character everywhere; a double quote too where the OS allows one.
    const name = `wlm upd\u200B${process.platform === 'win32' ? '' : '"q"'}-`;
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), name));
    cleanups.push(() => rm(tmpDir, { recursive: true, force: true }));
    const { svc, opened } = await makeService({
      fetch: fakeFetch(release('v0.9.0')),
      tmpDir,
      opens: false,
    });
    const { sc, text } = await call(await connect(svc), { install: true });
    expect(sc.action).toBe('downloaded');
    expect(opened).toHaveLength(1);
    const native = opened[0]!;
    expect(sc.bundlePath).toBe(toPosix(native));
    const shown = quoteId(toPosix(native));
    expect(text).toContain(shown);
    expect(String(sc.advice)).toContain(shown);
    expect(text).not.toContain(native);
    expect(String(sc.advice)).not.toContain(native);
  });
});
