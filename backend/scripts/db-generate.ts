import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { normaliseGeneratedMigrations, snapshotSqlFiles } from './migration-sql.js';

// The project's migration-generation command: `npm run db:generate [-- --name=<name>] [-- --custom]`.
// It runs `drizzle-kit generate`, then normalises the geography type in the migration files that run created.
// It works offline: no .env is loaded, no database variable is passed on, and drizzle-kit is given no credentials.
// Calling `drizzle-kit generate` directly is not the project workflow (it would leave "geography(Point,4326)" quoted).

const backendRoot = resolve(import.meta.dirname, '..');
const migrationsDir = join(backendRoot, 'drizzle'); // must match `out` in drizzle.config.ts
const drizzleKit = join(backendRoot, 'node_modules', 'drizzle-kit', 'bin.cjs');

// Only the flags this project uses. Anything that could redirect the output folder or the schema is refused,
// because the wrapper watches the configured migrations folder.
const ALLOWED_FLAGS = [/^--name=.+$/, /^--custom$/];

function fail(message: string): number {
  console.error(`db-generate: ${message}`);
  return 1;
}

function offlineEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(DATABASE_URL|TEST_DATABASE_URL|CONFIRM_|PG)/i.test(key)) continue;
    env[key] = value;
  }
  return env;
}

function main(): number {
  const args = process.argv.slice(2);
  const refused = args.filter((arg) => !ALLOWED_FLAGS.some((pattern) => pattern.test(arg)));
  if (refused.length > 0) return fail(`unsupported argument(s): ${refused.join(' ')}. Allowed: --name=<name>, --custom.`);
  if (!existsSync(drizzleKit)) return fail('drizzle-kit is not installed. Run npm install first.');
  if (!existsSync(migrationsDir)) return fail(`migrations folder not found: ${migrationsDir}`);

  const before = snapshotSqlFiles(migrationsDir);
  const run = spawnSync(process.execPath, [drizzleKit, 'generate', ...args], {
    cwd: backendRoot,
    env: offlineEnvironment(),
    stdio: 'inherit',
  });
  if (run.error) return fail(`could not start drizzle-kit: ${run.error.message}`);
  if (run.status !== 0) return fail(`drizzle-kit generate exited with status ${run.status ?? 'unknown'}. No files were normalised.`);

  const results = normaliseGeneratedMigrations(migrationsDir, before);
  if (results.length === 0) {
    console.log('db-generate: no migration file was created or changed.');
    return 0;
  }
  for (const { file, replacements } of results) {
    console.log(`db-generate: ${file}: ${replacements === 0 ? 'no geography type to normalise' : `normalised ${replacements} geography type(s) to geography(Point,4326)`}`);
  }

  const unfixable = results.filter((r) => r.remainingQuotedTypes.length > 0);
  for (const { file, remainingQuotedTypes } of unfixable) {
    console.error(`db-generate: ${file} still has quoted type(s) that Postgres would reject: ${remainingQuotedTypes.join(', ')}`);
  }
  return unfixable.length > 0 ? fail('drizzle-kit quoted a type this wrapper does not handle. Fix the generated file before using it.') : 0;
}

process.exitCode = main();
