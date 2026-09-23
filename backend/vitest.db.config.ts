import { defineConfig } from 'vitest/config';

// Batch 3.7: the database-integration test suite. A SEPARATE config from vitest.config.ts (which `npm test`
// uses and which only ever includes tests/unit/**), so there is no path by which the plain, always-offline
// `npm test` command can reach these files.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/db/**/*.db.test.ts'],
    globalSetup: ['tests/db/setup.ts'],
    // D7: sequential, not the default parallel workers. Bounds how many direct (non-pooled) connections this
    // suite opens against Neon at once, and keeps the concurrency tests' timing predictable.
    fileParallelism: false,
    // Some tests hold a transaction open across two reserved connections while orchestrating a race.
    testTimeout: 30_000,
  },
});
