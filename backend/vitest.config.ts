import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Unit tests only. Database tests (tests/db) arrive in Batch 3.7 and are run separately.
    include: ['tests/unit/**/*.test.ts'],
  },
});
