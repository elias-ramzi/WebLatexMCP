import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

/**
 * A tier over `.claude/workflows/*.js`.
 *
 * Those scripts commit and push unattended, and until this file existed the only automated
 * statement CI made about them was that prettier liked their whitespace: eslint ignored
 * `.claude/**`, tsc never saw them, and nothing imported them. The ignore is what #81 narrowed,
 * and `eslint.config.js reach` below is what keeps it narrowed. A Workflow script is not
 * importable — it has a top-level `return`, a SyntaxError in an ES module — so the host wraps
 * the body in an async function and injects its globals. This file does the same, which is what
 * lets the guards be executed rather than merely read.
 */

// ---------------------------------------------------------------------------
// Helpers under test (each has its own coverage in the last describe block).
// ---------------------------------------------------------------------------

/**
 * Make a Workflow script body executable inside `new AsyncFunction(...)`.
 *
 * Only the DECLARATION HEAD is rewritten — no brace matching, because `meta` contains braces
 * inside its own strings. `var meta = __out.meta =` keeps `meta` in scope for the rest of the
 * body and publishes it on `__out` as the very first statement, so it is captured even when the
 * body later throws (which is most of the scenarios below).
 */
function wrapWorkflowSource(src: string): string {
  const declaration = /^export\s+const\s+meta\s*=/m;
  if (!declaration.test(src)) {
    throw new Error(
      'workflow source has no top-level `export const meta =` declaration — refusing to wrap it, ' +
        'because a no-op replacement would leave every meta assertion below vacuously green',
    );
  }
  return src.replace(declaration, 'var meta = __out.meta =');
}

/** Phase titles the BODY actually uses: `phase('X')` and `{ phase: 'X' }` in agent opts. */
function phasesUsedInSource(src: string): string[] {
  const patterns = [
    /(?<![.\w$])phase\(\s*(['"`])([^'"`]*)\1\s*\)/g,
    /(?<![.\w$])phase:\s*(['"`])([^'"`]*)\1/g,
  ];
  const found = new Set<string>();
  for (const pattern of patterns) {
    for (const match of src.matchAll(pattern)) {
      const title = match[2];
      if (title !== undefined) found.add(title);
    }
  }
  return [...found].sort();
}

/** Human-readable problems with a script's `meta`; empty means well-formed. */
function validateMeta(meta: unknown): string[] {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    return [`meta is not a non-null plain object (got ${describeValue(meta)})`];
  }
  const record = meta as Record<string, unknown>;
  const problems: string[] = [];
  if (typeof record.name !== 'string' || record.name.trim() === '') {
    problems.push(`meta.name must be a non-empty string (got ${describeValue(record.name)})`);
  }
  if (typeof record.description !== 'string' || record.description.trim() === '') {
    problems.push(
      `meta.description must be a non-empty string (got ${describeValue(record.description)})`,
    );
  }
  const phases = record.phases;
  if (!Array.isArray(phases) || phases.length === 0) {
    problems.push(`meta.phases must be a non-empty array (got ${describeValue(phases)})`);
    return problems;
  }
  const titles: string[] = [];
  phases.forEach((phase, index) => {
    if (typeof phase !== 'object' || phase === null || Array.isArray(phase)) {
      problems.push(`meta.phases[${index}] is not a non-null object (got ${describeValue(phase)})`);
      return;
    }
    const entry = phase as Record<string, unknown>;
    if (typeof entry.title !== 'string' || entry.title.trim() === '') {
      problems.push(
        `meta.phases[${index}].title must be a non-empty string (got ${describeValue(entry.title)})`,
      );
    } else {
      titles.push(entry.title);
    }
    for (const optional of ['detail', 'model'] as const) {
      if (optional in entry && (typeof entry[optional] !== 'string' || entry[optional] === '')) {
        problems.push(
          `meta.phases[${index}].${optional}, when present, must be a non-empty string ` +
            `(got ${describeValue(entry[optional])})`,
        );
      }
    }
  });
  const duplicates = [...new Set(titles.filter((t, i) => titles.indexOf(t) !== i))];
  if (duplicates.length > 0) {
    problems.push(`meta.phases has duplicate titles: ${duplicates.join(', ')}`);
  }
  return problems;
}

function comparePhases(
  declared: string[],
  used: string[],
): { declaredNotUsed: string[]; usedNotDeclared: string[] } {
  const declaredSet = new Set(declared);
  const usedSet = new Set(used);
  return {
    declaredNotUsed: [...declaredSet].filter((t) => !usedSet.has(t)).sort(),
    usedNotDeclared: [...usedSet].filter((t) => !declaredSet.has(t)).sort(),
  };
}

function describeValue(value: unknown): string {
  if (typeof value === 'function') return 'a function';
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

// ---------------------------------------------------------------------------
// The harness: execute a script body against stubbed globals.
// ---------------------------------------------------------------------------

interface AgentCall {
  prompt: string;
  opts: Record<string, unknown>;
}

interface RunOutcome {
  meta: unknown;
  result: unknown;
  error: unknown;
  calls: AgentCall[];
  phases: string[];
  logs: string[];
}

interface WorkflowOut {
  meta?: unknown;
}

type WorkflowBody = (
  args: unknown,
  agent: (prompt: unknown, opts: unknown) => Promise<unknown>,
  phase: (title: unknown) => void,
  log: (message: unknown) => void,
  parallel: () => never,
  pipeline: () => never,
  workflow: unknown,
  budget: unknown,
  out: WorkflowOut,
) => Promise<unknown>;

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...parts: string[]
) => WorkflowBody;

type Responder = (call: AgentCall) => unknown;

function notStubbed(name: string): () => never {
  return () => {
    throw new Error(`${name}() is not stubbed in this harness`);
  };
}

/** Never rejects: a throw from the body (or from `respond`) comes back as `outcome.error`. */
async function runScript(src: string, args: unknown, respond: Responder): Promise<RunOutcome> {
  const body = wrapWorkflowSource(src);
  const fn = new AsyncFunction(
    'args',
    'agent',
    'phase',
    'log',
    'parallel',
    'pipeline',
    'workflow',
    'budget',
    '__out',
    body,
  );
  const calls: AgentCall[] = [];
  const phases: string[] = [];
  const logs: string[] = [];
  const out: WorkflowOut = {};
  let result: unknown;
  let error: unknown;
  try {
    result = await fn(
      args,
      (prompt, opts) => {
        const call: AgentCall = {
          prompt: String(prompt),
          opts: typeof opts === 'object' && opts !== null ? (opts as Record<string, unknown>) : {},
        };
        calls.push(call);
        return Promise.resolve(respond(call));
      },
      (title) => {
        phases.push(String(title));
      },
      (message) => {
        logs.push(String(message));
      },
      notStubbed('parallel'),
      notStubbed('pipeline'),
      undefined,
      undefined,
      out,
    );
  } catch (err) {
    error = err;
  }
  return { meta: out.meta, result, error, calls, phases, logs };
}

// ---------------------------------------------------------------------------
// Discovery. Separator-agnostic: CI runs ubuntu + windows + macos.
// ---------------------------------------------------------------------------

// Discovery is deliberately FLAT — the Workflow tool reads scripts straight out of this
// directory, so a `.js` in a subdirectory of it is not a workflow script. Note that
// eslint.config.js scopes its lint block to `**/*.js` here and so is one level wider: a file
// under `.claude/workflows/sub/` would be linted but is not loaded, meta-checked or executed by
// this tier. Both halves are right for their own reason; the asymmetry is known, not an oversight.
const workflowsDir = fileURLToPath(new URL('../../.claude/workflows/', import.meta.url));
const scriptNames = readdirSync(workflowsDir)
  .filter((name) => name.endsWith('.js'))
  .sort();
const sources = new Map<string, string>(
  scriptNames.map((name) => [name, readFileSync(path.join(workflowsDir, name), 'utf8')]),
);

const REVIEW_ROUND = 'review-round.js';

function sourceOf(name: string): string {
  const src = sources.get(name);
  if (src === undefined) throw new Error(`no workflow script named ${name} under ${workflowsDir}`);
  return src;
}

async function loadMeta(src: string): Promise<unknown> {
  // The meta is published by the first statement of the wrapped body, so it survives whatever
  // the rest of the script does — no agent needs to be stubbed to read it.
  const outcome = await runScript(src, {}, () => {
    throw new Error('meta-only run: no agent is stubbed');
  });
  return outcome.meta;
}

function metaPhaseTitles(meta: unknown): string[] {
  const record = meta as { phases?: { title?: unknown }[] };
  const phases = record.phases ?? [];
  return phases.map((p) => String(p.title));
}

// ---------------------------------------------------------------------------
// Assertion helpers (tsconfig has noUncheckedIndexedAccess, so nothing is index-asserted).
// ---------------------------------------------------------------------------

function labelOf(call: AgentCall): string {
  return typeof call.opts.label === 'string' ? call.opts.label : '';
}

/** `impl:b1#1` -> `impl`, `verify:b1#2` -> `verify`, everything else is its own key. */
function labelKey(label: string): string {
  if (label.startsWith('impl:')) return 'impl';
  if (label.startsWith('verify:')) return 'verify';
  return label;
}

function labelsOf(outcome: RunOutcome): string[] {
  return outcome.calls.map(labelOf);
}

function callsFor(outcome: RunOutcome, key: string): AgentCall[] {
  return outcome.calls.filter((call) => labelKey(labelOf(call)) === key);
}

function oneCallFor(outcome: RunOutcome, key: string): AgentCall {
  const matches = callsFor(outcome, key);
  const [first] = matches;
  if (matches.length !== 1 || first === undefined) {
    throw new Error(
      `expected exactly one ${key} agent call, saw ${matches.length} (labels: ${labelsOf(outcome).join(', ') || 'none'})`,
    );
  }
  return first;
}

function errorText(outcome: RunOutcome): string | undefined {
  if (outcome.error === undefined) return undefined;
  return outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
}

function expectThrown(outcome: RunOutcome): string {
  const message = errorText(outcome);
  if (message === undefined) {
    throw new Error(
      `expected the run to throw, but it returned ${describeValue(outcome.result)} (labels: ${labelsOf(outcome).join(', ') || 'none'})`,
    );
  }
  return message;
}

function expectCompleted(outcome: RunOutcome): Record<string, unknown> {
  expect(errorText(outcome)).toBeUndefined();
  const result = outcome.result;
  if (typeof result !== 'object' || result === null) {
    throw new Error(`expected an object result, got ${describeValue(result)}`);
  }
  return result as Record<string, unknown>;
}

function batchResults(outcome: RunOutcome): Record<string, unknown>[] {
  const batches = expectCompleted(outcome).batches;
  if (!Array.isArray(batches)) {
    throw new Error(`expected result.batches to be an array, got ${describeValue(batches)}`);
  }
  return batches.map((batch, index) => {
    if (typeof batch !== 'object' || batch === null) {
      throw new Error(`result.batches[${index}] is not an object: ${describeValue(batch)}`);
    }
    return batch as Record<string, unknown>;
  });
}

function onlyBatch(outcome: RunOutcome): Record<string, unknown> {
  const batches = batchResults(outcome);
  const [first] = batches;
  if (batches.length !== 1 || first === undefined) {
    throw new Error(`expected exactly one batch result, got ${batches.length}`);
  }
  return first;
}

// ---------------------------------------------------------------------------
// Stubbed agent answers for review-round.js, keyed on opts.label.
// ---------------------------------------------------------------------------

type ResponderKey =
  | 'preflight'
  | 'review'
  | 'plan'
  | 'impl'
  | 'verify'
  // A bare, constant label, so `labelKey` needs no branch for it — unlike `impl:`/`verify:`,
  // which carry a batch name and an attempt number. The tail audit runs exactly once.
  | 'tail-audit'
  | 'sign-off';
type ResponderMap = Partial<Record<ResponderKey, Responder>>;

function defaultRespond(overrides: ResponderMap = {}): Responder {
  return (call) => {
    const label = labelOf(call);
    const key = labelKey(label);
    const override = overrides[key as ResponderKey];
    if (override) return override(call);
    switch (key) {
      case 'preflight':
        return { current_branch: 'feature/x', head_branch: '', dirty_paths: [] };
      case 'review':
        return 'REVIEW TEXT';
      case 'plan':
        return { shared_context: 'ctx', batches: [{ name: 'b1', spec: 'SPEC ONE' }] };
      case 'impl':
        return {
          files_changed: ['src/a.ts'],
          tests_added: ['t'],
          tests_watched_failing: ['t'],
          gate: 'green',
        };
      case 'verify':
        return { approved: true, feedback: '', boundary_probes: 'probed' };
      case 'tail-audit':
        return { blocking: false, findings: 'none' };
      case 'sign-off':
        return 'SIGNED OFF';
      default:
        // An unknown label must fail loudly: a silent `undefined` reads to the script as
        // "the agent returned nothing", which is a guard path, not a stub.
        throw new Error(`no stub for agent label ${JSON.stringify(label)}`);
    }
  };
}

/** A preflight answer with the defaults patched — the free-text self-report the guards consume. */
function preflightReporting(patch: Record<string, unknown>): Responder {
  return () => ({ current_branch: 'feature/x', head_branch: '', dirty_paths: [], ...patch });
}

async function runRound(args: unknown = {}, overrides: ResponderMap = {}): Promise<RunOutcome> {
  return runScript(sourceOf(REVIEW_ROUND), args, defaultRespond(overrides));
}

// ---------------------------------------------------------------------------
// 1. Discovery is not vacuous.
// ---------------------------------------------------------------------------

describe('.claude/workflows discovery', () => {
  it('finds at least one script, including review-round.js', () => {
    expect(scriptNames.length).toBeGreaterThan(0);
    // Without this, emptying or renaming the directory would make every describe.each below
    // expand to zero tests and the whole tier would go green over nothing.
    expect(scriptNames).toContain(REVIEW_ROUND);
  });
});

// ---------------------------------------------------------------------------
// 1b. What `npm run lint` actually reaches.
//
// #81 narrowed the global ignore from `.claude/**` to `.claude/*` + `!.claude/workflows`, and
// that distinction is one character wide and silent when wrong: in flat config a directory
// ignored with `/**` is skipped WHOLE, and nothing inside it can be unignored afterwards, so
// the obvious-looking `['.claude/**', '!.claude/workflows']` lints nothing at all and every
// test below still passes — this tier reads the scripts off disk itself, it does not run
// eslint. Nothing else in the repo would notice either: a config that lints one file fewer
// goes green.
//
// It is not only a config detail. review-round.js states the reach of `npm run lint` twice in
// prose that is injected into every agent of every round, so a config drift here turns those
// two sentences into instructions to disregard a real signal (or to trust an absent one).
// These assertions are the only thing that ties the two together.
// ---------------------------------------------------------------------------

describe('eslint.config.js reach', () => {
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
  const eslint = new ESLint({ cwd: repoRoot });

  it('lints the workflow scripts', async () => {
    for (const name of scriptNames) {
      const file = path.join(workflowsDir, name);
      expect(await eslint.isPathIgnored(file), `${name} is ignored by eslint`).toBe(false);
    }
  });

  it('still ignores every other child of .claude/', async () => {
    // Paths that need not exist — `isPathIgnored` answers from the config, not the disk, which
    // is the point: it holds for a file a future round adds, not merely for today's tree.
    for (const rel of [
      '.claude/agents/implementer.js',
      '.claude/commands/implement.js',
      '.claude/skills/whatever/helper.js',
      // The hazard the ignore exists for: a nested checkout of this repo, whose own src/ must
      // never be pulled into this one's typed lint.
      '.claude/worktrees/wt-x/src/index.ts',
      '.claude/worktrees/wt-x/eslint.config.js',
    ]) {
      expect(await eslint.isPathIgnored(path.join(repoRoot, rel)), `${rel} is linted`).toBe(true);
    }
  });

  it('gives a workflow script the Workflow globals, and no-undef to use them', async () => {
    // Without these the block is decorative: eslint:recommended's own `no-undef` reports every
    // `agent`/`phase` call in a script as undefined, which buries real findings under 30-odd
    // false ones and is why un-ignoring `.claude/**` wholesale was rejected.
    const config = (await eslint.calculateConfigForFile(path.join(workflowsDir, REVIEW_ROUND))) as {
      languageOptions?: {
        globals?: Record<string, unknown>;
        parserOptions?: Record<string, unknown>;
      };
      rules?: Record<string, unknown>;
    };
    const globals = config.languageOptions?.globals ?? {};
    for (const name of [
      'args',
      'agent',
      'parallel',
      'pipeline',
      'phase',
      'log',
      'workflow',
      'budget',
    ]) {
      expect(globals[name], `global ${name} not declared for a workflow script`).toBe('readonly');
    }
    // A Workflow body's top-level `return` is legal; without this it is a parse error and the
    // file is never linted at all — which reads exactly like a clean lint.
    expect(config.languageOptions?.parserOptions?.allowReturnOutsideFunction).toBe(true);
    const noUndef = config.rules?.['no-undef'];
    expect(Array.isArray(noUndef) ? noUndef[0] : noUndef, 'no-undef is off').not.toBe('off');
    expect(Array.isArray(noUndef) ? noUndef[0] : noUndef).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Generic, directory-driven checks — no script name is hardcoded here.
// ---------------------------------------------------------------------------

describe.each(scriptNames)('workflow script %s', (name) => {
  const src = sourceOf(name);

  it('has a well-formed meta', async () => {
    const meta = await loadMeta(src);
    const problems = validateMeta(meta);
    expect(problems, `meta problems: ${problems.join(' | ')}`).toEqual([]);
  });

  it('names itself after its file', async () => {
    const meta = await loadMeta(src);
    const record = meta as { name?: unknown };
    expect(record.name).toBe(name.replace(/\.js$/, ''));
  });

  it('uses at least one phase', () => {
    // A script that used no phases would match a meta declaring none and pass the
    // cross-check below without either side saying anything.
    expect(phasesUsedInSource(src)).not.toEqual([]);
  });

  it('declares every phase its body uses, and uses every phase it declares', async () => {
    const declared = metaPhaseTitles(await loadMeta(src));
    const used = phasesUsedInSource(src);
    const { declaredNotUsed, usedNotDeclared } = comparePhases(declared, used);
    expect(
      declaredNotUsed,
      `declared in meta but never used by the body: ${declaredNotUsed.join(', ')}`,
    ).toEqual([]);
    expect(
      usedNotDeclared,
      `used by the body but never declared in meta: ${usedNotDeclared.join(', ')}`,
    ).toEqual([]);
  });

  it('passes only declared phase titles to agent()', async () => {
    const declared = new Set(metaPhaseTitles(await loadMeta(src)));
    // The generic stubs only know review-round's labels; for any other script the run stops at
    // its first unknown label. The calls recorded up to that point are still real, and their
    // phases are still checked — the assertion is about what was observed, not about finishing.
    const outcome = await runScript(src, {}, defaultRespond());
    // Without this the loop below iterates zero times and the test passes over nothing — which
    // is not hypothetical for a directory-generic check, since a script that refuses on empty
    // args (review-round.js does, for a dozen arg shapes) reaches no agent call at all. A new
    // script landing here should go RED and be given stubs, not quietly contribute a pass.
    expect(
      outcome.calls.length,
      `${name} made no agent call with args {} — give it stubs in defaultRespond() rather than ` +
        'letting this check pass over zero calls',
    ).toBeGreaterThan(0);
    for (const call of outcome.calls) {
      const phase = call.opts.phase;
      if (phase === undefined) continue;
      expect(declared, `agent call ${labelOf(call)} used phase ${describeValue(phase)}`).toContain(
        String(phase),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 3. review-round.js guard behaviour, executed.
// ---------------------------------------------------------------------------

describe('review-round.js', () => {
  describe('synchronous input validation (before a single agent spawns)', () => {
    it('refuses a review that is not a URL', async () => {
      const outcome = await runRound({ review: 'not-a-url' });
      expect(expectThrown(outcome)).toMatch(/review must be a posted review-comment URL/);
      expect(outcome.calls).toEqual([]);
    });

    it.each([[-1], [1.5], ['2']])('refuses max_attempts %o', async (max_attempts) => {
      const outcome = await runRound({ max_attempts });
      expect(expectThrown(outcome)).toMatch(/max_attempts must be a non-negative integer/);
      expect(outcome.calls).toEqual([]);
    });

    it('accepts max_attempts: 0 as plan-only and implements nothing', async () => {
      // The boundary just outside the refusal: `??` rather than `||` is what keeps 0 meaning 0.
      const outcome = await runRound({ max_attempts: 0 });
      const batch = onlyBatch(outcome);
      expect(callsFor(outcome, 'impl')).toEqual([]);
      expect(callsFor(outcome, 'verify')).toEqual([]);
      expect(batch.approved).toBe(false);
      expect(batch.attempts).toBe(0);
      expect(batch.notes).toBe('never ran');
    });

    it.each([['false'], [0]])('refuses commit: %o', async (commit) => {
      // These are the exact values that previously read as truthy and pushed anyway.
      const outcome = await runRound({ commit });
      expect(expectThrown(outcome)).toMatch(/commit must be a boolean/);
      expect(outcome.calls).toEqual([]);
    });

    it.each([['   '], ['']])('refuses base: %o', async (base) => {
      const outcome = await runRound({ base });
      expect(expectThrown(outcome)).toMatch(/base must be a non-empty string/);
      expect(outcome.calls).toEqual([]);
    });

    it('refuses a fable_model that is neither fable nor opus', async () => {
      const outcome = await runRound({ fable_model: 'sonnet' });
      expect(expectThrown(outcome)).toMatch(/fable_model must be "fable" or "opus"/);
      expect(outcome.calls).toEqual([]);
    });

    // These two assert the `plan` label only, because #81 split the knob: {fable}/{fable_model}
    // governs the PLANNER alone now. The sign-off's own tier is pinned — it is not left
    // unasserted any more — in the `sign-off` block below ('signs off on opus by default'),
    // and the floor that keeps it there is the group of tests immediately after these.
    it('plans on fable by default', async () => {
      const outcome = await runRound();
      expect(oneCallFor(outcome, 'plan').opts.model).toBe('fable');
    });

    it('plans on opus with {fable: false}', async () => {
      const outcome = await runRound({ fable: false });
      expect(oneCallFor(outcome, 'plan').opts.model).toBe('opus');
    });

    it('refuses a committing round whose sign-off runs below the verifier tier', async () => {
      const outcome = await runRound({ signoff_model: 'fable' });
      const message = expectThrown(outcome);
      // The refusal names the tier it is measured against, why the sign-off may not go below
      // it, and both routes out — a reader who only sees this message can act on it.
      expect(message).toMatch(/below the verifier's tier \(opus\)/);
      expect(message).toMatch(/commits and pushes unattended/);
      expect(message).toMatch(/\{commit: false\}/);
      expect(message).toMatch(/signoff_model/);
      // And, like every other input refusal in this script, it fires before an agent spawns.
      expect(outcome.calls).toEqual([]);
    });

    it('refuses the middle rank, sonnet, while committing', async () => {
      // sonnet is the rank that tells a real comparison from an `=== 'opus'` equality check:
      // every other case here passes under either implementation.
      const outcome = await runRound({ signoff_model: 'sonnet' });
      expect(expectThrown(outcome)).toMatch(/below the verifier's tier/);
      expect(outcome.calls).toEqual([]);
    });

    it.each([['fable'], ['sonnet']])(
      'accepts signoff_model %s for a non-committing round, and really runs it there',
      async (signoff_model) => {
        // The boundary just outside the floor: it is scoped to a COMMITTING round, so an
        // advisory one may audit on any ranked tier — and the model really reaches the call.
        const outcome = await runRound({ signoff_model, commit: false });
        expect(oneCallFor(outcome, 'sign-off').opts.model).toBe(signoff_model);
        expect(expectCompleted(outcome).auditor).toBe(signoff_model);
      },
    );

    it('accepts the value at the floor for a committing round', async () => {
      // The boundary just inside: equal to the verifier's tier is allowed, not only above it.
      const outcome = await runRound({ signoff_model: 'opus' });
      expect(oneCallFor(outcome, 'sign-off').opts.model).toBe('opus');
      expect(expectCompleted(outcome).auditor).toBe('opus');
    });

    it.each([['haiku'], ['toString'], [2]])(
      'refuses an unranked signoff_model %o on its own terms',
      async (signoff_model) => {
        // 'toString' is the prototype-chain case: `'toString' in MODEL_TIER` is true, so an
        // `in`-based tierOf would rank it and every other test here would still pass.
        const outcome = await runRound({ signoff_model, commit: false });
        const message = expectThrown(outcome);
        expect(message).toMatch(/signoff_model must be one of fable, sonnet, opus/);
        // Refused as unknown, never absorbed by the floor (`null < 2` is true in JS), and
        // refused even for a round that does not commit, where the floor does not apply.
        expect(message).not.toMatch(/below the verifier's tier/);
        expect(outcome.calls).toEqual([]);
      },
    );

    it.each([[0], [-3], [1.5]])('refuses pr: %o', async (pr) => {
      const outcome = await runRound({ pr });
      expect(expectThrown(outcome)).toMatch(/pr must be a positive integer/);
      expect(outcome.calls).toEqual([]);
    });

    it('refuses a pr: that disagrees with the PR in the review URL', async () => {
      const review = 'https://github.com/o/r/pull/12#issuecomment-1';
      const outcome = await runRound({ review, pr: 13 });
      expect(expectThrown(outcome)).toMatch(/disagrees with the PR in the review URL/);
      expect(outcome.calls).toEqual([]);
    });

    it('accepts a pr: that agrees with the review URL', async () => {
      const review = 'https://github.com/o/r/pull/12#issuecomment-1';
      const outcome = await runRound(
        { review, pr: 12 },
        { preflight: preflightReporting({ head_branch: 'feature/x' }) },
      );
      // The boundary just inside the refusal above: the round runs to completion, and the
      // posted review is used instead of one being produced in-run.
      const result = expectCompleted(outcome);
      expect(result.review).toBe(review);
      expect(callsFor(outcome, 'review')).toEqual([]);
    });

    it.each([['dev'], ['main'], ['master']])('refuses branch: %s', async (branch) => {
      const outcome = await runRound({ branch });
      expect(expectThrown(outcome)).toMatch(/refusing to run against protected branch/);
      expect(outcome.calls).toEqual([]);
    });

    it('refuses an empty branch', async () => {
      const outcome = await runRound({ branch: '' });
      expect(expectThrown(outcome)).toMatch(/branch must be a non-empty string/);
      expect(outcome.calls).toEqual([]);
    });
  });

  describe('preflight assertions fail closed', () => {
    it('refuses when the preflight returns nothing', async () => {
      const outcome = await runRound({}, { preflight: () => null });
      expect(expectThrown(outcome)).toMatch(/refusing to run a fix round blind/);
    });

    it.each([['refs/heads/dev'], ['  dev  ']])(
      'normalizes %o before the protected-branch check',
      async (current_branch) => {
        const outcome = await runRound({}, { preflight: preflightReporting({ current_branch }) });
        expect(expectThrown(outcome)).toMatch(
          /refusing to run a committing round on protected branch dev/,
        );
      },
    );

    it('refuses an unparseable branch name', async () => {
      const outcome = await runRound(
        {},
        { preflight: preflightReporting({ current_branch: 'feature branch' }) },
      );
      expect(expectThrown(outcome)).toMatch(/unparseable/);
    });

    it('refuses a committing round on a detached HEAD', async () => {
      const outcome = await runRound({}, { preflight: preflightReporting({ current_branch: '' }) });
      expect(expectThrown(outcome)).toMatch(/detached HEAD/);
    });

    it('allows a detached HEAD when the round does not commit', async () => {
      // The boundary just outside the refusal above: it is scoped to a committing round.
      const outcome = await runRound(
        { commit: false },
        { preflight: preflightReporting({ current_branch: '' }) },
      );
      expectCompleted(outcome);
      expect(labelsOf(outcome)).toContain('sign-off');
    });

    it('refuses when the PR head branch could not be read', async () => {
      const outcome = await runRound({ pr: 7 }, { preflight: preflightReporting({}) });
      expect(expectThrown(outcome)).toMatch(/could not read the head branch/);
    });

    it('refuses when the checked-out branch is not the PR head branch', async () => {
      const outcome = await runRound(
        { pr: 7 },
        {
          preflight: preflightReporting({
            current_branch: 'feature/x',
            head_branch: 'feature/other',
          }),
        },
      );
      const message = expectThrown(outcome);
      expect(message).toMatch(/would write PR #7's fixes onto the wrong branch/);
    });

    it('refuses when the requested branch is not the one checked out', async () => {
      const outcome = await runRound(
        { branch: 'feature/x' },
        { preflight: preflightReporting({ current_branch: 'feature/y' }) },
      );
      const message = expectThrown(outcome);
      expect(message).toMatch(/was requested but/);
      expect(message).toContain('feature/y');
    });

    it('treats a preflight that reports no dirty_paths field as nothing dirty', async () => {
      // `pre.dirty_paths || []` — the field is a free-text agent's to omit, and reading
      // `undefined.length` here would crash the round after the review had already been paid for.
      const outcome = await runRound(
        {},
        { preflight: () => ({ current_branch: 'feature/x', head_branch: '' }) },
      );
      expect(expectCompleted(outcome).preexisting_dirty).toEqual([]);
      expect(outcome.logs.join('\n')).not.toContain('already modified before this round');
    });

    it("carries a peer's pre-existing dirty paths through to the sign-off", async () => {
      const outcome = await runRound(
        {},
        { preflight: preflightReporting({ dirty_paths: ['peer.ts'] }) },
      );
      const result = expectCompleted(outcome);
      expect(result.preexisting_dirty).toEqual(['peer.ts']);
      expect(outcome.logs.join('\n')).toContain('already modified before this round');
      const prompt = oneCallFor(outcome, 'sign-off').prompt;
      expect(prompt).toContain('must NOT be committed: peer.ts');
      // The claimed list added for #81 finding 3 would otherwise contradict this rule outright
      // when a batch touches a path a peer already had in flight — both lines are rendered, and
      // only this sentence says which one wins.
      expect(prompt).toContain('leave it uncommitted anyway');
    });
  });

  describe('review phase', () => {
    it('refuses when the reviewer returns nothing', async () => {
      const outcome = await runRound({}, { review: () => null });
      expect(expectThrown(outcome)).toMatch(/no round to plan from/);
      expect(callsFor(outcome, 'plan')).toEqual([]);
    });

    it('skips the review phase entirely when a posted review is supplied', async () => {
      const outcome = await runRound(
        { review: 'https://github.com/o/r/pull/12#issuecomment-1', pr: 12 },
        { preflight: preflightReporting({ head_branch: 'feature/x' }) },
      );
      expectCompleted(outcome);
      expect(callsFor(outcome, 'review')).toEqual([]);
      expect(oneCallFor(outcome, 'plan').prompt).toContain('gh pr view 12 --comments');
    });
  });

  describe('plan phase', () => {
    it('refuses when the planner returns nothing', async () => {
      const outcome = await runRound({}, { plan: () => null });
      expect(expectThrown(outcome)).toMatch(/refusing to implement an unplanned round/);
    });

    it('returns early when the plan has no batches', async () => {
      const outcome = await runRound(
        {},
        { plan: () => ({ shared_context: 'NOTHING_TO_FIX', batches: [] }) },
      );
      const result = expectCompleted(outcome);
      expect(result.batches).toEqual([]);
      expect(result.signoff).toBe('nothing to fix');
      expect(callsFor(outcome, 'impl')).toEqual([]);
      expect(callsFor(outcome, 'verify')).toEqual([]);
      expect(callsFor(outcome, 'sign-off')).toEqual([]);
    });
  });

  describe('implement -> verify loop', () => {
    it('does not verify an implementer that returned nothing', async () => {
      const outcome = await runRound({}, { impl: () => null });
      const batch = onlyBatch(outcome);
      expect(callsFor(outcome, 'verify')).toEqual([]);
      expect(String(batch.notes)).toMatch(/implementer returned nothing/);
      expect(outcome.logs.join('\n')).toMatch(/implementer returned nothing on attempt 1/);
    });

    it('records a verifier that returned nothing', async () => {
      const outcome = await runRound({}, { verify: () => null });
      const batch = onlyBatch(outcome);
      expect(String(batch.notes)).toMatch(/verifier returned nothing/);
    });

    it('retries up to max_attempts and carries the rejection feedback forward', async () => {
      const outcome = await runRound(
        { max_attempts: 2 },
        { verify: () => ({ approved: false, feedback: 'FIX THE THING', boundary_probes: '' }) },
      );
      const impls = callsFor(outcome, 'impl');
      expect(impls).toHaveLength(2);
      expect(callsFor(outcome, 'verify')).toHaveLength(2);
      const batch = onlyBatch(outcome);
      expect(batch.approved).toBe(false);
      expect(batch.attempts).toBe(2);
      const second = impls[1];
      expect(second?.prompt).toContain('FIX THE THING');
    });

    it("stops after one approved attempt and reports the implementer's files", async () => {
      const outcome = await runRound();
      expect(callsFor(outcome, 'impl')).toHaveLength(1);
      const batch = onlyBatch(outcome);
      expect(batch.approved).toBe(true);
      expect(batch.attempts).toBe(1);
      expect(batch.files).toEqual(['src/a.ts']);
    });

    it('tells each batch what the earlier ones landed', async () => {
      // The `done` string is the ONLY channel carrying earlier batches forward to a later
      // implementer, so a single-batch suite would never exercise it.
      const outcome = await runRound(
        {},
        {
          plan: () => ({
            shared_context: 'ctx',
            batches: [
              { name: 'b1', spec: 'SPEC ONE' },
              { name: 'b2', spec: 'SPEC TWO' },
            ],
          }),
        },
      );
      const impls = callsFor(outcome, 'impl');
      expect(impls).toHaveLength(2);
      expect(impls[0]?.prompt).toContain('Batches already implemented this run');
      expect(impls[0]?.prompt).toContain('none yet');
      // The read-the-tree paragraph is about earlier batches' files, so on the first batch —
      // where the list is 'none yet' — "those files" would refer to nothing at all.
      expect(impls[0]?.prompt).not.toContain('Read those files as they are NOW');
      expect(impls[1]?.prompt).toContain('Read those files as they are NOW');
      expect(impls[1]?.prompt).toContain('b1: landed');
      // The files b1 reported, rendered INTO that entry (#81): the plan's ordering was computed
      // before any batch ran, so a later spec can describe code an earlier reworked batch has
      // moved. A done-list that names no file makes that invisible to the agent executing it.
      expect(impls[1]?.prompt).toContain('b1: landed — files: src/a.ts');
      expect(batchResults(outcome).map((b) => b.batch)).toEqual(['b1', 'b2']);
    });

    it('reports an unapproved earlier batch as such to the next one', async () => {
      let seen = 0;
      const outcome = await runRound(
        { max_attempts: 1 },
        {
          plan: () => ({
            shared_context: 'ctx',
            batches: [
              { name: 'b1', spec: 'SPEC ONE' },
              { name: 'b2', spec: 'SPEC TWO' },
            ],
          }),
          verify: () => {
            seen += 1;
            return seen === 1
              ? { approved: false, feedback: 'nope', boundary_probes: '' }
              : { approved: true, feedback: '', boundary_probes: '' };
          },
        },
      );
      expect(callsFor(outcome, 'impl')[1]?.prompt).toContain('b1: landed unapproved');
    });

    it('renders a batch that reported no files as such to the next one', async () => {
      // A batch whose implementer returned nothing carries `files: []`, and the happy path
      // never produces that. An empty tail there would read as "touched nothing", which is not
      // what it means — it means nobody said (#81).
      let impls = 0;
      const outcome = await runRound(
        {},
        {
          plan: () => ({
            shared_context: 'ctx',
            batches: [
              { name: 'b1', spec: 'SPEC ONE' },
              { name: 'b2', spec: 'SPEC TWO' },
            ],
          }),
          impl: () => {
            impls += 1;
            return impls === 1
              ? null
              : {
                  files_changed: ['src/b.ts'],
                  tests_added: ['t'],
                  tests_watched_failing: ['t'],
                  gate: 'green',
                };
          },
        },
      );
      const prompt = callsFor(outcome, 'impl')[1]?.prompt;
      expect(prompt).toContain('b1: landed unapproved');
      expect(prompt).toContain('(no files reported)');
    });

    it('wires each label to the intended agent type and model', async () => {
      const outcome = await runRound();
      expect(oneCallFor(outcome, 'preflight').opts.agentType).toBe('plan-verifier');
      expect(oneCallFor(outcome, 'review').opts.agentType).toBe('plan-verifier');
      const impl = oneCallFor(outcome, 'impl');
      expect(impl.opts.model).toBe('sonnet');
      expect(impl.opts.agentType).toBe('implementer');
      const verify = oneCallFor(outcome, 'verify');
      // The adversarial check is itself a guard: it runs on opus.
      expect(verify.opts.model).toBe('opus');
      expect(verify.opts.agentType).toBe('plan-verifier');
    });
  });

  describe('tail audit (#82)', () => {
    // The phase the per-batch verifiers structurally could not do: they each saw ONE batch, at
    // the moment it landed, and the last batch's fixes had no adversarial pass at all. Before
    // this, the only agent that read the whole accumulated diff was the sign-off — the same
    // agent that commits and pushes it.
    const twoBatches = () => ({
      shared_context: 'ctx',
      batches: [
        { name: 'b1', spec: 'SPEC ONE' },
        { name: 'b2', spec: 'SPEC TWO' },
      ],
    });

    it('declares its phase in meta and uses it in the body', async () => {
      // The generic both-directions check ('declares every phase its body uses...') would catch
      // a mismatch, but not the phase being absent from BOTH sides — which is the shape this
      // feature regresses to if the phase is deleted wholesale.
      const declared = metaPhaseTitles(await loadMeta(sourceOf(REVIEW_ROUND)));
      expect(declared).toContain('Tail audit');
      expect(phasesUsedInSource(sourceOf(REVIEW_ROUND))).toContain('Tail audit');
      const outcome = await runRound();
      expect(outcome.phases).toContain('Tail audit');
      expect(oneCallFor(outcome, 'tail-audit').opts.phase).toBe('Tail audit');
    });

    it('runs on the same model as the per-batch verifier, as a plan-verifier', async () => {
      // Asserted against the verify call's model, never a hardcoded 'opus': the point of
      // reusing VERIFIER_MODEL is that no edit can lower the tail audit without lowering the
      // verifier too. A literal here would go green on exactly the drift it exists to stop.
      const outcome = await runRound();
      const tail = oneCallFor(outcome, 'tail-audit');
      expect(tail.opts.model).toBe(oneCallFor(outcome, 'verify').opts.model);
      expect(tail.opts.agentType).toBe('plan-verifier');
    });

    it('runs once, after the last verify and before the sign-off, with no implementer after it', async () => {
      // Asserted on the label SEQUENCE, not on counts: "no fix step may follow" is a statement
      // about order, and a count of impl calls is satisfied by a loop that ran them afterwards.
      const outcome = await runRound({}, { plan: twoBatches });
      const labels = labelsOf(outcome);
      const keys = labels.map(labelKey);
      const tail = labels.indexOf('tail-audit');
      const lastVerify = keys.lastIndexOf('verify');
      const signoff = labels.indexOf('sign-off');
      expect(tail, `no tail-audit call (labels: ${labels.join(', ')})`).toBeGreaterThan(-1);
      expect(callsFor(outcome, 'tail-audit')).toHaveLength(1);
      expect(lastVerify).toBeGreaterThan(-1);
      expect(tail).toBeGreaterThan(lastVerify);
      expect(signoff).toBeGreaterThan(tail);
      expect(keys.slice(tail)).not.toContain('impl');
    });

    it('gives the tail auditor no write authority and tells it nothing will be fixed', async () => {
      const prompt = oneCallFor(await runRound(), 'tail-audit').prompt;
      expect(prompt).toContain('NO authority to change the tree');
      expect(prompt).toContain('`git diff`');
      expect(prompt).toContain('edit-and-revert');
      // The half a prompt cannot be trusted to infer: with no fix step behind it, a hedged
      // finding is a finding nobody acts on.
      expect(prompt).toContain('Nothing you find will be fixed in this invocation');
    });

    it('withholds the commit on a blocking verdict even when every batch is approved', async () => {
      const outcome = await runRound(
        {},
        { 'tail-audit': () => ({ blocking: true, findings: 'F' }) },
      );
      expect(onlyBatch(outcome).approved).toBe(true);
      const prompt = oneCallFor(outcome, 'sign-off').prompt;
      expect(prompt).toContain('DO NOT COMMIT');
      expect(prompt).toMatch(/tail audit/i);
      // The write-authority carve-out and the by-path commit instructions belong to the branch
      // that commits; either one surviving here hands an auditor a licence the guard withdrew.
      expect(prompt).not.toContain('commit BY PATH');
      expect(prompt).not.toContain('Claimed paths (');
      expect(prompt).not.toContain('sequence in step 5');
      const result = expectCompleted(outcome);
      expect((result.tail_audit as Record<string, unknown>).blocking).toBe(true);
    });

    it('treats a tail auditor that returned nothing as blocking, and records it', async () => {
      // Fail CLOSED: an unaudited tail is exactly what this phase exists to stop shipping, so
      // `undefined` must never read as "not blocking".
      const outcome = await runRound({}, { 'tail-audit': () => null });
      const result = expectCompleted(outcome);
      const audit = result.tail_audit as Record<string, unknown>;
      expect(audit.blocking).toBe(true);
      expect(String(audit.findings)).toMatch(/returned nothing/);
      expect(oneCallFor(outcome, 'sign-off').prompt).toContain('DO NOT COMMIT');
      expect(outcome.logs.join('\n')).toMatch(/tail audit: returned nothing/);
    });

    it.each([
      ['a string "false"', { blocking: 'false', findings: 'f' }],
      ['a falsy non-boolean', { blocking: 0, findings: 'f' }],
      ['the key absent', { findings: 'f' }],
      ['null', { blocking: null, findings: 'f' }],
    ])('treats %s where the boolean belongs as blocking', async (_label, verdict) => {
      // The value just outside the guard: every one of these is falsy or absent, so a
      // `!verdict.blocking` reading would let all four through as a clean bill of health.
      const outcome = await runRound({}, { 'tail-audit': () => verdict });
      const result = expectCompleted(outcome);
      expect((result.tail_audit as Record<string, unknown>).blocking).toBe(true);
      expect(oneCallFor(outcome, 'sign-off').prompt).toContain('DO NOT COMMIT');
    });

    it.each([
      ['findings absent', { blocking: false }],
      ['findings a non-string', { blocking: false, findings: 42 }],
      ['findings empty', { blocking: false, findings: '' }],
      ['findings whitespace only', { blocking: false, findings: '   ' }],
    ])(
      'treats an explicit blocking:false with %s as blocking — a broken schema is not a clean bill',
      async (_label, verdict) => {
        // `findings` is `required` in TAIL_SCHEMA exactly as `blocking` is, so an answer missing
        // it violated the shape that was asked for — and an answer that broke the schema in one
        // required field is not evidence about the other. The shape that makes this bite: a reply
        // truncated after `blocking: false`, or a host that dropped an oversized findings string.
        // Reading it permissively would commit and push on a verdict nothing vouched for, which
        // is the exact outcome this phase exists to prevent.
        const outcome = await runRound({}, { 'tail-audit': () => verdict });
        const result = expectCompleted(outcome);
        expect((result.tail_audit as Record<string, unknown>).blocking).toBe(true);
        expect(oneCallFor(outcome, 'sign-off').prompt).toContain('DO NOT COMMIT');
      },
    );

    it('still instructs the by-path commit on a non-blocking verdict', async () => {
      // The boundary just inside: an explicit `blocking: false` is the ONLY value that leaves
      // the commit authority standing, so it has to really leave it standing.
      const outcome = await runRound();
      const prompt = oneCallFor(outcome, 'sign-off').prompt;
      expect(prompt).toContain('commit BY PATH');
      expect(prompt).toContain('sequence in step 5');
      expect(prompt).not.toContain('DO NOT COMMIT');
      expect((expectCompleted(outcome).tail_audit as Record<string, unknown>).blocking).toBe(false);
    });

    it('runs even when a batch was not approved, and the round still does not commit', async () => {
      // The findings are the deliverable either way, and the round is not committing regardless
      // — skipping the audit on an unapproved batch would drop the audit exactly where the tree
      // is least reviewed.
      const outcome = await runRound(
        {},
        { verify: () => ({ approved: false, feedback: 'nope', boundary_probes: '' }) },
      );
      expect(callsFor(outcome, 'tail-audit')).toHaveLength(1);
      const prompt = oneCallFor(outcome, 'sign-off').prompt;
      expect(prompt).toContain('DO NOT COMMIT');
      expect(prompt).toMatch(/batches not approved: b1/);
    });

    it('carries its findings into the sign-off prompt and into the result', async () => {
      // After the fact the prompt is gone and the commit is not, so the findings have to land
      // in both channels — the same argument the `auditor` key carries.
      const outcome = await runRound(
        {},
        {
          'tail-audit': () => ({
            blocking: false,
            findings: 'src/lib/thing.ts:doThing — b2 moved the helper b1 verified',
          }),
        },
      );
      const prompt = oneCallFor(outcome, 'sign-off').prompt;
      expect(prompt).toContain('src/lib/thing.ts:doThing — b2 moved the helper b1 verified');
      const audit = expectCompleted(outcome).tail_audit as Record<string, unknown>;
      expect(audit.findings).toBe('src/lib/thing.ts:doThing — b2 moved the helper b1 verified');
      expect(audit.model).toBe(oneCallFor(outcome, 'verify').opts.model);
    });

    it('spawns no tail audit at all when the plan has no batches', async () => {
      // There is no tail to audit when nothing was implemented, and `blocking: false` there
      // would claim an audit ran and cleared the round. `null` says no audit ran.
      const outcome = await runRound(
        {},
        { plan: () => ({ shared_context: 'NOTHING_TO_FIX', batches: [] }) },
      );
      expect(callsFor(outcome, 'tail-audit')).toEqual([]);
      expect(expectCompleted(outcome).tail_audit).toBeNull();
    });
  });

  describe('sign-off', () => {
    it('signs off on opus by default', async () => {
      // Every irreversible act of the round lives in this phase — the whole-diff read, the
      // gate, the trivial-failure fixes and the unattended add/commit/push — so it does not
      // run on the cheapest tier in the round (#81).
      const outcome = await runRound();
      expect(oneCallFor(outcome, 'sign-off').opts.model).toBe('opus');
      expect(expectCompleted(outcome).auditor).toBe('opus');
    });

    it('keeps the sign-off on opus when {fable_model: "fable"} pins the planner to fable', async () => {
      // The discriminating half of the split: the planner knob no longer reaches the auditor.
      const outcome = await runRound({ fable_model: 'fable' });
      expect(oneCallFor(outcome, 'plan').opts.model).toBe('fable');
      expect(oneCallFor(outcome, 'sign-off').opts.model).toBe('opus');
    });

    it('does not lower the sign-off when {fable: false} raises the planner', async () => {
      // The other direction of the same split, and deliberately the WEAK one: it held before
      // #81 too, and a full re-coupling (SIGNOFF = PLANNER) would still pass it, because
      // {fable: false} raises both ends at once. The test above it is the discriminating pin;
      // this one only says the no-op direction stayed a no-op.
      const outcome = await runRound({ fable: false });
      expect(oneCallFor(outcome, 'plan').opts.model).toBe('opus');
      expect(oneCallFor(outcome, 'sign-off').opts.model).toBe('opus');
    });

    it('instructs a by-path commit and a re-checked branch when everything is approved', async () => {
      const outcome = await runRound();
      const prompt = oneCallFor(outcome, 'sign-off').prompt;
      expect(prompt).toContain('commit and push');
      expect(prompt).toContain('commit BY PATH');
      expect(prompt).toContain('`git add` exactly the paths');
      expect(prompt).toContain('Never `git add -A`');
      expect(prompt).toContain('`git branch --show-current`');
      expect(prompt).toContain('Stop unless it is exactly feature/x');
      // The other side of the carve-out pinned in 'forbids committing when commit is disabled
      // by args': a round that DOES commit keeps step 2's exception, or step 5 asks for a
      // sequence step 2 forbade.
      expect(prompt).toContain('sequence in step 5');
    });

    it('re-measures the tree against the claimed paths immediately before `git add`', async () => {
      // The branch is re-checked immediately before the commit; the TREE was not (#81,
      // finding 3). `git status --porcelain` and `src/a.ts` both already appear elsewhere in
      // this prompt, so the literal prefix is what is pinned, never the bare path.
      const prompt = oneCallFor(await runRound(), 'sign-off').prompt;
      expect(prompt).toContain('SECOND, still before `git add`, re-measure the tree: run');
      // Neither flag is the default, and both decide whether a claimed path is found at all:
      // `-uall` because a wholly new directory otherwise collapses to one `?? dir/` line (a
      // test-first round creating a fixture directory is the ordinary case), and
      // core.quotePath=false because a non-ASCII path is otherwise C-quoted and matches
      // nothing — the rule CLAUDE.md already applies to every path-returning git call.
      expect(prompt).toContain('`git -c core.quotePath=false status --porcelain -uall`');
      expect(prompt).toContain('Claimed paths (the exact set this round may add): src/a.ts');
      expect(prompt).toContain('stop and report the round rather than committing');
      // A TEST-FIRST round's most common artifact is a NEW file, which porcelain reports as
      // `??` — untracked, not modified. "no longer listed as modified" read literally would
      // abort every such round at the commit step, so the rule is about a path going quiet.
      expect(prompt).toContain('no longer appears in that fresh status AT ALL');
      expect(prompt).toContain('any status code counts as');
    });

    it('states plainly that the re-measure does not make the commit line-accurate', async () => {
      // The caveat is the point of the check: `git add <path>` takes the whole file, so a peer
      // editing another region of a claimed path still ships with the round. This assertion is
      // what stops a later edit from quietly reading as a fix for finding 3.
      const prompt = oneCallFor(await runRound(), 'sign-off').prompt;
      expect(prompt).toContain('#81, finding 3');
      expect(prompt).toContain('takes the whole file');
    });

    it('says so loudly when no batch claimed a single path', async () => {
      // The value just outside the normal case: nothing to `git add` by path at all. Silence
      // here would read as "add nothing and carry on", which is a commit of nobody's work.
      const outcome = await runRound(
        {},
        {
          impl: () => ({
            files_changed: [],
            tests_added: ['t'],
            tests_watched_failing: ['t'],
            gate: 'green',
          }),
        },
      );
      expect(oneCallFor(outcome, 'sign-off').prompt).toContain(
        'Claimed paths (the exact set this round may add): (none — no batch reported a file',
      );
    });

    it('deduplicates the claimed set across batches', async () => {
      // Two batches touching one file must not claim it twice — a future edit dropping the Set
      // would render it twice and go unnoticed by a `toContain`, so the whole line is compared.
      const outcome = await runRound(
        {},
        {
          plan: () => ({
            shared_context: 'ctx',
            batches: [
              { name: 'b1', spec: 'SPEC ONE' },
              { name: 'b2', spec: 'SPEC TWO' },
            ],
          }),
          impl: (call) => ({
            files_changed: String(call.opts.label).startsWith('impl:b1')
              ? ['src/a.ts', 'src/b.ts']
              : ['src/b.ts'],
            tests_added: ['t'],
            tests_watched_failing: ['t'],
            gate: 'green',
          }),
        },
      );
      const line = oneCallFor(outcome, 'sign-off')
        .prompt.split('\n')
        .find((l) => l.includes('Claimed paths ('));
      expect(line?.trim()).toBe(
        'Claimed paths (the exact set this round may add): src/a.ts, src/b.ts',
      );
    });

    it('forbids committing when a batch was not approved', async () => {
      const outcome = await runRound(
        {},
        { verify: () => ({ approved: false, feedback: 'nope', boundary_probes: '' }) },
      );
      const prompt = oneCallFor(outcome, 'sign-off').prompt;
      expect(prompt).toContain('DO NOT COMMIT');
      expect(prompt).toMatch(/batches not approved: b1/);
      // Both halves of MAY_COMMIT, not just the args one: an unapproved batch withdraws the
      // write authority too.
      expect(prompt).not.toContain('sequence in step 5');
      expect(prompt).not.toContain('Claimed paths (');
    });

    it('forbids committing when commit is disabled by args', async () => {
      const outcome = await runRound({ commit: false });
      const prompt = oneCallFor(outcome, 'sign-off').prompt;
      expect(prompt).toContain('DO NOT COMMIT');
      expect(prompt).toContain('commit disabled by args');
      // Step 2's "you have NO authority to change the tree" paragraph used to carve out "plus
      // the one git add/commit/push sequence in step 5" unconditionally — pointing at a step
      // that, on this branch, says DO NOT COMMIT. It was the only sentence in the prompt
      // granting write authority, and {commit: false} is exactly what the sign-off tier floor
      // tells a user to pass to run a cheaper auditor, so an advisory round was handing the
      // cheapest model in the repo a licence to push.
      expect(prompt).not.toContain('sequence in step 5');
      expect(prompt).toContain('no other git command at all: this round does not');
      // The re-measure belongs to the branch that actually commits; an advisory round that is
      // told what it may `git add` is one edit away from doing it.
      expect(prompt).not.toContain('Claimed paths (');
    });

    it.each([[null], [undefined]])(
      'falls back when the sign-off returns %o',
      async (signoffAnswer) => {
        const outcome = await runRound({}, { 'sign-off': () => signoffAnswer });
        const result = expectCompleted(outcome);
        expect(String(result.signoff)).toMatch(/tree left uncommitted for a human/);
      },
    );
  });
});

// ---------------------------------------------------------------------------
// 4. The checks themselves fail on broken input — otherwise this whole tier is decorative.
// ---------------------------------------------------------------------------

const FAKE_TYPO_SOURCE = `export const meta = {
  name: 'fake',
  description: 'a fake workflow',
  phases: [{ title: 'Reviw' }],
};
phase('Review');
return 'done';
`;

const FAKE_EXTRA_PHASE_SOURCE = `export const meta = {
  name: 'fake',
  description: 'a fake workflow',
  phases: [{ title: 'Review' }],
};
phase('Review');
phase('Cleanup');
return 'done';
`;

const FAKE_UNUSED_PHASE_SOURCE = `export const meta = {
  name: 'fake',
  description: 'a fake workflow',
  phases: [{ title: 'Review' }, { title: 'Ghost' }],
};
phase('Review');
return 'done';
`;

const FAKE_OK_SOURCE = `export const meta = {
  name: 'fake-ok',
  description: 'a fake workflow',
  phases: [{ title: 'Only' }],
};
phase('Only');
const said = await agent('hello', { label: 'only', phase: 'Only' });
log('ran');
return { said };
`;

const FAKE_PARALLEL_SOURCE = `export const meta = {
  name: 'fake-parallel',
  description: 'a fake workflow',
  phases: [{ title: 'Only' }],
};
phase('Only');
return await parallel([]);
`;

describe('the checks themselves fail on broken input', () => {
  it('reports a typo’d phase title in both directions', async () => {
    const declared = metaPhaseTitles(await loadMeta(FAKE_TYPO_SOURCE));
    const { declaredNotUsed, usedNotDeclared } = comparePhases(
      declared,
      phasesUsedInSource(FAKE_TYPO_SOURCE),
    );
    expect(declaredNotUsed).toEqual(['Reviw']);
    expect(usedNotDeclared).toEqual(['Review']);
  });

  it('reports a phase used but never declared', async () => {
    const declared = metaPhaseTitles(await loadMeta(FAKE_EXTRA_PHASE_SOURCE));
    const compared = comparePhases(declared, phasesUsedInSource(FAKE_EXTRA_PHASE_SOURCE));
    expect(compared.usedNotDeclared).toContain('Cleanup');
    expect(compared.declaredNotUsed).toEqual([]);
  });

  it('reports a phase declared but never used', async () => {
    const declared = metaPhaseTitles(await loadMeta(FAKE_UNUSED_PHASE_SOURCE));
    const compared = comparePhases(declared, phasesUsedInSource(FAKE_UNUSED_PHASE_SOURCE));
    expect(compared.declaredNotUsed).toContain('Ghost');
    expect(compared.usedNotDeclared).toEqual([]);
  });

  it.each([
    ['not an object', 42],
    ['missing name', { description: 'd', phases: [{ title: 'A' }] }],
    ['empty name', { name: '  ', description: 'd', phases: [{ title: 'A' }] }],
    ['missing description', { name: 'n', phases: [{ title: 'A' }] }],
    ['no phases', { name: 'n', description: 'd', phases: [] }],
    ['phase without a title', { name: 'n', description: 'd', phases: [{ detail: 'x' }] }],
    ['phase that is not an object', { name: 'n', description: 'd', phases: ['A'] }],
    ['non-string detail', { name: 'n', description: 'd', phases: [{ title: 'A', detail: 7 }] }],
    ['empty model', { name: 'n', description: 'd', phases: [{ title: 'A', model: '' }] }],
    ['duplicate titles', { name: 'n', description: 'd', phases: [{ title: 'A' }, { title: 'A' }] }],
  ])('validateMeta reports a meta with %s', (_label, meta) => {
    expect(validateMeta(meta)).not.toEqual([]);
  });

  it('validateMeta accepts a well-formed meta', async () => {
    expect(validateMeta(await loadMeta(FAKE_OK_SOURCE))).toEqual([]);
  });

  it('wrapWorkflowSource refuses a source with no exported meta', () => {
    expect(() => wrapWorkflowSource('const meta = {};\nreturn 1;\n')).toThrow(
      /no top-level `export const meta =` declaration/,
    );
  });

  it('runScript actually executes a body', async () => {
    const outcome = await runScript(FAKE_OK_SOURCE, {}, () => 'hi');
    expect(errorText(outcome)).toBeUndefined();
    expect((outcome.meta as { name?: unknown }).name).toBe('fake-ok');
    expect(outcome.phases).toEqual(['Only']);
    expect(outcome.logs).toEqual(['ran']);
    expect(labelsOf(outcome)).toEqual(['only']);
    expect(outcome.result).toEqual({ said: 'hi' });
  });

  it('runScript refuses to silently stub parallel/pipeline', async () => {
    const outcome = await runScript(FAKE_PARALLEL_SOURCE, {}, () => 'hi');
    expect(expectThrown(outcome)).toMatch(/parallel\(\) is not stubbed in this harness/);
  });
});
