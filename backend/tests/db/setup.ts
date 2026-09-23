import { RESET_TABLES } from './reset-tables.js';
import { verifyAndReset } from './reset.js';
import { closeTestPool, endpointLabel, sql, testTarget } from './helpers.js';

// Vitest globalSetup for tests/db (Batch 3.7). Importing helpers.js above already resolved and confirmed the
// test target (fail closed) before this function body runs at all.

export default async function setup(): Promise<() => Promise<void>> {
  console.log(`tests/db setup: target ${testTarget.host}/${testTarget.database}`);
  console.log(`tests/db setup: resetting ${RESET_TABLES.length} tables (request_transitions excluded)`);
  await verifyAndReset(sql, { database: testTarget.database, endpointLabel });
  console.log('tests/db setup: reset complete');

  return async () => {
    await closeTestPool();
  };
}
