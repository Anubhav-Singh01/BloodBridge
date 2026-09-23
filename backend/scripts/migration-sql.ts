import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Helpers for `npm run db:generate` (scripts/db-generate.ts). Offline: they only read and write migration files.
//
// Why this exists: drizzle-kit 0.31.10 wraps every column type that is not on its built-in list in double quotes.
// `geometry` is on that list and `geography` is not, so our geography(Point,4326) columns come out as
// "geography(Point,4326)". Postgres reads that as one identifier and the migration fails. The custom column type
// (src/db/schema/geography.ts) is correct; only the SQL drizzle-kit writes for it needs the quotes removed.

export const GEOGRAPHY_POINT = 'geography(Point,4326)';

const QUOTED_GEOGRAPHY_POINT = /"geography\(Point,4326\)"/;
// The three places where drizzle-kit writes a column type. The token is replaced only there, so the same text
// inside a string literal or a CHECK expression is never touched.
const TYPE_POSITIONS: RegExp[] = [
  new RegExp(String.raw`(^[ \t]+"[^"\n]+" )${QUOTED_GEOGRAPHY_POINT.source}`, 'gm'), // CREATE TABLE column definition
  new RegExp(String.raw`(ADD COLUMN "[^"\n]+" )${QUOTED_GEOGRAPHY_POINT.source}`, 'g'), // ALTER TABLE ... ADD COLUMN
  new RegExp(String.raw`(SET DATA TYPE )${QUOTED_GEOGRAPHY_POINT.source}`, 'g'), // ALTER COLUMN ... SET DATA TYPE
];

/** Replaces the exact quoted token "geography(Point,4326)" with geography(Point,4326) where a column type is written. */
export function unquoteGeographyPoint(sql: string): { sql: string; replacements: number } {
  let replacements = 0;
  let result = sql;
  for (const pattern of TYPE_POSITIONS) {
    result = result.replace(pattern, (_match, prefix: string) => {
      replacements += 1;
      return `${prefix}${GEOGRAPHY_POINT}`;
    });
  }
  return { sql: result, replacements };
}

/** Column definitions or type changes whose type is one quoted name containing parentheses, e.g. "geography(Point,4326)". */
export function findQuotedParenTypes(sql: string): string[] {
  const patterns = [
    /^[ \t]+"[^"\n]+" "[^"\n]*\([^"\n]*"/gm, // CREATE TABLE column definition
    /ADD COLUMN "[^"\n]+" "[^"\n]*\([^"\n]*"/g, // ALTER TABLE ... ADD COLUMN
    /SET DATA TYPE "[^"\n]*\([^"\n]*"/g, // ALTER TABLE ... ALTER COLUMN ... SET DATA TYPE
  ];
  return patterns.flatMap((p) => [...sql.matchAll(p)].map((m) => m[0].trim()));
}

/** File name to content hash for every .sql file directly inside `dir`. */
export function snapshotSqlFiles(dir: string): Map<string, string> {
  const snapshot = new Map<string, string>();
  for (const name of readdirSync(dir)) {
    if (name.endsWith('.sql')) snapshot.set(name, createHash('sha256').update(readFileSync(join(dir, name))).digest('hex'));
  }
  return snapshot;
}

/** Names of the files that are new in `after` or whose content differs from `before`. */
export function changedFiles(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...after].filter(([name, hash]) => before.get(name) !== hash).map(([name]) => name).sort();
}

export interface RewriteResult {
  file: string;
  replacements: number;
  /** Quoted parenthesised types still present after the rewrite (a type this tool does not know how to fix). */
  remainingQuotedTypes: string[];
}

/**
 * Normalises the geography type in exactly the migration files that a generate run created or changed
 * (compared with the `before` snapshot). Files that were not touched by the run are never read for rewriting.
 */
export function normaliseGeneratedMigrations(dir: string, before: Map<string, string>): RewriteResult[] {
  const results: RewriteResult[] = [];
  for (const file of changedFiles(before, snapshotSqlFiles(dir))) {
    const path = join(dir, file);
    const original = readFileSync(path, 'utf8');
    const { sql, replacements } = unquoteGeographyPoint(original);
    if (replacements > 0) writeFileSync(path, sql, 'utf8');
    results.push({ file, replacements, remainingQuotedTypes: findQuotedParenTypes(sql) });
  }
  return results;
}
