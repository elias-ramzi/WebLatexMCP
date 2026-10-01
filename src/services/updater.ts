import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getServerVersion } from '../lib/version.js';
import { openBrowser } from '../lib/openBrowser.js';

/**
 * Checks for, and fetches, a newer release of this server.
 *
 * Only the Claude Desktop extension is updated by the server itself, and even there it does not
 * install anything: it downloads the release's `.mcpb`, verifies it, and hands it to the OS, which
 * opens it in Claude Desktop — whose own confirmation dialog is what installs it. The npm and
 * source installs are only told what to run, because the server cannot tell how its client
 * launches it (`npx`, a global install, a pinned path) and replacing the package under a running
 * process is not something to guess at.
 *
 * What is downloaded is pinned, fail closed: the release must come from this repository's
 * `releases/latest`, the asset URL must be exactly `releases/download/<tag>/web-latex-mcp.mcpb` on
 * github.com, and the bytes must match the SHA-256 digest GitHub publishes for the asset, its
 * declared size, and the zip signature. A release without a digest is refused rather than opened
 * unverified.
 */

export const RELEASE_REPO = 'elias-ramzi/WebLatexMCP';
export const BUNDLE_ASSET = 'web-latex-mcp.mcpb';
const LATEST_RELEASE_API = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`;
/** Far above any bundle shipped so far (~20 MB); a cap, so a wrong asset cannot fill the disk. */
export const MAX_BUNDLE_BYTES = 200 * 1024 * 1024;
const API_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 180_000;

/**
 * How this server was installed, read off the package root it runs from: a git checkout has
 * `.git`; the `.mcpb` bundle ships `manifest.json` (npm's `files` list leaves it out); anything
 * else came from npm.
 */
export type InstallKind = 'desktop-extension' | 'npm' | 'source';

export interface UpdateResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type UpdateFetch = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<UpdateResponse>;

export interface UpdateCheck {
  currentVersion: string;
  latestVersion: string;
  /** False also when the running version cannot be read — nothing is claimed then. */
  updateAvailable: boolean;
  installKind: InstallKind;
  releaseUrl: string;
}

export interface DownloadedBundle {
  path: string;
  bytes: number;
  sha256: string;
  /** Whether the OS accepted the request to open the bundle (not whether it was installed). */
  opened: boolean;
}

export class UpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpdateError';
  }
}

interface ReleaseAsset {
  url: string;
  size: number;
  sha256: string | undefined;
}

interface LatestRelease {
  version: string;
  tag: string;
  htmlUrl: string;
  asset: ReleaseAsset | undefined;
}

export interface UpdateServiceOptions {
  fetch?: UpdateFetch;
  /** The package root this server runs from (where `package.json` sits). */
  packageRoot?: string;
  currentVersion?: string;
  /** Opens a file with the OS's default handler; `openBrowser` already does exactly that. */
  open?: (target: string) => Promise<boolean>;
  /** Where the downloaded bundle is written (a fresh directory is made under it). */
  tmpDir?: string;
}

/** `1.2.3` or `v1.2.3`, numeric parts only; anything else (a pre-release, `unknown`) is null. */
export function parseVersion(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Whether `latest` is strictly newer than `current`; false when either cannot be read. */
export function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i]! > b[i]!;
  }
  return false;
}

export function detectInstallKind(packageRoot: string): InstallKind {
  if (existsSync(path.join(packageRoot, '.git'))) return 'source';
  if (existsSync(path.join(packageRoot, 'manifest.json'))) return 'desktop-extension';
  return 'npm';
}

/** What to run when the server cannot update itself — the advice the tool hands back. */
export function manualUpdateAdvice(kind: InstallKind, latestVersion: string): string {
  switch (kind) {
    case 'desktop-extension':
      return (
        `Download ${BUNDLE_ASSET} from https://github.com/${RELEASE_REPO}/releases/latest and ` +
        'drag it onto the Claude Desktop window (or Settings → Extensions → Install Extension).'
      );
    case 'npm':
      return (
        'Launched with `npx -y web-latex-mcp`: npx reuses its cached copy, so change the command ' +
        `to \`npx -y web-latex-mcp@${latestVersion}\` (or \`@latest\`) and restart the client. ` +
        'Installed globally: `npm install -g web-latex-mcp@latest`, then restart the client.'
      );
    case 'source':
      return (
        'Running from a git checkout: `git pull`, then `npm ci && npm run build`, then restart ' +
        'the client.'
      );
  }
}

function defaultPackageRoot(): string {
  // Both src/services/ (tsx) and dist/services/ (built) sit two levels under the package root.
  return fileURLToPath(new URL('../../', import.meta.url));
}

const defaultFetch: UpdateFetch = (url, init) => fetch(url, init);

export class UpdateService {
  private readonly fetchImpl: UpdateFetch;
  private readonly packageRoot: string;
  private readonly currentVersion: string;
  private readonly open: (target: string) => Promise<boolean>;
  private readonly tmpDir: string;

  constructor(opts: UpdateServiceOptions = {}) {
    this.fetchImpl = opts.fetch ?? defaultFetch;
    this.packageRoot = opts.packageRoot ?? defaultPackageRoot();
    this.currentVersion = opts.currentVersion ?? getServerVersion();
    this.open = opts.open ?? openBrowser;
    this.tmpDir = opts.tmpDir ?? os.tmpdir();
  }

  installKind(): InstallKind {
    return detectInstallKind(this.packageRoot);
  }

  async check(): Promise<UpdateCheck & { release: LatestRelease }> {
    const release = await this.latestRelease();
    return {
      currentVersion: this.currentVersion,
      latestVersion: release.version,
      updateAvailable: isNewer(release.version, this.currentVersion),
      installKind: this.installKind(),
      releaseUrl: release.htmlUrl,
      release,
    };
  }

  /**
   * Download the release's bundle, verify it, and open it with the OS (which hands a `.mcpb` to
   * Claude Desktop). Throws `UpdateError` on anything that does not verify; nothing is written
   * unless every check passed.
   */
  async downloadBundle(release: LatestRelease): Promise<DownloadedBundle> {
    const asset = release.asset;
    if (!asset) {
      throw new UpdateError(
        `Release ${release.tag} has no ${BUNDLE_ASSET} attached, so there is nothing to install. ` +
          `See ${release.htmlUrl}.`,
      );
    }
    if (!asset.sha256) {
      throw new UpdateError(
        `GitHub publishes no SHA-256 digest for ${BUNDLE_ASSET} in release ${release.tag}, so the ` +
          'download cannot be verified and was not attempted. Download it by hand from ' +
          `${release.htmlUrl} if you trust it.`,
      );
    }
    if (asset.size > MAX_BUNDLE_BYTES) {
      throw new UpdateError(
        `${BUNDLE_ASSET} in release ${release.tag} declares ${asset.size} bytes, over the ` +
          `${MAX_BUNDLE_BYTES}-byte cap; not downloaded.`,
      );
    }

    const res = await this.request(asset.url, DOWNLOAD_TIMEOUT_MS, 'application/octet-stream');
    let bytes: Buffer;
    try {
      bytes = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      throw new UpdateError(`Downloading ${BUNDLE_ASSET} failed: ${reason(err)}.`);
    }
    if (bytes.length !== asset.size) {
      throw new UpdateError(
        `Downloaded ${bytes.length} bytes, but the release declares ${asset.size} for ` +
          `${BUNDLE_ASSET}; the download was discarded.`,
      );
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== asset.sha256) {
      throw new UpdateError(
        `The downloaded ${BUNDLE_ASSET} does not match the SHA-256 digest GitHub publishes for ` +
          `release ${release.tag}; the download was discarded.`,
      );
    }
    // A .mcpb is a zip; the digest already pins the bytes, this only guards a wrong asset.
    if (!bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
      throw new UpdateError(`The downloaded ${BUNDLE_ASSET} is not a zip archive; discarded.`);
    }

    // A fresh, unpredictable directory: nothing else can have planted a file at this name.
    const dir = await mkdtemp(path.join(this.tmpDir, 'web-latex-mcp-update-'));
    const file = path.join(dir, `web-latex-mcp-${release.version}.mcpb`);
    await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
    const opened = await this.open(file);
    return { path: file, bytes: bytes.length, sha256, opened };
  }

  private async request(url: string, timeoutMs: number, accept: string): Promise<UpdateResponse> {
    let res: UpdateResponse;
    try {
      res = await this.fetchImpl(url, {
        headers: { Accept: accept, 'User-Agent': `web-latex-mcp/${this.currentVersion}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new UpdateError(`Could not reach GitHub (${url}): ${reason(err)}.`);
    }
    if (!res.ok) {
      const limited = res.status === 403 || res.status === 429;
      throw new UpdateError(
        `GitHub answered ${res.status} ${res.statusText} for ${url}.` +
          (limited
            ? ' This is usually its hourly rate limit for anonymous requests; retry later.'
            : ''),
      );
    }
    return res;
  }

  private async latestRelease(): Promise<LatestRelease> {
    const res = await this.request(
      LATEST_RELEASE_API,
      API_TIMEOUT_MS,
      'application/vnd.github+json',
    );
    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      throw new UpdateError(`GitHub's release listing could not be read: ${reason(err)}.`);
    }
    return parseLatestRelease(body);
  }
}

/** Read GitHub's `releases/latest` body, refusing anything outside the expected shape. */
export function parseLatestRelease(body: unknown): LatestRelease {
  const rec = asRecord(body);
  const tag = typeof rec?.tag_name === 'string' ? rec.tag_name : undefined;
  const parsed = tag ? parseVersion(tag) : null;
  if (!rec || !tag || !parsed) {
    throw new UpdateError(
      "GitHub's latest release does not carry a version tag (vMAJOR.MINOR.PATCH); cannot compare.",
    );
  }
  const version = parsed.join('.');
  const htmlUrl = `https://github.com/${RELEASE_REPO}/releases/tag/${tag}`;
  const expectedUrl = `https://github.com/${RELEASE_REPO}/releases/download/${tag}/${BUNDLE_ASSET}`;
  const assets = Array.isArray(rec.assets) ? rec.assets : [];
  let asset: ReleaseAsset | undefined;
  for (const raw of assets) {
    const a = asRecord(raw);
    if (!a || a.name !== BUNDLE_ASSET) continue;
    // Pinned to this repository and this tag: the API's own URL is used only when it is exactly
    // the one we would have built.
    if (a.browser_download_url !== expectedUrl) {
      throw new UpdateError(
        `The release's ${BUNDLE_ASSET} points somewhere other than ${expectedUrl}; refusing it.`,
      );
    }
    const size = typeof a.size === 'number' && Number.isSafeInteger(a.size) ? a.size : undefined;
    if (size === undefined || size <= 0) {
      throw new UpdateError(`The release's ${BUNDLE_ASSET} declares no usable size; refusing it.`);
    }
    const digest = typeof a.digest === 'string' ? /^sha256:([0-9a-f]{64})$/.exec(a.digest) : null;
    asset = { url: expectedUrl, size, sha256: digest?.[1] };
    break;
  }
  return { version, tag, htmlUrl, asset };
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function reason(err: unknown): string {
  if (err instanceof Error) {
    return err.name === 'TimeoutError' ? 'timed out' : err.message;
  }
  return String(err);
}
