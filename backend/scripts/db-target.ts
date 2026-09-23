import dotenv from 'dotenv';
import {
  GuardError,
  formatTarget,
  parseTarget,
  resolveConfirmedTarget,
  resolveConfirmedTestTarget,
} from '../src/db/guard.js';

dotenv.config({ quiet: true });

// Prints which database the db scripts would act on: host and database name only, never credentials.
// It reads environment variables and does NOT connect to anything.
function line(label: string, text: string): void {
  console.log(`${label.padEnd(20)} ${text}`);
}

function explain(error: unknown): string {
  return error instanceof GuardError ? `NOT confirmed. ${error.message}` : 'NOT confirmed (unexpected error).';
}

function main(): number {
  const env = process.env;
  let ok = true;

  const devUrl = env.DATABASE_URL_DIRECT || env.DATABASE_URL;
  if (!devUrl) {
    line('dev target:', 'not set (DATABASE_URL_DIRECT or DATABASE_URL)');
    ok = false;
  } else {
    try {
      const source = env.DATABASE_URL_DIRECT ? 'DATABASE_URL_DIRECT' : 'DATABASE_URL';
      line('dev target:', `${formatTarget(parseTarget(devUrl))}  (from ${source})`);
      resolveConfirmedTarget(env, 'probe');
      line('dev confirmation:', 'CONFIRMED (CONFIRM_DB_HOST matches)');
    } catch (error) {
      line('dev confirmation:', explain(error));
      ok = false;
    }
  }

  if (!env.TEST_DATABASE_URL) {
    line('test target:', 'not set (only needed for database tests)');
  } else {
    try {
      line('test target:', formatTarget(parseTarget(env.TEST_DATABASE_URL)));
      resolveConfirmedTestTarget(env);
      line('test confirmation:', 'CONFIRMED (CONFIRM_TEST_DB_HOST matches, and it is not the dev database)');
    } catch (error) {
      line('test confirmation:', explain(error));
      ok = false;
    }
  }

  return ok ? 0 : 1;
}

process.exitCode = main();
