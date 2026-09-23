import { describe, expect, it } from 'vitest';
import { ALL_EXPECTED_TABLES, REFERENCE_TABLES, RESET_STATEMENT, RESET_TABLES, tableSetMismatch } from '../../tests/db/reset-tables.js';

// Offline: this file imports only the pure comparison logic (reset-tables.ts), never the live database code in
// tests/db/reset.ts. It exists to prove the safeguard's LOGIC is correct without ever touching a database.

describe('the hard-coded reset allowlist', () => {
  it('has exactly the 40 tables Batch 3.4 created, excluding request_transitions', () => {
    expect(RESET_TABLES).toHaveLength(40);
    expect(new Set(RESET_TABLES).size).toBe(40); // no duplicates
    expect(RESET_TABLES).not.toContain('request_transitions');
    expect(RESET_TABLES).not.toContain('analytics_daily'); // deferred in Batch 3.4, does not exist
  });

  it('keeps request_transitions as the one reference table, and the combined set has 41 names', () => {
    expect(REFERENCE_TABLES).toEqual(['request_transitions']);
    expect(ALL_EXPECTED_TABLES).toHaveLength(41);
    expect(new Set(ALL_EXPECTED_TABLES).size).toBe(41);
  });

  it('builds the TRUNCATE statement from the hard-coded array itself, listing every reset table and no other', () => {
    expect(RESET_STATEMENT).toMatch(/^TRUNCATE TABLE ".+" RESTART IDENTITY CASCADE$/);
    for (const table of RESET_TABLES) expect(RESET_STATEMENT).toContain(`"${table}"`);
    expect(RESET_STATEMENT).not.toContain('"request_transitions"');
    expect(RESET_STATEMENT.split(',')).toHaveLength(RESET_TABLES.length);
  });
});

describe('tableSetMismatch: the fail-closed check that runs before every reset', () => {
  it('finds no mismatch when the live set exactly equals the expected 41 tables, in any order', () => {
    expect(tableSetMismatch([...ALL_EXPECTED_TABLES])).toBeNull();
    expect(tableSetMismatch([...ALL_EXPECTED_TABLES].reverse())).toBeNull();
  });

  it('reports a missing table (for example: migrations not yet applied to this branch)', () => {
    const missingOne = ALL_EXPECTED_TABLES.filter((t) => t !== 'ml_model_versions');
    const problems = tableSetMismatch(missingOne);
    expect(problems).toEqual(['missing: ml_model_versions']);
  });

  it('reports every missing table when the live schema is completely empty', () => {
    const problems = tableSetMismatch([]);
    expect(problems).toHaveLength(41);
    expect(problems).toEqual(ALL_EXPECTED_TABLES.map((t) => `missing: ${t}`));
  });

  it('reports an unexpected table (for example: a stray table left over from something else)', () => {
    const problems = tableSetMismatch([...ALL_EXPECTED_TABLES, 'some_other_table']);
    expect(problems).toEqual(['unexpected: some_other_table']);
  });

  it('reports both kinds of difference together, and treats request_transitions as required, not as an extra', () => {
    const withoutReference = RESET_TABLES; // request_transitions missing, plus one stray table
    const problems = tableSetMismatch([...withoutReference, 'evil_table']);
    expect(problems).toContain('missing: request_transitions');
    expect(problems).toContain('unexpected: evil_table');
    expect(problems).toHaveLength(2);
  });

  it('is not fooled by a table name that merely contains an expected name as a substring', () => {
    const problems = tableSetMismatch([...ALL_EXPECTED_TABLES, 'users_backup']);
    expect(problems).toContain('unexpected: users_backup');
  });
});
