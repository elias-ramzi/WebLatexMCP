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
const review = (args && args.review) ?? null;
if (review !== null && !/^https?:\/\/\S+$/.test(String(review))) {
  throw new Error(`review must be a posted review-comment URL, got ${JSON.stringify(review)}`);
}
// `??`, not `||`: max_attempts: 0 is a legitimate "plan only, implement nothing", and `||`
// silently turned it into 2. Same for every other input below.
const MAX_ATTEMPTS = (args && args.max_attempts) ?? 2;
if (!Number.isInteger(MAX_ATTEMPTS) || MAX_ATTEMPTS < 0) {
  throw new Error(
    `max_attempts must be a non-negative integer, got ${JSON.stringify(MAX_ATTEMPTS)}`,
  );
}
// Opt-out, not opt-in — the unattended commit is this workflow's deliberate difference from
// /review. But the opt-out is type-checked: `commit: "false"` and `commit: 0` used to read as
// true and push anyway.
const commitArg = (args && args.commit) ?? true;
if (typeof commitArg !== 'boolean') {
  throw new Error(`commit must be a boolean, got ${JSON.stringify(commitArg)}`);
}
const COMMIT = commitArg;
const BASE = (args && args.base) ?? 'origin/dev';
if (typeof BASE !== 'string' || !BASE.trim()) {
  throw new Error(`base must be a non-empty string, got ${JSON.stringify(BASE)}`);
}
// The planner and the sign-off auditor both run on fable by default. Pass {fable: false} — or
// name one outright with {fable_model: 'opus'} — to run both on opus instead. One knob for both:
// they are the two ends of the same whole-round view, and splitting them invites a plan written
// at one altitude being audited at another.
const FABLE = args && args.fable === false ? 'opus' : (args && args.fable_model) || 'fable';
if (FABLE !== 'fable' && FABLE !== 'opus') {
  throw new Error(`fable_model must be "fable" or "opus", got ${JSON.stringify(FABLE)}`);
}

const prFromUrl = review ? (review.match(/\/pull\/(\d+)/) || [])[1] : null;
const prArg = (args && args.pr) ?? null;
if (prArg !== null && (!Number.isInteger(prArg) || prArg <= 0)) {
  throw new Error(`pr must be a positive integer, got ${JSON.stringify(prArg)}`);
}
// A review URL carries its own PR number. If `pr:` disagrees, one of them is wrong and we
// would review one PR's diff while reporting against another — refuse rather than pick.
if (prArg !== null && prFromUrl && prArg !== Number(prFromUrl)) {
  throw new Error(`pr: ${prArg} disagrees with the PR in the review URL (#${prFromUrl})`);
}
const PR = prArg ?? (prFromUrl ? Number(prFromUrl) : null);
const PROTECTED = ['dev', 'main', 'master'];
const branchArg = (args && args.branch) ?? null;
if (branchArg !== null && (typeof branchArg !== 'string' || !branchArg.trim())) {
  throw new Error(`branch must be a non-empty string, got ${JSON.stringify(branchArg)}`);
}
// Refuse synchronously, before a single agent spawns. The old default was a *sentence*
// ("stop if it is a protected branch") spliced into a target description — a rule no phase
// was told to act on, which is exactly the failure this repo learned from #77: a description
// is not a rule the agent is bound by. A named protected branch is now a throw; an unnamed
// one is caught by the preflight assert below, which is JS too.
if (branchArg !== null && PROTECTED.includes(branchArg)) {
  throw new Error(`refusing to run against protected branch ${branchArg}`);
}
const BRANCH = branchArg ?? '(the currently checked-out branch)';
const TARGET = PR ? `PR #${PR} (branch ${BRANCH})` : `branch ${BRANCH}, reviewed against ${BASE}`;
// CLAUDE.md is injected into every subagent's context automatically — restating its rules here
// produced a second copy that drifted (it still claimed the local gate was the only gate, and
// it predated rewrite-mode, the reference backends, case folding, the conflict budget and the
// compiler preflight). A paraphrased rule is a wrong rule. So HOUSE now carries only what
// CLAUDE.md does NOT say, plus this round's target.
const HOUSE = `
Repo: this repository — your working directory. Never reach outside it, and never operate on
another checkout of it. Target of this round: ${TARGET}. This is WebLatexMCP, a TypeScript MCP
server (stdio transport).

CLAUDE.md is already in your context. Follow it as written; do not work from a summary of it,
and do not ask another agent for its rules. These are the things it does not tell you:

- The local gate is NOT the only gate. CI also requires the [Unreleased] section of CHANGELOG.md
  to have CHANGED on a PR into dev (.github/workflows/changelog.yml — waived for a back-merge
  from main and for a PR labelled no-changelog), plus lint/typecheck/test on ubuntu + windows +
  macos and a LaTeX compile smoke. A round whose diff is user-facing and adds no [Unreleased]
  entry goes red on a check no local command runs.
- \`npm run lint\` does NOT cover .claude/** — eslint ignores it globally. For a diff under
  .claude/ the only automated check is prettier. Do not report a green lint as coverage there.
- The canonical tool reference is docs/tools.md, not just README — with docs/configuration.md,
  docs/CONCURRENCY.md and docs/skills.md alongside it. A behaviour change that leaves those
  describing the old behaviour is a finding.
- CLAUDE.md's Git-workflow section tells you to rebase onto origin/main before committing.
  Both halves are wrong here. The branch is wrong — the integration branch is dev, and main
  only ever receives dev — so compare against ${BASE}. And the instruction is wrong for this
  round: NO agent in this round rebases or merges anything. The tree is uncommitted from the
  first batch onward, git refuses to rebase a dirty tree, and the only way it would let you is
  the stash that is forbidden below.

The local gate, which you run in full:
  npm run typecheck && npm run lint && npm run format:check && npm test
(typecheck covers src AND test; the build does not, so a clean build proves nothing about
tests). Single test file: npx vitest run test/unit/<file>.test.ts; by name: npx vitest run -t "...".`;

// ---- Preflight: assert in JS what a sentence in a prompt cannot ---------
// The old script told an agent, inside a target *description*, to "stop if it is a protected
// branch". No phase was told to act on it. And in PR mode nothing ever checked the PR's branch
// out: Workflow({pr: N}) from a checkout sitting on dev reviewed PR N's diff, wrote PR N's
// fixes onto dev, and tried to commit and push them there. Workflow scripts have no filesystem
// or child-process access, so the only way to learn the tree's state is to ask an agent and
// then assert on the answer here, in JS, where no prompt can talk past it.
const PREFLIGHT_SCHEMA = {
  type: 'object',
  required: ['current_branch', 'head_branch', 'dirty_paths'],
  properties: {
    current_branch: {
      type: 'string',
      description: 'Output of `git branch --show-current`, verbatim. Empty string if detached.',
    },
    head_branch: {
      type: 'string',
      description: PR
        ? `The headRefName of PR #${PR}. Empty string only if the command failed.`
        : 'Empty string — there is no PR in this round.',
    },
    dirty_paths: {
      type: 'array',
      items: { type: 'string' },
      description:
        'One repo-relative PATH per entry — the path only, with the two porcelain status characters and their trailing space stripped, and for a rename the NEW path (after the "->"). Not the raw status line.',
    },
  },
};
const pre = await agent(
  `Measure the repository's current state and report it. Run exactly these, and report what they
print. Change nothing: no commit, no checkout, no stash, no edit — this is a measurement, and
acting on what you find is not your job.
- git branch --show-current
${PR ? `- gh pr view ${PR} --json headRefName --jq .headRefName` : '- (no PR this round — report head_branch as "")'}
- git status --porcelain
For dirty_paths, report the paths alone — strip the leading status characters (\`cut -c4-\`),
and for a rename line report the path after the "->". A raw status line is not a path.`,
  { label: 'preflight', phase: 'Review', schema: PREFLIGHT_SCHEMA, agentType: 'plan-verifier' },
);
if (!pre) {
  throw new Error('preflight returned nothing — refusing to run a fix round blind');
}
// These assertions consume one agent's free-text self-report, so every one of them fails
// CLOSED. An answer we cannot parse is refused, never read as "not protected": `refs/heads/dev`
// and ` dev` are things a model plausibly reports, and under exact equality each of them would
// have sailed past `PROTECTED.includes`.
const normBranch = (s) =>
  String(s ?? '')
    .trim()
    .replace(/^refs\/heads\//, '');
const currentBranch = normBranch(pre.current_branch);
const headBranch = normBranch(pre.head_branch);
const BRANCH_RE = /^[\w.\-/]+$/;
if (currentBranch && !BRANCH_RE.test(currentBranch)) {
  throw new Error(
    `preflight reported an unparseable branch name ${JSON.stringify(pre.current_branch)} — refusing rather than assuming it is safe`,
  );
}
if (COMMIT && !currentBranch) {
  throw new Error('detached HEAD — a committing round needs a branch to commit to');
}
if (COMMIT && PROTECTED.includes(currentBranch)) {
  throw new Error(
    `refusing to run a committing round on protected branch ${currentBranch} — check out a feature branch first, or pass {commit: false}`,
  );
}
if (PR && !headBranch) {
  throw new Error(
    `could not read the head branch of PR #${PR} (is gh authenticated?) — refusing, because without it nothing checks that this round's fixes land on the PR's branch`,
  );
}
if (PR && currentBranch !== headBranch) {
  throw new Error(
    `PR #${PR} is on branch ${headBranch} but ${currentBranch || '(detached HEAD)'} is checked out — this round would write PR #${PR}'s fixes onto the wrong branch`,
  );
}
if (branchArg !== null && currentBranch !== branchArg) {
  throw new Error(
    `branch: ${branchArg} was requested but ${currentBranch || '(detached HEAD)'} is checked out`,
  );
}
// This checkout is shared with other agent sessions, so anything already modified before the
// round began is somebody else's in-flight work. Record it: the sign-off must not commit it.
const PRE_DIRTY = pre.dirty_paths || [];
if (PRE_DIRTY.length) {
  log(
    `preflight: ${PRE_DIRTY.length} path(s) were already modified before this round — excluded from the commit as a peer's work`,
  );
}

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
    { model: 'opus', label: 'review', phase: 'Review', agentType: 'plan-verifier' },
  );
  if (!reviewText) {
    throw new Error('reviewer returned nothing — no round to plan from');
  }
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
if (!plan) {
  throw new Error('planner returned nothing — refusing to implement an unplanned round');
}
if (!plan.batches.length) {
  log('review found nothing to fix — done');
  return {
    review: review || 'produced in-run',
    planner: FABLE,
    batches: [],
    preexisting_dirty: PRE_DIRTY,
    signoff: 'nothing to fix',
  };
}
log(`plan: ${plan.batches.length} batch(es): ${plan.batches.map((b) => b.name).join(', ')}`);

// ---- Phase 2+3: sequential implement -> verify loop per batch -----------
// The implementer's change list used to be produced "for the verifier" and then discarded —
// agent() was called without a schema and its return value went nowhere, so the one artifact
// naming which tests were watched failing pre-fix never reached the verifier that was supposed
// to check it. It is also what the sign-off needs in order to commit by path instead of
// committing the whole shared tree.
const IMPL_SCHEMA = {
  type: 'object',
  required: ['files_changed', 'tests_added', 'tests_watched_failing', 'gate'],
  properties: {
    files_changed: {
      type: 'array',
      items: { type: 'string' },
      description: 'Every path you created or modified, repo-relative, verbatim.',
    },
    tests_added: {
      type: 'array',
      items: { type: 'string' },
      description: 'Each new or extended test, as "<file> :: <test name>".',
    },
    tests_watched_failing: {
      type: 'array',
      items: { type: 'string' },
      description:
        'The subset of tests_added you actually ran and watched FAIL before writing the fix. A test not listed here did not prove a regression.',
    },
    gate: {
      type: 'string',
      description:
        'Result of the four gate commands: pass/fail each, and the test pass/skip counts.',
    },
  },
};
const VERDICT_SCHEMA = {
  type: 'object',
  required: ['approved', 'feedback', 'boundary_probes'],
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
  let implReport = null;
  let verdict = { approved: false, feedback: 'never ran', boundary_probes: '' };
  while (attempt < MAX_ATTEMPTS) {
    attempt += 1;
    const done =
      results.map((r) => `${r.batch}: ${r.approved ? 'landed' : 'landed unapproved'}`).join('; ') ||
      'none yet';
    implReport = await agent(
      `You are the implementer. ${HOUSE}

Shared context from the planner: ${plan.shared_context}
Batches already implemented this run (their changes are in the working tree): ${done}

Implement this batch spec, TEST FIRST (write the failing regression tests, watch them fail on
the pre-fix code, then fix until green). Do not commit — a later sign-off step commits. Do not
touch anything outside the spec except where the spec's cleanup items say so.

You are the only agent in this round that writes code, so the guards are yours to preserve.
Follow CLAUDE.md as written; none of these may be weakened, moved or bypassed unless the spec
above says so outright: requireGitProject first in a git-backed tool, a mutating tool inside
runExclusive, a .bib write behind confirmBibEdit, an edit to the extra writing guide behind
confirmGuideEdit, recordBaseline only on a read that handed the caller a whole file, symlink
resolution on every path with strictLinks for a server-picked one, ff-only pull and a push that
refuses when behind, a shadow-store conflicted flag that stays flagged, an error snippet only
for a log-vouched location, and --literal-pathspecs on any git call taking a caller-named path.
If the spec asks you to change one, say so explicitly in your report rather than doing it
quietly.

To watch a test fail on the pre-fix code, write the test FIRST and run it before you write the
fix — that ordering is the whole point, and it needs no rollback at all.

Never roll the tree back to manufacture a pre-fix state. No git command that changes the
working tree, the index, refs or the stash — not \`stash\`, \`checkout\`, \`restore\`,
\`reset\`, \`clean\`, \`switch\`, \`worktree\`, \`rebase\` or \`commit\`; \`git diff\`,
\`log\`, \`show\` and \`status\` only. And no hand equivalent either: editing a source file to
remove a fix and editing it back is the same rollback without git's safety, and if you stop
between the two edits the round is silently corrupted. This checkout is shared with other agent
sessions and holds every earlier batch of this round, all uncommitted; the stash stack is
repo-global, so a stash here surfaces in a sibling worktree and a stash left unpopped discards
the round. If a test could not be watched failing first, say so in tests_watched_failing rather
than reconstructing the past.

${batch.spec}
${feedback ? `\nA verifier rejected your previous attempt. Address every point:\n${feedback}` : ''}

Run the gate before finishing, and report it as raw data for the verifier — not prose for a
human. A test you did NOT watch fail before the fix must be reported as such: it proves
nothing, and saying so is a finding for the verifier to act on, never a line to smooth over.`,
      {
        model: 'sonnet',
        label: `impl:${batch.name}#${attempt}`,
        phase: 'Implement',
        agentType: 'implementer',
        schema: IMPL_SCHEMA,
      },
    );
    if (!implReport) {
      verdict = {
        approved: false,
        feedback: 'implementer returned nothing — nothing to verify',
        boundary_probes: '',
      };
      log(`${batch.name}: implementer returned nothing on attempt ${attempt}`);
      break;
    }
    verdict = await agent(
      `You are the adversarial verifier. ${HOUSE}

A batch of fixes was just implemented in the working tree (NOT committed — inspect with
git diff). The implementer reported this; treat it as a claim to check, not as evidence:

${JSON.stringify(implReport)}

Any test in tests_added but NOT in tests_watched_failing proves nothing about the defect it
claims to pin — say so and reject on it, rather than counting it as coverage.

The spec it had to satisfy:

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
3. Are the new tests real? Mutation-check BY REASONING: read the fix hunk, and say whether each
   new test would still pass with that hunk reverted, and whether it asserts observable
   behavior rather than an internal counter. Then cross-check \`tests_watched_failing\` above —
   the implementer's own record of what it watched fail before the fix existed. A test it did
   not watch fail is unproven; treat that as the finding, not as something to go and prove.
   Do not reconstruct the pre-fix state to check. The tree holds
   this batch's fix, every earlier batch of this round and any peer's in-flight work, none of it
   committed; the stash stack is repo-global, so a stash surfaces in sibling worktrees and one
   left unpopped discards the round. A copy in the scratchpad does not help: the test imports
   the module by its real path, so it would exercise the untouched original and look vacuous
   when it is not. Reason about it, or reject for lack of evidence.

   You have NO authority to change the tree, for ANY purpose — not to mutation-check, not to
   rebase, not to tidy, not to undo something you typed. No git command that changes the working
   tree, the index, refs or the stash: not \`stash\`, \`checkout\`, \`restore\`, \`reset\`,
   \`clean\`, \`switch\`, \`worktree\`, \`rebase\`, \`merge\`, \`add\` or \`commit\`.
   \`git diff\`, \`log\`, \`show\` and \`status\` only. And no hand edit-and-revert of a
   source file either — that is the same rollback without git's safety net, and if you stop
   between the two edits the round is silently corrupted. You verify; you never write.
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
        agentType: 'plan-verifier',
      },
    );
    if (!verdict) {
      verdict = { approved: false, feedback: 'verifier returned nothing', boundary_probes: '' };
      log(`${batch.name}: verifier returned nothing on attempt ${attempt}`);
      break;
    }
    if (verdict.approved) break;
    feedback = verdict.feedback;
    log(`${batch.name}: rejected on attempt ${attempt} — ${feedback.slice(0, 120)}`);
  }
  results.push({
    batch: batch.name,
    approved: verdict.approved,
    attempts: attempt,
    notes: verdict.feedback,
    boundary_probes: verdict.boundary_probes,
    files: implReport ? implReport.files_changed : [],
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
2. Look at the remote; change nothing. Run \`git fetch origin\`, then
   \`git rev-list --count HEAD..${BASE}\` and REPORT the number. Do not act on it: being behind
   ${BASE} does not stop this round and is not a reason to withhold the commit. It does not
   block the push either — you push to this branch, not to ${BASE} — it only means a human will
   rebase before merge. Never rebase or merge here yourself: the tree is uncommitted from the
   first batch onward, git refuses to rebase a dirty tree ("Please commit or stash them"), and
   the stash it suggests is forbidden. CLAUDE.md's own rule for this server is that conflicts
   fail safe and are never auto-merged; an unattended agent resolving someone else's conflict
   is exactly what that rule forbids.
   You have NO authority to change the tree with git, for any purpose: no \`stash\`,
   \`reset\`, \`checkout\`, \`restore\`, \`clean\`, \`switch\`, \`worktree\`, \`rebase\`
   or \`merge\` — \`git diff\`/\`log\`/\`show\`/\`status\` only, plus the one
   \`git add\`/\`commit\`/\`push\` sequence in step 5. The stash stack is repo-global: a stash
   here surfaces in sibling worktrees and discards the round.
   Then run the complete gate. Fix trivial gate failures (a prettier reflow, a lint autofix,
   an import) yourself, but ONLY in the paths this round's batches claim — a repo-wide
   \`npm run format\` reflows a peer's in-flight file, which is their work, not yours.
   Anything substantive gets reported, not patched. Remember that \`npm run lint\` does not
   read .claude/**, so for a diff there a green lint says nothing.
3. Self-review for the boundary class: for every guard in the diff, name the value just
   outside it and confirm a test covers it — in the right tier (a TeX-gated smoke does not
   count as coverage on machines without latexmk).
4. Check the invariants that span batches: a commit still contains one session's lines only
   (shadow store / commitContents untouched or deliberately changed), no credential can reach
   disk or a result message, and errors stay token-scrubbed.
${
  COMMIT && unapproved.length === 0
    ? `5. If and only if the gate is green and you found no substantive problem: commit and push.
   FIRST, before \`git add\` and before anything else in this step, re-check the branch: run
   \`git branch --show-current\`. Stop unless it is exactly ${currentBranch} — the branch a
   preflight measured before this round began — and stop if it is empty, dev, main or master.
   The preflight already refused those, but this checkout is shared and a peer session can
   switch branches while a round is in flight; the measurement that decides is the one taken
   immediately before the commit, not the one taken before the first batch.
   Then commit BY PATH — \`git add\` exactly the paths this round's batches reported changing, listed
   above, and nothing else. Never \`git add -A\`, never \`git commit -a\`, never "commit
   everything": this checkout is shared with other agent sessions, and CLAUDE.md's longest
   section exists to guarantee that a commit contains one session's lines and nobody else's —
   do not break by hand the invariant this repo builds a shadow store to keep.${
     PRE_DIRTY.length
       ? ` These paths were already modified before the round began and are a peer's in-flight work — they must NOT be committed: ${PRE_DIRTY.join(', ')}.`
       : ''
   }
   If \`git status --porcelain\` shows a modified path that no batch claims AND that was not in
   the pre-existing list above, stop and report it rather than committing it — it appeared
   during the round and nobody here owns it. A path already in that list is expected: leave it
   uncommitted and carry on. Write a message describing the round, with the Co-Authored-By
   trailer per house style.
   Then \`git push\` plainly. Never \`--force\` and never \`--force-with-lease\`: nothing in
   this round rewrites history, so a rejected push means the remote moved under you — stop and
   report it for a human, exactly as step 2 does.`
    : `5. DO NOT COMMIT: ${unapproved.length ? `batches not approved: ${unapproved.map((r) => r.batch).join(', ')}` : 'commit disabled by args'}. Leave the tree for a human.`
}

Your final text: gate result, whether you committed (and the SHA), unresolved concerns.`,
  { model: FABLE, label: 'sign-off', phase: 'Sign-off' },
);

return {
  review: review || 'produced in-run',
  planner: FABLE,
  batches: results,
  preexisting_dirty: PRE_DIRTY,
  signoff: signoff ?? 'sign-off returned nothing — tree left uncommitted for a human',
};
