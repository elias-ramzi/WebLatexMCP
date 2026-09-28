import os from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { chmod, lstat, mkdir, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { execCapture } from '../lib/exec.js';
import type { ExecResult } from '../lib/exec.js';
import type { CompilerKind } from '../types.js';
import { toPosix } from '../lib/paths.js';
import { luatexCommandRefused, needsShellEscape, shellCommandRefused } from './logParser.js';

export type Engine = 'pdflatex' | 'xelatex' | 'lualatex';

export interface CompileRequest {
  /** Absolute path to the project clone. */
  projectDir: string;
  /** Root .tex file, relative to projectDir. */
  rootFile: string;
  engine?: Engine;
  /** Force a full rebuild. */
  clean?: boolean;
  timeoutSec?: number;
  /**
   * Pass `-shell-escape`, letting the document run arbitrary shell commands (needed by TikZ
   * externalization). Off by default; never inferred — the caller must opt in per compile.
   */
  shellEscape?: boolean;
  /**
   * Pass `-shell-restricted`: only TeX's allow-listed binaries may run. Safer than full
   * `shellEscape` and sufficient for most externalization setups. Ignored if `shellEscape` is set.
   *
   * With NEITHER set, latexmk gets `-no-shell-escape` (issue #213): TeX Live's own default
   * (`shell_escape = p` in texmf.cnf) is this restricted mode, so passing no flag at all left the
   * allow-list on for every compile the caller never opted into — and those commands write
   * relative to the engine's cwd, the project, so `\write18{makeindex -o sections/a.tex …}`
   * truncated a source file. Tectonic needs no flag: it runs no shell command without
   * `shellEscape`.
   */
  restrictedShellEscape?: boolean;
  /**
   * Directory the backend runs in (its cwd), which `rootFile` is relative to. Default
   * `projectDir`. An overlay compile (`compile`'s `overlay`) points it at the variant's link farm,
   * which mirrors the project tree, so `rootFile` keeps its project-relative spelling.
   */
  workDir?: string;
  /**
   * The build (`-outdir`) directory. Default `buildDir(projectDir)`. An overlay compile points it
   * at the variant's own `out/`, so the main build is never touched.
   */
  outDir?: string;
}

export interface CompileOutcome {
  success: boolean;
  pdfPath?: string;
  durationSec: number;
  /** Raw log content (the .log file when available, otherwise captured stdout/stderr). */
  log: string;
  logPath?: string;
  timedOut: boolean;
  /**
   * Directory the engine ran in, relative to the project root ('' for the root itself). The log's
   * paths are relative to it, not to the project: latexmk gets `-cd` and chdirs into the root
   * file's directory, so `paper/main.tex` reports its own errors as `./main.tex`. `parseLog` needs
   * it to hand back paths a caller can open.
   */
  logBaseDir: string;
  /**
   * Whether the backend actually wrote a fresh PDF during this run. The build dir is stable per
   * project path and shared by every session on a clone, so when a peer session just compiled the
   * same clone, latexmk can find nothing to do and finish near-instantly — `success: true` but
   * `pdfPath` pointing at a previous run's output, not this call's. `false` means exactly that:
   * derived by comparing the build-dir PDF's mtime and size from just before this run's exec
   * against just after — never from parsing backend stdout (discarded once a `.log` exists,
   * worded differently per backend, and tectonic emits none of it) and never from the wall clock.
   * A filesystem that truncates mtime to whole seconds can only miss a genuine rebuild that lands
   * in the same second as the previous write AND produces a byte-identical PDF — the narrowest
   * failure this comparison can have.
   */
  rebuilt: boolean;
  /** ISO 8601 mtime of the build-dir PDF, read before any surfacing copy is made. Absent with no PDF. */
  pdfMtime?: string;
  /**
   * The engine latexmk could not run because the shell reported it not found — set only on a
   * failed latexmk run whose own stdout/stderr carried one of {@link engineNotFound}'s shapes,
   * and never by tectonic, which drives its bundled engine and runs no engine binary. Read off
   * the captured output, never off `log`: the build dir is stable per project, so a run whose
   * engine never started leaves the previous run's `.log` in place and `log` is that stale file.
   * The captured output is document-controlled too (`\typeout` reaches the terminal), which is
   * why this is only ever a name from the fixed engine allowlist and never a captured line.
   */
  missingEngine?: Engine;
}

export interface LatexCompiler {
  isAvailable(): Promise<boolean>;
  compile(req: CompileRequest): Promise<CompileOutcome>;
}

export type { CompilerKind };

const ENGINE_FLAG: Record<Engine, string> = {
  pdflatex: '-pdf',
  xelatex: '-pdfxe',
  lualatex: '-pdflua',
};

/** The engine binaries latexmk runs for {@link ENGINE_FLAG}'s flags — the matcher's allowlist. */
const ENGINES = Object.keys(ENGINE_FLAG) as Engine[];
const ENGINE_ALT = ENGINES.join('|');

/**
 * The shell's "no such command" lines, anchored to a whole line and to an engine name exactly:
 * - POSIX `sh`/`bash` (latexmk hands a quoted command line to `system`, so a shell runs it):
 *   `sh: 1: xelatex: not found` (dash), `sh: xelatex: not found` (busybox),
 *   `sh: xelatex: command not found` (bash as sh, macOS), `bash: line 1: xelatex: command not
 *   found`, `xelatex: command not found`;
 * - Windows `cmd.exe`: `'xelatex' is not recognized as an internal or external command,` (English
 *   only — a localized Windows words it differently and simply gets no hint).
 */
const ENGINE_NOT_FOUND_POSIX = new RegExp(
  `^(?:\\S+: (?:line )?\\d+: |\\S+: )?(${ENGINE_ALT}): (?:command )?not found$`,
);
const ENGINE_NOT_FOUND_WINDOWS = new RegExp(
  `^'(${ENGINE_ALT})' is not recognized as an internal or external command`,
);

/**
 * The engine a latexmk run's captured output says the shell could not find, or `undefined`.
 * Pure, and deliberately narrow: only the shapes above, only for an engine latexmk runs, only a
 * whole line — `biber: not found` or `xdvipdfmx: not found` is not an engine, and a mention inside
 * some other line is not the shell speaking. A document CAN print a forged line of this shape
 * (`\typeout`), which is why the answer is a name from the allowlist rather than any captured
 * text, and why {@link engineNotFoundHint} fires only on a failure no parsed error explains.
 */
export function engineNotFound(output: string): Engine | undefined {
  for (const raw of output.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const m = ENGINE_NOT_FOUND_POSIX.exec(line) ?? ENGINE_NOT_FOUND_WINDOWS.exec(line);
    if (m) return m[1] as Engine;
  }
  return undefined;
}

/** Where each engine comes from, for the install half of the hint. */
const ENGINE_PACKAGES: Record<Engine, { debian: string; tlmgr: string }> = {
  pdflatex: { debian: 'texlive-latex-base', tlmgr: 'collection-latex' },
  xelatex: { debian: 'texlive-xetex', tlmgr: 'collection-xetex' },
  lualatex: { debian: 'texlive-luatex', tlmgr: 'collection-luatex' },
};

/**
 * The compile hint for an engine latexmk could not run, or `undefined` when there is nothing to
 * say. Gated on a failed compile with **zero parsed errors**: a forged not-found line can then
 * only add a misleading hint to a compile that already failed with nothing else to show for it,
 * and can never mask a real error. Fixed server text; the only variable is the allowlisted name.
 */
export function engineNotFoundHint(
  outcome: Pick<CompileOutcome, 'success' | 'missingEngine'>,
  parsedErrorCount: number,
): string | undefined {
  const engine = outcome.missingEngine;
  if (outcome.success || parsedErrorCount > 0 || engine === undefined) return undefined;
  const pkg = ENGINE_PACKAGES[engine];
  const others = ENGINES.filter((e) => e !== engine)
    .map((e) => `"${e}"`)
    .join(' or ');
  return (
    `The ${engine} engine is not installed (latexmk could not run it), so this run compiled ` +
    'nothing — a pdfPath or logPath in this result is left from an earlier run. Install it with ' +
    'your TeX ' +
    `distribution (Debian/Ubuntu: \`apt install ${pkg.debian}\`; TeX Live: ` +
    `\`tlmgr install ${pkg.tlmgr}\`), or compile with another engine: pass engine: ${others} ` +
    '(doctor lists the engines this machine has). If you already passed a different engine, a ' +
    `latexmkrc in the project is choosing ${engine}.`
  );
}

/**
 * The compile hint for a shell command the engine refused (`runsystem(<cmd>)...disabled` in a
 * pdfTeX/XeTeX log, or LuaTeX's `system(<cmd>) ...` record with shell escape off — see
 * `luatexCommandRefused` in `logParser.ts`), or `undefined` when there is nothing to say. Every latexmk compile now runs with
 * `-no-shell-escape` unless the caller opted in (#213), so a document that relied on TeX Live's
 * default restricted allow-list — most often an `.eps` figure converted by `repstopdf`, or
 * `makeindex` — builds without that command's output, and the caller has to be told which switch
 * brings it back and what flipping it costs. One hint for every compile; an overlay compile gets
 * the overlay's own wording, since there the cost is the source itself.
 *
 * Gated on the caller NOT having opted in (then the flag was theirs and they know). For a normal
 * compile it stays quiet when the TikZ-externalization hint already covers the same refusal
 * (`needsShellEscape`), so one cause does not get two retry instructions; an overlay compile says
 * it either way, because its version carries the one thing the TikZ hint does not — that opting in
 * lets the command write the source through the variant's links. Fixed server text: nothing from
 * the document-controlled log is echoed.
 */
export function shellEscapeRefusedHint(
  log: string,
  opts: { shellEscapeOn: boolean; overlay: boolean; backend: CompilerKind },
): string | undefined {
  if (opts.shellEscapeOn) return undefined;
  const refused = shellCommandRefused(log) || luatexCommandRefused(log);
  const tikz = needsShellEscape(log);
  if (opts.overlay ? !(refused || tikz) : !refused || tikz) return undefined;
  const retry =
    opts.backend === 'tectonic'
      ? 'shellEscape: true (tectonic has no restricted mode, so restrictedShellEscape does not ' +
        'run it)'
      : 'restrictedShellEscape: true (or shellEscape: true)';
  if (opts.overlay) {
    return (
      'This overlay compile refused a shell command the document ran (\\write18): an ' +
      'overlay compile disables shell escape — as every compile does unless you opt in — to ' +
      "keep the source untouched, since the variant's files are links to it. So this variant " +
      `can differ from a build with shell escape on. Retrying with ${retry} runs it, but lifts ` +
      'that guarantee: the command can then write the source through those links.'
    );
  }
  const cost =
    opts.backend === 'tectonic'
      ? 'What that costs: the document can then run ARBITRARY shell commands — only for a ' +
        'project you trust.'
      : "What that costs: TeX's allow-listed helpers (repstopdf, makeindex, extractbb, …) then " +
        'run in the project directory and can write files there — makeindex -o can overwrite a ' +
        'source file. shellEscape: true runs ARBITRARY commands; only for a project you trust.';
  return (
    'The engine refused a shell command the document ran (\\write18) — typically repstopdf ' +
    'converting an .eps figure, or makeindex: compile runs no shell command unless you opt in, ' +
    "not even TeX's restricted allow-list, so whatever that command would have produced is " +
    `missing from this build. Retry with ${retry} if the document needs it. ${cost}`
  );
}

/**
 * Whether a spawn rejection means "the binary is not there" — `ENOENT`, which is also what a
 * missing binary surfaces as on Windows. Exported because it is the whole of the availability
 * decision: everything else `spawn` can reject with (`EACCES` — present but not executable,
 * `EAGAIN`/`EMFILE` — process or fd exhaustion) is a real fault on a machine that *does* have
 * the backend, and must never be read as "not installed".
 */
export function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT';
}

/**
 * What a spawn failure that is NOT "not found" said, for a report: node's own message
 * (`spawn latexmk EACCES`), which already carries the errno. Shared with `doctor`, so the two
 * places that describe an unrunnable backend describe it in the same words.
 */
export function spawnFailureReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A backend binary that is on PATH but could not be run (`EACCES`, `EAGAIN`, …). Deliberately
 * not a `MissingCompilerError`: it is never read as "not installed", so it never licenses a
 * substitution. It keeps the original errno as `code` (so `isNotFound` still answers false for
 * it) and the original error as `cause`.
 */
export class UnrunnableCompilerError extends Error {
  readonly code: unknown;

  constructor(cmd: string, err: unknown) {
    super(
      `${cmd} is on PATH but could not be run (${spawnFailureReason(err)}). A backend that is ` +
        'present but fails to start is a fault, not a missing default, so no other backend was ' +
        'substituted for it. Make sure it is executable and runs from a shell, or choose a ' +
        'different backend: pass compiler: "<backend>" on this call, or set ' +
        'WEB_LATEX_MCP_COMPILER for every compile. Run the doctor tool for a full toolchain report.',
      { cause: err },
    );
    this.name = 'UnrunnableCompilerError';
    this.code = typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined;
  }
}

/**
 * Probe a backend binary by running its version flag. Resolves `true` if it ran at all (a
 * non-zero exit still means the binary is there), `false` only when it is absent — and
 * **rethrows** any other spawn failure. Swallowing those into `false` is what would let a
 * transient `EAGAIN` under fork pressure silently switch a healthy machine's engine, which is
 * precisely the silent substitution `CompilerResolver` exists to prevent: only the caller can
 * be told that latexmk is installed but unrunnable. The rethrow is wrapped in
 * {@link UnrunnableCompilerError} so the caller is told that in words, not by a bare errno.
 *
 * `run` is injectable so the rethrow can be tested: a real non-ENOENT spawn failure needs fd or
 * process exhaustion to reproduce, and a test that cannot cause one cannot pin the branch that
 * matters most here.
 */
export async function probeOnPath(
  cmd: string,
  versionArg: string,
  run: typeof execCapture = execCapture,
): Promise<boolean> {
  try {
    await run(cmd, [versionArg], { timeoutMs: 5000 });
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw new UnrunnableCompilerError(cmd, err);
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Per-project build dir under the OS temp root, keeping the project directory clean.
 *
 * Keyed by the *full* path, not just its basename: local projects are directories the user chose,
 * so `~/work/paper` and `~/archive/paper` are entirely different documents that would otherwise
 * share a build dir and surface each other's PDF. The basename is kept as a prefix so the temp
 * directory is still recognisable by eye.
 */
export function buildDir(projectDir: string): string {
  const resolved = path.resolve(projectDir);
  const key = createHash('sha1').update(resolved).digest('hex').slice(0, 8);
  return path.join(buildRoot(), `${path.basename(resolved)}-${key}`);
}

/**
 * The directory every project's {@link buildDir} sits in. Exported so an overlay compile's link
 * farm can refuse to mirror it, should a project directory ever contain the OS temp dir.
 *
 * Per user (#215): a shared, predictable `/tmp/web-latex-mcp-build` let another local user create
 * it first, or plant links in it, and read or swap the build artifacts the PDF tools trust.
 * - On POSIX the name carries the uid (`web-latex-mcp-build-<uid>`), and {@link ensureBuildRoot}
 *   creates it `0700` and verifies its owner and mode before any build goes in.
 * - On win32 the name carries the user name (`web-latex-mcp-build-<user>`, from
 *   `os.userInfo().username`, cut to one safe path segment by {@link userPathSegment}), so two
 *   accounts sharing one `TEMP` (a managed machine with `TEMP=C:\Temp`) never share a root by
 *   name. **The owner and ACL of the win32 root are NOT verified** — only that it is a real
 *   directory, not a junction or link. So a shared `TEMP` is only as safe as the name: another
 *   user can still pre-create `web-latex-mcp-build-<you>` there with an `Everyone:F` ACL and the
 *   server will accept it. The default `%LOCALAPPDATA%\Temp` is per user, and on it this is moot.
 *   Two accounts of the same name in different domains (a local `bob` and `CORP\bob`) also map to
 *   one name. When the user name cannot be read the name falls back to a fixed
 *   `web-latex-mcp-build-unknown-user`, and {@link ensureBuildRoot} refuses to use it, so nothing
 *   is ever built or read there.
 *
 * A pure path function — it touches no disk, and never throws, so the farm skip lists and
 * `variants.ts` can call it freely. `who` injects the identity and temp dir for tests. Anything
 * that CREATES or READS a build dir must go through {@link ensureBuildRoot} first.
 */
export function buildRoot(who: Partial<BuildRootIdentity> = {}): string {
  const tmp = who.tmpdir ?? os.tmpdir();
  // Keyed on whether the process HAS a uid, not on `process.platform`: Node defines
  // `process.getuid` on POSIX only, so the two agree in production, and a test that stubs the
  // platform (to drive a case-folding branch) no longer moves the root out from under the build
  // it staged. The user name is asked for only where there is no uid: `os.userInfo()` throws on
  // POSIX for a uid with no passwd entry (common in containers), which must not matter there.
  const uid = 'uid' in who ? who.uid : process.getuid?.();
  if (uid !== undefined) return path.join(tmp, `web-latex-mcp-build-${uid}`);
  const user = currentUserSegment(who.username ?? osUsername);
  return path.join(tmp, user === undefined ? UNKNOWN_USER_ROOT : `web-latex-mcp-build-${user}`);
}

/** The identity {@link buildRoot} names the root after — injectable for tests. */
export interface BuildRootIdentity {
  /** The OS temp dir the root sits in. */
  tmpdir: string;
  /** The current user's uid; `undefined` where the process has none (win32). */
  uid: number | undefined;
  /** Reads the current user name; may throw. Consulted only when `uid` is `undefined`. */
  username: () => string;
}

/**
 * The root's name when the user name cannot be read; {@link ensureBuildRoot} refuses it by name,
 * so the decision is the one {@link buildRoot} made, not a second read that could disagree. No
 * user name maps onto it: {@link userPathSegment} keeps a `.` only before 8 hex digits.
 */
const UNKNOWN_USER_ROOT = 'web-latex-mcp-build-unknown.user';

const osUsername = (): string => os.userInfo().username;

/**
 * Cut a user name down to one safe path segment, deterministically and without letting two
 * distinct names meet: a name made only of `[A-Za-z0-9_-]` (at most 64 characters) is used as is;
 * any other has each unsafe character replaced by `_`, is cut to 32 characters, and gets `.` plus
 * 8 hex digits of its SHA-1. A name used as is never contains `.`, so it can never equal a
 * rewritten one, and two rewritten names differ in their hash. No `\`, `/`, `:`, `..`, drive
 * letter or trailing dot or space survives, so the segment cannot leave the temp dir or name a
 * Windows device path. Returns `undefined` for an empty name — that is no identity at all.
 */
export function userPathSegment(raw: string): string | undefined {
  if (raw.length === 0) return undefined;
  if (/^[A-Za-z0-9_-]{1,64}$/.test(raw)) return raw;
  const kept = raw.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32);
  return `${kept}.${createHash('sha1').update(raw).digest('hex').slice(0, 8)}`;
}

/** The current user's {@link userPathSegment}, or `undefined` when the name cannot be read. */
function currentUserSegment(read: () => string): string | undefined {
  try {
    return userPathSegment(read());
  } catch {
    return undefined;
  }
}

/** Where a build root refusal points the user, by what is wrong. */
const PRIVATE_ROOT_ADVICE =
  'The build directory root must be a real directory owned by the user running this server, ' +
  'with no access for anyone else, so no other local user can read or replace the build output ' +
  '(the PDF, .aux and .log the PDF tools read back). Remove it if it is yours to remove, or ' +
  'point TMPDIR (TEMP on Windows) at a private directory, then compile again.';

/** A build root that is not safe to build in; the message names the path and the reason. */
export class UnsafeBuildRootError extends Error {
  constructor(
    readonly root: string,
    readonly reason: string,
    advice: string = PRIVATE_ROOT_ADVICE,
  ) {
    super(`Refusing to build in ${root}: ${reason}. ${advice}`);
    this.name = 'UnsafeBuildRootError';
  }
}

/** What {@link ensureBuildRoot} needs from the filesystem — injectable for tests. */
export interface BuildRootFs {
  mkdir(p: string, opts: { mode: number }): Promise<unknown>;
  lstat(p: string): Promise<{
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    uid: number;
    mode: number;
  }>;
  chmod(p: string, mode: number): Promise<void>;
}

/** The environment {@link ensureBuildRoot} judges against — injectable for tests. */
export interface BuildRootEnv {
  platform: NodeJS.Platform;
  /** The current user's uid; `undefined` where there is none to ask for (win32). */
  uid: number | undefined;
  fs: BuildRootFs;
}

const realBuildRootFs: BuildRootFs = { mkdir, lstat, chmod };

/**
 * Create the build root if it is missing and verify it before anything is built in it — fail
 * closed. It must be, by `lstat` (never following a link):
 * - a real directory, not a symbolic link or a junction (win32 included — a junction `lstat`s as
 *   a link), and not a file;
 * - on POSIX, owned by this process's uid, with no group or other permission bits. A root this
 *   user owns that others could only read or search (a test's `mkdir -p` under umask 022) is
 *   tightened to `0700` and checked again. A root that grants group or other WRITE access is
 *   refused, not tightened: a chmod cannot vouch for what was placed in it while it was open. A
 *   root owned by anyone else is refused, never adopted;
 * - on win32, nothing more: its owner and ACL are NOT verified. The name is per user
 *   ({@link buildRoot}), which is the whole of the protection there — enough under the default
 *   per-user `%LOCALAPPDATA%\Temp`, and only as strong as the name under a shared `TEMP`.
 *
 * Two more refusals, before anything is judged: the name {@link buildRoot} falls back to when the
 * user name cannot be read (it is not per user; refused before the mkdir, so never created), and
 * a missing temp dir. The mkdir is not recursive, so a `TMPDIR`/`TEMP` that does not exist (its
 * `ENOENT`) is reported in words — point it at an existing directory — and never created: making
 * it would pick the owner and mode of a directory other programs share.
 *
 * Every creation of a build dir goes through this (`outDirFor`, `applyOverlay`'s case probe,
 * `stageVariant`, `render_pages` before its PNGs), and so does every read of one outside a compile
 * (`locateRootPdf` for the main build — `render_pages`, `extract_text`, `pdf_geometry`, the
 * viewer — and `resolveVariantBuild` for a variant). Deliberately NOT memoised across calls: the
 * check is one `mkdir` and one `lstat`, and
 * a remembered success would outlive the directory — a /tmp cleaner that removes the idle root
 * lets another user recreate it, and a memo would then build straight into theirs. Returns the
 * root.
 */
export async function ensureBuildRoot(
  root: string = buildRoot(),
  env: Partial<BuildRootEnv> = {},
): Promise<string> {
  // Windows vs POSIX is decided the way `buildRoot` decides it — by whether this process HAS a
  // uid — not by `process.platform`, so the name and the rules applied to it cannot disagree: a
  // test stubbing the platform on a win32 runner otherwise got a POSIX judgement of a root with no
  // uid to own it, and every lookup was refused.
  const win32 = env.platform !== undefined ? env.platform === 'win32' : !process.getuid;
  const fs = env.fs ?? realBuildRootFs;
  const uid = 'uid' in env ? env.uid : win32 ? undefined : process.getuid?.();
  if (path.basename(root) === UNKNOWN_USER_ROOT) {
    // `buildRoot` could not read the user name, so this name is shared by everyone it happens
    // to. Refused before the mkdir: nothing is created under a name that is not per user.
    throw new UnsafeBuildRootError(
      root,
      'the current user name could not be determined, so the build root cannot be named per user',
      'This happens only when the operating system will not report the current user name; run ' +
        'the server under a regular user account.',
    );
  }
  try {
    // Not recursive: the parent is the OS temp dir, and a recursive mkdir would silently accept
    // whatever already sits at `root`. EEXIST is the ordinary case, judged below.
    await fs.mkdir(root, { mode: 0o700 });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      // The parent — the OS temp dir, from TMPDIR/TEMP — is missing (or is not a directory).
      // Never created here: making it would mean choosing its owner and mode, for a directory
      // other programs share, on the strength of an environment variable. Say so in words
      // rather than let a raw `ENOENT: … mkdir` stand for it.
      const parent = path.dirname(root);
      throw new UnsafeBuildRootError(
        root,
        `the temp directory it goes in, ${parent}, ${code === 'ENOENT' ? 'does not exist' : 'is not a directory'}`,
        'The server never creates the temp directory itself. Point TMPDIR (TEMP on Windows) at ' +
          'an existing directory, then compile again.',
      );
    }
    if (code !== 'EEXIST') throw err;
  }
  const judge = async (): Promise<{ loose: boolean; writable: boolean }> => {
    const st = await fs.lstat(root);
    if (st.isSymbolicLink()) {
      throw new UnsafeBuildRootError(root, 'it is a symbolic link (or junction), not a directory');
    }
    if (!st.isDirectory()) throw new UnsafeBuildRootError(root, 'it is not a directory');
    // No owner/ACL check on win32 (see the docstring): the per-user name is all there is.
    if (win32) return { loose: false, writable: false };
    if (uid === undefined) {
      throw new UnsafeBuildRootError(root, 'the current user id could not be determined');
    }
    if (st.uid !== uid) {
      throw new UnsafeBuildRootError(
        root,
        `it is owned by uid ${st.uid}, not by the user running this server (uid ${uid})`,
      );
    }
    return { loose: (st.mode & 0o077) !== 0, writable: (st.mode & 0o022) !== 0 };
  };
  const first = await judge();
  if (first.writable) {
    // Tightening it now would close the door, not empty the room: whatever another user put in
    // it while it was writable — a link where a project's build dir goes, a forged PDF, a
    // group-writable file of ours they rewrote — stays, and a chmod of the root vouches for none
    // of it. Judging every entry below (owner, mode, kind) would be a deep walk of every build
    // and variant farm on every call, so the root is refused whole instead.
    throw new UnsafeBuildRootError(
      root,
      'it grants group or other WRITE access, so another user may already have placed entries ' +
        'in it that tightening it now would not remove',
    );
  }
  if (first.loose) {
    // Only read/search bits: nobody else could have written into it, so restricting it to its
    // owner is enough.
    await fs.chmod(root, 0o700);
    // Judged again from scratch: the chmod follows a link, so the entry must still be the same
    // kind of thing, still ours, and now actually tight.
    if ((await judge()).loose) {
      throw new UnsafeBuildRootError(
        root,
        'it grants group or other access and could not be restricted to its owner (mode 0700)',
      );
    }
  }
  return root;
}

/**
 * The build dir a request writes to — its `outDir`, else the project's — created if missing,
 * after the build root it lives under has been created or verified ({@link ensureBuildRoot}).
 */
async function outDirFor(req: CompileRequest): Promise<string> {
  await ensureBuildRoot();
  const dir = req.outDir ?? buildDir(req.projectDir);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** The directory a request's backend runs in: its `workDir`, else the project itself. */
function workDirFor(req: CompileRequest): string {
  return req.workDir ?? req.projectDir;
}

/**
 * Mirror the project's subdirectory tree (directories only, never files) into the build dir.
 * The engine compiles into `-output-directory`, but a document's relative write paths resolve
 * against that dir — most notably TikZ externalization's cache (`imgs/tikzmain-figure0.md5`,
 * `.dpth`, `.pdf`). Those subdirectories exist in the source but not in the fresh build dir, so
 * the write fails with "I can't write on file". Recreating every source subdirectory is the
 * simple, robust fix — no preamble parsing, no special-casing `imgs`. `.git` is skipped.
 */
export async function mirrorSubdirs(srcDir: string, buildDir: string): Promise<void> {
  const entries = await readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '.git') continue;
    const dest = path.join(buildDir, entry.name);
    await mkdir(dest, { recursive: true });
    await mirrorSubdirs(path.join(srcDir, entry.name), dest);
  }
}

/**
 * {@link mirrorSubdirs} for latexmk, whose `-cd` puts the engine in the root file's own directory.
 * Relative write paths then resolve against the build dir from THAT directory, not the project
 * root: `paper/main.tex` doing `\include{chap/c1}` writes `<outdir>/chap/c1.aux`, while mirroring
 * the project root alone created only `<outdir>/paper/chap`, and the compile failed with "I can't
 * write on file `chap/c1.aux'". So the root file's directory subtree is mirrored at the build dir's
 * root too. The project-root mirror stays, since a document may also write through `../`.
 *
 * `rootFile` is caller-supplied, so the root's directory is mirrored only when it resolves INSIDE
 * the project and is an existing directory. Anything else — an absolute root, a directory that
 * does not exist, a `../` root — is skipped silently and left to latexmk to fail on in its own
 * words: mirroring `path.join(projectDir, '/abs/paper')` threw a raw ENOENT where a plain compile
 * had worked, and `../x.tex` copied the tree of a directory outside the project.
 *
 * "Inside" is judged on REAL paths (both sides `realpath`ed), never on the path string: the walk
 * below follows the root directory itself, so a committed `paper -> /` passed a string check and
 * made every compile mirror the outside tree into the build dir. A link to a directory that stays
 * in the project is still mirrored, so its `\include` keeps working. The walk cannot loop: it
 * starts at a real directory inside the project and {@link mirrorSubdirs} never descends into a
 * linked directory (a `Dirent` of a link is not `isDirectory()`).
 */
export async function mirrorSubdirsForRoot(
  projectDir: string,
  buildDir: string,
  rootFile: string,
): Promise<void> {
  await mirrorSubdirs(projectDir, buildDir);
  const base = logBaseDir(rootFile);
  if (base === '') return;
  const root = path.resolve(projectDir);
  const abs = path.resolve(root, base);
  // `to` lies strictly below `from`: not `from` itself, and not outside it.
  const strictlyInside = (from: string, to: string): boolean => {
    const rel = path.relative(from, to);
    return !(rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel));
  };
  if (!strictlyInside(root, abs)) return;
  let real: string;
  try {
    real = await realpath(abs);
    if (!strictlyInside(await realpath(root), real)) return;
    if (!(await stat(real)).isDirectory()) return;
  } catch {
    return;
  }
  await mirrorSubdirs(real, buildDir);
}

/**
 * The engine shell-escape flag for a request — always one of three, never none. Full
 * `-shell-escape` (arbitrary commands) takes precedence over the safer `-shell-restricted`
 * (allow-list only) when both are set; neither is ever enabled unless the caller explicitly opted
 * in. With neither, `-no-shell-escape`: leaving the flag out does NOT mean "off", it means the TeX
 * installation's own default, which on TeX Live is the restricted allow-list (`shell_escape = p`)
 * — so the schema's "never enabled unless you ask" was false for every plain compile (#213).
 *
 * latexmk hands the flag to the engine through `%O`, so a latexmkrc that drops `%O` or appends its
 * own `-shell-escape` after it can still turn shell escape back on; `shellEscapeWasEnabled` reads
 * the engine's own banner for exactly that reason.
 */
function shellEscapeFlag(req: CompileRequest): string {
  if (req.shellEscape) return '-shell-escape';
  if (req.restrictedShellEscape) return '-shell-restricted';
  return '-no-shell-escape';
}

/**
 * Whether the caller's request turns shell escape on for `backend` — what the compile hints and
 * the variant line judge "the caller opted in" by. `shellEscape` does on both backends;
 * `restrictedShellEscape` only under latexmk ({@link shellEscapeFlag}): tectonic has no restricted
 * mode, so its backend passes no flag for it and runs no command, and a caller who passed it is
 * exactly the one a refused-command hint is for. Pure.
 */
export function shellEscapeRequested(
  req: Pick<CompileRequest, 'shellEscape' | 'restrictedShellEscape'>,
  backend: CompilerKind,
): boolean {
  if (req.shellEscape === true) return true;
  return req.restrictedShellEscape === true && backend !== 'tectonic';
}

/**
 * The directory latexmk's `-cd` puts the engine in, relative to the project root: the root file's
 * own directory, or '' when it sits at the root. Exported so the rebasing of log paths is unit
 * testable against the flag that causes it.
 */
export function logBaseDir(rootFile: string): string {
  const dir = path.posix.dirname(toPosix(rootFile));
  return dir === '.' || dir === '/' ? '' : dir;
}

/**
 * The full latexmk argument vector for a request. Pure and exported so the arg construction —
 * in particular that shell escape is enabled only when explicitly requested, and disabled
 * outright (`-no-shell-escape`) otherwise — is unit testable without a TeX install.
 */
export function latexmkArgs(req: CompileRequest, buildDir: string): string[] {
  const engine = req.engine ?? 'pdflatex';
  const args = [
    ENGINE_FLAG[engine],
    '-interaction=nonstopmode',
    '-file-line-error',
    // chdir into the root file's directory before compiling, so a document that lives in a
    // subdirectory of the clone still finds its sibling .sty/.bst/.cls with a bare
    // `\usepackage{local}`. A no-op when the root file is at the clone root. `-outdir` stays
    // absolute (below), so the build artifacts land in the temp build dir regardless.
    '-cd',
    // Emit a .synctex.gz next to the PDF so a click in the viewer maps back to source file:line
    // (powers `list_comments`). Cheap and harmless when unused.
    '-synctex=1',
    `-outdir=${buildDir}`,
  ];
  args.push(shellEscapeFlag(req));
  if (req.clean) args.push('-gg');
  args.push(req.rootFile);
  return args;
}

/**
 * The path a compile would write its `.pdf` to (the build-dir `<jobname>.pdf`). Lets the read-only
 * `viewer` tool locate the last build without re-compiling. This is only the temp build
 * copy; a workspace-local compile also surfaces the same PDF beside the clone (`pdfSurface`).
 */
export function buildPdfPath(projectDir: string, rootFile: string): string {
  return buildPdfPathIn(buildDir(projectDir), rootFile);
}

/**
 * {@link buildPdfPath} inside a given build dir — the one an overlay compile writes to
 * (`CompileRequest.outDir`) rather than the project's own.
 */
export function buildPdfPathIn(outDir: string, rootFile: string): string {
  const rootBase = path.basename(rootFile).replace(/\.tex$/, '');
  return path.join(outDir, `${rootBase}.pdf`);
}

/**
 * The path a compile would write its `.aux` to (the build-dir `<jobname>.aux`). Lets the
 * read-only `pdf_geometry` tool locate the last build's float labels without re-compiling, mirroring
 * `buildPdfPath` exactly.
 */
export function buildAuxPath(projectDir: string, rootFile: string): string {
  return buildAuxPathIn(buildDir(projectDir), rootFile);
}

/** {@link buildAuxPath} inside a given build dir, as {@link buildPdfPathIn}. */
export function buildAuxPathIn(outDir: string, rootFile: string): string {
  const rootBase = path.basename(rootFile).replace(/\.tex$/, '');
  return path.join(outDir, `${rootBase}.aux`);
}

/**
 * A PDF's mtime and size — the two cheap markers `collectOutcome` compares from before a run to
 * after, to tell "the backend rewrote this file" from "found nothing to do and left it alone"
 * without any wall-clock assumption.
 */
export interface PdfStat {
  mtimeMs: number;
  size: number;
}

/** `stat` a path for its `PdfStat`, or `null` when it does not exist. */
async function statOrNull(p: string): Promise<PdfStat | null> {
  try {
    const info = await stat(p);
    return { mtimeMs: info.mtimeMs, size: info.size };
  } catch {
    return null;
  }
}

/**
 * Resolve the `.log` and `.pdf` a run produced. Both backends write `<jobname>.{log,pdf}`
 * into the build dir, where jobname is the root file's basename. Falls back to captured
 * stdout/stderr when no `.log` was written (e.g. the engine died before opening one).
 *
 * `rebuilt` and `pdfMtime` are derived from the PDF's own mtime and size, never parsed out of
 * backend stdout/log wording (discarded once a `.log` exists, differs per backend, and tectonic
 * has none) and never from the wall clock: `before` is a stat of the build-dir PDF taken just
 * before the exec (`null` when it did not exist yet). The PDF changed during this run —
 * `rebuilt: true` — when it exists now and either its mtime or its size differs from `before`. A
 * filesystem that truncates mtime to whole seconds can only miss a genuine rebuild that lands in
 * the same second as the previous write AND produces a byte-identical PDF — the narrowest failure
 * this comparison can have.
 *
 * Exported for unit tests, which drive it directly against a temp build dir and a fake
 * `ExecResult` rather than a real compile.
 */
export async function collectOutcome(
  buildDir: string,
  rootFile: string,
  res: ExecResult,
  durationSec: number,
  logBase: string,
  before: PdfStat | null,
  opts: {
    /** Scan the captured output for {@link engineNotFound} on failure — latexmk only. */
    detectMissingEngine?: boolean;
  } = {},
): Promise<CompileOutcome> {
  const rootBase = path.basename(rootFile).replace(/\.tex$/, '');
  const logPath = path.join(buildDir, `${rootBase}.log`);
  const pdfPath = path.join(buildDir, `${rootBase}.pdf`);

  let log: string;
  let resolvedLogPath: string | undefined;
  if (await exists(logPath)) {
    log = await readFile(logPath, 'utf8');
    resolvedLogPath = logPath;
  } else {
    log = `${res.stdout}\n${res.stderr}`;
  }

  const after = await statOrNull(pdfPath);
  const rebuilt =
    after !== null &&
    (before === null || after.mtimeMs !== before.mtimeMs || after.size !== before.size);
  const success = res.code === 0 && after !== null && !res.timedOut;
  // From what the backend printed, never from `log`, which may be a previous run's file.
  const missingEngine =
    !success && opts.detectMissingEngine
      ? engineNotFound(`${res.stdout}\n${res.stderr}`)
      : undefined;
  return {
    success,
    pdfPath: after !== null ? pdfPath : undefined,
    durationSec,
    log,
    logPath: resolvedLogPath,
    timedOut: res.timedOut,
    logBaseDir: logBase,
    rebuilt,
    // `mtimeMs` is a float derived from nanoseconds; `new Date(x)` truncates it, so an mtime set
    // to an exact millisecond can read back one ms early (seen on CI). Round to the nearest ms.
    pdfMtime: after !== null ? new Date(Math.round(after.mtimeMs)).toISOString() : undefined,
    ...(missingEngine ? { missingEngine } : {}),
  };
}

/**
 * Compiles a project locally with latexmk. Build artifacts go to a temp dir, keeping the clone clean.
 * `run` is injectable (as for {@link probeOnPath}) so what a run's output does to the outcome is
 * testable without TeX.
 */
export class LatexmkCompiler implements LatexCompiler {
  constructor(private readonly run: typeof execCapture = execCapture) {}

  isAvailable(): Promise<boolean> {
    return probeOnPath('latexmk', '-v');
  }

  async compile(req: CompileRequest): Promise<CompileOutcome> {
    const buildDir = await outDirFor(req);
    await mirrorSubdirsForRoot(req.projectDir, buildDir, req.rootFile);
    const args = latexmkArgs(req, buildDir);

    const before = await statOrNull(buildPdfPathIn(buildDir, req.rootFile));
    const start = Date.now();
    const res = await this.run('latexmk', args, {
      cwd: workDirFor(req),
      timeoutMs: (req.timeoutSec ?? 120) * 1000,
    });
    // `-cd` chdirs into the root file's directory: that is what the log's paths are relative to.
    // latexmk shells out to the engine, so a missing one shows up as the shell's not-found line.
    return collectOutcome(
      buildDir,
      req.rootFile,
      res,
      (Date.now() - start) / 1000,
      logBaseDir(req.rootFile),
      before,
      { detectMissingEngine: true },
    );
  }
}

/**
 * Compiles with tectonic. Self-contained (bundles its own TeX and fetches packages on
 * demand into a local cache), so no system TeX install is needed — at the cost of a
 * network round-trip on the first, cold-cache compile.
 *
 * Tectonic is XeTeX-only: it always drives its bundled XeTeX engine and produces a PDF
 * directly, so `req.engine` is not honored (a `pdflatex`/`lualatex` request still runs
 * XeTeX). Tectonic reruns all passes internally every time, so there is no incremental
 * state to force-clean and `req.clean` is a no-op. It only writes a `.log` when asked
 * (`--keep-logs`), which the parser needs.
 */
export class TectonicCompiler implements LatexCompiler {
  /** Injectable like {@link LatexmkCompiler}'s. */
  constructor(private readonly run: typeof execCapture = execCapture) {}

  isAvailable(): Promise<boolean> {
    return probeOnPath('tectonic', '--version');
  }

  async compile(req: CompileRequest): Promise<CompileOutcome> {
    const buildDir = await outDirFor(req);
    // No root-directory mirror here (see `mirrorSubdirsForRoot`): tectonic takes no `-cd`, so its
    // relative paths already resolve against the project root, which this mirrors.
    await mirrorSubdirs(req.projectDir, buildDir);

    const args = [req.rootFile, '--outdir', buildDir, '--keep-logs', '--chatter', 'minimal'];
    // Tectonic has no restricted mode, so `restrictedShellEscape` alone does not widen to full
    // shell escape here; only an explicit `shellEscape` enables system calls. Without it tectonic
    // runs none at all, so it needs no counterpart of latexmk's `-no-shell-escape`.
    if (req.shellEscape) args.push('-Z', 'shell-escape');

    const before = await statOrNull(buildPdfPathIn(buildDir, req.rootFile));
    const start = Date.now();
    const res = await this.run('tectonic', args, {
      cwd: workDirFor(req),
      timeoutMs: (req.timeoutSec ?? 120) * 1000,
    });
    // Tectonic takes no `-cd`: it runs in the project root, so its log paths already are. No
    // `detectMissingEngine`: it drives its bundled engine and never runs an engine binary, so a
    // not-found line in its output could only have come from the document.
    return collectOutcome(buildDir, req.rootFile, res, (Date.now() - start) / 1000, '', before);
  }
}

/** Build the configured compile backend. */
export function createCompiler(kind: CompilerKind): LatexCompiler {
  return kind === 'tectonic' ? new TectonicCompiler() : new LatexmkCompiler();
}
