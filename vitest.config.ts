import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Each DB-backed test file spins up its own PGlite (WASM Postgres)
    // instance and migrates it. Running many of those fully in parallel in
    // a resource-constrained sandbox causes real timeouts, not test bugs —
    // capping worker concurrency trades a bit of wall-clock time for
    // reliability. Individual git-plumbing/git-worktree tests are also
    // real subprocess-heavy work, same reasoning.
    maxWorkers: 4,
    minWorkers: 1,
    testTimeout: 30_000,
  },
});
