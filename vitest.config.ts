import { defineConfig } from 'vitest/config';

// Integration tests shell out to real git against a file:// bare repo, and a Windows CI runner
// runs those spawns roughly 10x slower than a Linux one: the same suite takes ~50s of test time
// on ubuntu and ~460s on windows-latest. The default 5s per-test timeout trips everywhere, and
// 30s -- "ample headroom" when it was written -- is not, because 10x is the MEDIAN and the tail
// is worse. Two tests costing 1.5s locally hit the 30s wall on windows (a 20x factor) on a commit
// whose windows job passed in a concurrent run of the identical tree, which is what tells a slow
// test from a hung one. Chasing the individual test does not close this: the flake has already
// moved from pushConflictBudget to safePush, and any git-heavy test whose windows time lands in
// that tail is next.
//
// So the budget is per-platform. Windows gets 90s, which is ~40x the slowest integration test's
// local cost (2.3s) and ~4x its typical windows cost; everywhere else stays at 30s, so a test
// that genuinely hangs still surfaces in 30s in the job people actually watch. Raise the local
// cost of a test and this does NOT excuse you -- it buys tail headroom, not a licence to make a
// fixture expensive. Unit tests finish in milliseconds regardless.
const IS_WINDOWS = process.platform === 'win32';
const TEST_TIMEOUT_MS = IS_WINDOWS ? 90_000 : 30_000;

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: TEST_TIMEOUT_MS,
    hookTimeout: TEST_TIMEOUT_MS,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
    },
  },
});
