import { quoteId } from './projectId.js';

/**
 * Credentials a caller pasted INTO a git URL (`https://user:token@host/repo`). A project's
 * `gitUrl` is persisted to the workspace `registry.json`, echoed in `register_project`'s result and
 * listed by `list_projects`, and `GitService.clone` writes it to the clone's `origin` — so a token
 * left inside it would be stored in plain text in two files and shown back to the model. Tokens
 * are resolved per host at git time instead (`CredentialResolver`: `tokenEnv`, the host-default
 * env var, `set_credential`, `git credential fill`).
 *
 * A secret can sit in three places of a `<scheme>://` URL, and each is judged here:
 *
 * - **the userinfo**: a password (`user:secret@`) on ANY scheme — `ssh://`, `git+ssh://`,
 *   `ftp(s)://` as well as `http(s)://` — and, on http(s) only, a username that is itself a token
 *   (below). A non-http login (`ssh://git@host/…`) is never judged a token: an ssh user name is a
 *   login, and `git@` is what every host's ssh URL carries. An scp-style `git@host:owner/repo`
 *   has no password syntax at all and is left byte-identical, as is a local path;
 * - **the query**: a parameter whose name (percent-decoded, compared case-insensitively) is one of
 *   `CREDENTIAL_PARAMS` (`access_token`, `private_token`, `token`, `sig`, …), or whose decoded
 *   value starts with a documented token prefix (`TOKEN_PREFIX`). Stripping removes that
 *   parameter and its `&` (the `?` too when nothing is left), keeping the other parameters and any
 *   `#fragment` as written; an empty parameter (`?&…`, `&&`) goes too once anything is removed, so
 *   no bare `?` or stray `&` is left. Judged on every `<scheme>://` URL — git hands an ssh URL's
 *   `?…` to the server as part of the path, and a `?token=` there is no less a secret;
 * - **a path segment**: a segment (after the authority, before `?`/`#`) whose decoded value starts
 *   with a documented token prefix AND has a prefix-less token's length and character mix
 *   (`OPAQUE_MIN_LENGTH`, `opaqueTokenMix`), so a repository named `hf_utils` or `ghp_notes` is not
 *   one. Redacted as `***`, but NEVER stripped: removing a path segment changes which repository
 *   the URL names. `stripGitUrlCredentials` reports it as `pathToken` instead, and registration
 *   refuses such a URL (`pathTokenRefusal`: `register_project` before the project lock, and
 *   `ProjectManager.registerProject` behind it).
 *
 * A `file:` URL has no userinfo to judge: git never authenticates one, and its "authority" is
 * often a Windows path (`file://C:\Users\me@corp\repo.git`), where an `@` is part of a
 * directory name — reading `C:\Users\me` as `user:password` named another path and reported a
 * removed password. Its query and path are judged as on any other scheme.
 *
 * Everything but the secret (and surrounding whitespace, which is trimmed) is kept as written —
 * the URL is not re-serialised, so a host or path spelling the caller chose is never normalised
 * under them.
 *
 * **A login name is kept; only a secret is removed.** The username in an http(s) URL is not a
 * secret, and it is not inert either: `CredentialResolver` never reads it (its username is the
 * per-project `username` or the host default), but when the resolver finds no token git falls
 * through to the user's own credential helpers, and those look the credential up by host AND
 * the URL's username — Azure DevOps' default clone URL is `https://<org>@dev.azure.com/…`,
 * Bitbucket's is `https://<user>@bitbucket.org/…`. Removing the name changed which credential
 * they found. So:
 *
 * - `user:secret@` loses `:secret` and keeps `user@` (on every scheme);
 * - a colon-less `name@` is kept — UNLESS, on http(s), the name is itself an access token (`looksLikeToken`):
 *   GitHub, GitLab and others accept a token as the username alone
 *   (`https://<token>@github.com/…`), and a token is removed wherever it sits, the whole userinfo
 *   with it (`token:x-oauth-basic@` included).
 *
 * The token test errs toward removal: a login name it mistakes for a token is dropped from the
 * URL — the pre-fix behaviour, and the note says so — while a token it missed would be persisted.
 * Two kinds of name are recognised as logins before that error can happen: a name the same URL
 * already publishes as a path segment or host label (Azure DevOps' `<org>@dev.azure.com/<org>/…`
 * and `<org>@<org>.visualstudio.com`, a user's own namespace in the path) — keeping it keeps
 * nothing that is not stored anyway — and AWS CodeCommit's generated `<user>-at-<account id>`.
 *
 * The scheme is matched as a URL parser reads it, not as it is usually written: WHATWG takes
 * `https:` followed by any run of `/` and `\` (none included) as `https://`, so
 * `https:/<token>@host` and `https:\<token>@host` carry the token in the userinfo just the same.
 * When a userinfo credential is removed the separator is written back as `//`; a URL whose only
 * credential was in its query keeps its separator as written, and a URL left alone is returned as
 * written.
 */

/**
 * The userinfo of an http(s) URL: everything between the scheme's slashes and the LAST `@` before
 * the authority ends (`/`, `?`, `#`, or `\`, which WHATWG treats as `/` for these schemes).
 * Greedy on purpose — a raw `@` inside a password still leaves the last one as the host
 * delimiter, as a URL parser reads it, so no fragment of the token survives. The slashes are any
 * run of `/` and `\`, none included, because that is what WHATWG accepts there (`https:/tok@h`,
 * `https:\\tok@h` and `https:tok@h` all parse with `tok` as the username).
 */
const HTTP_USERINFO = /^(https?:)([\\/]*)([^/?#\\]*)@/i;

/**
 * Documented token prefixes: GitHub (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`),
 * GitLab (`glpat-`, `gloas-`, `gldt-`, `glrt-`, `glptt-`, `glcbt-`, `glft-`, `glimt-`, `glsoat-`),
 * Overleaf (`olp_`), Atlassian/Bitbucket (`ATBB`, `ATATT`), Hugging Face (`hf_`).
 */
const TOKEN_PREFIX =
  /^(gh[pousr]_|github_pat_|gl(pat|oas|dt|rt|ptt|cbt|ft|imt|soat)-|olp_|ATBB|ATATT|hf_)/;

/**
 * Characters that never appear in a login name but do in a base64 token — a Bitbucket Data Center
 * HTTP access token (`NjE0…+kB2f…`), any `…==`-padded secret. Judged on the DECODED userinfo, so
 * `%2B`/`%2F`/`%3D` count too.
 */
const BASE64_ONLY = /[+=/]/;

/**
 * The length from which a prefix-less userinfo is judged by its character mix rather than kept:
 * 20 is a legacy GitLab personal access token's whole length (a base64url `friendly_token`, no
 * prefix), and every other prefix-less token (40-hex GitHub OAuth, 52-char Azure DevOps PAT) is
 * longer. Hand-picked login names reach it rarely — and then usually as `firstname.lastname`,
 * which the character mix keeps.
 */
const OPAQUE_MIN_LENGTH = 20;

/**
 * AWS CodeCommit's HTTPS Git credential user name: the IAM user name (`[\w+=,.@-]`), `-at-`, and
 * the 12-digit account id. Generated by AWS, never a secret (the password is), and long enough
 * with a digit that the character-mix rule would otherwise drop it. `+`/`=` are judged a token
 * first (`BASE64_ONLY`), the errs-toward-removal side.
 */
const CODECOMMIT_USER = /^[\w+=,.@-]+-at-[0-9]{12}$/;

/**
 * A prefix-less token's character mix: a digit, or both letter cases. A random 20-character
 * base64url string misses a digit about one time in thirty and misses one case about one time in
 * thirty thousand, so together they catch practically all of them; a login name of that length
 * is usually lower-case words (`firstname.lastname`, `jean-baptiste.dupont`), which neither test
 * matches. A long login with a digit or CamelCase (`ContosoEngineeringTeam`) is dropped — the
 * errs-toward-removal side, whose cost is only the name.
 */
function opaqueTokenMix(s: string): boolean {
  return /[0-9]/.test(s) || (/[a-z]/.test(s) && /[A-Z]/.test(s));
}

/** `s` percent-decoded, or as written when its escapes are malformed. */
function decoded(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Whether the rest of the URL already publishes `name` (percent-decoded): as one of the host's
 * labels (port dropped), compared case-insensitively since DNS is, or as a path segment, compared
 * EXACTLY — a path segment publishes its own spelling and no other, and a mixed-case token whose
 * lower-cased form happens to be a segment is not published by it. Not the query or the fragment.
 * `rest` is what follows the userinfo's `@`.
 */
function publishesName(rest: string, name: string): boolean {
  const beforeQuery = rest.split(/[?#]/, 1)[0]!;
  const cut = beforeQuery.search(/[/\\]/);
  const host = cut === -1 ? beforeQuery : beforeQuery.slice(0, cut);
  const pathPart = cut === -1 ? '' : beforeQuery.slice(cut + 1);
  const folded = name.toLowerCase();
  const hostLabels = host.replace(/:[0-9]*$/, '').split('.');
  if (hostLabels.some((l) => l !== '' && decoded(l).toLowerCase() === folded)) return true;
  return pathPart.split(/[/\\]/).some((seg) => seg !== '' && decoded(seg) === name);
}

/**
 * Whether a URL username is an access token rather than a login name. In order: a documented
 * token prefix; an e-mail address (its `@` percent-encoded — no token format contains `@`, and
 * `+` is common in one) is a login; a base64-only character; a name the URL already publishes in
 * its host or path (`publishesName` — keeping it keeps nothing the stored URL does not hold
 * anyway) or a CodeCommit user name is a login; a long run with a token's character mix.
 */
function looksLikeToken(user: string, rest: string): boolean {
  const name = decoded(user);
  if (TOKEN_PREFIX.test(name)) return true;
  if (name.includes('@')) return false;
  if (BASE64_ONLY.test(name)) return true;
  if (publishesName(rest, name)) return false;
  if (CODECOMMIT_USER.test(name)) return false;
  return name.length >= OPAQUE_MIN_LENGTH && opaqueTokenMix(name);
}

/**
 * What a strip removed, judged by the userinfo first: a password (the username kept), a whole
 * userinfo that was a token, or — when the userinfo carried nothing — one or more credential
 * query parameters. A query removed beside a userinfo credential is reported by `queryRemoved`.
 */
export type RemovedCredential = 'password' | 'token' | 'query';

/** What `stripGitUrlCredentials` returns. Keys are present only when they say something. */
export interface StrippedGitUrl {
  url: string;
  stripped: boolean;
  removed?: RemovedCredential;
  /** A credential query parameter was removed — set beside a userinfo `removed` too. */
  queryRemoved?: true;
  /**
   * A path segment looks like an access token. It is NOT removed (that would change which
   * repository the URL names), so `url` still carries it; registration refuses such a URL.
   */
  pathToken?: true;
}

/**
 * The userinfo of any other `<scheme>://` URL: everything between `//` and the LAST `@` before the
 * authority ends (`/`, `?`, `#`). WHATWG's leniency for http(s) — any run of `/` and `\` as the
 * separator, `\` ending the authority — is for special schemes only; anywhere else `//` is required
 * and `\` is an ordinary character. Only tried when the scheme is not http(s).
 */
const OTHER_USERINFO = /^([A-Za-z][A-Za-z0-9+.-]*:)(\/\/)([^/?#]*)@/;

/** The `file:` scheme, whose userinfo is never judged (see the module comment). */
const FILE_SCHEME = /^file:/i;

/** The scheme and separator of an http(s) URL, read as WHATWG reads it (see `HTTP_USERINFO`). */
const HTTP_HEAD = /^(https?:)([\\/]*)/i;

/** The scheme and `//` of any other URL — only then does it have an authority, a path and a query. */
const OTHER_HEAD = /^([A-Za-z][A-Za-z0-9+.-]*:)(\/\/)/;

/**
 * Query parameter names that carry a credential, lower-cased (compared on the percent-decoded,
 * lower-cased name). A `Set`, so no name can answer with an inherited member.
 */
const CREDENTIAL_PARAMS: ReadonlySet<string> = new Set([
  'access_token',
  'private_token',
  'token',
  'oauth_token',
  'auth',
  'password',
  'passwd',
  'pwd',
  'secret',
  'api_key',
  'apikey',
  'key',
  'sig',
  'signature',
]);

/** A URL with an authority, cut into the substrings it is written as — concatenated, they are it. */
interface UrlParts {
  http: boolean;
  /** The scheme as written (`https:`). */
  scheme: string;
  /** The scheme and the separator as written (`https://`, or `https:/` and the like). */
  head: string;
  /** The userinfo without its `@`, when there is one. */
  userinfo?: { user: string; password?: string };
  /** `userinfo` as written, with its `@` — `''` without one. */
  userinfoRaw: string;
  authority: string;
  path: string;
  /** The query without its `?` — `undefined` when there is no `?`. */
  query?: string;
  /** `#…`, or `''`. */
  fragment: string;
}

function urlParts(url: string): UrlParts | undefined {
  const http = /^https?:/i.test(url);
  const withInfo = http
    ? HTTP_USERINFO.exec(url)
    : FILE_SCHEME.test(url)
      ? null
      : OTHER_USERINFO.exec(url);
  const head = withInfo ?? (http ? HTTP_HEAD : OTHER_HEAD).exec(url);
  if (!head) return undefined;
  let userinfo: UrlParts['userinfo'];
  if (withInfo) {
    const raw = withInfo[3]!;
    const colon = raw.indexOf(':');
    userinfo =
      colon === -1 ? { user: raw } : { user: raw.slice(0, colon), password: raw.slice(colon + 1) };
  }
  const rest = url.slice(head[0].length);
  const authorityEnd = rest.search(http ? /[/?#\\]/ : /[/?#]/);
  const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
  const afterAuthority = authorityEnd === -1 ? '' : rest.slice(authorityEnd);
  const pathEnd = afterAuthority.search(/[?#]/);
  const path = pathEnd === -1 ? afterAuthority : afterAuthority.slice(0, pathEnd);
  let tail = pathEnd === -1 ? '' : afterAuthority.slice(pathEnd);
  let query: string | undefined;
  if (tail.startsWith('?')) {
    const hash = tail.indexOf('#');
    query = hash === -1 ? tail.slice(1) : tail.slice(1, hash);
    tail = hash === -1 ? '' : tail.slice(hash);
  }
  return {
    http,
    scheme: head[1]!,
    head: withInfo ? `${withInfo[1]!}${withInfo[2]!}` : head[0],
    ...(userinfo ? { userinfo } : {}),
    userinfoRaw: withInfo ? `${withInfo[3]!}@` : '',
    authority,
    path,
    ...(query !== undefined ? { query } : {}),
    fragment: tail,
  };
}

/** What follows the userinfo's `@`, as written — what `publishesName` reads. */
function afterUserinfo(p: UrlParts): string {
  return `${p.authority}${p.path}${p.query !== undefined ? `?${p.query}` : ''}${p.fragment}`;
}

/**
 * How a URL's userinfo is to be treated: kept as is, reduced to its user, or removed. The
 * token-as-username test is http(s)-only: a non-http login (`ssh://git@…`) is never a token.
 */
function classify(p: UrlParts): 'keep' | 'user-only' | 'remove' {
  const info = p.userinfo;
  if (info === undefined) return 'keep';
  if (!p.http) {
    if (info.password === undefined) return 'keep';
    return info.user === '' ? 'remove' : 'user-only';
  }
  if (info.user === '' || looksLikeToken(info.user, afterUserinfo(p))) return 'remove';
  return info.password === undefined ? 'keep' : 'user-only';
}

/** One `&`-separated query parameter, split at its first `=` (`value` is the whole when none). */
function paramParts(param: string): { name: string; value: string; hasValue: boolean } {
  const eq = param.indexOf('=');
  return eq === -1
    ? { name: param, value: param, hasValue: false }
    : { name: param.slice(0, eq), value: param.slice(eq + 1), hasValue: true };
}

/** Whether one query parameter is a credential: a credential name, or a token-prefixed value. */
function isCredentialParam(param: string): boolean {
  if (param === '') return false;
  const { name, value } = paramParts(param);
  return CREDENTIAL_PARAMS.has(decoded(name).toLowerCase()) || TOKEN_PREFIX.test(decoded(value));
}

/**
 * One `&`-separated query parameter as it is displayed: `name=***` (or `***` for a bare one) when
 * it is a credential, as written otherwise. `redact` (`src/lib/redact.ts`) masks query credentials
 * in free text by this same rule, through `maskUrlPathAndQuery`.
 */
function maskCredentialParam(param: string): string {
  if (!isCredentialParam(param)) return param;
  const { name, hasValue } = paramParts(param);
  return hasValue ? `${name}=***` : '***';
}

/**
 * Whether a path segment is an access token: a documented prefix, AND a prefix-less token's
 * length and character mix — so `hf_utils`, `ghp_notes` or a long all-lower-case repository name
 * stay what they are. `redact` (`src/lib/redact.ts`) masks such a segment in free text by this
 * same rule, through `maskUrlPathAndQuery`.
 */
function isPathToken(segment: string): boolean {
  const d = decoded(segment);
  return TOKEN_PREFIX.test(d) && d.length >= OPAQUE_MIN_LENGTH && opaqueTokenMix(d);
}

/** The path's segments run through `f`, separators kept as written (`\` too, on http(s)). */
function mapSegments(p: UrlParts, f: (segment: string) => string): string {
  return p.path.replace(p.http ? /[^/\\]+/g : /[^/]+/g, f);
}

/**
 * The scheme, separator and userinfo of `p` once its userinfo credential is dealt with: `password`
 * replaces a removed password (`''` drops it with its `:`), `token` a removed userinfo (`''` drops
 * it). A rewritten userinfo gets the separator written back as `//`; a kept one is as written.
 */
function userinfoFor(
  p: UrlParts,
  verdict: 'keep' | 'user-only' | 'remove',
  password: string,
  token: string,
): string {
  switch (verdict) {
    case 'keep':
      return `${p.head}${p.userinfoRaw}`;
    case 'user-only':
      return password === ''
        ? `${p.scheme}//${p.userinfo!.user}@`
        : `${p.scheme}//${p.userinfo!.user}:${password}@`;
    case 'remove':
      return `${p.scheme}//${token}`;
  }
}

/**
 * `gitUrl` with any userinfo secret and credential query parameter removed, whether there was one,
 * and what it was; `pathToken` when a path segment looks like a token, which is never removed (see
 * the module comment for what counts).
 */
export function stripGitUrlCredentials(gitUrl: string): StrippedGitUrl {
  // Trimmed first: surrounding whitespace is never part of a remote URL (a paste artefact), and
  // left in place it defeats the `^`-anchored userinfo match, so a token in `  https://tok@…`
  // was kept and persisted. The trimmed URL is what gets registered, stripped or not.
  const trimmed = gitUrl.trim();
  const p = urlParts(trimmed);
  if (p === undefined) return { url: trimmed, stripped: false };
  const verdict = classify(p);
  const params = p.query?.split('&');
  const queryRemoved = params?.some(isCredentialParam) === true;
  // Once a parameter is removed, the empty ones (`?&token=…`, `a=1&&token=…`) go too: kept, they
  // left a bare `?` or a trailing `&` behind.
  const keptParams = params?.filter((param) => param !== '' && !isCredentialParam(param));
  const pathToken = p.path !== '' && mapSegments(p, (s) => (isPathToken(s) ? '' : s)) !== p.path;
  const flags = pathToken ? { pathToken: true as const } : {};
  if (verdict === 'keep' && !queryRemoved) return { url: trimmed, stripped: false, ...flags };
  const query =
    p.query === undefined || !queryRemoved
      ? p.query === undefined
        ? ''
        : `?${p.query}`
      : keptParams!.length === 0
        ? ''
        : `?${keptParams!.join('&')}`;
  const url = `${userinfoFor(p, verdict, '', '')}${p.authority}${p.path}${query}${p.fragment}`;
  const removed: RemovedCredential =
    verdict === 'user-only' ? 'password' : verdict === 'remove' ? 'token' : 'query';
  return {
    url,
    stripped: true,
    removed,
    ...(queryRemoved && removed !== 'query' ? { queryRemoved: true as const } : {}),
    ...flags,
  };
}

/**
 * Whether `gitUrl` carries a credential anywhere this module recognises one — a userinfo secret, a
 * credential query parameter, or a token-like path segment. What every "does this URL carry a
 * credential" decision uses (the origin ownership rule, its notes), so none judges a narrower set
 * than registration strips and refuses.
 */
export function carriesCredential(gitUrl: string): boolean {
  const r = stripGitUrlCredentials(gitUrl);
  return r.stripped || r.pathToken === true;
}

/**
 * `gitUrl` for display: a userinfo secret replaced by `***` (`user:***@`, or `***@` for a token
 * username), a credential query parameter's value by `***` (`name=***`), and a token-like path
 * segment by `***` — so a reader can still see that the configuration embeds a credential (and go
 * and remove it) without seeing the credential. A login name alone is shown as written.
 */
export function redactGitUrlCredentials(gitUrl: string): string {
  const trimmed = gitUrl.trim();
  const p = urlParts(trimmed);
  if (p === undefined) return trimmed;
  return `${userinfoFor(p, classify(p), '***', '***@')}${maskedAfterUserinfo(p)}`;
}

/** What follows `p`'s userinfo with each token-like path segment and credential parameter masked. */
function maskedAfterUserinfo(p: UrlParts): string {
  const query =
    p.query === undefined ? '' : `?${p.query.split('&').map(maskCredentialParam).join('&')}`;
  const path = mapSegments(p, (s) => (isPathToken(s) ? '***' : s));
  return `${p.authority}${path}${query}${p.fragment}`;
}

/**
 * `url` (a `<scheme>://` URL found in free text) with its token-like path segments and credential
 * query parameters masked as `redactGitUrlCredentials` masks them — cut by the same `urlParts`, so
 * the two agree on where the path starts and how it splits (`\` as well as `/` on http(s)). The
 * scheme, separator and userinfo are kept as written: `redact` deals with a userinfo by its own
 * rules first. Characters before the scheme's first letter (a run such as `1ssh://` matched whole)
 * are kept as written too, and the rest is parsed from that letter.
 */
export function maskUrlPathAndQuery(url: string): string {
  const start = url.search(/[A-Za-z]/);
  if (start === -1) return url;
  const p = urlParts(url.slice(start));
  if (p === undefined) return url;
  return `${url.slice(0, start)}${p.head}${p.userinfoRaw}${maskedAfterUserinfo(p)}`;
}

/**
 * The refusal for a `gitUrl` with a token-like path segment (`pathToken`), which cannot be
 * stripped. One text for every place that refuses one: `register_project` before the project
 * lock, and `ProjectManager.registerProject` behind it.
 */
export function pathTokenRefusal(gitUrl: string): string {
  return (
    `The gitUrl ${quoteId(redactGitUrlCredentials(gitUrl))} carries what looks like an ` +
    'access token in its path; nothing was stored. Remove the token from the URL and ' +
    'supply it another way: set_credential, or an env var named by `tokenEnv` (or the ' +
    'host default, e.g. GITHUB_TOKEN).'
  );
}

/**
 * The result-text sentence for a registration whose URL carried a credential, claiming only what
 * was actually removed (`alsoQuery`: a credential query parameter went too, beside a userinfo
 * one). Names every route a token can take instead, since the next clone/push will otherwise fail
 * on auth with no hint why.
 */
export function strippedCredentialsNote(
  removed: RemovedCredential = 'token',
  alsoQuery = false,
): string {
  const what =
    removed === 'password'
      ? ' The gitUrl carried a password or token after the username (user:token@); it was ' +
        'removed and NOT stored — neither in the workspace registry nor in the clone’s git ' +
        'config. The username was kept.'
      : removed === 'token'
        ? ' The gitUrl’s userinfo was an access token (token@); it was removed and NOT stored — ' +
          'neither in the workspace registry nor in the clone’s git config.'
        : ' The gitUrl’s query string carried what looks like an access token (a parameter such ' +
          'as private_token=… or access_token=…); that parameter was removed and NOT stored — ' +
          'neither in the workspace registry nor in the clone’s git config. The rest of the URL ' +
          'was kept as written.';
  const query =
    alsoQuery && removed !== 'query'
      ? ' A credential parameter in its query string (such as private_token=…) was removed too.'
      : '';
  return (
    `${what}${query} Supply the token another way: set_credential (stores it in the OS credential ` +
    'helper), or an env var named by `tokenEnv` (or the host default, e.g. GITHUB_TOKEN / ' +
    'OVERLEAF_GIT_TOKEN), with `username` if the host needs a specific one.'
  );
}

/**
 * The note for a caller-supplied `gitUrl` — `''` when nothing would be removed from it (or there
 * is no URL). Judged on the caller's own URL, by the same `stripGitUrlCredentials` that decides
 * what is registered, so the note and the stored URL cannot disagree.
 */
export function strippedCredentialsNoteFor(gitUrl: string | undefined): string {
  if (gitUrl === undefined) return '';
  const { removed, queryRemoved } = stripGitUrlCredentials(gitUrl);
  return removed === undefined ? '' : strippedCredentialsNote(removed, queryRemoved === true);
}

/**
 * `gitUrl` with its credentials removed (`stripGitUrlCredentials`) and then its whole http(s)
 * userinfo — login name included — or as written (trimmed) when it has none. Not for storing (a
 * login name is worth keeping, see the module comment) and never for deciding anything: it only
 * lets a message say whether an `origin` carrying a token points anywhere other than the
 * registered URL. A non-http login (`ssh://git@…`) is kept, as is a token-like path segment.
 */
export function withoutUserinfo(gitUrl: string): string {
  const stripped = stripGitUrlCredentials(gitUrl).url;
  const m = HTTP_USERINFO.exec(stripped);
  return m === null ? stripped : `${m[1]!}//${stripped.slice(m[0].length)}`;
}

/**
 * The login name in an http(s) URL's userinfo (as written, percent-escapes kept), or `undefined`
 * when it has none. Read with the same split as everything else here — no other parsing. http(s)
 * only: it serves a remedy that `redact`'s https rule would otherwise mangle, and that rule masks
 * no login on any other scheme.
 */
export function urlLoginName(gitUrl: string): string | undefined {
  const p = urlParts(gitUrl.trim());
  return p === undefined || !p.http || p.userinfo === undefined || p.userinfo.user === ''
    ? undefined
    : p.userinfo.user;
}
