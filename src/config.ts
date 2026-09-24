import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  readProjectRegistry,
  readProjectRegistryDefault,
  readProjectRegistrySkipped,
  registryPath,
} from './services/projectRegistry.js';
// One list of backends, shared with the resolver's fallback loop: a private copy here could
// accept a kind the fallback never tries (or reject one it does).
import { COMPILER_KINDS } from './services/compilerResolver.js';
import { REWRITE_MODES, DEFAULT_REWRITE_MODE } from './lib/rewriteMode.js';
import {
  describeSkippedProject,
  escapeInvisibleChars,
  findSkippedProject,
  listIds,
  projectIdProblem,
  quoteId,
} from './lib/projectId.js';
import type { RewriteMode } from './lib/rewriteMode.js';
// One list of ids, shared with the reference-lookup resolver: a private copy here could accept
// an id the resolver never tries (or reject one it does) — the same reasoning as COMPILER_KINDS.
import { REFERENCE_SOURCES } from './lib/referenceKey.js';
import type { ReferenceSourceId } from './lib/referenceKey.js';
import type {
  CompilerKind,
  ProjectConfig,
  ServerConfig,
  SkippedProject,
  ViewerTarget,
} from './types.js';

/**
 * `WEB_LATEX_MCP_PROJECTS` entries: a git remote to clone, or a directory to use in place. An entry
 * without `mode` is a git project — which is every entry written before local mode existed.
 */
const projectsSchema = z.record(
  z.string(),
  z.union([
    z.object({
      mode: z.literal('git').optional(),
      gitUrl: z.string().min(1),
      rootFile: z.string().min(1).optional(),
      branch: z.string().min(1).optional(),
      username: z.string().min(1).optional(),
      tokenEnv: z.string().min(1).optional(),
    }),
    z.object({
      mode: z.literal('local'),
      path: z.string().min(1),
      rootFile: z.string().min(1).optional(),
      followSymlinks: z.boolean().optional(),
    }),
  ]),
);

/** Expand a leading `~` to the user's home directory. */
function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Sentinel value for `WEB_LATEX_MCP_WORKSPACE` that forces clones into the coding agent's own
 * workspace — under `<launch-dir>/.web_latex_mcp` — so the `.tex`/PDF files sit right beside
 * the code the agent is working on. The launch dir is the server's cwd, which for a stdio
 * server spawned by Claude Code (or another agent) is the workspace root. This is also the
 * automatic default whenever the launch dir is inside a git repo (see `resolveWorkspace`).
 */
const WORKSPACE_CWD_SENTINEL = 'cwd';

/** Name of the workspace-local clone directory (the `cwd` sentinel and the in-repo default). */
export const LOCAL_WORKSPACE_DIRNAME = '.web_latex_mcp';

interface ResolvedWorkspace {
  workspaceRoot: string;
  /** True when clones live inside the agent's workspace (and are git-excluded from it). */
  workspaceIsLocal: boolean;
}

/** The shared home cache used when the launch dir isn't a suitable workspace. */
function homeWorkspace(): ResolvedWorkspace {
  return {
    workspaceRoot: path.join(os.homedir(), '.web-latex-mcp', 'projects'),
    workspaceIsLocal: false,
  };
}

/** Whether `dir` (or any ancestor) is a git working tree — walked synchronously via `.git`. */
function isInsideGitRepo(dir: string): boolean {
  let cur = path.resolve(dir);
  for (;;) {
    if (existsSync(path.join(cur, '.git'))) return true;
    const parent = path.dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}

/**
 * Resolve `WEB_LATEX_MCP_WORKSPACE` (raw env value) to an absolute clone root.
 *
 * Precedence: an explicit value always wins (the `cwd` sentinel forces workspace-local; any
 * other value is a path). When unset, the default is workspace-local (`<cwd>/.web_latex_mcp`)
 * *if the launch dir is inside a git repo and isn't the home dir itself* — the case where the
 * agent is clearly working in a project and the clone can be git-excluded from it. Otherwise it
 * falls back to the shared home cache (e.g. Claude Desktop launched from `/` or `~`).
 *
 * `insideRepo` is injectable so the default can be unit-tested without touching the filesystem.
 */
function resolveWorkspace(
  raw: string | undefined,
  cwd: string,
  insideRepo: (dir: string) => boolean = isInsideGitRepo,
): ResolvedWorkspace {
  const value = raw?.trim();
  if (!value) {
    const local = path.resolve(cwd) !== path.resolve(os.homedir()) && insideRepo(cwd);
    return local
      ? { workspaceRoot: path.join(cwd, LOCAL_WORKSPACE_DIRNAME), workspaceIsLocal: true }
      : homeWorkspace();
  }
  if (value.toLowerCase() === WORKSPACE_CWD_SENTINEL) {
    return { workspaceRoot: path.join(cwd, LOCAL_WORKSPACE_DIRNAME), workspaceIsLocal: true };
  }
  // Relative paths resolve against the launch dir; absolute (and ~-expanded) paths pass through.
  return { workspaceRoot: path.resolve(cwd, expandHome(value)), workspaceIsLocal: false };
}

function parseProjects(
  raw: string | undefined,
  cwd: string,
  workspaceRoot: string,
): { projects: ProjectConfig[]; skipped: SkippedProject[] } {
  if (!raw || !raw.trim()) return { projects: [], skipped: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`WEB_LATEX_MCP_PROJECTS is not valid JSON: ${(err as Error).message}`, {
      cause: err,
    });
  }
  // An id `src/lib/projectId.ts` refuses would name a directory outside the workspace (or inside
  // another project's clone). Skip it with a report rather than throw: one bad entry must not take
  // down every tool in the server — the same call the registry makes for a bad persisted entry.
  // The skip is also remembered (`ServerConfig.skippedProjects`), so a call naming the id is told
  // why: this stderr line never reaches an MCP client.
  //
  // Judged on the RAW keys, before the schema: `JSON.parse` keeps a "__proto__" key as an own
  // property, but the schema's record parse drops it on the way to its output object — so judged
  // after, `{"__proto__": …}` vanished with no report at all. The usable entries go to the schema
  // in a null-prototype object, so no key can reach `Object.prototype`'s setter on the way.
  const skipped: SkippedProject[] = [];
  let toValidate: unknown = parsed;
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    const usableRaw = Object.create(null) as Record<string, unknown>;
    for (const [id, value] of Object.entries(parsed)) {
      const problem = projectIdProblem(id);
      if (problem === undefined) {
        Object.defineProperty(usableRaw, id, {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
        continue;
      }
      const entry: SkippedProject = { id, source: 'WEB_LATEX_MCP_PROJECTS', kind: 'id', problem };
      skipped.push(entry);
      console.error(`[web-latex-mcp] ${describeSkippedProject(entry, workspaceRoot)}`);
    }
    toValidate = usableRaw;
  }
  const result = projectsSchema.safeParse(toValidate);
  if (!result.success) {
    throw new Error(`WEB_LATEX_MCP_PROJECTS is invalid: ${result.error.message}`);
  }
  const projects = Object.entries(result.data).map(([id, cfg]) =>
    cfg.mode === 'local'
      ? // A path from the environment may be `~`-prefixed or relative to the launch dir, the same
        // as WEB_LATEX_MCP_WORKSPACE. Resolve it once here so everything downstream sees absolute.
        { id, ...cfg, path: path.resolve(cwd, expandHome(cfg.path)) }
      : { id, ...cfg },
  );
  return { projects, skipped };
}

/**
 * Select the compile backend from env, defaulting to latexmk — and say whether that was a
 * *choice* or merely the default. Both answers come from this one emptiness test so they can
 * never disagree: unset, empty, and whitespace-only alike mean "not chosen", which is what
 * licenses a downstream fallback to whichever backend is installed. Naming a backend — even
 * the default one — is an assertion, never substituted.
 */
function parseCompilerChoice(raw: string | undefined): {
  kind: CompilerKind;
  explicit: boolean;
} {
  const value = raw?.trim().toLowerCase();
  if (!value) return { kind: 'latexmk', explicit: false };
  if (!(COMPILER_KINDS as readonly string[]).includes(value)) {
    throw new Error(
      `WEB_LATEX_MCP_COMPILER ${quoteEnvValue(raw ?? '')} is invalid; expected one of: ${COMPILER_KINDS.join(', ')}.`,
    );
  }
  return { kind: value as CompilerKind, explicit: true };
}

/**
 * Select the reference-lookup backend (DBLP / Crossref / OpenAlex) from
 * `WEB_LATEX_MCP_REFERENCE_SOURCE` — and say whether that was a *choice*, nothing at all, or a
 * value this server cannot use.
 *
 * **An invalid value does NOT throw**, and `parseCompilerChoice`'s precedent deliberately does
 * not transfer here. Note the difference is NOT that throwing is better scoped there — it is
 * not: `parseCompilerChoice` throws inside `loadConfig` too, so it costs every tool exactly the
 * same way. The difference is what is left afterwards. A LaTeX server that cannot compile has
 * little to offer; one that cannot search DBLP still has twenty-odd working tools. This setting
 * is scoped to `search_references` and nothing else, so throwing costs a user every tool in the
 * server — `read_file`, `compile`, `commit`, `push` — because `loadConfig` runs before the
 * transport exists and the process exits, which most MCP clients surface only as "MCP server
 * failed to start". `parseRewriteMode`, below, already takes the proportionate route for a
 * setting of comparable blast radius; this one takes it too.
 *
 * **But the alternative is not a silent fallback**, and that is the half a later "fix" will want
 * to take. Quietly reverting to the unpinned DBLP→Crossref→OpenAlex order would break "an
 * assertion, never an inference" outright: the user named a bibliography, and answering from a
 * *different* one is a different claim, not a degraded version of the same one. So the rejected
 * value is REMEMBERED and returned as `invalid`, `explicit` stays false (a rejected value is
 * nobody's choice, and `referenceSourceExplicit` must stay the sole licence for a substitution),
 * and `ReferenceResolver` refuses an unpinned search by name — while a per-call `source:`, which
 * is its own assertion, keeps working. Everything else in the server is unaffected. That is what
 * "proportionate" means here: refuse the thing configured, not the process.
 *
 * The rejection is logged to stderr — never stdout, which is the JSON-RPC channel — in the same
 * shape `parseContactEmail` uses, the value `quoteEnvValue`d (escaped and elided). It is elided
 * in the RETURNED `invalid` too, not only in the log: unlike the contact email, this value is
 * echoed onward into the tool's refusal message and into `server_info`, so a pasted
 * multi-kilobyte env var would otherwise reach a model's context three times over. The elision says how much was cut.
 *
 * One deliberate difference from `parseCompilerChoice`, worth not "fixing" later: an unset value
 * here returns `source: undefined`, never a default id. `parseCompilerChoice` can default to
 * `latexmk` because the *tool* substitutes a missing backend; here the *resolver* is what owns
 * fallback order across three backends (trying each in turn, e.g. on a DBLP anti-bot block), so
 * config must stay silent about which one wins rather than naming a winner the resolver would
 * then have to un-name.
 */
export function parseReferenceSource(raw: string | undefined): {
  source: ReferenceSourceId | undefined;
  explicit: boolean;
  /** The rejected value, trimmed and elided. Set ONLY when the value named no known backend. */
  invalid: string | undefined;
} {
  const trimmed = raw?.trim();
  if (!trimmed) return { source: undefined, explicit: false, invalid: undefined };
  const value = trimmed.toLowerCase();
  if ((REFERENCE_SOURCES as readonly string[]).includes(value)) {
    return { source: value as ReferenceSourceId, explicit: true, invalid: undefined };
  }
  const shown = elide(trimmed);
  console.error(
    `WEB_LATEX_MCP_REFERENCE_SOURCE ${quoteEnvValue(trimmed)} is invalid; expected one of: ` +
      `${REFERENCE_SOURCES.join(', ')}. search_references will refuse to search until this is ` +
      'fixed or unset (a per-call source: still works); every other tool is unaffected.',
  );
  return { source: undefined, explicit: false, invalid: shown };
}

/**
 * Resolve an optional contact address for the "polite pool" Crossref and OpenAlex offer to
 * requests that identify a contact. This is a privacy boundary: the address is read ONLY from
 * `WEB_LATEX_MCP_CONTACT_EMAIL` — never derived from `git config user.email` or any other
 * source — because it is sent to two third-party services, and the only thing that may put a
 * user's address there is the user deliberately setting this variable. Opt-in, not inferred.
 *
 * A malformed value is a convenience failure, not a correctness one (the same reasoning as
 * `parseRewriteMode`): it does not throw, it logs the rejection to stderr (never stdout — the
 * JSON-RPC channel) and returns undefined, so a typo costs only the polite-pool speedup. It does
 * not cost it *silently*, though: `loadConfig` also records `contactEmailInvalid`, so a rejected
 * value is distinguishable from an unset one in `server_info` rather than being byte-identical
 * to a default install with nothing to explain why the polite pool is off.
 * Checked here, not merely "looks emailish": the value is interpolated into a URL query
 * parameter, so `&`, `?`, `#`, `/` and any whitespace/control character (including a newline)
 * are rejected too — those could otherwise let a malformed value alter the request URL. Length
 * is capped for the same reason: the value goes into a `User-Agent` header *and* a `mailto=`
 * query parameter, and a pasted multi-kilobyte value draws a 431 from some fronts, which reaches
 * the caller as "Crossref could not be reached" with nothing naming the variable that caused it.
 * Rejecting it here spends the same stderr line every other malformed value gets, and names the
 * real cause.
 */
export function parseContactEmail(raw: string | undefined): string | undefined {
  return resolveContactEmail(raw).email;
}

/**
 * The single derivation behind `parseContactEmail`, returning what `loadConfig` needs and the
 * exported wrapper does not: whether a value was present and REJECTED, as opposed to absent.
 *
 * Kept as one function rather than two tests of the same string, for `parseCompilerChoice`'s
 * reason: two derivations of "was this usable" can disagree, and this one is also the thing
 * that decides whether a stderr line is spent. `parseContactEmail` stays a thin wrapper so its
 * exported signature — an address or undefined, which is all any caller wants — is unchanged.
 *
 * What is returned is a BOOLEAN, never the offending value; see `ServerConfig.contactEmailInvalid`
 * for why this is the one rejected setting whose value is not carried forward.
 */
function resolveContactEmail(raw: string | undefined): {
  email: string | undefined;
  /** True only when a non-empty value was set and could not be used. Unset is not invalid. */
  invalid: boolean;
} {
  const value = raw?.trim();
  if (!value) return { email: undefined, invalid: false };
  if (isUsableContactEmail(value)) return { email: value, invalid: false };
  // The rejected value is echoed back so the typo is visible — but it is echoed ELIDED, since
  // the one rejection reason that has no short value is "too long", and dumping a pasted
  // multi-kilobyte token into the log trades one oversized string for another. This log line is
  // the ONLY place the rejected address appears: stderr is the operator's own terminal, whereas
  // `server_info` is read by a model, so the flag below is all that travels onward.
  console.error(
    `WEB_LATEX_MCP_CONTACT_EMAIL ${quoteEnvValue(raw ?? '')} is not usable as a contact address; ` +
      'ignoring it. Expected a plain ASCII email address (no query-altering characters, no ' +
      `whitespace or "();\\", at most ${MAX_CONTACT_EMAIL_LENGTH} characters).`,
  );
  return { email: undefined, invalid: true };
}

/** Shorten an over-long value for a log line, saying what was cut rather than hiding it. */
function elide(value: string, max = 120): string {
  return value.length <= max ? value : `${value.slice(0, max)}… (${value.length} characters)`;
}

/**
 * A raw environment value as an error or stderr message shows it: `quoteId`'d, so a newline
 * cannot forge a second log line nor a bidi control reorder the rest of it, and shortened past
 * `max` characters the way `elide` does, the count outside the quotes.
 */
function quoteEnvValue(value: string, max = 120): string {
  return value.length <= max
    ? quoteId(value)
    : `${quoteId(value.slice(0, max))}… (${value.length} characters)`;
}

/**
 * RFC 5321's limit on a forward path, and the cap on a usable contact address. Anything longer
 * is a paste accident, not an address, and it would be sent in a header and a query parameter.
 */
const MAX_CONTACT_EMAIL_LENGTH = 254;

/**
 * True when `value` is a plausible email address that is safe both in a URL query string and
 * inside a User-Agent header comment. See `parseContactEmail`.
 */
function isUsableContactEmail(value: string): boolean {
  // Measured on the trimmed value, like every check below it.
  if (value.length > MAX_CONTACT_EMAIL_LENGTH) return false;
  // Printable ASCII only (0x21-0x7E), which also excludes whitespace and control characters.
  // The address is interpolated into a User-Agent header, and fetch refuses a header value with
  // a code point above 255 before any I/O — so a non-ASCII address turned every Crossref and
  // OpenAlex request into "could not be reached" while `server_info` reported it configured.
  // Latin-1 would pass that check, but a header value is only portably ASCII, so it goes too.
  if (!/^[\x21-\x7e]+$/.test(value)) return false;
  // Reject anything that could alter a URL query string (`&?#/`), or break out of the
  // `(+url; mailto:<email>)` comment the User-Agent carries it in (`()` delimit a comment, `\`
  // escapes inside one, `;` separates its parts).
  if (/[&?#/()\\;]/.test(value)) return false;
  const at = value.split('@');
  if (at.length !== 2) return false;
  const [local, domain] = at;
  if (!local || !domain) return false;
  if (!domain.includes('.')) return false;
  const domainParts = domain.split('.');
  return domainParts.every((part) => part.length > 0);
}

/**
 * Select the default rewrite-preservation mode from `WEB_LATEX_MCP_REWRITE_MODE`. Unlike
 * `parseCompilerChoice`, an invalid value does not throw: a bad compiler choice is unrecoverable
 * (the server cannot compile), whereas this setting is cosmetic — refusing to start the whole
 * server over a typo in a comment-style preference would be out of proportion. Instead, fall
 * back to the default and log the rejection to stderr (never stdout — that is the JSON-RPC
 * channel) so the typo is still visible.
 */
export function parseRewriteMode(raw: string | undefined): {
  mode: RewriteMode;
  explicit: boolean;
} {
  const value = raw?.trim().toLowerCase();
  // Both answers come from this one emptiness test so they can never disagree — the same shape
  // as `parseCompilerChoice`. `explicit` is what lets a *reporting* tool tell "the user set this"
  // from "nobody set anything": the resolved mode is populated either way, so a caller testing
  // `rewriteMode !== undefined` would call the built-in default a configured one.
  if (!value) return { mode: DEFAULT_REWRITE_MODE, explicit: false };
  if ((REWRITE_MODES as readonly string[]).includes(value)) {
    return { mode: value as RewriteMode, explicit: true };
  }
  // Echoed trimmed and `quoteEnvValue`d, as `parseReferenceSource` does: the typo stays visible, but a
  // pasted multi-kilobyte value costs one bounded line rather than kilobytes of stderr.
  console.error(
    `WEB_LATEX_MCP_REWRITE_MODE ${quoteEnvValue((raw ?? '').trim())} is invalid; expected one of: ${REWRITE_MODES.join(
      ', ',
    )}. Falling back to "${DEFAULT_REWRITE_MODE}".`,
  );
  // A rejected value is not a choice: fall back to the default *and* report it as unchosen, so
  // nothing downstream describes the fallback as something the user asked for.
  return { mode: DEFAULT_REWRITE_MODE, explicit: false };
}

/**
 * Resolve `WEB_LATEX_MCP_WRITING_GUIDE_EXTRA` — a path or a `file://` URL to an ADDITIONAL
 * writing guide, appended to (never replacing) the base one.
 *
 * A `file:` value MUST use the authority form `file://...` — a bare `file:conventions.md` (no
 * `//`) is not a relative-path shorthand, it's a URL whose path component is `conventions.md`,
 * which `fileURLToPath` resolves to `/conventions.md` (the filesystem root) — and on Windows to
 * the current drive's root. So: only `/^file:\/\//i` is treated as a URL; anything else starting
 * with `file:` but lacking `//` is malformed and must NOT fall through to the plain-path branch
 * either (that would silently turn it into `<cwd>/file:conventions.md`). Malformed input here is
 * never fatal — an optional overlay must not be able to take the whole server down — so this logs
 * a loud `[web-latex-mcp]` line to stderr (never stdout: that's the JSON-RPC channel) and returns
 * the same "nothing named" result as unset, for `loadConfig` to pass along unchanged.
 */
export function parseExtraWritingGuide(raw: string | undefined, cwd: string): { path?: string } {
  const value = raw?.trim();
  if (!value) return {};
  if (/^file:/i.test(value)) {
    if (!/^file:\/\//i.test(value)) {
      warnMalformedWritingGuideExtra(
        value,
        'a file: value must use the authority form file:// (e.g. file:///path/to/conventions.md), not a bare file:path',
      );
      return {};
    }
    let resolved: string;
    try {
      resolved = fileURLToPath(new URL(value));
    } catch (err) {
      warnMalformedWritingGuideExtra(value, `not a usable file:// URL: ${(err as Error).message}`);
      return {};
    }
    if (!path.isAbsolute(resolved)) {
      warnMalformedWritingGuideExtra(value, `resolved to a non-absolute path "${resolved}"`);
      return {};
    }
    if (isFilesystemRoot(resolved)) {
      warnMalformedWritingGuideExtra(value, `resolved to the filesystem root "${resolved}"`);
      return {};
    }
    return { path: resolved };
  }
  const plainResolved = path.resolve(cwd, expandHome(value));
  if (isFilesystemRoot(plainResolved)) {
    warnMalformedWritingGuideExtra(value, `resolved to the filesystem root "${plainResolved}"`);
    return {};
  }
  return { path: plainResolved };
}

/** True when `resolved` is a filesystem root (POSIX `/`, or a Windows drive root like `C:\`). */
function isFilesystemRoot(resolved: string): boolean {
  return path.dirname(resolved) === resolved || path.basename(resolved) === '';
}

function warnMalformedWritingGuideExtra(raw: string, reason: string): void {
  console.error(
    `[web-latex-mcp] WEB_LATEX_MCP_WRITING_GUIDE_EXTRA ${quoteEnvValue(raw)} is not usable: ${escapeInvisibleChars(reason)}. ` +
      'Accepted forms: a plain path (e.g. /path/to/conventions.md) or a file:// URL with the ' +
      'authority form (e.g. file:///path/to/conventions.md). Ignoring it; no extra writing ' +
      'guide will be loaded.',
  );
}

/**
 * Build the server configuration from environment variables. Reads the filesystem for four
 * things: whether the launch dir is a git repo (for the workspace default), the persisted
 * project registry's project list, the persisted registry's `default: true` flag, and — only
 * when `WEB_LATEX_MCP_DEFAULT_PROJECT` names no loaded project — the registry entries it
 * skipped. All four reads are injectable (`insideRepo`, `readRegistry`, `readRegistryDefault`,
 * `readRegistrySkipped`) so unit tests stay
 * hermetic — a real on-disk registry (e.g. a developer's actual workspace) must never leak into a
 * test that didn't ask for it.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  insideRepo?: (dir: string) => boolean,
  readRegistry: (workspaceRoot: string) => ProjectConfig[] = readProjectRegistry,
  readRegistryDefault: (workspaceRoot: string) => string | undefined = readProjectRegistryDefault,
  readRegistrySkipped: (workspaceRoot: string) => SkippedProject[] = readProjectRegistrySkipped,
): ServerConfig {
  const { workspaceRoot, workspaceIsLocal } = resolveWorkspace(
    env.WEB_LATEX_MCP_WORKSPACE,
    cwd,
    insideRepo,
  );

  // Env projects are the explicit source of truth and always win; persisted (runtime-registered)
  // projects fill in the rest, so a git URL added from the chat is still here after a restart.
  const { projects: envProjects, skipped: skippedProjects } = parseProjects(
    env.WEB_LATEX_MCP_PROJECTS,
    cwd,
    workspaceRoot,
  );
  const byId = new Map<string, ProjectConfig>();
  for (const p of readRegistry(workspaceRoot)) byId.set(p.id, p);
  for (const p of envProjects) byId.set(p.id, p);
  const projects = [...byId.values()];

  const envDefault = env.WEB_LATEX_MCP_DEFAULT_PROJECT?.trim() || undefined;
  const knownProjectIds = () => listIds(projects.map((p) => p.id));

  if (envDefault && !projects.some((p) => p.id === envDefault)) {
    // A default naming an entry that IS configured but was skipped (an id the rule refuses, or a
    // registry entry this version cannot use) is not a typo, and must not stop the server: the
    // skip was already reported, and every other tool — and every call that names its project —
    // still works. It stays the default, so a call that omits `project` gets the same
    // explanation from `ProjectManager.getProjectConfig` (which the stderr note never reaches).
    // Only a name configured nowhere at all is still refused at startup.
    const skipped = findSkippedProject(
      [...skippedProjects, ...readRegistrySkipped(workspaceRoot)],
      envDefault,
    );
    if (skipped === undefined) {
      throw new Error(
        `WEB_LATEX_MCP_DEFAULT_PROJECT ${quoteId(envDefault)} is not a known project. Known ` +
          `(from WEB_LATEX_MCP_PROJECTS and the workspace registry at ` +
          `${registryPath(workspaceRoot)}): ${knownProjectIds()}.`,
      );
    }
    console.error(
      `[web-latex-mcp] WEB_LATEX_MCP_DEFAULT_PROJECT ${quoteId(envDefault)} names a project ` +
        `that was skipped (${skipped.problem}); it stays the default, and a call that omits ` +
        '"project" is told why and how to fix it.',
    );
  }

  // A registry.json default (register_project { default: true }) fills in only when the env var
  // above did not — an explicit env default always wins, never merely overridden in memory here.
  // Still resolved unconditionally so a stale/unknown persisted default is reported either way.
  const persistedDefaultCandidate = readRegistryDefault(workspaceRoot);
  let persistedDefault: string | undefined;
  if (persistedDefaultCandidate && projects.some((p) => p.id === persistedDefaultCandidate)) {
    persistedDefault = persistedDefaultCandidate;
  } else if (persistedDefaultCandidate) {
    console.error(
      `[web-latex-mcp] ignoring persisted default project ${quoteId(persistedDefaultCandidate)} ` +
        `(registry.json at ${registryPath(workspaceRoot)}): not a known project (from ` +
        `WEB_LATEX_MCP_PROJECTS and the workspace registry): ${knownProjectIds()}.`,
    );
  }

  const defaultProject = envDefault ?? persistedDefault;
  const defaultProjectExplicit = envDefault !== undefined;

  const { kind: compiler, explicit: compilerExplicit } = parseCompilerChoice(
    env.WEB_LATEX_MCP_COMPILER,
  );
  const viewerPort = parseViewerPort(env.WEB_LATEX_MCP_VIEWER_PORT);
  const viewerTarget = parseViewerTarget(env.WEB_LATEX_MCP_VIEWER_TARGET);
  const { mode: rewriteMode, explicit: rewriteModeExplicit } = parseRewriteMode(
    env.WEB_LATEX_MCP_REWRITE_MODE,
  );
  const { path: extraWritingGuidePath } = parseExtraWritingGuide(
    env.WEB_LATEX_MCP_WRITING_GUIDE_EXTRA,
    cwd,
  );
  const {
    source: referenceSource,
    explicit: referenceSourceExplicit,
    invalid: referenceSourceInvalid,
  } = parseReferenceSource(env.WEB_LATEX_MCP_REFERENCE_SOURCE);
  const { email: contactEmail, invalid: contactEmailRejected } = resolveContactEmail(
    env.WEB_LATEX_MCP_CONTACT_EMAIL,
  );

  return {
    workspaceRoot,
    workspaceIsLocal,
    sessionId: parseSessionId(env.WEB_LATEX_MCP_SESSION),
    projects,
    ...(skippedProjects.length > 0 ? { skippedProjects } : {}),
    defaultProject,
    defaultProjectExplicit,
    compiler,
    compilerExplicit,
    viewerPort,
    viewerTarget,
    rewriteMode,
    rewriteModeExplicit,
    extraWritingGuidePath,
    referenceSource,
    referenceSourceExplicit,
    referenceSourceInvalid,
    contactEmail,
    // Set only when a value was actually rejected: a `false` on every healthy install would say
    // "a value was considered", which is exactly the state this flag exists to tell apart.
    ...(contactEmailRejected ? { contactEmailInvalid: true } : {}),
  };
}

/**
 * Resolve this process's session id. An explicit `WEB_LATEX_MCP_SESSION` is the useful case —
 * it names the session in `status` and keys its shadow of uncommitted work, so parallel agent
 * sessions on one project should each set a distinct, meaningful value. Unset, we generate one,
 * which still isolates this process's changes but reads as anonymous to peers.
 *
 * Sanitised to a safe directory name, since it becomes one under the session state dir.
 */
function parseSessionId(raw: string | undefined): string {
  const value = raw?.trim();
  if (raw === undefined || !value) return `session-${randomBytes(4).toString('hex')}`;
  const safe = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  if (!safe) {
    throw new Error(
      `WEB_LATEX_MCP_SESSION ${quoteId(raw)} has no usable characters; use letters, digits, ".", "_" or "-".`,
    );
  }
  const id = safe.slice(0, 64);
  // Judged on the id actually used, case-folded: on a case-insensitive disk `Shelves/` IS
  // `shelves/`, and refusing on every platform keeps a config portable between them.
  if (RESERVED_SESSION_IDS.includes(id.toLowerCase())) {
    throw new Error(
      `WEB_LATEX_MCP_SESSION ${quoteId(raw)} is reserved: "${id}" names project-wide state beside the ` +
        `session directories (${RESERVED_SESSION_IDS.join(', ')}); choose another name.`,
    );
  }
  return id;
}

/**
 * Names a session id may not take, because each is already an entry directly under
 * `<workspace>/.sessions/<projectId>/`, where every session's own directory also lives
 * (`src/lib/sessionPaths.ts`): the shelf store's `shelves/` (`ShelfStore.shelvesDir`), the
 * cross-process lock (`projectLockPath`) and the sticky rewrite mode (`rewriteModePath`). A session
 * named `shelves` wrote its session.json/shadow/base into the shelf store. Lower-case, compared
 * against the lower-cased id. `test/unit/config.test.ts` reads each name off the real layout, so
 * a renamed entry fails there; a NEW project-level entry must be added here by hand.
 */
const RESERVED_SESSION_IDS: readonly string[] = ['shelves', 'project.lock', 'rewrite-mode.json'];

/** Parse the default viewer target from env; undefined (the default) means the OS browser. */
function parseViewerTarget(raw: string | undefined): ViewerTarget | undefined {
  const v = raw?.trim().toLowerCase();
  if (!v) return undefined;
  if (v === 'browser' || v === 'vscode') return v;
  throw new Error(
    `WEB_LATEX_MCP_VIEWER_TARGET ${quoteEnvValue(raw ?? '')} is invalid; expected "browser" or "vscode".`,
  );
}

/** Parse an optional fixed viewer port; undefined (the default) means OS-assigned ephemeral. */
function parseViewerPort(raw: string | undefined): number | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(
      `WEB_LATEX_MCP_VIEWER_PORT ${quoteEnvValue(raw ?? '')} is invalid; expected a port 0-65535.`,
    );
  }
  return port;
}
