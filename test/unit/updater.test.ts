import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import type { AppContext } from '../../src/context.js';
import {
  BUNDLE_ASSET,
  UpdateService,
  detectInstallKind,
  isNewer,
  parseLatestRelease,
  parseVersion,
  type UpdateFetch,
  type UpdateResponse,
} from '../../src/services/updater.js';
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

function response(body: unknown, init: { status?: number } = {}): UpdateResponse {
  const status = init.status ?? 200;
  return {
    ok: status < 400,
    status,
    statusText: status < 400 ? 'OK' : 'Forbidden',
    json: async () => body,
    arrayBuffer: async () => {
      const b = body as Buffer;
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    },
  };
}

/** Answers the release API with `rel` and the asset URL with `bytes`; records every URL asked. */
function fakeFetch(rel: unknown, bytes: Buffer = ZIP): UpdateFetch & { urls: string[] } {
  const urls: string[] = [];
  const f: UpdateFetch = async (url) => {
    urls.push(url);
    if (url.endsWith('/releases/latest')) return response(rel);
    if (url.includes('/releases/download/')) return response(bytes);
    throw new Error(`unexpected URL ${url}`);
  };
  return Object.assign(f, { urls });
}

async function extensionRoot(): Promise<string> {
  const root = await tmp('wlm-upd-root-');
  await writeFile(path.join(root, 'manifest.json'), '{}');
  return root;
}

describe('version comparison', () => {
  it('reads plain and v-prefixed versions, nothing else', () => {
    expect(parseVersion('0.8.0')).toEqual([0, 8, 0]);
    expect(parseVersion('v1.10.2')).toEqual([1, 10, 2]);
    expect(parseVersion('1.0.0-rc.1')).toBeNull();
    expect(parseVersion('unknown')).toBeNull();
  });

  it('compares numerically and never claims an update it cannot read', () => {
    expect(isNewer('0.10.0', '0.9.9')).toBe(true);
    expect(isNewer('0.8.0', '0.8.0')).toBe(false);
    expect(isNewer('0.7.9', '0.8.0')).toBe(false);
    expect(isNewer('0.9.0', 'unknown')).toBe(false);
  });
});

describe('detectInstallKind', () => {
  it('tells a git checkout, the .mcpb bundle and an npm install apart', async () => {
    const source = await tmp('wlm-upd-src-');
    await mkdir(path.join(source, '.git'));
    await writeFile(path.join(source, 'manifest.json'), '{}');
    expect(detectInstallKind(source)).toBe('source');
    expect(detectInstallKind(await extensionRoot())).toBe('desktop-extension');
    expect(detectInstallKind(await tmp('wlm-upd-npm-'))).toBe('npm');
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

  it('reports a missing asset or digest rather than inventing one', () => {
    expect(parseLatestRelease(release('v0.9.0', null)).asset).toBeUndefined();
    expect(parseLatestRelease(release('v0.9.0', { digest: undefined })).asset?.sha256).toBe(
      undefined,
    );
  });
});

describe('UpdateService.downloadBundle', () => {
  async function service(rel: unknown, bytes?: Buffer) {
    const tmpDir = await tmp('wlm-upd-dl-');
    const opened: string[] = [];
    const fetch = fakeFetch(rel, bytes);
    const svc = new UpdateService({
      fetch,
      packageRoot: await extensionRoot(),
      currentVersion: '0.8.0',
      tmpDir,
      open: async (p) => {
        opened.push(p);
        return true;
      },
    });
    return { svc, fetch, opened, tmpDir };
  }

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
    const { svc, fetch, opened } = await service(release('v0.9.0', { digest: undefined }));
    const { release: rel } = await svc.check();
    await expect(svc.downloadBundle(rel)).rejects.toThrow(/cannot be verified/);
    expect(fetch.urls.some((u) => u.includes('/releases/download/'))).toBe(false);
    expect(opened).toEqual([]);
  });

  it('refuses a size mismatch and a non-zip', async () => {
    const short = await service(release('v0.9.0', { size: ZIP.length + 1 }));
    await expect(short.svc.downloadBundle((await short.svc.check()).release)).rejects.toThrow(
      /declares/,
    );

    const notZip = Buffer.from('not a zip archive');
    const plain = await service(
      release('v0.9.0', { size: notZip.length, digest: `sha256:${sha(notZip)}` }),
      notZip,
    );
    await expect(plain.svc.downloadBundle((await plain.svc.check()).release)).rejects.toThrow(
      /not a zip/,
    );
  });

  it('names the rate limit when GitHub answers 403', async () => {
    const svc = new UpdateService({
      fetch: async () => response({}, { status: 403 }),
      packageRoot: await extensionRoot(),
      currentVersion: '0.8.0',
    });
    await expect(svc.check()).rejects.toThrow(/rate limit/);
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
    return { res, sc: sc! };
  }

  it('only checks unless install is passed', async () => {
    const opened: string[] = [];
    const client = await connect(
      new UpdateService({
        fetch: fakeFetch(release('v0.9.0')),
        packageRoot: await extensionRoot(),
        currentVersion: '0.8.0',
        tmpDir: await tmp('wlm-upd-tool-'),
        open: async (p) => (opened.push(p), true),
      }),
    );
    const checked = await call(client, {});
    expect(checked.sc).toMatchObject({ updateAvailable: true, action: 'none' });
    expect(opened).toEqual([]);

    const installed = await call(client, { install: true });
    expect(installed.sc).toMatchObject({ action: 'opened', sha256: sha(ZIP) });
    expect(opened).toHaveLength(1);
  });

  it('reports up to date without downloading', async () => {
    const fetch = fakeFetch(release('v0.8.0'));
    const client = await connect(
      new UpdateService({ fetch, packageRoot: await extensionRoot(), currentVersion: '0.8.0' }),
    );
    const { sc } = await call(client, { install: true });
    expect(sc).toMatchObject({ updateAvailable: false, action: 'none' });
    expect(fetch.urls).toHaveLength(1);
  });

  it('gives an npm install advice instead of downloading', async () => {
    const fetch = fakeFetch(release('v0.9.0'));
    const client = await connect(
      new UpdateService({
        fetch,
        packageRoot: await tmp('wlm-upd-npm-'),
        currentVersion: '0.8.0',
      }),
    );
    const { sc } = await call(client, { install: true });
    expect(sc).toMatchObject({ installKind: 'npm', action: 'manual' });
    expect(String(sc.advice)).toContain('web-latex-mcp@0.9.0');
    expect(fetch.urls).toHaveLength(1);
  });

  it('surfaces a refused download as a tool error', async () => {
    const client = await connect(
      new UpdateService({
        fetch: fakeFetch(release('v0.9.0', { digest: undefined })),
        packageRoot: await extensionRoot(),
        currentVersion: '0.8.0',
      }),
    );
    const res = await client.callTool({ name: 'update_server', arguments: { install: true } });
    expect((res as { isError?: boolean }).isError).toBe(true);
  });
});
