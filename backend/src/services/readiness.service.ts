import { sql } from '../db/connection.js';
import { log } from '../utils/logger.js';

export type CheckResult = 'ok' | 'fail' | 'not_implemented';

export interface ReadinessReport {
  status: 'ready' | 'not_ready';
  checks: Record<string, CheckResult>;
}

type ReadinessCheck = () => CheckResult | Promise<CheckResult>;

// API.md section 3: the database check answers a trivial query within a short timeout, and its result is
// only ever "ok" or "fail" - never a connection string, host, version or error message.
export const DATABASE_CHECK_TIMEOUT_MS = 2000;

/** Rejects with a timeout error if `promise` has not settled within `ms`. Clears its own timer either way. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

const checks: Record<string, ReadinessCheck> = {
  // The environment is validated in config/env.ts and the process exits at startup if it is invalid,
  // so a running server has, by definition, loaded its configuration.
  config: () => 'ok',
  // A trivial, timed query against the connection src/db/connection.ts holds for the server's lifetime.
  // Any failure or timeout is caught below (by the shared catch in getReadinessReport) and reported as "fail".
  database: async (): Promise<CheckResult> => {
    await withTimeout(sql`SELECT 1`, DATABASE_CHECK_TIMEOUT_MS);
    return 'ok';
  },
};

export async function getReadinessReport(): Promise<ReadinessReport> {
  const results: Record<string, CheckResult> = {};

  for (const [name, run] of Object.entries(checks)) {
    try {
      results[name] = await run();
    } catch {
      // Only the check name is logged, and the response only ever says "fail": no error text leaves the server.
      log('warn', 'readiness check threw', { check: name });
      results[name] = 'fail';
    }
  }

  // "not_implemented" is a documented placeholder, not a failure.
  const ready = Object.values(results).every((result) => result !== 'fail');
  return { status: ready ? 'ready' : 'not_ready', checks: results };
}
