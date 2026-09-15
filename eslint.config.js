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
      ],
    },
  },
  prettier,
);
