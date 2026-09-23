import type { ReferenceSetting } from '../src/db/seed/reference-data.js';

// Pure planning logic for scripts/db-seed.ts. No database access here - every function takes what's already
// been read from the database (or nothing, for reference constants) and returns what should happen, so this
// whole module can be unit tested offline (tests/unit/db-seed-plan.test.ts).

export type SettingsAction =
  | { key: string; kind: 'insert'; value: number }
  | { key: string; kind: 'noop'; value: number }
  | { key: string; kind: 'mismatch'; expectedValue: number; existingValue: unknown };

export interface SettingsPlan {
  actions: readonly SettingsAction[];
  hasMismatch: boolean;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * The approved-modification behavior: missing -> insert; identical -> noop; different -> mismatch. A mismatch
 * never becomes a write - scripts/db-seed.ts must refuse to apply anything at all when hasMismatch is true,
 * exactly as approved ("report a clear mismatch and fail the seed without modifying that setting").
 */
export function planSettings(existing: ReadonlyMap<string, unknown>, desired: readonly ReferenceSetting[]): SettingsPlan {
  const actions: SettingsAction[] = desired.map((row): SettingsAction => {
    if (!existing.has(row.key)) return { key: row.key, kind: 'insert', value: row.value };
    const existingValue = existing.get(row.key);
    return valuesEqual(existingValue, row.value)
      ? { key: row.key, kind: 'noop', value: row.value }
      : { key: row.key, kind: 'mismatch', expectedValue: row.value, existingValue };
  });
  return { actions, hasMismatch: actions.some((a) => a.kind === 'mismatch') };
}

export interface PresencePlan {
  toInsert: readonly string[];
  alreadyPresent: readonly string[];
}

/**
 * The simpler presence-only plan used for roles and for every demo-data table: a row's natural (or fixed) key
 * either already exists, in which case nothing happens (demo/reference identity rows are never diffed or
 * updated, only ever inserted-if-missing), or it doesn't, in which case it is inserted.
 */
export function planPresence(existingKeys: ReadonlySet<string>, desiredKeys: readonly string[]): PresencePlan {
  const toInsert: string[] = [];
  const alreadyPresent: string[] = [];
  for (const key of desiredKeys) {
    (existingKeys.has(key) ? alreadyPresent : toInsert).push(key);
  }
  return { toInsert, alreadyPresent };
}
