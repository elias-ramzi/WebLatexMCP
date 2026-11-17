import { quoteId } from './projectId.js';
import { redact } from './redact.js';
import { redactGitUrlCredentials, urlLoginName, withoutUserinfo } from './gitUrlCredentials.js';

/**
 * A `gitUrl` pasted as a whole `git clone` command line — what Overleaf's "Git" menu shows
 * (`git clone https://git@git.overleaf.com/<id>`). Held as written, it registered fine and then
 * every sync failed with `fatal: protocol 'git clone https' is not supported`. A registration
 * now takes the URL out of the line (`parseGitCloneLine`), and a registry or env entry that
 * already holds such a line fails fast at clone/sync/push (`storedCloneLineRefusal`) rather than
 * being rewritten behind the user's back.
 *
 * Pure: no I/O. Every message that quotes the input runs it through `redact` (or the URL through
 * `redactGitUrlCredentials`) first, so a token pasted inside the line is never echoed.
 */

/** `git clone` at the start of the trimmed text, then whitespace or the end. Case-sensitive. */
const CLONE_LINE_RE = /^git\s+clone(?:\s|$)/;

/** Whether `gitUrl` (trimmed) is a `git clone` command line rather than a URL. */
export function isGitCloneLine(gitUrl: string): boolean {
  const t = gitUrl.trim();
  const close = OPENERS.get(t[0] ?? '');
  const whole = close !== undefined && t.length >= 2 && t.endsWith(close) ? t.slice(1, -1) : t;
  return CLONE_LINE_RE.test(whole.trim());
}

/** What `parseGitCloneLine` read: the URL, and whether a `git clone` line was taken apart. */
export interface CloneLineUrl {
  url: string;
  /** True when `gitUrl` was a `git clone` line and `url` came out of it. */
  fromCloneLine: boolean;
  /** The directory argument the line named, which is ignored (the project id names the clone). */
  ignoredDir?: string;
}

/**
 * The URL in `gitUrl`: `gitUrl` itself, untouched, unless it is a `git clone` line, in which case
 * exactly `git clone <url>` or `git clone <url> <dir>` is accepted (the directory is ignored).
 * Anything else — an option (`-b main`, `--depth 1`), no URL, or more arguments — is refused,
 * asking for the URL alone: guessing which argument is the URL is exactly the kind of inference
 * a registration must not make. Throws on a refusal.
 */
export function parseGitCloneLine(gitUrl: string): CloneLineUrl {
  // A whole value pasted in one pair of quotes (or `<…>`) is read without them, so a quoted
  // URL reaches `stripGitUrlCredentials` bare — a token inside `'https://u:tok@h/r'` was
  // otherwise not recognised as one and was persisted in plain text.
  const trimmed = gitUrl.trim();
  if (!isGitCloneLine(trimmed)) {
    const url = unwrapQuoted(trimmed, gitUrl);
    return { url: url === trimmed ? gitUrl : url, fromCloneLine: false };
  }
  // A line wrapped whole in one pair (`"git clone url"`) is read without it; `git clone 'url'`
  // starts with `g`, so its closing quote is never taken for a wrapping pair.
  const close = OPENERS.get(trimmed[0] ?? '');
  const whole =
    close !== undefined && trimmed.length >= 2 && trimmed.endsWith(close)
      ? trimmed.slice(1, -1).trim()
      : trimmed;
  const args = whole.split(/\s+/).slice(2);
  if (args.length === 0 || args.length > 2 || args.some((a) => a.startsWith('-'))) {
    throw new Error(
      `The gitUrl ${quoteId(redact(gitUrl.trim()))} is a \`git clone\` command line, not a URL, ` +
        'and only `git clone <url>` or `git clone <url> <dir>` can be read as one — options ' +
        'such as -b or --depth are not. Nothing was stored. Pass just the repository URL as ' +
        'gitUrl (and a branch as `branch`, on register_project).',
    );
  }
  const url = unwrapQuoted(args[0]!, gitUrl);
  const dir = args[1] !== undefined ? unwrapQuoted(args[1], gitUrl) : undefined;
  return { url, fromCloneLine: true, ...(dir !== undefined ? { ignoredDir: dir } : {}) };
}

const OPENERS = new Map([
  ["'", "'"],
  ['"', '"'],
  ['<', '>'],
]);
const EDGE_CHARS = new Set(["'", '"', '<', '>']);

/**
 * `token` without exactly one matching pair of `'…'`, `"…"` or `<…>` around it, or `token` as is
 * when it has none. A quote or angle bracket left unbalanced at either end — before or after
 * unwrapping — is refused rather than guessed at, since keeping it would hide a token from
 * `stripGitUrlCredentials`. Only the ends are judged: a quote inside a local path
 * (`/home/o'brien/repo`) is the path's own. `input` is what the refusal quotes (redacted).
 */
function unwrapQuoted(token: string, input: string): string {
  const close = OPENERS.get(token[0] ?? '');
  let inner = token;
  if (close !== undefined && token.length >= 2 && token.endsWith(close)) {
    inner = token.slice(1, -1);
  }
  if (inner === '' && inner === token) return token;
  if (inner === '' || EDGE_CHARS.has(inner[0]!) || EDGE_CHARS.has(inner[inner.length - 1]!)) {
    throw new Error(
      `The gitUrl ${quoteId(redact(input.trim()))} has an unbalanced quote or angle bracket. ` +
        'Nothing was stored. Pass just the repository URL, without quotes.',
    );
  }
  return inner;
}

/** The result-text sentence for a registration whose gitUrl was a `git clone` line. */
export function cloneLineNote(parsed: CloneLineUrl): string {
  if (!parsed.fromCloneLine) return '';
  return (
    ' The gitUrl was a `git clone` command line: the `git clone` prefix was removed and only ' +
    'the URL was registered' +
    (parsed.ignoredDir !== undefined
      ? ` (the directory argument ${quoteId(parsed.ignoredDir)} was ignored: the project id ` +
        'names the clone directory).'
      : '.')
  );
}

/**
 * The refusal for a registry or env entry whose stored gitUrl is a `git clone` line: no remote
 * operation can work on it, and rewriting the registry silently is not this server's call. Names
 * the re-registration that fixes it, with the URL as it would be registered — credentials masked,
 * and its http(s) login name left out of the URL, because this text travels in an error and
 * `errorResult` would turn `https://git@…` into `https://***@…`, which run as written would set
 * the user name to `***`. The login name is named separately instead.
 */
export function storedCloneLineRefusal(
  id: string,
  gitUrl: string,
  opts: { envConfigured?: boolean } = {},
): string {
  let suggestion = '<the repository URL alone>';
  let login: string | undefined;
  try {
    const parsed = parseGitCloneLine(gitUrl);
    suggestion = redactGitUrlCredentials(withoutUserinfo(parsed.url));
    login = urlLoginName(parsed.url);
  } catch {
    // A line with options: no single URL to suggest.
  }
  const loginNote =
    login !== undefined
      ? ` (the line's login name, ${quoteId(login)}, is left out of the URL here; pass it as ` +
        "register_project's `username` if the host needs it)"
      : '';
  const remedy = opts.envConfigured
    ? 'Fix the entry in WEB_LATEX_MCP_PROJECTS to hold the URL alone ' +
      `(${quoteId(suggestion)})${loginNote} and restart the server; for this session only, ` +
      `project_sync { project: ${quoteId(id)}, gitUrl: ${quoteId(suggestion)} } overrides it.`
    : `Re-register it with register_project { project: ${quoteId(id)}, gitUrl: ` +
      `${quoteId(suggestion)} }${loginNote}, which also fixes the stored entry; ` +
      `project_sync { project: ${quoteId(id)}, gitUrl: ${quoteId(suggestion)} } does the same ` +
      'for this session only.';
  return (
    `The registered gitUrl of project ${quoteId(id)} is a \`git clone\` command line ` +
    `(${quoteId(redact(gitUrl.trim()))}), not a URL, so git cannot clone, fetch or push it. ` +
    `Nothing was run, and the stored entry was left as it is. ${remedy}`
  );
}
