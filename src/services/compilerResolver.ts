import { createCompiler } from './compiler.js';
import type { LatexCompiler } from './compiler.js';
import type { CompilerKind } from '../types.js';

/** Every backend `createCompiler` can build, in the order a fallback tries them. */
export const COMPILER_KINDS: readonly CompilerKind[] = ['latexmk', 'tectonic'];

export interface CompilerSelection {
  /** The backend that will actually run. */
  kind: CompilerKind;
  compiler: LatexCompiler;
  /** The configured backend this substitutes for — set ONLY on a fallback. */
  fallbackFrom?: CompilerKind;
  /** Why the substitution happened, for the compile result's hints. Set iff `fallbackFrom` is. */
  note?: string;
}

/** Thrown when no backend the caller may have can be found on PATH. */
export class MissingCompilerError extends Error {
  readonly missing: CompilerKind;
  readonly installed: readonly CompilerKind[];

  constructor(missing: CompilerKind, installed: readonly CompilerKind[], message: string) {
    super(message);
    this.name = 'MissingCompilerError';
    this.missing = missing;
    this.installed = installed;
  }
}

/**
 * What is surprising about tectonic once it is actually the backend. Every one of these is a
 * silent behaviour change rather than an error, so a message that offers tectonic — as a
 * substitute or as a retry — has to say them outright:
 * XeTeX-only (so `engine` is ignored), all passes rerun internally (so `clean` does nothing),
 * and no `-file-line-error` (so no diagnostic carries a file:line, and errors get no snippets).
 */
const TECTONIC_CAVEAT =
  'tectonic is XeTeX-only: `engine` is ignored and `clean` is a no-op, and its log carries no ' +
  'file:line, so errors carry no source snippets.';

/** The caveat sentence for a backend, or '' when it has none. Only tectonic does. */
function caveatFor(kind: CompilerKind): string {
  return kind === 'tectonic' ? TECTONIC_CAVEAT : '';
}

/** "latexmk", "latexmk nor tectonic" — for prose listing the backends that are *not* there. */
function joinNor(kinds: readonly CompilerKind[]): string {
  return kinds.join(' nor ');
}

/** "tectonic is", "latexmk and tectonic are" — for prose listing what *is* installed. */
function joinIs(kinds: readonly CompilerKind[]): string {
  const list =
    kinds.length > 1
      ? `${kinds.slice(0, -1).join(', ')} and ${kinds.slice(-1).join('')}`
      : kinds.join('');
  return `${list} ${kinds.length > 1 ? 'are' : 'is'} installed`;
}

/** Why a backend was asked for, which decides what the caller can do about it being absent. */
export type MissingReason =
  /** The call passed `compiler: "<kind>"`. Always an assertion; never substituted. */
  | 'requested'
  /** WEB_LATEX_MCP_COMPILER named it. Also an assertion; never substituted. */
  | 'explicit'
  /** Nobody chose it — it is the default, and a fallback was tried and found nothing. */
  | 'default';

/**
 * The message for a backend that is not on PATH. It names the missing backend, exactly which
 * backends are installed (and never claims one is when none is), the per-call `compiler` retry,
 * the `WEB_LATEX_MCP_COMPILER` env var, and — when nothing at all is installed — the `doctor`
 * tool. This text is the whole product of this module: it is what a model reads instead of a raw
 * `spawn latexmk ENOENT`.
 *
 * Exported for its own unit test: the 'default' reason cannot reach the `tail` below through
 * `select()` (see the throw site), so the only way to pin what it says is to call this directly.
 */
export function missingMessage(
  missing: CompilerKind,
  installed: readonly CompilerKind[],
  reason: MissingReason,
): string {
  const opening =
    reason === 'requested'
      ? `compiler: "${missing}" was requested, but ${missing} is not on PATH`
      : `${missing} is not on PATH`;

  const alt = installed[0];
  if (alt === undefined) {
    const others = COMPILER_KINDS.filter((k) => k !== missing);
    return (
      `${opening}, and neither is ${joinNor(others)} — no backend can build a document. ` +
      'Install a TeX distribution (TeX Live: https://tug.org/texlive, MiKTeX: ' +
      'https://miktex.org) or tectonic (https://tectonic-typesetting.github.io) and make sure ' +
      'it is on PATH. Run the doctor tool for a full toolchain report.'
    );
  }

  // One tail per reason, and never one reason's tail under another's: 'default' means nobody
  // chose anything, so it must not tell a user who set nothing that the env var "names it
  // explicitly". (That branch is unreachable today — see the 'default' throw site — which is
  // exactly why the text has to be right by construction rather than by that argument holding.)
  const tail =
    reason === 'requested'
      ? 'A per-call compiler is an assertion, so it is never substituted for you.'
      : reason === 'explicit'
        ? `WEB_LATEX_MCP_COMPILER names ${missing} explicitly, and an explicit choice is never ` +
          'substituted, so nothing was picked for you.'
        : `${missing} was only the default, and nothing was substituted for it automatically.`;
  const caveat = caveatFor(alt);
  return [
    `${opening}. ${joinIs(installed)} — retry this call with compiler: "${alt}", or set ` +
      `WEB_LATEX_MCP_COMPILER=${alt} to select it for every compile.`,
    caveat,
    tail,
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * The `note` on a fallback: the configured backend was only a default, so the substitution is
 * allowed — but it still has to be reported, along with anything the substitute does differently.
 */
function fallbackNote(from: CompilerKind, to: CompilerKind): string {
  const caveat = caveatFor(to);
  return [
    // "names no backend", not "is unset": unset, '' and whitespace-only all land here (see
    // `parseCompilerChoice`), and telling a user whose config says WEB_LATEX_MCP_COMPILER="  "
    // that it is unset sends them looking anywhere but at the value they actually set.
    `${from} is not on PATH, so this compiled with ${to} instead — WEB_LATEX_MCP_COMPILER names ` +
      `no backend, so ${from} was only the default.`,
    caveat,
    'Set WEB_LATEX_MCP_COMPILER to choose a backend explicitly — an explicit choice is never ' +
      'substituted.',
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Picks the compile backend that will actually run, and explains itself when it cannot.
 *
 * The policy, which mirrors how the rest of this server treats a user's word: an *unchosen*
 * default may be substituted, an *assertion* never may. So `WEB_LATEX_MCP_COMPILER` unset leaves
 * latexmk as a mere default — if it is missing and the other backend is there, the other one runs
 * and the substitution is reported. `WEB_LATEX_MCP_COMPILER` set (to anything, latexmk included)
 * and a per-call `requested` backend are both assertions: a missing one throws with a message
 * naming what to do, rather than quietly compiling with something else.
 *
 * Does no filesystem work, takes no lock, and knows nothing about projects.
 */
export class CompilerResolver {
  private readonly compilers = new Map<CompilerKind, LatexCompiler>();
  /**
   * Availability memo. Only *positive* results are stored, deliberately: a binary on PATH will
   * not vanish mid-session, but one that is absent may well be installed part-way through it —
   * and caching a negative would also freeze the failure path into repeating a stale claim about
   * what is installed. So a "yes" is asked once and a "no" is asked every time.
   */
  private readonly present = new Set<CompilerKind>();

  constructor(
    private readonly configured: CompilerKind,
    /** True when WEB_LATEX_MCP_COMPILER named it. False means `configured` is only a default. */
    private readonly explicit: boolean,
    private readonly make: (kind: CompilerKind) => LatexCompiler = createCompiler,
  ) {}

  /** The backend instance, built at most once per kind (they are stateless, but keep it clean). */
  private compilerFor(kind: CompilerKind): LatexCompiler {
    let compiler = this.compilers.get(kind);
    if (!compiler) {
      compiler = this.make(kind);
      this.compilers.set(kind, compiler);
    }
    return compiler;
  }

  /**
   * Resolve the backend to run. `requested` is a per-call assertion and is never substituted;
   * neither is `configured` when `explicit`. Throws {@link MissingCompilerError} otherwise.
   */
  async select(requested?: CompilerKind): Promise<CompilerSelection> {
    // Per-call view over the positive memo, so one `select` probes each kind at most once even
    // on the failure path (which asks again to report what *is* installed).
    const seen = new Map<CompilerKind, boolean>();
    const available = async (kind: CompilerKind): Promise<boolean> => {
      const perCall = seen.get(kind);
      if (perCall !== undefined) return perCall;
      if (this.present.has(kind)) return true;
      const ok = await this.compilerFor(kind).isAvailable();
      if (ok) this.present.add(kind);
      seen.set(kind, ok);
      return ok;
    };
    const installedBesides = async (missing: CompilerKind): Promise<CompilerKind[]> => {
      const found: CompilerKind[] = [];
      for (const kind of COMPILER_KINDS) {
        if (kind === missing) continue;
        if (await available(kind)) found.push(kind);
      }
      return found;
    };

    if (requested !== undefined) {
      if (await available(requested)) {
        return { kind: requested, compiler: this.compilerFor(requested) };
      }
      const installed = await installedBesides(requested);
      throw new MissingCompilerError(
        requested,
        installed,
        missingMessage(requested, installed, 'requested'),
      );
    }

    if (await available(this.configured)) {
      return { kind: this.configured, compiler: this.compilerFor(this.configured) };
    }

    if (this.explicit) {
      const installed = await installedBesides(this.configured);
      throw new MissingCompilerError(
        this.configured,
        installed,
        missingMessage(this.configured, installed, 'explicit'),
      );
    }

    // An unchosen default may be substituted: take the first other backend that is there.
    const installed = await installedBesides(this.configured);
    const alt = installed[0];
    if (alt !== undefined) {
      return {
        kind: alt,
        compiler: this.compilerFor(alt),
        fallbackFrom: this.configured,
        note: fallbackNote(this.configured, alt),
      };
    }
    // `installed` is provably `[]` here: `alt` is `installed[0]`, and the branch above returned
    // whenever that was defined — so reaching this line means the fallback loop found nothing.
    // That is why `missingMessage` takes its "nothing at all is installed" route and its
    // 'default' tail is unreachable *today*. Both facts are load-bearing; if a future filter
    // (a denylist, a per-project pin, a backend excluded from fallback) ever lets a non-empty
    // `installed` reach here, only the tail changes — it is already honest for that case.
    throw new MissingCompilerError(
      this.configured,
      installed,
      missingMessage(this.configured, installed, 'default'),
    );
  }
}
