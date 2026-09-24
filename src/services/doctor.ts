import { access, constants, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { execCapture } from '../lib/exec.js';
import { toPosix } from '../lib/paths.js';
import { isNotFound, spawnFailureReason } from './compiler.js';
import { COMPILER_KINDS } from './compilerResolver.js';
import { PdfRenderer } from './pdfRender.js';
import type { CompilerKind } from '../types.js';

/** What `PdfRenderer.canReadPdf` answers. */
type PdfReadProbe = { ok: true } | { ok: false; error: string };

/**
 * Reports what the local LaTeX toolchain actually is, before a compile fails into it.
 *
 * Everything a document needs beyond the .tex — an engine, a package manager, a writable place to
 * install into — lives outside this server and outside the project, so the only way a caller learns
 * about it today is by hitting an error and guessing. Each probe here answers one question that has
 * cost somebody a detour: which engines exist, how old the distribution is, whether the package
 * manager can still reach anything, and where a package could be installed without root.
 *
 * Read-only and network-free by default: a reachability check hangs on exactly the broken setups it
 * is meant to diagnose, so it is opt-in (`checkRepository`) and separately timed out.
 */

/** How bad a finding is. `fail` means something the server needs is missing. */
export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface DoctorCheck {
  /** Stable slug, e.g. `engines` — safe to branch on. */
  name: string;
  status: CheckStatus;
  /** One line of human-readable fact, e.g. `TeX Live 2019/Debian`. */
  detail: string;
}

export interface Diagnosis {
  /** True when nothing is outright missing — warnings can still be present. */
  ok: boolean;
  checks: DoctorCheck[];
  /** LaTeX engines found on PATH, in `compile`'s `engine` vocabulary. */
  engines: string[];
  /** Concrete remedies for the findings above, most important first. */
  hints: string[];
}

export interface DoctorOptions {
  /** The compiler backend the server is configured to use — the one that must exist. */
  compiler: CompilerKind;
  /**
   * Whether `compiler` was named by WEB_LATEX_MCP_COMPILER rather than defaulted. An explicit
   * choice is never substituted, so a missing one is a hard failure; a defaulted one falls back
   * to whichever backend is installed, which is a warning at most. Defaults to false.
   */
  compilerExplicit?: boolean;
  /** Where clones live; unwritable means nothing works, so it is worth one `access` call. */
  workspaceRoot?: string;
  /** Actually reach the package repository over the network (off by default). */
  checkRepository?: boolean;
}

/** The engines `compile` accepts, which is what makes this list worth probing. */
const ENGINES = ['pdflatex', 'xelatex', 'lualatex'] as const;

/**
 * The flag each backend prints its version for. They disagree — tectonic rejects `-v` — and this
 * is the only place in this file that needs to know it.
 */
function versionFlag(kind: CompilerKind): string {
  return kind === 'tectonic' ? '--version' : '-v';
}

/**
 * The backend `compile` would fall back to — the first of the others, matching the order
 * `CompilerResolver` tries them in, so `doctor` names the backend that would actually be picked.
 * Derived from `COMPILER_KINDS` rather than written as `kind === 'latexmk' ? …`, which silently
 * returns a wrong answer the day a third backend is added instead of failing loudly.
 */
function otherCompiler(kind: CompilerKind): CompilerKind | undefined {
  return COMPILER_KINDS.find((k) => k !== kind);
}

/**
 * What changes when tectonic is the backend rather than latexmk. Each one is a silent behaviour
 * change rather than an error, so any hint that offers tectonic has to say them outright — and
 * only then, since none of it is true of latexmk.
 */
const TECTONIC_CAVEAT =
  'Note that tectonic is XeTeX-only, so `engine` is ignored and `clean` is a no-op, and its log ' +
  'carries no file:line, so compile errors come back with no source snippets.';

/**
 * The oldest git this server works with. Two call sites set it, and only these two — every other
 * git feature the server uses (`config --type=bool` 2.18, `rebase --fork-point` 1.9,
 * `--literal-pathspecs` 1.8, `update-index --cacheinfo m,s,p` 2.0) is older:
 * - `git commit --only --pathspec-from-file=- --pathspec-file-nul` (git 2.25) — `commit` with
 *   `scope: "all"` and `paths`, which commits only what those paths cover out of the live index;
 * - `git checkout --no-overlay HEAD --` (git 2.22) — `discard`, whole-tree and with `paths`,
 *   which restores index and working tree from HEAD in one write.
 * An older git rejects the option outright, so those calls fail rather than misbehave.
 */
export const MIN_GIT_VERSION = '2.25';
/** {@link MIN_GIT_VERSION} as numbers — derived, so the two can never disagree. */
const MIN_GIT = parseGitVersion(`git version ${MIN_GIT_VERSION}`) ?? [Infinity, 0];

/** What needs {@link MIN_GIT_VERSION}, in the words a hint shows. */
const GIT_FLOOR_REASON =
  '`commit` with scope "all" and `paths` runs `git commit --only --pathspec-from-file` ' +
  '(git 2.25+), and `discard` restores from HEAD with `git checkout --no-overlay` (git 2.22+); ' +
  'an older git rejects both options.';

/**
 * `git version 2.46.0`, `git version 2.39.3 (Apple Git-146)`, `git version 2.45.1.windows.1`
 * -> `[major, minor]`. Anything else (a wrapper's banner, an empty line) is `undefined`: an
 * unknown version is reported as unknown, never guessed.
 */
export function parseGitVersion(banner: string): [number, number] | undefined {
  const m = /^git version (\d+)\.(\d+)(?:[.\s]|$)/.exec(banner.trim());
  if (!m?.[1] || !m[2]) return undefined;
  return [Number(m[1]), Number(m[2])];
}

function versionBelow(v: readonly [number, number], floor: readonly [number, number]): boolean {
  return v[0] < floor[0] || (v[0] === floor[0] && v[1] < floor[1]);
}

/** Long enough for a cold binary on a slow disk, short enough not to stall the caller. */
const PROBE_TIMEOUT_MS = 10_000;
/** The one probe that leaves the machine; kept tighter, since unreachable is the expected answer. */
const NETWORK_TIMEOUT_MS = 8_000;

/**
 * A frozen snapshot of a past year's package repository. `tlmgr` on an end-of-life TeX Live is
 * pointed at one of these by default, and installing from it ranges from unreliable to impossible —
 * the single most confusing failure in this area, because `tlmgr install` looks like it should work.
 */
const FROZEN_REPOSITORY = /(historic|tlnet-final|tlnet-archive)/i;

type Runner = typeof execCapture;

/**
 * What probing a backend found. "Absent" and "unrunnable" are kept apart because `compile` keeps
 * them apart: `probeOnPath` answers "not installed" for ENOENT alone and throws for every other
 * spawn failure, so only an absent default is ever substituted — a present-but-broken one makes
 * the compile throw. Reading both as "not on PATH" promised a fallback that never happened.
 */
type BackendProbe =
  | { state: 'found'; banner: string }
  | { state: 'absent' }
  | { state: 'unrunnable'; reason: string };
type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ status: number }>;

export class DoctorService {
  private readonly run: Runner;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;
  private readonly canWrite: (target: string) => Promise<boolean>;
  private readonly canRasterize: () => Promise<boolean>;
  private readonly canReadPdf: () => Promise<PdfReadProbe>;

  constructor(
    deps: {
      run?: Runner;
      fetch?: FetchLike;
      now?: () => Date;
      /** Injectable so tests decide what is writable — the real answer varies by OS and machine. */
      canWrite?: (target: string) => Promise<boolean>;
      /** Injectable so a test can assert both answers — the real one depends on the machine's platform. */
      canRasterize?: () => Promise<boolean>;
      /** Injectable for the same reason: whether pdf.js itself loads is a property of the install. */
      canReadPdf?: () => Promise<PdfReadProbe>;
    } = {},
  ) {
    this.run = deps.run ?? execCapture;
    this.fetchImpl = deps.fetch ?? ((url, init) => fetch(url, init));
    this.now = deps.now ?? (() => new Date());
    this.canWrite = deps.canWrite ?? isWritablePath;
    this.canRasterize = deps.canRasterize ?? (() => new PdfRenderer().canRasterize());
    this.canReadPdf = deps.canReadPdf ?? (() => new PdfRenderer().canReadPdf());
  }

  async diagnose(opts: DoctorOptions): Promise<Diagnosis> {
    const checks: DoctorCheck[] = [];
    const hints: string[] = [];

    // Independent probes, so pay for the slowest rather than the sum.
    const [compiler, engineVersions, tlmgr, texmfHome, texmfLocal, git, pdfRasterize, pdfRead] =
      await Promise.all([
        this.probeBackend(opts.compiler),
        Promise.all(ENGINES.map((e) => this.version(e, ['--version']))),
        this.version('tlmgr', ['--version']),
        this.kpsewhich('TEXMFHOME'),
        this.kpsewhich('TEXMFLOCAL'),
        this.version('git', ['--version']),
        this.canRasterize(),
        this.canReadPdf(),
      ]);

    // 1. The configured backend, and — only when it is absent — the other one. Whether a missing
    //    backend is fatal is not a question about this machine but about who chose it: `compile`
    //    substitutes a mere default and never an explicit choice, so the grade has to follow that
    //    or `doctor` calls a working setup broken. The alternative is probed here rather than in
    //    the batch above so the happy path pays for exactly the probes it always did.
    //
    //    `effective` is the backend a compile would really use, which is not always the configured
    //    one. Checks below are graded against it rather than `opts.compiler`, or `doctor` reports on
    //    a toolchain nobody is using — and since `ok` is `every(status !== 'fail')`, one such check
    //    silently overrides the grade decided here.
    let effective: CompilerKind = opts.compiler;
    // ...and whether that backend is actually *there*. The two come apart when nothing can compile
    // (an explicit choice that is missing, or no backend at all): `effective` still names the
    // backend that would run, but nothing may be claimed about what it provides. Softening a check
    // on the strength of a backend this machine does not have asserts a capability nothing has.
    let effectiveAvailable = false;
    if (compiler.state === 'found') {
      effectiveAvailable = true;
      checks.push({
        name: 'compiler',
        status: 'ok',
        detail: `${opts.compiler}: ${compiler.banner}`,
      });
    } else if (compiler.state === 'unrunnable') {
      // On PATH but it would not start. `compile` does not read that as "not installed", so it
      // substitutes nothing — explicit or not — and the compile throws. `fail`, then, and no
      // fallback promised. The other backend is probed only to name it as the way out.
      const other = otherCompiler(opts.compiler);
      const otherProbe = other ? await this.probeBackend(other) : undefined;
      const alt = other && otherProbe?.state === 'found' ? other : undefined;
      checks.push({
        name: 'compiler',
        status: 'fail',
        detail:
          `${opts.compiler} is on PATH but could not be run (${compiler.reason}) — compile ` +
          'will not fall back to another backend',
      });
      hints.push(
        `The configured compiler (${opts.compiler}) is on PATH but could not be run ` +
          `(${compiler.reason}), so no document can be built. A backend that is present but ` +
          'fails to start is a fault to fix, not a missing default, so compile never substitutes ' +
          'another one for it. Make sure the binary is executable and runs from a shell' +
          (alt
            ? `, or select ${alt}, which is installed: set WEB_LATEX_MCP_COMPILER=${alt} for ` +
              `every compile, or pass compiler: "${alt}" on a single compile call.` +
              (alt === 'tectonic' ? ` ${TECTONIC_CAVEAT}` : '')
            : '.'),
      );
    } else {
      const other = otherCompiler(opts.compiler);
      const otherProbe = other ? await this.probeBackend(other) : undefined;
      const caveat = other === 'tectonic' ? ` ${TECTONIC_CAVEAT}` : '';
      if (other !== undefined && otherProbe?.state === 'unrunnable') {
        // The fallback exists but will not start — and `compile`'s probe of it throws (explicit
        // or not, since it is asked either way to report what is installed), so nothing compiles.
        checks.push({
          name: 'compiler',
          status: 'fail',
          detail:
            `${opts.compiler} not found on PATH, and ${other} is on PATH but could not be run ` +
            `(${otherProbe.reason})`,
        });
        hints.push(
          `The configured compiler (${opts.compiler}) is not on PATH, and ${other} is on PATH ` +
            `but could not be run (${otherProbe.reason}), so no document can be built. Make ` +
            `sure ${other} is executable and runs from a shell, or install ${opts.compiler}.`,
        );
      } else if (other === undefined || otherProbe?.state !== 'found') {
        // `other` is undefined only if `COMPILER_KINDS` ever shrinks to one; say nothing about a
        // backend that does not exist rather than interpolating "undefined" into the report.
        checks.push({
          name: 'compiler',
          status: 'fail',
          detail: `${opts.compiler} not found on PATH` + (other ? ` (nor is ${other})` : ''),
        });
        hints.push(
          `The configured compiler (${opts.compiler}) is not on PATH` +
            (other ? `, and neither is ${other}` : '') +
            ' — no document can be built. Install a TeX distribution (TeX Live: ' +
            'https://tug.org/texlive, MiKTeX: https://miktex.org) or tectonic ' +
            '(https://tectonic-typesetting.github.io) and make sure its bin directory is on PATH.',
        );
      } else if (opts.compilerExplicit ?? false) {
        const otherVersion = otherProbe.banner;
        // An assertion, so nothing is picked for the caller — but say what would work.
        checks.push({
          name: 'compiler',
          status: 'fail',
          detail:
            `${opts.compiler} not found on PATH — ${other} (${otherVersion}) is installed, but ` +
            `WEB_LATEX_MCP_COMPILER names ${opts.compiler} explicitly`,
        });
        hints.push(
          `The configured compiler (${opts.compiler}) is not on PATH, so no document can be ` +
            `built. ${other} is installed, but WEB_LATEX_MCP_COMPILER names ${opts.compiler} ` +
            'explicitly and an explicit choice is never substituted. Set ' +
            `WEB_LATEX_MCP_COMPILER=${other} to select it for every compile, or pass ` +
            `compiler: "${other}" on a single compile call.${caveat}`,
        );
      } else {
        const otherVersion = otherProbe.banner;
        // Only a default, so `compile` falls back: the toolchain works, it is just not the one
        // configured. `warn` keeps `ok` true, which is the truth about this machine.
        effective = other;
        effectiveAvailable = true;
        checks.push({
          name: 'compiler',
          status: 'warn',
          detail: `${opts.compiler} not found on PATH — falling back to ${other} (${otherVersion})`,
        });
        hints.push(
          `The configured compiler (${opts.compiler}) is not on PATH, so compiles are falling ` +
            // "names no backend", not "is unset": unset, empty, and whitespace-only all land
            // here, and telling a user with WEB_LATEX_MCP_COMPILER="  " that it is unset sends
            // them looking anywhere but at the variable that caused this.
            `back to ${other}, which is installed — WEB_LATEX_MCP_COMPILER names no backend, so ` +
            `${opts.compiler} was only the default.${caveat} Set ` +
            `WEB_LATEX_MCP_COMPILER=${other} to choose it explicitly — an explicit choice is ` +
            'never substituted.',
        );
      }
    }

    // 2. Engines, named the way `compile`'s `engine` argument names them — but only latexmk needs
    //    them. Tectonic bundles its own XeTeX and drives it directly, so "no LaTeX engine on PATH"
    //    is not a finding about a tectonic machine, it is a category error: it would mark the one
    //    setup this whole fallback exists to rescue as broken, and `ok` is `every(!== 'fail')`, so
    //    a `fail` here would override the `warn` above and undo the grade entirely.
    //    Gated on the backend actually being installed: an explicitly-chosen tectonic that is
    //    absent leaves `effective` as tectonic, and claiming "none needed, tectonic bundles its
    //    own" on a machine that has no tectonic asserts a capability nothing there has.
    const engines = ENGINES.filter((_, i) => engineVersions[i]);
    const tectonicRuns = effective === 'tectonic' && effectiveAvailable;
    if (tectonicRuns) {
      checks.push({
        name: 'engines',
        status: 'ok',
        detail:
          (engines.length > 0
            ? `${engines.join(', ')} — not used: `
            : 'none on PATH, none needed: ') + 'tectonic bundles its own XeTeX',
      });
    } else if (engines.length > 0) {
      checks.push({ name: 'engines', status: 'ok', detail: engines.join(', ') });
    } else {
      checks.push({ name: 'engines', status: 'fail', detail: 'no LaTeX engine found on PATH' });
    }

    // 3. How old the distribution is — an EOL year explains package installs that cannot work.
    //    Only when latexmk is what runs, like the engines and package-manager checks around it:
    //    tectonic uses neither the system TeX nor its packages, so an end-of-life warning there
    //    sends the user to upgrade something no compile touches. It is still reported, as unused.
    const banner = engineVersions.find(Boolean);
    const distribution = banner ? describeDistribution(banner) : undefined;
    const year = banner ? distributionYear(banner) : undefined;
    const currentYear = this.now().getFullYear();
    // TeX Live goes to the historic archive about a year after release, so one year back is normal.
    const endOfLife = year !== undefined && year < currentYear - 1;
    if (distribution && tectonicRuns) {
      checks.push({
        name: 'distribution',
        status: 'ok',
        detail: `${distribution} — not used: tectonic bundles its own XeTeX and packages`,
      });
    } else if (distribution) {
      checks.push({
        name: 'distribution',
        status: endOfLife ? 'warn' : 'ok',
        detail: endOfLife ? `${distribution} — past end of life` : distribution,
      });
    }

    // 4. The package manager, and whether it can still reach anything — a question about a system
    //    TeX installation, so it is only a question at all when latexmk is what runs. Under
    //    tectonic the whole branch is a category error: a frozen `tlmgr` repository cannot affect
    //    a backend that never consults tlmgr, and warning about one sends the user to fix
    //    something that was not going to be used.
    const repository = tlmgr && !tectonicRuns ? await this.tlmgrRepository() : undefined;
    if (tectonicRuns) {
      checks.push({
        name: 'package-manager',
        status: 'ok',
        detail:
          (tlmgr ? `${tlmgr} — not used: ` : 'none on PATH, none needed: ') +
          'tectonic fetches packages into its own cache ' +
          '(which needs network access on the first compile of a project)',
      });
    } else if (tlmgr) {
      const frozen = repository !== undefined && FROZEN_REPOSITORY.test(repository);
      const reachable =
        opts.checkRepository && repository ? await this.reach(repository) : undefined;
      const parts = [tlmgr];
      if (repository) parts.push(`repository: ${repository}`);
      if (frozen) parts.push('(frozen archive)');
      if (reachable !== undefined) parts.push(reachable.detail);
      checks.push({
        name: 'package-manager',
        status: frozen || reachable?.ok === false ? 'warn' : 'ok',
        detail: parts.join(' — '),
      });
      if (frozen) {
        hints.push(
          `tlmgr points at a frozen archive (${repository}), so \`tlmgr install\` cannot reliably ` +
            'fetch anything' +
            (endOfLife ? ` — this TeX Live (${year}) is past end of life.` : '.') +
            ' Upgrade the TeX distribution to install packages the normal way; short of that, ' +
            'install a package by hand into TEXMFHOME (in TDS layout: tex/latex/<pkg>/) and run ' +
            '`mktexlsr`.',
        );
      } else if (reachable?.ok === false) {
        hints.push(
          `The tlmgr repository is not reachable (${reachable.detail}). Point it at a live mirror ` +
            'with `tlmgr option repository https://mirror.ctan.org/systems/texlive/tlnet`, or ' +
            'check the network, before trying to install packages.',
        );
      }
    } else if (await this.has('mpm')) {
      // MiKTeX installs missing packages on demand, so there is nothing to warn about.
      checks.push({ name: 'package-manager', status: 'ok', detail: 'MiKTeX (mpm)' });
    } else {
      checks.push({ name: 'package-manager', status: 'warn', detail: 'no tlmgr or mpm on PATH' });
    }

    // 5/6. Where a missing package could actually be installed. System texmf normally needs root,
    // which is why the no-root answer (TEXMFHOME, or tlmgr --usermode) is worth stating up front.
    //
    // These are the only three `detail`s in a diagnosis that carry a PATH, so they are the only
    // ones converted for display ("File paths are always POSIX, on every OS" — docs/tools.md).
    // Everything else here that looks path-ish is not a path: `compiler` and `git` hold
    // `--version` banner output and `package-manager`'s repository is a URL, and converting
    // either would be a regression. The conversion sits strictly BELOW `this.canWrite`, which is
    // `isWritablePath` in production and `stat`s the real filesystem: that probe is handed the
    // host's own spelling, always.
    const homeWritable = texmfHome ? await this.canWrite(texmfHome) : false;
    if (texmfHome) {
      const shownHome = toPosix(texmfHome);
      checks.push({
        name: 'texmf-home',
        status: homeWritable ? 'ok' : 'warn',
        detail: `${shownHome}${homeWritable ? ' (writable)' : ' (not writable)'}`,
      });
    }
    if (texmfLocal) {
      const localWritable = await this.canWrite(texmfLocal);
      const shownLocal = toPosix(texmfLocal);
      checks.push({
        name: 'system-texmf',
        status: 'ok', // not writable is the normal, safe state — never a problem in itself
        detail: `${shownLocal}${localWritable ? ' (writable)' : ' (not writable — needs root)'}`,
      });
      // A tlmgr route is advice about installing into the system TeX, which tectonic never reads.
      if (!localWritable && homeWritable && tlmgr && !tectonicRuns) {
        hints.push(
          'The system texmf tree needs root, so install packages into your own tree instead: ' +
            '`tlmgr --usermode init-usertree` once, then `tlmgr --usermode install <package>`.',
        );
      }
    }

    // 7. git, which every sync, commit and push shells out to — and not just any git: see
    // MIN_GIT_VERSION for the two operations that need a recent one.
    if (!git) {
      checks.push({ name: 'git', status: 'fail', detail: 'git not found on PATH' });
      hints.push('git is not on PATH — cloning, syncing and pushing cannot work.');
    } else {
      const found = parseGitVersion(git);
      if (!found) {
        // Present but unreadable (a wrapper, a vendor banner): not proof of a problem, so `warn`,
        // never `ok` — nothing here can vouch for the version floor.
        checks.push({
          name: 'git',
          status: 'warn',
          detail: `${git} (could not read a version number; git ${MIN_GIT_VERSION} or newer is needed)`,
        });
      } else if (versionBelow(found, MIN_GIT)) {
        checks.push({
          name: 'git',
          status: 'fail',
          detail: `${git} (older than ${MIN_GIT_VERSION}, the minimum this server needs)`,
        });
        hints.push(
          `Upgrade git to ${MIN_GIT_VERSION} or newer. ${GIT_FLOOR_REASON} Everything else — ` +
            'cloning, syncing, pushing and the other commit scopes — still works on this git.',
        );
      } else {
        checks.push({ name: 'git', status: 'ok', detail: git });
      }
    }

    // 8. The workspace itself: clones and build artifacts have to land somewhere.
    if (opts.workspaceRoot) {
      const ok = await this.canWrite(opts.workspaceRoot);
      // One displayed spelling, computed below the probe and used in BOTH channels it appears in
      // — the check detail and the hint — so a reader is never told two different paths.
      const shownWorkspace = toPosix(opts.workspaceRoot);
      checks.push({
        name: 'workspace',
        status: ok ? 'ok' : 'fail',
        detail: `${shownWorkspace}${ok ? ' (writable)' : ' (not writable)'}`,
      });
      if (!ok) {
        hints.push(
          `The workspace root (${shownWorkspace}) is not writable — set ` +
            'WEB_LATEX_MCP_WORKSPACE to a directory you own.',
        );
      }
    }

    // 9. The PDF side, as two questions rather than one, because they have different causes and
    // different cures. Reading a PDF — compile's pageCount, extract_text, pdf_geometry — needs
    // pdf.js and nothing else; rasterizing (render_pages) needs the optional native backend
    // `@napi-rs/canvas` too. Asking only "can it rasterize" is how a Claude Desktop extension
    // missing pdf.js itself was told to `npm i @napi-rs/canvas`. Both are `warn`, never `fail`:
    // compiling, the viewer, editing and the whole git side need neither, so neither may make
    // `ok` (checks.every(status !== 'fail')) go false.
    if (!pdfRead.ok) {
      checks.push({
        name: 'pdf-render',
        status: 'warn',
        detail:
          'pdf.js (pdfjs-dist) is not usable — no render_pages, extract_text, pdf_geometry ' +
          'measurement, or pageCount from compile',
      });
      hints.push(
        'The PDF library pdfjs-dist could not be loaded, so no PDF can be read: render_pages, ' +
          'extract_text and pdf_geometry fail (its `floats` index still works — that reads the ' +
          '.aux, not the PDF) and compile reports no pageCount. This is a broken or incomplete ' +
          'install of the server, not a missing optional package — reinstall the server (or its ' +
          `Claude Desktop extension). What failed: ${pdfRead.error}`,
      );
    } else if (pdfRasterize) {
      checks.push({
        name: 'pdf-render',
        status: 'ok',
        detail: '@napi-rs/canvas — page rasterization available',
      });
    } else {
      checks.push({
        name: 'pdf-render',
        status: 'warn',
        detail:
          'no native canvas backend — no render_pages; pageCount, extract_text and pdf_geometry ' +
          'still work',
      });
      hints.push(
        'No native canvas backend (@napi-rs/canvas) is available, so render_pages cannot ' +
          'rasterize pages to PNG. Nothing else needs it: compile (and its pageCount), ' +
          'extract_text, pdf_geometry and the viewer all work. In the Claude Desktop extension ' +
          'this is expected and cannot be fixed there — the bundle is built once for every ' +
          'platform and this backend is a per-platform native binary — so install the server ' +
          'from npm (`npx -y web-latex-mcp`) if you need page images. On an npm install it is ' +
          'an optional dependency (skipped on unsupported platforms or by --omit=optional): ' +
          "run `npm i @napi-rs/canvas` in the server's directory.",
      );
    }

    return { ok: checks.every((c) => c.status !== 'fail'), checks, engines, hints };
  }

  /**
   * Probe a compile backend with the same not-found test `compile`'s preflight uses
   * (`isNotFound`, as in `probeOnPath`), so the two can never disagree about whether a backend
   * that failed to start counts as missing.
   */
  private async probeBackend(kind: CompilerKind): Promise<BackendProbe> {
    try {
      const res = await this.run(kind, [versionFlag(kind)], { timeoutMs: PROBE_TIMEOUT_MS });
      return { state: 'found', banner: firstLine(res) ?? kind };
    } catch (err) {
      return isNotFound(err)
        ? { state: 'absent' }
        : { state: 'unrunnable', reason: spawnFailureReason(err) };
    }
  }

  /** First line of `cmd --version`, or undefined when the binary is not on PATH. */
  private async version(cmd: string, args: string[]): Promise<string | undefined> {
    try {
      const res = await this.run(cmd, args, { timeoutMs: PROBE_TIMEOUT_MS });
      return firstLine(res) ?? cmd;
    } catch {
      return undefined; // execCapture rejects only when the binary cannot be spawned
    }
  }

  private async has(cmd: string): Promise<boolean> {
    return (await this.version(cmd, ['--version'])) !== undefined;
  }

  /** Resolve a kpathsea variable (e.g. TEXMFHOME) to its path. */
  private async kpsewhich(variable: string): Promise<string | undefined> {
    try {
      const res = await this.run('kpsewhich', [`-var-value=${variable}`], {
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      const value = res.stdout.trim().split('\n')[0]?.trim();
      return value && value.length > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * The repository `tlmgr install` would fetch from. Its output carries preamble lines (Debian's
   * "switching to user mode!"), so pick the line that names the repository rather than the first.
   */
  private async tlmgrRepository(): Promise<string | undefined> {
    try {
      const res = await this.run('tlmgr', ['option', 'repository'], {
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      for (const line of res.stdout.split('\n')) {
        const m = /repository[^:]*:\s*(\S+)/i.exec(line.trim());
        if (m?.[1]) return m[1];
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  /** The one probe that leaves the machine, so it is opt-in and independently timed out. */
  private async reach(url: string): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) });
      return res.status < 400
        ? { ok: true, detail: `reachable (HTTP ${res.status})` }
        : { ok: false, detail: `unreachable (HTTP ${res.status})` };
    } catch (err) {
      return { ok: false, detail: `unreachable (${err instanceof Error ? err.message : 'error'})` };
    }
  }
}

/** The first non-empty line a `--version` run printed, on either stream. */
function firstLine(res: { stdout: string; stderr: string }): string | undefined {
  return `${res.stdout}\n${res.stderr}`
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
}

/** `pdfTeX 3.14…-1.40.20 (TeX Live 2019/Debian)` -> `TeX Live 2019/Debian`; MiKTeX likewise. */
function describeDistribution(banner: string): string | undefined {
  const paren = /\(([^)]*(?:TeX Live|MiKTeX|Web2C)[^)]*)\)/i.exec(banner);
  if (paren?.[1]) return paren[1].trim();
  return /MiKTeX/i.test(banner) ? 'MiKTeX' : undefined;
}

/** The release year in an engine banner, when it names one. */
function distributionYear(banner: string): number | undefined {
  const m = /(?:TeX Live|MiKTeX)[^)\d]*(\d{4})/i.exec(banner);
  return m?.[1] ? Number(m[1]) : undefined;
}

/**
 * Whether a path can be written to. TEXMFHOME usually does not exist yet (nothing has been
 * installed there), so what actually decides the answer is the nearest ancestor that does exist: it
 * has to be a writable *directory*. Requiring a directory matters — `/dev/null` is world-writable,
 * so a path underneath it would otherwise look creatable when nothing can ever live there.
 */
export async function isWritablePath(target: string): Promise<boolean> {
  let dir = path.resolve(target);
  for (;;) {
    let info: Stats;
    try {
      info = await stat(dir);
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return false; // walked past the root without finding anything
      dir = parent; // does not exist yet — ask about its parent
      continue;
    }
    if (!info.isDirectory()) return false;
    try {
      await access(dir, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }
}
