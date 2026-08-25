export const meta = {
  name: 'review-round',
  description:
    'One review round end-to-end: opus reviews the diff, fable plans, sonnet implements, opus verifies, fable signs off (fable swappable for opus)',
  whenToUse:
    'To review-and-fix a branch or PR in one pass: Workflow({name: "review-round"}) reviews the current branch ' +
    'against origin/dev itself. Optional args: {review: "<posted review-comment URL>" to fix an existing review ' +
    'instead of producing one, pr: <number>, branch: "<name>", base: "origin/dev", max_attempts: 2, commit: true, ' +
    'fable: false — or fable_model: "opus" — to run the planner and sign-off on opus instead}. ' +
    'Batches run sequentially (shared files), so wall-clock is the sum of batches.',
  phases: [
    {
      title: 'Review',
      detail:
        'opus reviews the target diff adversarially and writes the findings (skipped when a posted review is given)',
      model: 'opus',
    },
    {
      title: 'Plan',
      detail: 'fable (or opus, with args.fable === false) batches the findings into coherent fixes',
      model: 'fable',
    },
    {
      title: 'Implement',
      detail: 'sonnet fixes one batch at a time, tests first',
      model: 'sonnet',
    },
    {
      title: 'Verify',
      detail: 'opus adversarially verifies each batch and demands rework',
      model: 'opus',
    },
    {
      title: 'Sign-off',
      detail:
        'fable (or opus, with args.fable === false) audits the whole diff, runs the gate, commits',
      model: 'fable',
    },
  ],
};

// ---- inputs -------------------------------------------------------------
const review = (args && args.review) || null;
const MAX_ATTEMPTS = (args && args.max_attempts) || 2;
const COMMIT = args && args.commit === false ? false : true;
const BASE = (args && args.base) || 'origin/dev';
// The planner and the sign-off auditor both run on fable by default. Pass {fable: false} — or
// name one outright with {fable_model: 'opus'} — to run both on opus instead. One knob for both:
// they are the two ends of the same whole-round view, and splitting them invites a plan written
// at one altitude being audited at another.
const FABLE = args && args.fable === false ? 'opus' : (args && args.fable_model) || 'fable';
if (FABLE !== 'fable' && FABLE !== 'opus') {
  throw new Error(`fable_model must be "fable" or "opus", got ${JSON.stringify(FABLE)}`);
}

const REPO = '/home/eramzi/workspace/overleaf_mcp';
const prFromUrl = review ? (review.match(/\/pull\/(\d+)/) || [])[1] : null;
const PR = (args && args.pr) || (prFromUrl && Number(prFromUrl)) || null;
const BRANCH =
  (args && args.branch) ||
  '(the currently checked-out branch — verify with git branch --show-current, and stop if it is a protected branch: dev or main)';
const TARGET = PR ? `PR #${PR} (branch ${BRANCH})` : `branch ${BRANCH}, reviewed against ${BASE}`;
const HOUSE = `
Repo: ${REPO}. Target of this round: ${TARGET}. This is WebLatexMCP, a TypeScript MCP server
(stdio transport). Read CLAUDE.md first; its rules are load-bearing:
tools (src/tools/*) do only zod validation + formatting — all logic lives in services/lib so it
is testable without an MCP client; stdout is the JSON-RPC channel (never console.log — stderr
only); every handler's catch uses errorResult(err, ctx.credentials.allSecrets()) and
structuredContent is a fresh spread literal; guards are load-bearing and never weakened without
the spec saying so (requireGitProject first in git-backed tools, mutating tools inside
runExclusive, .bib writes behind confirmBibEdit, recordBaseline only for full intentional reads,
symlink resolution on every path with strictLinks for server-picked ones, ff-only pull,
push refuses when behind, a shadow-store conflicted flag stays flagged, error snippets only for
log-vouched locations); verbatimModuleSyntax is on (import type, .js import paths); code and
tests are separator-agnostic (toPosix, pathToFileURL) — CI runs ubuntu + windows + macos.
A new regression test must fail on the pre-fix code (mutation-check it). The TeX smokes
(test/smoke/**) auto-skip without latexmk — a green npm test proves nothing about compile
behaviour unless a non-smoke test covers it via the LatexCompiler interface or real log
fixtures; a skip is fine, a failure is not. Integration tests use the local bare-repo helper
(test/helpers/bareRepo.ts, branch master) — no network, no secrets.
The only gate is that the local CI passes:
  npm run typecheck && npm run lint && npm run format:check && npm test
(typecheck covers src AND test; the build does not, so a clean build proves nothing about
tests). Single test file: npx vitest run test/unit/<file>.test.ts; by name: npx vitest run -t "...".`;

// ---- Phase 0: obtain the review -----------------------------------------
// Either fetch a posted review round (args.review) or produce one ourselves.
let findingsSource;
if (review) {
  findingsSource = `Fetch the review with: gh pr view ${PR} --comments — the review to fix is the comment at
${review} (match it by URL; it is the latest review-round comment). Read the findings, the
cleanup list, and any "verified clean" section. Then read the cited code.`;
} else {
  phase('Review');
  const reviewText = await agent(
    `You are the reviewer for this round. ${HOUSE}

Review the round's diff end to end: ${
      PR
        ? `gh pr diff ${PR} (and gh pr view ${PR} for its description)`
        : `git diff ${BASE}...HEAD (run git fetch origin first so ${BASE} is current)`
    }.
Your job is to refute the claim "this change is correct and complete", not to confirm it.
Verify claims by reading the surrounding code in the tree, not the diff context alone.

Hunt, in order of severity: real defects (a failure scenario you can state in one sentence);
weakened or bypassed guards (requireGitProject, runExclusive, confirmBibEdit, recordBaseline,
symlink resolution, ff-only pull / push-refuses-behind, conflicted-stays-flagged, snippet
provenance); logic leaked into a tool handler, a catch not going through errorResult, a
non-spread structuredContent, stdout writes from server code; session-isolation leaks near the
shadow store or commitContents; vacuously green tests (a smoke skip claimed as coverage, a
probe whose path never fired, a regression test that would pass on the pre-fix code);
cross-platform breakage (hardcoded separators, string-built file:// URLs, paths not through
toPosix); stale docs (README's tool list, CLAUDE.md conventions, CHANGELOG). Then a cleanup
list: smaller reuse/clarity items worth fixing while here.

Your final text is the review round itself, for a planner who has not seen the diff: numbered
findings ranked most-severe first, each with file and symbol, what is wrong, the failure
scenario in one sentence, and the required direction of the fix; then the numbered cleanup
list; then a "verified clean" section naming what you tried to break and could not. If there
are NO findings and NO cleanup items, say exactly that.`,
    { model: 'opus', label: 'review', phase: 'Review' },
  );
  findingsSource = `The review round below was just produced against the working tree — trust it as the round to
fix, and read the cited code yourself:

${reviewText}`;
}

// ---- Phase 1: fable plans ----------------------------------------------
phase('Plan');
const PLAN_SCHEMA = {
  type: 'object',
  required: ['batches', 'shared_context'],
  properties: {
    shared_context: {
      type: 'string',
      description:
        'Facts every implementer needs: round title, cross-batch interactions, ordering constraints, whether guard/lock/session code is involved. Empty-string sentinel "NOTHING_TO_FIX" if the review found nothing.',
    },
    batches: {
      type: 'array',
      minItems: 0,
      maxItems: 4,
      items: {
        type: 'object',
        required: ['name', 'spec'],
        properties: {
          name: { type: 'string', description: 'short slug, e.g. baseline-guard' },
          spec: {
            type: 'string',
            description:
              'A complete, self-contained implementation spec: which findings it covers (numbers + file:symbol), ' +
              'the required approach per finding, exact tests to write FIRST (each pinning the reproduced failure ' +
              'scenario and asserting observable behavior, not internal counters; for every new guard or boundary, ' +
              'a test for the value just OUTSIDE it), which tier each test belongs to (unit / integration / ' +
              'TeX-gated smoke), and which cleanup items ride along.',
          },
        },
      },
    },
  },
};
const plan = await agent(
  `You are the planner for a fix round. ${HOUSE}

${findingsSource}

Produce a plan that groups all findings AND cleanup items into 1-4 coherent batches, where a
batch = changes that belong in one reviewable unit (same defect family or same functions;
keep a service change and the tool surface that exposes it in the SAME batch so the
test-and-gate cycle stays coherent). Order the batches so earlier ones don't invalidate later
specs (e.g. a lib helper move before its new callers; a behavior change before the README /
CLAUDE.md text that must describe it). Each batch spec must be executable by an implementer
who has NOT read the review: restate everything needed. Demand test-first: for every guard or
boundary in the spec, name the test for the value just outside it, and say which tier it lives
in (unit with temp dirs / integration against the bare-repo helper / TeX-gated smoke). Flag
explicitly any batch that touches guard code, runExclusive/lock paths, the shadow store, or
credential handling — those need the invariant-preservation treatment. Note in each spec which
findings interact with fixes from earlier batches in this same run. If the review genuinely
found nothing to fix, return zero batches and shared_context "NOTHING_TO_FIX".`,
  { model: FABLE, label: 'plan', phase: 'Plan', schema: PLAN_SCHEMA },
);
if (!plan.batches.length) {
  log('review found nothing to fix — done');
  return {
    review: review || 'produced in-run',
    planner: FABLE,
    batches: [],
    signoff: 'nothing to fix',
  };
}
log(`plan: ${plan.batches.length} batch(es): ${plan.batches.map((b) => b.name).join(', ')}`);

// ---- Phase 2+3: sequential implement -> verify loop per batch -----------
const VERDICT_SCHEMA = {
  type: 'object',
  required: ['approved', 'feedback'],
  properties: {
    approved: { type: 'boolean' },
    feedback: {
      type: 'string',
      description:
        'If not approved: precise rework instructions (file:symbol, what is wrong, what to do). ' +
        'If approved: residual notes worth carrying to sign-off (may be empty).',
    },
    boundary_probes: {
      type: 'string',
      description:
        'The just-outside-the-guard values you actually ran, what happened, and proof the probed path fired (a probe whose path never executed proves nothing)',
    },
  },
};

const results = [];
for (const batch of plan.batches) {
  let attempt = 0;
  let feedback = '';
  let verdict = { approved: false, feedback: 'never ran' };
  while (attempt < MAX_ATTEMPTS) {
    attempt += 1;
    const done =
      results.map((r) => `${r.batch}: ${r.approved ? 'landed' : 'landed unapproved'}`).join('; ') ||
      'none yet';
    await agent(
      `You are the implementer. ${HOUSE}

Shared context from the planner: ${plan.shared_context}
Batches already implemented this run (their changes are in the working tree): ${done}

Implement this batch spec, TEST FIRST (write the failing regression tests, watch them fail on
the pre-fix code, then fix until green). Do not commit — a later sign-off step commits. Do not
touch anything outside the spec except where the spec's cleanup items say so.

${batch.spec}
${feedback ? `\nA verifier rejected your previous attempt. Address every point:\n${feedback}` : ''}

Run the gate before finishing. Your final text: a factual change list (files, functions,
tests added and which were watched failing pre-fix, gate result) for the verifier — raw data,
not prose for a human.`,
      { model: 'sonnet', label: `impl:${batch.name}#${attempt}`, phase: 'Implement' },
    );
    verdict = await agent(
      `You are the adversarial verifier. ${HOUSE}

A batch of fixes was just implemented in the working tree (NOT committed — inspect with
git diff). The spec it had to satisfy:

${batch.spec}

Verify adversarially, in this order:
1. Does each fix land at the boundary, not one value inside it? For EVERY new or moved guard,
   check, or refusal in the diff, construct and RUN the input just outside it (npx vitest run
   on a scratch test, or a small node script over the service layer, in the session
   scratchpad). Confirm the probed path actually fired: a probe that never reached the guard
   proves nothing.
2. Did the fix break existing behavior? Run the full gate (all four commands — typecheck
   covers the tests, the build does not). If the diff touches compile, logParser, or snippet
   code, confirm a NON-smoke test exercises it (the TeX smokes auto-skip without latexmk —
   check the vitest output for skips being claimed as coverage). If it touches git behavior,
   run the integration suite and confirm it stays on the bare-repo helper (no network, no
   secrets). Re-probe the behaviors the spec says interact with earlier batches.
3. Are the new tests real? Mutation-check: revert the fix hunk (mentally or with git stash of
   the src change) and confirm the new tests fail there, and that they assert observable
   behavior, not internal counters.
4. House-rule sweep of the diff: any console.log in server code, logic in a tool handler, a
   catch not going through errorResult, a non-spread structuredContent, a weakened guard
   (requireGitProject / runExclusive / confirmBibEdit / recordBaseline / symlink resolution /
   ff-only / conflicted-stays-flagged / snippet provenance), a type-only import without
   import type, a hardcoded path separator or string-built file:// URL, or a survivor of the
   batch's defect pattern elsewhere in src/? Grep.
Approve ONLY if all pass. If rejecting, give file:symbol-precise rework instructions.`,
      {
        model: 'opus',
        label: `verify:${batch.name}#${attempt}`,
        phase: 'Verify',
        schema: VERDICT_SCHEMA,
      },
    );
    if (verdict.approved) break;
    feedback = verdict.feedback;
    log(`${batch.name}: rejected on attempt ${attempt} — ${feedback.slice(0, 120)}`);
  }
  results.push({
    batch: batch.name,
    approved: verdict.approved,
    attempts: attempt,
    notes: verdict.feedback,
  });
  log(
    `${batch.name}: ${verdict.approved ? 'approved' : 'NOT approved'} after ${attempt} attempt(s)`,
  );
}

// ---- Phase 4: fable signs off -------------------------------------------
phase('Sign-off');
const unapproved = results.filter((r) => !r.approved);
const signoff = await agent(
  `You are the final auditor. ${HOUSE}

Every batch of this fix round has been implemented in the working tree (uncommitted).
Batch outcomes: ${JSON.stringify(results)}

1. Read the FULL diff (git diff) end to end, as one reviewer, looking for cross-batch
   interactions the per-batch verifiers could not see: one batch's helper move breaking
   another's caller, duplicate helpers introduced twice, README's tool list or CLAUDE.md
   conventions describing pre-fix behavior of another batch, two batches touching the same
   guard from different directions.
2. Sync before committing, per CLAUDE.md: git fetch origin, rebase onto the branch's
   upstream (or its base if it has none), resolve any conflicts, then run the complete gate.
   Fix trivial gate failures (a prettier reflow, a lint autofix, an import) yourself;
   anything substantive gets reported, not patched.
3. Self-review for the boundary class: for every guard in the diff, name the value just
   outside it and confirm a test covers it — in the right tier (a TeX-gated smoke does not
   count as coverage on machines without latexmk).
4. Check the invariants that span batches: a commit still contains one session's lines only
   (shadow store / commitContents untouched or deliberately changed), no credential can reach
   disk or a result message, and errors stay token-scrubbed.
${
  COMMIT && unapproved.length === 0
    ? `5. If and only if the gate is green and you found no substantive problem: commit everything to the branch with a message describing the round (Co-Authored-By trailer per house style), and push. Never commit directly on dev or main — stop and report instead if that is where you are.`
    : `5. DO NOT COMMIT: ${unapproved.length ? `batches not approved: ${unapproved.map((r) => r.batch).join(', ')}` : 'commit disabled by args'}. Leave the tree for a human.`
}

Your final text: gate result, whether you committed (and the SHA), unresolved concerns.`,
  { model: FABLE, label: 'sign-off', phase: 'Sign-off' },
);

return { review: review || 'produced in-run', planner: FABLE, batches: results, signoff };
