// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    // `.claude/` holds agent scratch space and worktrees (a nested checkout of this repo), which
    // must not be linted — a second tsconfig root there breaks typed linting.
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '.claude/**'],
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
  prettier,
);
