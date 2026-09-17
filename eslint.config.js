// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    // `.claude/` holds agent scratch space and worktrees (a nested checkout of this repo), which
    // must not be linted — a second tsconfig root there breaks typed linting. That stays true of
    // everything under `.claude/` EXCEPT `workflows/`, which holds the Workflow scripts that
    // review, commit and push this repo unattended and had no automated check but prettier.
    //
    // The pattern is `.claude/*`, not `.claude/**`, and that distinction is load-bearing rather
    // than cosmetic: in flat config a directory ignored with `/**` is skipped whole, and nothing
    // inside it can be unignored afterwards — `['.claude/**', '!.claude/workflows']` silently
    // lints nothing. `.claude/*` ignores each direct child instead, so the negation can take one
    // of them back. Every other child, a nested worktree included, is still skipped as a
    // directory before eslint descends into it.
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '.claude/*', '!.claude/workflows'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // The reference backends each used to declare their own `REQUEST_TIMEOUT_MS = 15_000`
    // while `transportReason` quoted the shared one in "timed out after 15s" — so a drift in
    // any copy made the error message lie, and nothing in the suite could see it (a test would
    // have to wait out a real 15s timeout). The constant now has one home,
    // `src/services/referenceBackend.ts`, and this rule is what keeps it there: a
    // re-declaration is caught by the gate rather than by a user reading a wrong number.
    // Scoped to the three reference backends, not all of `src/services`: `doctor.ts` has its
    // own, unrelated `NETWORK_TIMEOUT_MS` for its reachability probe, and nothing reports that
    // one back to a caller. The hazard is specific to the clients whose transport errors
    // `transportReason` words.
    //
    // The scope is three LITERAL paths, and nothing points back here from a backend file: **a
    // fourth backend must be added to this list by hand**, or it ships outside every rule below
    // and the drift they exist to catch goes uncaught in the one file nobody thought to check.
    files: ['src/services/dblp.ts', 'src/services/crossref.ts', 'src/services/openalex.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'VariableDeclarator[id.name="REQUEST_TIMEOUT_MS"]',
          message:
            'Import REQUEST_TIMEOUT_MS from ./referenceBackend.js instead of re-declaring it — ' +
            'transportReason reports the shared value, so a local copy makes the timeout ' +
            'message lie.',
        },
        {
          // The rule above pins the NAME; this one pins the behaviour it was really after.
          // `const TIMEOUT = 20_000; AbortSignal.timeout(TIMEOUT)` renames its way past the
          // first rule and reproduces the hazard exactly — the reported timeout and the
          // applied one drift apart, and no test can see it without waiting out a real one.
          selector:
            'CallExpression[callee.object.name="AbortSignal"][callee.property.name="timeout"]:not([arguments.0.name="REQUEST_TIMEOUT_MS"])',
          message:
            'Pass the shared REQUEST_TIMEOUT_MS (from ./referenceBackend.js) to ' +
            'AbortSignal.timeout — transportReason reports that constant, so any other value ' +
            'makes the timeout message lie.',
        },
        {
          // And this one pins the hazard arriving under a different NAME. Both rules above are
          // written around `AbortSignal.timeout`, so the pre-17.3 idiom that predates it —
          // `const c = new AbortController(); setTimeout(() => c.abort(), 20_000);` — walks past
          // them reporting zero problems while reproducing the drift exactly: a timeout applied
          // here, a different one reported by transportReason. It is also the copy a contributor
          // is likeliest to paste, being what every older fetch-with-timeout snippet on the web
          // still shows. A blanket ban is the honest shape of the rule: a reference backend
          // issues one request and awaits it, so it has no legitimate use for a timer at all,
          // and "no setTimeout in these three files" needs no exception carved into it.
          // Both spellings: a bare `setTimeout(...)` and a qualified `globalThis.setTimeout(...)`
          // (or `global.`/`window.`). The name-bound selector alone let the qualified form through,
          // which is not a hypothetical — it is one keystroke from the form it does catch.
          selector:
            "CallExpression[callee.name='setTimeout'], CallExpression[callee.property.name='setTimeout']",
          message:
            'Do not hand-roll a request timeout with setTimeout + AbortController — pass the ' +
            'shared REQUEST_TIMEOUT_MS (from ./referenceBackend.js) to AbortSignal.timeout ' +
            'instead, since transportReason reports that constant and any separately applied ' +
            'delay makes the timeout message lie. A reference backend has no other use for a ' +
            'timer.',
        },
      ],
    },
  },
  {
    // The Workflow scripts unignored above. They are plain JavaScript, but they are not modules
    // and they are not scripts either: the Workflow tool wraps each file body in an async
    // function and calls it with its own globals injected. So two things have to be told to
    // eslint before `no-undef` says anything true about them.
    //
    // Do NOT reach for un-ignoring `.claude/**` wholesale instead. Measured on this config,
    // forced over review-round.js that way, eslint reports **32 problems, every one of them
    // `no-undef`** on these very globals — noise that buries the findings this block exists for.
    // Those findings are real: a review of review-round.js shipped a `const` declared inside a
    // retry loop and read after it, and a typo'd hook name, and neither was caught by anything
    // in CI. `no-undef` with the globals declared catches both and reports nothing else.
    //
    // `allowReturnOutsideFunction` is defence in depth, not load-bearing today, and the
    // difference matters if you are tempted to delete it as dead config. `#81` predicted a parse
    // error on the top-level `return`; there is none, because `tseslint.configs.recommended`
    // carries no `files:` restriction and so claims `.js` too, making
    // `typescript-eslint/parser` the effective parser here — and it accepts a top-level `return`
    // silently. Under espree the same file is a single `Parsing error: 'return' outside of
    // function` and NO rule messages at all, since a parse error suppresses them. So the option
    // buys nothing now and everything if the parser is ever swapped back.
    //
    // The scope is `**/*.js` rather than `*.js` because the ignore above hands back the whole
    // `workflows/` directory: a file in a subdirectory of it would otherwise be linted by
    // eslint:recommended's own `no-undef` with none of these globals declared, and report every
    // `agent`/`phase` call as undefined. The honest cost of that widening: anything ever placed
    // under `.claude/workflows/` is linted, and linted with `agent`/`phase`/`log` declared as
    // globals, which is wrong for ordinary code — so a nested checkout belongs in
    // `.claude/worktrees/` (still ignored) or outside `.claude/` entirely, never here.
    files: ['.claude/workflows/**/*.js'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        args: 'readonly',
        agent: 'readonly',
        parallel: 'readonly',
        pipeline: 'readonly',
        phase: 'readonly',
        log: 'readonly',
        workflow: 'readonly',
        budget: 'readonly',
      },
      // A Workflow script's body IS a function body, so its top-level `return` is legal and
      // must not be reported as a parse error.
      parserOptions: { allowReturnOutsideFunction: true },
    },
    rules: {
      // Already on via eslint:recommended; named here because it is the entire point of the
      // block, and because a future edit to the shared rule set must not be able to switch it
      // off here by accident.
      'no-undef': 'error',
    },
  },
  prettier,
);
