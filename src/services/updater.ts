import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getServerVersion } from '../lib/version.js';
import { openFile } from '../lib/openFile.js';
import { toPosix } from '../lib/paths.js';
import { escapeInvisibleChars, quoteId } from '../lib/projectId.js';
import type { InstallKind } from '../lib/installKind.js';

export type { InstallKind } from '../lib/installKind.js';

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
/**
 * Far above any bundle shipped so far (~20 MB). It caps the size the release DECLARES, checked
 * before anything is downloaded. The body is read as a stream that stops at the first chunk that
 * passes that declared size (one network read past it at most), and nothing beyond the declared
 * size is ever written to disk, so memory stays within roughly twice the cap plus one chunk.
 */
export const MAX_BUNDLE_BYTES = 200 * 1024 * 1024;
const API_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 180_000;

export interface UpdateResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
  /** The download is read from this stream (never buffered whole); null reads as no bytes. */
  body: ReadableStream<Uint8Array> | null;
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
  /**
   * The install kind the launcher asserted (`WEB_LATEX_MCP_INSTALL_KIND`, set by the Desktop
   * extension's manifest). Wins over anything read off `packageRoot` — see `detectInstallKind`.
   */
  installKind?: InstallKind;
  currentVersion?: string;
  /** Opens a file with the OS's default handler (`openFile`: on win32 the path never reaches cmd). */
  open?: (target: string) => Promise<boolean>;
  /** Where the downloaded bundle is written (a fresh directory is made under it). */
  tmpDir?: string;
}

/**
 * `1.2.3` or `v1.2.3`, numeric parts of 1–9 digits only; anything else (a pre-release, `unknown`,
 * surrounding whitespace, a part too long to stay an exact number) is null. The string judged is
 * the string given — never a trimmed copy — because a release tag is put into URLs and messages as
 * it came.
 */
export function parseVersion(v: string): [number, number, number] | null {
  const m = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Whether `v` is a version `isNewer` can compare; when it is not, no update claim is made. */
export function isComparableVersion(v: string): boolean {
  return parseVersion(v) !== null;
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

/**
 * How this server was installed. The Desktop extension is known only because its launcher says so:
 * the extension's `manifest.json` sets `WEB_LATEX_MCP_INSTALL_KIND=desktop-extension` in the env
 * Claude Desktop starts the server with, and an asserted kind (`asserted`) always wins. Without
 * one, a package root holding `.git` (a directory, or the file a worktree has) is a `source`
 * checkout, and anything else is `npm`.
 *
 * An assertion, never an inference: `manifest.json` on disk is NOT read as the extension, because
 * it sits at the repository root, so every copy of the repository without `.git` (a GitHub
 * "Source code" archive, degit, a Docker image that drops `.git`, a copied folder) carries it —
 * and the extension is the one kind `update_server` acts on, downloading the `.mcpb` and opening
 * it, which would offer a second install in Claude Desktop while the copy actually running stays
 * stale. Mistaking such a copy for npm costs only advice that does not fit; nothing is downloaded.
 */
export function detectInstallKind(packageRoot: string, asserted?: InstallKind): InstallKind {
  if (asserted !== undefined) return asserted;
  if (existsSync(path.join(packageRoot, '.git'))) return 'source';
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
  private readonly assertedKind: InstallKind | undefined;
  private readonly currentVersion: string;
  private readonly open: (target: string) => Promise<boolean>;
  private readonly tmpDir: string;

  constructor(opts: UpdateServiceOptions = {}) {
    this.fetchImpl = opts.fetch ?? defaultFetch;
    this.packageRoot = opts.packageRoot ?? defaultPackageRoot();
    this.assertedKind = opts.installKind;
    this.currentVersion = opts.currentVersion ?? getServerVersion();
    this.open = opts.open ?? openFile;
    // Resolved now: `os.tmpdir()` returns a relative TMPDIR as is, and `openFile` opens only an
    // absolute path.
    this.tmpDir = path.resolve(opts.tmpDir ?? os.tmpdir());
  }

  installKind(): InstallKind {
    return detectInstallKind(this.packageRoot, this.assertedKind);
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
    const bytes = await readCapped(res.body, asset.size);
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
    // The temp dir is named by the environment, so a failure here names it quoted and escaped.
    const saveFailed = (where: string, err: unknown) =>
      new UpdateError(
        `Could not save ${BUNDLE_ASSET} under ${quoteId(toPosix(where))}: ${reason(err)}.`,
      );
    let dir: string;
    try {
      dir = await mkdtemp(path.join(this.tmpDir, 'web-latex-mcp-update-'));
    } catch (err) {
      throw saveFailed(this.tmpDir, err);
    }
    const file = path.join(dir, `web-latex-mcp-${release.version}.mcpb`);
    try {
      await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
    } catch (err) {
      throw saveFailed(dir, err);
    }
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
        `GitHub answered ${res.status} ${escapeInvisibleChars(res.statusText)} for ${url}.` +
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

/**
 * Read a download body, keeping no more than `declared` bytes of it: the read is cancelled, and the
 * download refused, at the first chunk that takes the running total past the size the release
 * declares, so at most one network read beyond it is buffered before the refusal. On success the
 * chunks and their joined copy are briefly held together (about twice `declared`). A shorter body
 * is returned as is, for the caller's size check to refuse. A missing body reads as no bytes. A
 * read error (the download's timeout firing mid-stream included) is an `UpdateError`.
 */
async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  declared: number,
): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const step = await reader.read().catch((err: unknown) => {
      throw new UpdateError(`Downloading ${BUNDLE_ASSET} failed: ${reason(err)}.`);
    });
    if (step.done) break;
    total += step.value.byteLength;
    if (total > declared) {
      await reader.cancel().catch(() => undefined);
      throw new UpdateError(
        `The download of ${BUNDLE_ASSET} ran past the ${declared} bytes the release declares; ` +
          'it was cut off there and discarded.',
      );
    }
    chunks.push(step.value);
  }
  return Buffer.concat(chunks, total);
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

/**
 * A failure as a message names it. Node's `fetch` throws a bare `TypeError('fetch failed')` and
 * keeps what happened (`ENOTFOUND`, `ECONNREFUSED`, a TLS error) in `cause`, so the cause's code —
 * or, without one, its message — is appended. Everything is escaped, the error's own message
 * included: a JSON parse error quotes the response body, which a proxy may have written.
 */
function reason(err: unknown): string {
  if (!(err instanceof Error)) return escapeInvisibleChars(String(err));
  if (err.name === 'TimeoutError') return 'timed out';
  const cause: unknown = err.cause;
  let detail: string | undefined;
  if (cause !== null && typeof cause === 'object') {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'string' && code !== '') detail = code;
    else if (cause instanceof Error && cause.message !== '') detail = cause.message;
  }
  const message = escapeInvisibleChars(err.message);
  return detail === undefined ? message : `${message} (${escapeInvisibleChars(detail)})`;
}
