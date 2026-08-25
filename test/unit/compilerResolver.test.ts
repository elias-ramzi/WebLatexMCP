import { describe, it, expect } from 'vitest';
import {
  CompilerResolver,
  MissingCompilerError,
  COMPILER_KINDS,
  missingMessage,
} from '../../src/services/compilerResolver.js';
import type { LatexCompiler } from '../../src/services/compiler.js';
import type { CompilerKind } from '../../src/types.js';

/** Which backends the scripted PATH has. */
type Availability = Partial<Record<CompilerKind, boolean>>;

/**
 * Backends whose probe *fails* rather than answering — a spawn error that is not "the binary is
 * absent" (EACCES, EAGAIN, EMFILE). Distinct from `Availability: false`, which is the honest "not
 * installed" answer that licenses a substitution.
 */
type ProbeFailures = Partial<Record<CompilerKind, Error>>;

interface Scripted {
  make: (kind: CompilerKind) => LatexCompiler;
  /** How many times `isAvailable` was asked, per kind — for the memoization assertions. */
  probes: Record<CompilerKind, number>;
}

/**
 * A `make` returning stubs whose availability is scripted and whose `compile` throws: `select`
 * must never run a compile, only probe. No temp dirs and no TeX are involved.
 */
function scripted(available: Availability, failures: ProbeFailures = {}): Scripted {
  const probes: Record<CompilerKind, number> = { latexmk: 0, tectonic: 0 };
  const make = (kind: CompilerKind): LatexCompiler => ({
    isAvailable: () => {
      probes[kind]++;
      const failure = failures[kind];
      if (failure) return Promise.reject(failure);
      return Promise.resolve(available[kind] ?? false);
    },
    compile: () => {
      throw new Error(`compile must not be called during select (${kind})`);
    },
  });
  return { make, probes };
}

describe('COMPILER_KINDS', () => {
  it('lists every backend, latexmk first (the fallback order)', () => {
    expect(COMPILER_KINDS).toEqual(['latexmk', 'tectonic']);
  });
});

describe('CompilerResolver.select — the configured backend is there', () => {
  it('selects it, with no fallbackFrom and no note', async () => {
    const { make } = scripted({ latexmk: true });
    const sel = await new CompilerResolver('latexmk', false, make).select();
    expect(sel.kind).toBe('latexmk');
    expect(sel.fallbackFrom).toBeUndefined();
    expect(sel.note).toBeUndefined();
  });
});

describe('CompilerResolver.select — an unchosen default may be substituted', () => {
  it('falls back to tectonic and reports the substitution with its caveats', async () => {
    const { make } = scripted({ tectonic: true });
    const sel = await new CompilerResolver('latexmk', false, make).select();
    expect(sel.kind).toBe('tectonic');
    expect(sel.fallbackFrom).toBe('latexmk');
    expect(sel.note).toBeDefined();
    const note = sel.note ?? '';
    expect(note).toContain('WEB_LATEX_MCP_COMPILER');
    expect(note).toContain('tectonic');
    // "unset" is only one of the three states that leave the backend unchosen: '' and '   ' are
    // set-but-naming-nothing, and a user with WEB_LATEX_MCP_COMPILER="  " told the variable "is
    // unset" never looks at it. Say what is true of all three.
    expect(note).toContain('WEB_LATEX_MCP_COMPILER names no backend');
    expect(note).not.toContain('is unset');
    // The substitution silently changes what a compile can report — say so.
    expect(note).toContain('no source snippets');
    expect(note).toContain('XeTeX');
  });

  it('falls back the other way too, without the tectonic caveats', async () => {
    const { make } = scripted({ latexmk: true });
    const sel = await new CompilerResolver('tectonic', false, make).select();
    expect(sel.kind).toBe('latexmk');
    expect(sel.fallbackFrom).toBe('tectonic');
    const note = sel.note ?? '';
    expect(note).toContain('WEB_LATEX_MCP_COMPILER');
    expect(note).not.toContain('XeTeX');
    expect(note).not.toContain('no source snippets');
  });
});

describe('CompilerResolver.select — an assertion is never substituted', () => {
  it('throws instead of falling back when WEB_LATEX_MCP_COMPILER named the missing backend', async () => {
    // Identical to the fallback case above but for `explicit`, which is the whole guard.
    const { make } = scripted({ tectonic: true });
    const resolver = new CompilerResolver('latexmk', true, make);
    const err = await resolver.select().then(
      (sel) => sel,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MissingCompilerError);
    const message = (err as MissingCompilerError).message;
    expect(message).toContain('latexmk is not on PATH');
    expect(message).toContain('tectonic is installed');
    expect(message).toContain('compiler: "tectonic"');
    expect(message).toContain('WEB_LATEX_MCP_COMPILER');
    // Setting the variable makes a backend a *choice*, and a choice is exactly what is never
    // substituted — calling that "the default" teaches the opposite of what the next missing
    // backend will do.
    expect(message).toContain('to select it for every compile');
    expect(message).not.toContain('make it the default');
    await expect(resolver.select()).rejects.toThrow(MissingCompilerError);
  });

  it('throws for a per-call request even when the configured backend was only a default', async () => {
    // explicit: false licenses substituting the *default*, never a backend the call asked for.
    const { make } = scripted({ tectonic: true });
    const resolver = new CompilerResolver('latexmk', false, make);
    await expect(resolver.select('latexmk')).rejects.toBeInstanceOf(MissingCompilerError);
    await expect(resolver.select('latexmk')).rejects.toThrow(
      /compiler: "latexmk" was requested, but latexmk is not on PATH/,
    );
  });

  it('selects an explicitly requested backend with no note, even when both are present', async () => {
    const { make } = scripted({ latexmk: true, tectonic: true });
    const sel = await new CompilerResolver('latexmk', false, make).select('tectonic');
    expect(sel.kind).toBe('tectonic');
    expect(sel.fallbackFrom).toBeUndefined();
    expect(sel.note).toBeUndefined();
  });
});

describe('CompilerResolver.select — nothing installed', () => {
  it('throws naming both backends and doctor, and claims nothing is installed', async () => {
    const { make } = scripted({});
    const resolver = new CompilerResolver('latexmk', false, make);
    const err = await resolver.select().then(
      (sel) => sel,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MissingCompilerError);
    const failure = err as MissingCompilerError;
    expect(failure.installed).toEqual([]);
    expect(failure.missing).toBe('latexmk');
    expect(failure.message).toContain('latexmk');
    expect(failure.message).toContain('tectonic');
    expect(failure.message).toContain('doctor');
    expect(failure.message).not.toContain('is installed');
    expect(failure.message).not.toContain('are installed');
  });
});

describe('MissingCompilerError payload', () => {
  it('carries the missing backend and exactly the installed ones', async () => {
    const { make } = scripted({ latexmk: true });
    const resolver = new CompilerResolver('tectonic', true, make);
    const err = await resolver.select().then(
      (sel) => sel,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MissingCompilerError);
    const failure = err as MissingCompilerError;
    expect(failure.missing).toBe('tectonic');
    expect(failure.installed).toEqual(['latexmk']);
  });
});

describe('missingMessage — each reason says something true of itself', () => {
  // Driven directly rather than through `select()`: the 'default' reason is thrown only after the
  // fallback loop found nothing, so `installed` is always [] there and the message never reaches
  // this tail today. The branch exists so the text cannot become a lie if that ever changes.
  it('does not claim WEB_LATEX_MCP_COMPILER named anything when nobody chose the backend', () => {
    const message = missingMessage('latexmk', ['tectonic'], 'default');
    expect(message).not.toContain('explicitly');
    expect(message).toContain('latexmk is not on PATH');
  });

  it('still says "explicitly" when the env var really did name it', () => {
    expect(missingMessage('latexmk', ['tectonic'], 'explicit')).toContain(
      'WEB_LATEX_MCP_COMPILER names latexmk explicitly',
    );
  });

  it('calls a per-call compiler an assertion', () => {
    expect(missingMessage('latexmk', ['tectonic'], 'requested')).toContain(
      'A per-call compiler is an assertion',
    );
  });
});

describe('CompilerResolver.select — a probe that fails is not an absent backend', () => {
  it('propagates a non-ENOENT spawn failure instead of silently switching engines', async () => {
    // Under fork pressure a healthy latexmk machine can get EAGAIN. Reading that as "not
    // installed" is exactly the silent substitution this whole resolver exists to prevent —
    // and switching to tectonic silently drops every source snippet.
    const eagain = Object.assign(new Error('spawn latexmk EAGAIN'), { code: 'EAGAIN' });
    const { make } = scripted({ tectonic: true }, { latexmk: eagain });
    const resolver = new CompilerResolver('latexmk', false, make);

    const outcome = await resolver.select().then(
      (sel) => ({ selected: sel.kind }),
      (err: unknown) => ({ thrown: err }),
    );
    expect(outcome).toEqual({ thrown: eagain });
    // The core of the finding: it must not have come back having picked the other backend.
    expect(outcome).not.toHaveProperty('selected');
  });

  it('still substitutes when the probe answers false — that is the honest "not installed"', async () => {
    const { make } = scripted({ tectonic: true });
    const sel = await new CompilerResolver('latexmk', false, make).select();
    expect(sel.kind).toBe('tectonic');
    expect(sel.fallbackFrom).toBe('latexmk');
  });
});

describe('CompilerResolver availability memoization', () => {
  it('probes a present backend once and re-probes a missing one every call', async () => {
    const present = scripted({ latexmk: true });
    const resolver = new CompilerResolver('latexmk', true, present.make);
    await resolver.select();
    await resolver.select();
    // A binary on PATH does not vanish mid-session: ask once.
    expect(present.probes.latexmk).toBe(1);

    const absent = scripted({});
    const failing = new CompilerResolver('latexmk', false, absent.make);
    await expect(failing.select()).rejects.toBeInstanceOf(MissingCompilerError);
    await expect(failing.select()).rejects.toBeInstanceOf(MissingCompilerError);
    // A missing one may be installed part-way through the session: ask again, every time.
    expect(absent.probes.latexmk).toBe(2);
    // ...and each call still asks each kind at most once, failure path included.
    expect(absent.probes.tectonic).toBe(2);
  });
});
