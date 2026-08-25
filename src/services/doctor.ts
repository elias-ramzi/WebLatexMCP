import { access, constants, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { execCapture } from '../lib/exec.js';
import { COMPILER_KINDS } from './compilerResolver.js';
import type { CompilerKind } from '../types.js';

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
type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ status: number }>;

export class DoctorService {
  private readonly run: Runner;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;
  private readonly canWrite: (target: string) => Promise<boolean>;

  constructor(
    deps: {
      run?: Runner;
      fetch?: FetchLike;
      now?: () => Date;
      /** Injectable so tests decide what is writable — the real answer varies by OS and machine. */
      canWrite?: (target: string) => Promise<boolean>;
    } = {},
  ) {
    this.run = deps.run ?? execCapture;
    this.fetchImpl = deps.fetch ?? ((url, init) => fetch(url, init));
    this.now = deps.now ?? (() => new Date());
    this.canWrite = deps.canWrite ?? isWritablePath;
  }

  async diagnose(opts: DoctorOptions): Promise<Diagnosis> {
    const checks: DoctorCheck[] = [];
    const hints: string[] = [];

    // Independent probes, so pay for the slowest rather than the sum.
    const [compiler, engineVersions, tlmgr, texmfHome, texmfLocal, git] = await Promise.all([
      this.version(opts.compiler, [versionFlag(opts.compiler)]),
      Promise.all(ENGINES.map((e) => this.version(e, ['--version']))),
      this.version('tlmgr', ['--version']),
      this.kpsewhich('TEXMFHOME'),
      this.kpsewhich('TEXMFLOCAL'),
      this.version('git', ['--version']),
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
    if (compiler) {
      effectiveAvailable = true;
      checks.push({ name: 'compiler', status: 'ok', detail: `${opts.compiler}: ${compiler}` });
    } else {
      const other = otherCompiler(opts.compiler);
      const otherVersion = other ? await this.version(other, [versionFlag(other)]) : undefined;
      const caveat = other === 'tectonic' ? ` ${TECTONIC_CAVEAT}` : '';
      if (other === undefined || otherVersion === undefined) {
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
    const banner = engineVersions.find(Boolean);
    const distribution = banner ? describeDistribution(banner) : undefined;
    const year = banner ? distributionYear(banner) : undefined;
    const currentYear = this.now().getFullYear();
    // TeX Live goes to the historic archive about a year after release, so one year back is normal.
    const endOfLife = year !== undefined && year < currentYear - 1;
    if (distribution) {
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
    const homeWritable = texmfHome ? await this.canWrite(texmfHome) : false;
    if (texmfHome) {
      checks.push({
        name: 'texmf-home',
        status: homeWritable ? 'ok' : 'warn',
        detail: `${texmfHome}${homeWritable ? ' (writable)' : ' (not writable)'}`,
      });
    }
    if (texmfLocal) {
      const localWritable = await this.canWrite(texmfLocal);
      checks.push({
        name: 'system-texmf',
        status: 'ok', // not writable is the normal, safe state — never a problem in itself
        detail: `${texmfLocal}${localWritable ? ' (writable)' : ' (not writable — needs root)'}`,
      });
      if (!localWritable && homeWritable && tlmgr) {
        hints.push(
          'The system texmf tree needs root, so install packages into your own tree instead: ' +
            '`tlmgr --usermode init-usertree` once, then `tlmgr --usermode install <package>`.',
        );
      }
    }

    // 7. git, which every sync, commit and push shells out to.
    checks.push(
      git
        ? { name: 'git', status: 'ok', detail: git }
        : { name: 'git', status: 'fail', detail: 'git not found on PATH' },
    );
    if (!git) hints.push('git is not on PATH — cloning, syncing and pushing cannot work.');

    // 8. The workspace itself: clones and build artifacts have to land somewhere.
    if (opts.workspaceRoot) {
      const ok = await this.canWrite(opts.workspaceRoot);
      checks.push({
        name: 'workspace',
        status: ok ? 'ok' : 'fail',
        detail: `${opts.workspaceRoot}${ok ? ' (writable)' : ' (not writable)'}`,
      });
      if (!ok) {
        hints.push(
          `The workspace root (${opts.workspaceRoot}) is not writable — set ` +
            'WEB_LATEX_MCP_WORKSPACE to a directory you own.',
        );
      }
    }

    return { ok: checks.every((c) => c.status !== 'fail'), checks, engines, hints };
  }

  /** First line of `cmd --version`, or undefined when the binary is not on PATH. */
  private async version(cmd: string, args: string[]): Promise<string | undefined> {
    try {
      const res = await this.run(cmd, args, { timeoutMs: PROBE_TIMEOUT_MS });
      const out = `${res.stdout}\n${res.stderr}`
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.length > 0);
      return out ?? cmd;
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
