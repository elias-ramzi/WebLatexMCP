import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A tier over `.claude/workflows/*.js`.
 *
 * Those scripts commit and push unattended, and until this file existed the only automated
 * statement CI made about them was that prettier liked their whitespace: eslint ignores
 * `.claude/**`, tsc never sees them, and nothing imported them. A Workflow script is not
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

type ResponderKey = 'preflight' | 'review' | 'plan' | 'impl' | 'verify' | 'sign-off';
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

    // The planner's model tier is asserted on the `plan` label ONLY, never on `sign-off`:
    // a separate lane is deliberately changing the sign-off's tier, and pinning it here would
    // hand them a spurious failure for a change this test has no opinion about.
    it('plans on fable by default', async () => {
      const outcome = await runRound();
      expect(oneCallFor(outcome, 'plan').opts.model).toBe('fable');
    });

    it('plans on opus with {fable: false}', async () => {
      const outcome = await runRound({ fable: false });
      expect(oneCallFor(outcome, 'plan').opts.model).toBe('opus');
    });

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
      expect(oneCallFor(outcome, 'sign-off').prompt).toContain('must NOT be committed: peer.ts');
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
      expect(impls[1]?.prompt).toContain('b1: landed');
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

  describe('sign-off', () => {
    it('instructs a by-path commit and a re-checked branch when everything is approved', async () => {
      const outcome = await runRound();
      const prompt = oneCallFor(outcome, 'sign-off').prompt;
      expect(prompt).toContain('commit and push');
      expect(prompt).toContain('commit BY PATH');
      expect(prompt).toContain('`git add` exactly the paths');
      expect(prompt).toContain('Never `git add -A`');
      expect(prompt).toContain('`git branch --show-current`');
      expect(prompt).toContain('Stop unless it is exactly feature/x');
    });

    it('forbids committing when a batch was not approved', async () => {
      const outcome = await runRound(
        {},
        { verify: () => ({ approved: false, feedback: 'nope', boundary_probes: '' }) },
      );
      const prompt = oneCallFor(outcome, 'sign-off').prompt;
      expect(prompt).toContain('DO NOT COMMIT');
      expect(prompt).toMatch(/batches not approved: b1/);
    });

    it('forbids committing when commit is disabled by args', async () => {
      const outcome = await runRound({ commit: false });
      const prompt = oneCallFor(outcome, 'sign-off').prompt;
      expect(prompt).toContain('DO NOT COMMIT');
      expect(prompt).toContain('commit disabled by args');
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
