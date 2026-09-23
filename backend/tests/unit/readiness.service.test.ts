import { afterEach, describe, expect, it, vi } from 'vitest';

// Replaces src/db/connection.ts entirely, so this file never constructs a real postgres.js client and never
// opens a network connection, regardless of what DATABASE_URL happens to be set to.
vi.mock('../../src/db/connection.js', () => ({ sql: vi.fn() }));

import { sql } from '../../src/db/connection.js';
import { DATABASE_CHECK_TIMEOUT_MS, getReadinessReport, withTimeout } from '../../src/services/readiness.service.js';

const mockSql = vi.mocked(sql);

afterEach(() => {
  mockSql.mockReset();
});

describe('withTimeout', () => {
  it('resolves with the value when the promise settles before the deadline', async () => {
    await expect(withTimeout(Promise.resolve('value'), 50)).resolves.toBe('value');
  });

  it('rejects with the original error when the promise rejects before the deadline', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 50)).rejects.toThrow('boom');
  });

  it('rejects with a timeout error when the promise has not settled by the deadline', async () => {
    await expect(withTimeout(new Promise(() => undefined), 10)).rejects.toThrow(/timed out/);
  });

  it('clears its own timer once the promise settles, so a later deadline cannot also reject it', async () => {
    vi.useFakeTimers();
    try {
      const settled = withTimeout(Promise.resolve('x'), 100_000);
      await vi.advanceTimersByTimeAsync(0); // let the already-resolved promise's .then run
      vi.advanceTimersByTime(200_000); // if the timer were still armed, this moves past its deadline
      await expect(settled).resolves.toBe('x');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the readiness report', () => {
  it('reports "ready" with database "ok" when the query resolves within the timeout', async () => {
    mockSql.mockResolvedValueOnce([{ '?column?': 1 }] as never);
    const report = await getReadinessReport();
    expect(report).toEqual({ status: 'ready', checks: { config: 'ok', database: 'ok' } });
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('reports "not_ready" with database "fail" when the query rejects, and leaks no connection detail to the response or the log', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    mockSql.mockRejectedValueOnce(new Error('password authentication failed for host 10.0.0.5 secret-token'));
    const report = await getReadinessReport();
    expect(report).toEqual({ status: 'not_ready', checks: { config: 'ok', database: 'fail' } });
    const logged = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).not.toMatch(/10\.0\.0\.5|secret-token|password authentication/);
    expect(logged).toContain('"check":"database"');
    logSpy.mockRestore();
  });

  it('reports "not_ready" with database "fail" when the query does not settle within the configured timeout', async () => {
    vi.useFakeTimers();
    try {
      mockSql.mockReturnValueOnce(new Promise(() => undefined) as never);
      const reportPromise = getReadinessReport();
      await vi.advanceTimersByTimeAsync(DATABASE_CHECK_TIMEOUT_MS + 1);
      await expect(reportPromise).resolves.toEqual({ status: 'not_ready', checks: { config: 'ok', database: 'fail' } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('never reports "not_implemented" for the database check, in either outcome', async () => {
    mockSql.mockResolvedValueOnce([] as never);
    const ready = await getReadinessReport();
    mockSql.mockRejectedValueOnce(new Error('x'));
    const notReady = await getReadinessReport();
    expect([ready.checks.database, notReady.checks.database]).toEqual(['ok', 'fail']);
  });
});

describe('the approved database check timeout', () => {
  it('is exactly 2000ms', () => {
    expect(DATABASE_CHECK_TIMEOUT_MS).toBe(2000);
  });
});
