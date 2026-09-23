import { join } from 'node:path';
import dotenv from 'dotenv';
import postgres from 'postgres';
import { runMigrate, type Io, type MigrateConnectionOptions, type RawDb, type RawTx, type Row } from './db-migrate-core.js';
import { checkTestTarget } from './db-migrate-plan.js';

dotenv.config({ quiet: true });

// The guarded migration runner for the TEST branch (Batch 3.7, D1). This mirrors db-migrate.ts exactly, except it
// resolves its target with checkTestTarget instead of the default (dev) checkTarget (D2): a separate entry point
// so the dev and test paths can never be confused with each other, sharing the same core apply/verify engine so
// the test branch gets exactly the same scanner, one-transaction-per-migration, tracking table and
// plan-fingerprint confirmation as dev (D4). `npm run db:test:migrate` is a PLAN and never writes.
// Applying needs `--apply --confirm-plan=<fingerprint>` from a plan that was reviewed.

const io: Io = {
  line: (label, text) => console.log(`${label.padEnd(30)} ${text}`),
  text: (message) => console.log(message),
  error: (message) => console.error(message),
};

function connect(options: MigrateConnectionOptions): RawDb {
  const sql = postgres(options);
  const adapt = (tx: postgres.TransactionSql): RawTx => ({
    unsafe: async (statement, params) => [...(await tx.unsafe(statement, params ? [...params] : []))] as Row[],
  });
  return {
    async begin<T>(mode: 'read only' | 'read write', work: (tx: RawTx) => Promise<T>): Promise<T> {
      const run = mode === 'read only' ? sql.begin('read only', (tx) => work(adapt(tx))) : sql.begin((tx) => work(adapt(tx)));
      return (await run) as T;
    },
    end: () => sql.end({ timeout: 5 }),
  };
}

const watchdog = setTimeout(() => {
  console.error('db-test-migrate: gave up after 10 minutes.');
  process.exit(1);
}, 600_000);
watchdog.unref();

process.exitCode = await runMigrate({
  env: process.env,
  argv: process.argv.slice(2),
  migrationsDir: join(import.meta.dirname, '..', 'drizzle'),
  connect,
  io,
  checkTarget: checkTestTarget,
});
