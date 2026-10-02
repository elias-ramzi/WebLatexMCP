import path from 'node:path';
import {
  redactGitUrlCredentials,
  stripGitUrlCredentials,
  urlLoginName,
  withoutUserinfo,
} from './gitUrlCredentials.js';
import { quoteId } from './projectId.js';
import { toPosix } from './paths.js';

/**
 * Who owns a clone's `origin`, and so whether the server may move it.
 *
 * Every remote operation runs against the clone's `origin` (`fetch --prune origin`,
 * `push origin …`); the held `gitUrl` only keys the injected credential. So when the held URL
 * changes — `project_sync { gitUrl }`, `register_project { gitUrl }`, an env URL winning again
 * after a restart, a peer holding another URL — `origin` has to follow, or fetch and push go to the
 * old remote while the result names the new one.
 *
 * **The server rewrites `origin` only when `origin` is still exactly what the server itself last
 * wrote.** A record in the clone's own `.git/config` — `webLatexMcp.heldUrl` (the held URL it
 * pointed `origin` at) and `webLatexMcp.originUrl` (`origin` as git reported it after that write)
 * — says what that was. An `origin` the user set by hand is never rewritten, and neither is one
 * carrying a password or token: the server never writes a credential into `origin` itself, and
 * never adopts one — the one way it puts one there is a `git clone` of an env-configured or legacy
 * URL that embeds a token, and such an origin is left as it is too (one may also have been put
 * there on purpose, for a host the resolver has no token for). It is reported with the remedy
 * instead. No URL is compared for "sameness": an earlier version
 * judged `origin` by a same-repository heuristic, which called git's absolutised form of a
 * relative clone URL a different repository (and wrote back a relative path git then resolved
 * against the clone) and rewrote SSH host aliases to https.
 *
 * The one comparison beyond byte equality is git's own: `git clone ../r.git` records `origin` as
 * `$PWD/../r.git`, so for a held local path and an absolute `origin` the two are compared resolved
 * and, failing that, by realpath (`$PWD` may be a symlinked launch directory while Node's cwd is
 * the real one).
 */

/** What the server last wrote, read back from the clone's `.git/config` (local scope only). */
export interface OriginRecord {
  heldUrl: string;
  originUrl: string;
}

/** What the decision is made from. */
export interface OriginState {
  /** Every effective `remote.origin.url` value (includes, global and system config counted). */
  originUrls: readonly string[];
  /** The `remote.origin.url` values in the clone's own `.git/config` — what a write changes. */
  localOriginUrls: readonly string[];
  record: OriginRecord | undefined;
  /** The held URL, credential-stripped. */
  heldStripped: string;
  /** Whether the held URL carries a password or token (an env-configured or legacy URL). */
  heldCarriesToken: boolean;
  /**
   * The filesystem's realpath of a local path, `undefined` when it cannot be resolved — supplied
   * by `GitService` so the decision stays pure. Absent: local paths are compared resolved only.
   */
  realpath?: (p: string) => string | undefined;
}

export type OriginRefusal = 'multiple' | 'token' | 'external' | 'conflict';

/**
 * - `unchanged` — leave `origin`; `writeRecord` when the record should be (re)written: a clone
 *   adopted (no record, `origin` already the held URL) or a hand edit that already points at it.
 * - `add` / `repoint` — write `value` to `origin` (then the record).
 * - `unowned` — the server did not set `origin` (or it carries a credential, `credentialOnDisk`):
 *   leave it, and say so; the operation goes where `origin` says, as it always did.
 * - `refuse` — the operation must not run (see `originRefusalMessage`).
 */
export type OriginDecision =
  | { kind: 'unchanged'; writeRecord: boolean }
  | { kind: 'add'; value: string }
  | { kind: 'repoint'; value: string }
  | { kind: 'unowned'; credentialOnDisk?: true }
  | { kind: 'refuse'; reason: OriginRefusal };

/** A URL scheme followed by `://` — only then is `://` a URL (`./a://b` is a path to git). */
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/**
 * Whether git reads `url` as a local path, and which kind — git's own url-vs-path rule
 * (`url_is_local_not_ssh`), not a judgement of which repository a URL names: a scheme followed by
 * `://` is a URL; on Windows a DOS drive (`C:`) is local — absolute with a separator after it,
 * drive-relative otherwise; a `:` before the first `/` makes it scp-like `host:path` (or a
 * `<transport>::` helper) — on POSIX `C:/x` too, which git reads as host `C`; everything else is a
 * path. `undefined` for a URL. `platform` is injectable for tests.
 */
export function localPathKind(
  url: string,
  platform: NodeJS.Platform = process.platform,
): 'relative' | 'absolute' | undefined {
  if (URL_SCHEME.test(url)) return undefined;
  if (platform === 'win32' && /^[A-Za-z]:/.test(url)) {
    return /^[A-Za-z]:[\\/]/.test(url) ? 'absolute' : 'relative';
  }
  const colon = url.indexOf(':');
  const slash = url.indexOf('/');
  if (colon !== -1 && (slash === -1 || colon < slash)) return undefined;
  return (platform === 'win32' ? path.win32 : path.posix).isAbsolute(url) ? 'absolute' : 'relative';
}

/**
 * The value to write to `origin` for held URL `held`. A relative local path is written resolved
 * against this process's cwd, where `GitService.clone` runs git — written verbatim, git would
 * resolve it against the CLONE, and every later fetch would fail. That is what `git clone` records
 * for `../r.git`; for a Windows drive-relative `C:r.git` git records it as written, and the
 * resolved form is written deliberately, as the safer target.
 */
export function originValueToWrite(held: string): string {
  return localPathKind(held) === 'relative' ? path.resolve(held) : held;
}

/**
 * Whether `origin` is the held URL as git would record it: the same string, or — for a held local
 * path and an absolute `origin` — the same path once resolved (`git clone ../r.git` records
 * `$PWD/../r.git`), or failing that the same realpath (a symlinked `$PWD`). A relative `origin`
 * is never resolved: git resolves it against the clone, not against this process's cwd. An equal
 * relative string is still the held URL (adopted as written; a later re-point writes the absolute
 * form).
 */
function isHeld(state: OriginState, origin: string): boolean {
  const held = state.heldStripped;
  if (origin === held) return true;
  if (localPathKind(held) === undefined || localPathKind(origin) !== 'absolute') return false;
  if (path.resolve(held) === path.resolve(origin)) return true;
  if (state.realpath === undefined) return false;
  const a = state.realpath(path.resolve(held));
  const b = state.realpath(origin);
  return a !== undefined && a === b;
}

/**
 * The ownership record from the values `git config --local` holds for its two keys — `undefined`
 * (no record) unless each has exactly one non-empty value, so a partial, doubled or emptied record
 * falls to the no-record path, which never rewrites a hand-set `origin`.
 */
export function parseOriginRecord(
  heldValues: readonly string[],
  originValues: readonly string[],
): OriginRecord | undefined {
  if (heldValues.length !== 1 || originValues.length !== 1) return undefined;
  const [heldUrl, originUrl] = [heldValues[0]!, originValues[0]!];
  return heldUrl === '' || originUrl === '' ? undefined : { heldUrl, originUrl };
}

/** Why a write to `origin` cannot happen, if it cannot: a token held, or origin defined elsewhere. */
function writeBlocked(state: OriginState): OriginRefusal | undefined {
  if (state.heldCarriesToken) return 'token';
  const local = state.localOriginUrls;
  const effective = state.originUrls;
  const sameLists = local.length === effective.length && local.every((u, i) => u === effective[i]);
  return sameLists ? undefined : 'external';
}

/** A write to `origin`, or the refusal that stops it. */
function write(state: OriginState, kind: 'add' | 'repoint'): OriginDecision {
  const blocked = writeBlocked(state);
  if (blocked) return { kind: 'refuse', reason: blocked };
  return { kind, value: originValueToWrite(state.heldStripped) };
}

/**
 * The one decision `GitService.reconcileOrigin` acts on and `planOrigin` previews. Pure (the
 * realpath it may use is injected).
 *
 * An `origin` carrying a password or token is never the server's: the server never writes one,
 * so it never adopts, re-records or rewrites one — `unowned` with `credentialOnDisk`, or the
 * conflict refusal when the registration changed since the server's own write. More than one
 * `origin` URL (a push mirror) is a hand configuration the server never owns: left as it is when
 * its first URL is the held one, `unowned` otherwise — refused only when the registration
 * changed, since then a write would be needed. No `origin` is added. Without a record, an
 * `origin` that is the held URL as git records it is adopted, and anything else is `unowned` (a
 * hand-set SSH alias and a clone an older version left at the old remote look the same from
 * here). With a record, ownership is the RAW `origin` equal to what the server recorded: then it
 * follows the held URL; `origin` edited by hand is kept — re-recorded when it already is the held
 * URL, `unowned` while the registration has not changed, and refused when both changed, since
 * then neither the user's edit nor the registration can be honoured silently.
 */
export function decideOrigin(state: OriginState): OriginDecision {
  const { originUrls, record, heldStripped: held } = state;
  const raw = originUrls[0];
  if (raw === undefined) return write(state, 'add');
  const credentialOnDisk = stripGitUrlCredentials(raw).stripped;
  const unowned: OriginDecision = credentialOnDisk
    ? { kind: 'unowned', credentialOnDisk: true }
    : { kind: 'unowned' };
  if (originUrls.length > 1) {
    if (!credentialOnDisk && isHeld(state, raw)) return { kind: 'unchanged', writeRecord: false };
    if (record === undefined || record.heldUrl === held) return unowned;
    return { kind: 'refuse', reason: 'multiple' };
  }
  if (record === undefined) {
    if (credentialOnDisk) return unowned;
    return isHeld(state, raw) ? { kind: 'unchanged', writeRecord: true } : unowned;
  }
  if (!credentialOnDisk && raw === record.originUrl) {
    if (record.heldUrl === held) return { kind: 'unchanged', writeRecord: false };
    // The held URL changed to another spelling of what `origin` already says (a relative path
    // and its absolute form): nothing to write but the record.
    if (isHeld(state, raw)) return { kind: 'unchanged', writeRecord: true };
    return write(state, 'repoint');
  }
  if (!credentialOnDisk && isHeld(state, raw)) return { kind: 'unchanged', writeRecord: true };
  if (record.heldUrl === held) return unowned;
  return { kind: 'refuse', reason: 'conflict' };
}

/** A URL read from config (it may carry a credential), as a message shows it. */
const shown = (url: string): string => quoteId(redactGitUrlCredentials(url));
/** The clone's directory, as a message shows it. */
const shownDir = (dir: string): string => quoteId(toPosix(dir));

/** The registration routes out, worded for both a registered and an env-configured project. */
const REGISTER_ADVICE =
  'register_project (or, for a project configured through WEB_LATEX_MCP_PROJECTS, that entry)';

/**
 * The message a refused remote operation throws — fixed words, never git's output. Config URLs are
 * redacted and quoted; `count` is the number of `origin` URLs for `multiple`.
 */
export function originRefusalMessage(
  reason: OriginRefusal,
  opts: { held: string; origin: string | undefined; dir: string; count?: number },
): string {
  const held = shown(opts.held);
  switch (reason) {
    case 'multiple':
      return (
        `The clone's origin has ${opts.count ?? 2} URLs (remote.origin.url is set more than once, ` +
        'perhaps by an included config file), so which remote a fetch or push would reach is ' +
        `ambiguous; nothing was fetched or pushed. Keep one in ${shownDir(opts.dir)} — this ` +
        `project's URL is ${held} — then retry.`
      );
    case 'token':
      return (
        `This project's URL (${held}) carries a password or token, and pointing the clone's ` +
        'origin at it would write that token into .git/config, which this server never does; ' +
        'nothing was fetched or pushed. Register the URL without the token — through ' +
        `${REGISTER_ADVICE} — and supply the token with set_credential or \`tokenEnv\` instead.`
      );
    case 'external':
      return (
        "The clone's origin is defined outside its own .git/config (an included config file, or " +
        `the global or system config), so the server will not rewrite it to this project's URL ` +
        `(${held}); nothing was fetched or pushed. Point origin at it where it is defined, or ` +
        `define it in ${shownDir(opts.dir)}/.git/config instead, then retry.`
      );
    case 'conflict':
      return (
        `The clone's origin (${opts.origin === undefined ? 'unset' : shown(opts.origin)}) was ` +
        'changed by hand since the server set it, and the registered URL has changed too ' +
        `(${held}), so the server will not choose between them; nothing was fetched or pushed. ` +
        `Run \`git remote set-url origin <url>\` in ${shownDir(opts.dir)} with the registered URL, ` +
        `or register the URL origin now has (${REGISTER_ADVICE}).`
      );
  }
}

/** What `GitService.reconcileOrigin` did. `previous` may carry a credential. */
export interface OriginReconcile {
  kind: 'unchanged' | 'repointed' | 'unowned';
  /** The `origin` URL before the call, as read (`undefined`: there was none). */
  previous: string | undefined;
  /** `remote.origin.pushurl` values — read only on `repointed`, `[]` otherwise. */
  pushUrls: string[];
  /** Present (true) on `unowned` when `origin` carries a password or token. */
  credentialOnDisk?: true;
}

/** How a note is delivered: in a result's text, or appended to an error's message. */
export interface NoteOptions {
  /**
   * The note rides on an error. `errorResult` scrubs every https userinfo there — a login name
   * included — so a command naming `https://org@…` would reach the caller as `https://***@…` and
   * set the username to `***`. Such a remedy then names its URL by where to read it instead.
   */
  forError?: boolean;
}

/**
 * The `git remote set-url` remedy pointing `origin` at the held URL: the URL the server would
 * write (`originValueToWrite` of the tokenless held URL), quoted with `quoteId` for reading —
 * never redacted. Quoting is for reading, not for pasting into every shell: `quoteId` escapes `"`
 * and `\` the way a POSIX double-quoted string undoes them, but not `$` or a backtick, and Windows
 * shells read `\` literally. On an error path a URL with a login name is not printed (see
 * `NoteOptions.forError`): the remedy names `list_projects`, which shows it with the login kept,
 * and the login name itself, which carries no scheme for the scrubber to match.
 */
function setUrlRemedy(held: string, dir: string, opts: NoteOptions): string {
  const url = originValueToWrite(stripGitUrlCredentials(held).url);
  const login = urlLoginName(url);
  if (opts.forError && login !== undefined) {
    return (
      `\`git remote set-url origin <url>\` in ${shownDir(dir)}, with <url> this project's gitUrl ` +
      `as list_projects shows it (with the login name ${quoteId(login)})`
    );
  }
  return `\`git remote set-url origin ${quoteId(url)}\` in ${shownDir(dir)}`;
}

/**
 * The note for an `unowned` origin: where fetch and push go, why, and how to change it — one note
 * in every case. Shown on every result while it lasts: it is a real divergence between what is
 * registered and what is used, or a credential sitting in `.git/config`. `origin` and the held URL
 * are shown redacted; the remedy is `setUrlRemedy`'s.
 *
 * When the held URL itself embeds a password or token (an env-configured or legacy URL), the
 * clone was most likely made from it — `git clone` writes it into `origin` — so the note says so
 * and points at removing the token from that URL, not at an older version of this server.
 */
export function unownedOriginNote(
  origin: string,
  held: string,
  dir: string,
  credentialOnDisk = false,
  opts: NoteOptions = {},
): string {
  const heldTokenless = stripGitUrlCredentials(held);
  const remedy = setUrlRemedy(held, dir, opts);
  // Wording only: whether the origin points anywhere but the registered URL, its userinfo (login
  // name included) aside. Nothing is decided by it.
  const elsewhere = withoutUserinfo(origin) !== withoutUserinfo(held);
  const what = credentialOnDisk
    ? `The clone's origin in .git/config holds a password or token (${shown(origin)}` +
      (elsewhere ? `, and is not the registered ${shown(held)})` : ')')
    : `The clone's origin is ${shown(origin)}, not the registered ${shown(held)}`;
  const fromConfiguredUrl = heldTokenless.stripped && credentialOnDisk && !elsewhere;
  const where = fromConfiguredUrl
    ? ": this project's configured URL embeds a password or token, and a clone made from that " +
      'URL keeps it there. The server never adopts such an origin, so it leaves it as it is and ' +
      'fetch and push go there.'
    : '; the server did not set this origin, or no longer owns it, so it leaves it as it is and ' +
      `fetch and push go there${elsewhere ? ', not to the registered URL' : ''}.`;
  const how = heldTokenless.stripped
    ? (fromConfiguredUrl
        ? ''
        : ` This project's configured URL embeds a password or token${credentialOnDisk ? ' too' : ''}.`) +
      ' To keep tokens off disk, remove it from that URL — the WEB_LATEX_MCP_PROJECTS entry, or ' +
      're-register with register_project — and supply it with `tokenEnv` or set_credential; then ' +
      `run ${remedy}.`
    : credentialOnDisk
      ? ' If it was not put there on purpose (e.g. an older version of this server left it after a ' +
        `crash)${elsewhere ? ', or to use the registered URL' : ''}, remove it with ${remedy}.`
      : ` To use the registered URL, run ${remedy}.`;
  return ` ${what}${where}${how}`;
}

/**
 * The result-text sentence for what a tool's reconcile did — `''` when nothing needs saying.
 * `then` finishes a re-point sentence for the tool ("this sync fetches from it"). A tool attaches
 * the `forError` variant to an error and the plain one to its result.
 */
export function originNote(
  r: OriginReconcile,
  held: string,
  dir: string,
  then: string,
  opts: NoteOptions = {},
): string {
  if (r.kind === 'unowned') {
    return r.previous === undefined
      ? ''
      : unownedOriginNote(r.previous, held, dir, r.credentialOnDisk === true, opts);
  }
  if (r.kind === 'unchanged') return '';
  const from =
    r.previous === undefined
      ? `The existing clone had no origin remote; it now points at ${shown(held)}`
      : `The existing clone's origin was re-pointed from ${shown(r.previous)} to ${shown(held)}`;
  const push =
    r.pushUrls.length === 0
      ? ''
      : ` Its remote.origin.pushurl is set (${r.pushUrls.map(shown).join(', ')}) and was left ` +
        'as it is, so push still goes there.';
  return ` ${from}; ${then}.${push}`;
}

/**
 * `register_project`'s read-only preview for a clone that already exists: what the next remote
 * operation will do with `origin`, or `''` when it leaves it as it is and nothing diverges.
 * Registration itself writes nothing to the clone.
 */
export function pendingOriginNote(
  decision: OriginDecision,
  state: { originUrls: readonly string[] },
  held: string,
  dir: string,
): string {
  const next = 'the next project_sync, push or reset_to_remote';
  const origin = state.originUrls[0];
  switch (decision.kind) {
    case 'unchanged':
      return '';
    case 'add':
      return ` The existing clone has no origin remote; ${next} adds one at ${shown(held)}.`;
    case 'repoint':
      return ` The existing clone's origin is ${shown(origin ?? '')}; ${next} re-points it to ${shown(held)}.`;
    case 'unowned':
      return origin === undefined
        ? ''
        : unownedOriginNote(origin, held, dir, decision.credentialOnDisk === true);
    case 'refuse':
      return (
        ` Note: ${next} will refuse — ` +
        originRefusalMessage(decision.reason, {
          held,
          origin,
          dir,
          count: state.originUrls.length,
        })
      );
  }
}

/** `register_project`'s note when the clone's config could not be read — never an error. */
export function unreadableOriginNote(dir: string): string {
  return (
    ` The existing clone's git config in ${shownDir(dir)} could not be read, so where its origin ` +
    'points was not checked; the next project_sync, push or reset_to_remote reads it again and ' +
    'reports what it finds.'
  );
}

/**
 * `err` with `note` appended to its message (the original kept as the cause) — `err` itself when
 * there is no note. For a remote operation that fails after its origin was reconciled: the note
 * says where it went.
 */
export function withOriginNote(err: unknown, note: string): unknown {
  if (note === '') return err;
  const message = err instanceof Error ? err.message : String(err);
  return new Error(`${message}${note}`, { cause: err });
}
