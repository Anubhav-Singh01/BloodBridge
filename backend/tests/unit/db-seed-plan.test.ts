import { describe, expect, it } from 'vitest';
import { planPresence, planSettings } from '../../scripts/db-seed-plan.js';
import type { ReferenceSetting } from '../../src/db/seed/reference-data.js';

// Batch 3.8. Pure logic only - no database, no seed data files needed beyond the ReferenceSetting shape.

describe('planSettings', () => {
  const desired: readonly ReferenceSetting[] = [
    { key: 'batch.size', value: 20 },
    { key: 'batch.max_count', value: 5 },
  ];

  it('plans an INSERT for a key with no existing row', () => {
    const plan = planSettings(new Map(), desired);
    expect(plan.actions).toEqual([
      { key: 'batch.size', kind: 'insert', value: 20 },
      { key: 'batch.max_count', kind: 'insert', value: 5 },
    ]);
    expect(plan.hasMismatch).toBe(false);
  });

  it('plans a NOOP for a key whose existing value is identical', () => {
    const plan = planSettings(new Map([['batch.size', 20]]), [desired[0]!]);
    expect(plan.actions).toEqual([{ key: 'batch.size', kind: 'noop', value: 20 }]);
    expect(plan.hasMismatch).toBe(false);
  });

  it('plans a MISMATCH, never a silent overwrite, for a key whose existing value differs (the approved modification)', () => {
    const plan = planSettings(new Map([['batch.size', 99]]), [desired[0]!]);
    expect(plan.actions).toEqual([{ key: 'batch.size', kind: 'mismatch', expectedValue: 20, existingValue: 99 }]);
    expect(plan.hasMismatch).toBe(true);
  });

  it('sets hasMismatch true if even one of several keys mismatches, alongside otherwise-fine keys', () => {
    const plan = planSettings(new Map([['batch.size', 20]]), desired); // batch.max_count is missing (insert), batch.size matches (noop)
    expect(plan.hasMismatch).toBe(false);

    const withMismatch = planSettings(new Map([['batch.size', 20], ['batch.max_count', 999]]), desired);
    expect(withMismatch.actions.map((a) => a.kind)).toEqual(['noop', 'mismatch']);
    expect(withMismatch.hasMismatch).toBe(true);
  });

  it('compares by value, not by reference (JSON-equal counts as identical)', () => {
    // Every current settings value is a bare number, so this mostly documents intent for any future non-primitive value.
    const plan = planSettings(new Map([['batch.size', 20]]), [{ key: 'batch.size', value: 20 }]);
    expect(plan.actions[0]).toEqual({ key: 'batch.size', kind: 'noop', value: 20 });
  });
});

describe('planPresence', () => {
  it('splits desired keys into toInsert and alreadyPresent based on what already exists', () => {
    const plan = planPresence(new Set(['a', 'c']), ['a', 'b', 'c', 'd']);
    expect(plan.toInsert).toEqual(['b', 'd']);
    expect(plan.alreadyPresent).toEqual(['a', 'c']);
  });

  it('treats an empty existing set as everything needing insertion', () => {
    const plan = planPresence(new Set(), ['a', 'b']);
    expect(plan.toInsert).toEqual(['a', 'b']);
    expect(plan.alreadyPresent).toEqual([]);
  });

  it('treats every desired key already present as nothing needing insertion', () => {
    const plan = planPresence(new Set(['a', 'b']), ['a', 'b']);
    expect(plan.toInsert).toEqual([]);
    expect(plan.alreadyPresent).toEqual(['a', 'b']);
  });
});
