import { join } from 'node:path';
import dotenv from 'dotenv';
import postgres from 'postgres';
import { runMigrate, type Io, type MigrateConnectionOptions, type RawDb, type RawTx, type Row } from './db-migrate-core.js';

dotenv.config({ quiet: true });

// The guarded migration runner (Batch 3.5). `npm run db:migrate` is a PLAN and never writes.
// Applying needs `--apply --confirm-plan=<fingerprint>` from a plan that was reviewed. See scripts/db-migrate-core.ts.
// This file only connects the flow to the real driver. All the checks live in the core and are tested offline.

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
  console.error('migrate: gave up after 10 minutes.');
  process.exit(1);
}, 600_000);
watchdog.unref();

process.exitCode = await runMigrate({
  env: process.env,
  argv: process.argv.slice(2),
  migrationsDir: join(import.meta.dirname, '..', 'drizzle'),
  connect,
  io,
});
