import { log } from '../utils/logger.js';

export type CheckResult = 'ok' | 'fail' | 'not_implemented';

export interface ReadinessReport {
  status: 'ready' | 'not_ready';
  checks: Record<string, CheckResult>;
}

type ReadinessCheck = () => CheckResult | Promise<CheckResult>;

// PHASE 2 LIMITATION (documented in the root README; API.md is unchanged).
// API.md section 3 requires /ready to verify that the database answers. Phase 2 must not connect to
// Neon or run any query, so the database check is a placeholder that reports "not_implemented".
// The database/backend infrastructure phase replaces it with a real check that returns "ok" or "fail".
const checks: Record<string, ReadinessCheck> = {
  // The environment is validated in config/env.ts and the process exits at startup if it is invalid,
  // so a running server has, by definition, loaded its configuration.
  config: () => 'ok',
  database: () => 'not_implemented',
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
