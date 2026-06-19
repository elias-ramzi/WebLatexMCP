import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Integration tests shell out to real git against a file:// bare repo; Windows CI
    // runners are slow enough that the default 5s per-test timeout trips. 30s is ample
    // headroom and unit tests still finish in milliseconds regardless.
    testTimeout: 30000,
    hookTimeout: 30000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
    },
  },
});
