import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { is } from 'drizzle-orm';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { changedFiles, findQuotedParenTypes, normaliseGeneratedMigrations, snapshotSqlFiles, unquoteGeographyPoint } from '../../scripts/migration-sql.js';
import * as schema from '../../src/db/schema/index.js';

// Offline audits of the migration SQL text. They exist because drizzle-kit 0.31.10 has two generation quirks
// that only fail when a migration is applied to a real database (Batch 3.5):
//   1. It wraps any type outside its native-type list in double quotes, so a custom type such as
//      geography(Point,4326) is emitted as "geography(Point,4326)", which Postgres reads as one identifier.
//      `npm run db:generate` (scripts/db-generate.ts) fixes that; the audit below fails if any file still has it.
//   2. It emits ALTER TABLE ... ADD CONSTRAINT ... UNIQUE for an existing table at the END of the file, after
//      foreign keys that need that constraint. There is no automatic fix: move the statement by hand, and the
//      audit below fails until it is in the right place.

const drizzleDir = join(import.meta.dirname, '../../drizzle');

interface MigrationFile {
  name: string;
  sql: string;
}

const migrationFiles = (): MigrationFile[] =>
  readdirSync(drizzleDir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(drizzleDir, name), 'utf8') }));

const statementsOf = (sql: string): string[] =>
  sql
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

const columnList = (raw: string): string[] => raw.split(',').map((c) => c.trim().replaceAll('"', ''));
const setKey = (table: string, columns: string[]): string => `${table}(${[...columns].sort().join(',')})`;

/**
 * Finds composite foreign keys whose referenced column set has no PRIMARY KEY or full UNIQUE constraint
 * (or non-partial unique index) defined EARLIER in the migration order.
 */
export function findCompositeFkOrderViolations(files: MigrationFile[]): { fk: string; problem: string }[] {
  const uniqueAt = new Map<string, number>(); // "table(col,col)" -> position of the first statement that defines it
  const foreignKeys: { name: string; target: string; position: number }[] = [];
  let position = 0;

  for (const file of files) {
    for (const statement of statementsOf(file.sql)) {
      position += 1;
      const create = statement.match(/^CREATE TABLE (?:"[^"]+"\.)?"([^"]+)"/);
      if (create?.[1]) {
        for (const m of statement.matchAll(/(?:UNIQUE|PRIMARY KEY)\s*\(([^)]*)\)/g)) {
          const key = setKey(create[1], columnList(m[1] ?? ''));
          if (!uniqueAt.has(key)) uniqueAt.set(key, position);
        }
        continue;
      }
      const addUnique = statement.match(/^ALTER TABLE (?:"[^"]+"\.)?"([^"]+)" ADD CONSTRAINT "[^"]+" (?:UNIQUE|PRIMARY KEY)\s*\(([^)]*)\)/);
      if (addUnique?.[1]) {
        const key = setKey(addUnique[1], columnList(addUnique[2] ?? ''));
        if (!uniqueAt.has(key)) uniqueAt.set(key, position);
        continue;
      }
      const uniqueIndex = statement.match(/^CREATE UNIQUE INDEX "[^"]+" ON (?:"[^"]+"\.)?"([^"]+)" USING \w+ \(([^)]*)\)/);
      if (uniqueIndex?.[1] && !/\sWHERE\s/.test(statement)) {
        const key = setKey(uniqueIndex[1], columnList(uniqueIndex[2] ?? ''));
        if (!uniqueAt.has(key)) uniqueAt.set(key, position);
        continue;
      }
      const fk = statement.match(/^ALTER TABLE (?:"[^"]+"\.)?"[^"]+" ADD CONSTRAINT "([^"]+)" FOREIGN KEY \(([^)]+)\) REFERENCES (?:"[^"]+"\.)?"([^"]+)"\(([^)]+)\)/);
      if (fk?.[1] && columnList(fk[2] ?? '').length > 1) {
        foreignKeys.push({ name: fk[1], target: setKey(fk[3] ?? '', columnList(fk[4] ?? '')), position });
      }
    }
  }

  const violations: { fk: string; problem: string }[] = [];
  for (const fk of foreignKeys) {
    const definedAt = uniqueAt.get(fk.target);
    if (definedAt === undefined) violations.push({ fk: fk.name, problem: `no PRIMARY KEY or UNIQUE constraint on ${fk.target}` });
    else if (definedAt > fk.position) violations.push({ fk: fk.name, problem: `${fk.target} is made unique later in the migrations (statement ${definedAt}) than this foreign key (statement ${fk.position})` });
  }
  return violations;
}

const countCompositeFks = (files: MigrationFile[]): number =>
  files.reduce((n, f) => n + statementsOf(f.sql).filter((s) => /^ALTER TABLE .* FOREIGN KEY \("[^"]+","/.test(s)).length, 0);

describe('migration SQL audit: type declarations', () => {
  it('never wraps a parenthesised type in quotes (drizzle-kit emits "geography(Point,4326)")', () => {
    for (const file of migrationFiles()) expect({ file: file.name, quoted: findQuotedParenTypes(file.sql) }).toEqual({ file: file.name, quoted: [] });
  });

  it('declares every geography column of the schema unquoted, as geography(Point,4326)', () => {
    const exported: unknown[] = Object.values(schema);
    const geographyColumns = exported
      .filter((x): x is PgTable => is(x, PgTable))
      .flatMap((t) => getTableConfig(t).columns.filter((c) => c.getSQLType() === 'geography(Point,4326)'));
    const declared = migrationFiles().reduce((n, f) => n + (f.sql.match(/^[ \t]+"[^"\n]+" geography\(Point,4326\)/gm)?.length ?? 0), 0);
    expect(geographyColumns.length).toBeGreaterThan(0);
    expect(declared).toBeGreaterThanOrEqual(geographyColumns.length);
  });

  it('the quoted-type check flags the drizzle-kit output and accepts correct SQL (checks the check)', () => {
    expect(findQuotedParenTypes('CREATE TABLE "t" (\n\t"location" "geography(Point,4326)" NOT NULL\n);')).toEqual(['"location" "geography(Point,4326)"']);
    expect(findQuotedParenTypes('ALTER TABLE "t" ADD COLUMN "loc" "geography(Point,4326)";')).toHaveLength(1);
    expect(findQuotedParenTypes('ALTER TABLE "t" ALTER COLUMN "loc" SET DATA TYPE "geography(Point,4326)";')).toHaveLength(1);
    expect(findQuotedParenTypes('CREATE TABLE "t" (\n\t"location" geography(Point,4326) NOT NULL,\n\t"n" "kind"[] NOT NULL\n);')).toEqual([]);
    // Quotes and parentheses inside a CHECK expression must not be mistaken for a quoted type.
    expect(findQuotedParenTypes('\tCONSTRAINT "c" CHECK (("t"."status" = \'X\') = ("t"."ref" IS NOT NULL)),')).toEqual([]);
  });
});

describe('migration SQL audit: composite foreign key ordering', () => {
  it('makes every referenced column set unique before a composite foreign key uses it', () => {
    const files = migrationFiles();
    expect(countCompositeFks(files)).toBeGreaterThanOrEqual(6); // guards against a parser that silently finds nothing
    expect(findCompositeFkOrderViolations(files)).toEqual([]);
  });

  it('the ordering check flags a late or missing unique constraint and accepts a correct order (checks the check)', () => {
    const fk = 'ALTER TABLE "child" ADD CONSTRAINT "child_fk" FOREIGN KEY ("a","b") REFERENCES "public"."parent"("id","owner") ON DELETE restrict ON UPDATE no action;';
    const late = [{ name: '0001_x.sql', sql: `CREATE TABLE "parent" (\n\t"id" uuid PRIMARY KEY NOT NULL,\n\t"owner" uuid NOT NULL\n);\n--> statement-breakpoint\n${fk}--> statement-breakpoint\nALTER TABLE "parent" ADD CONSTRAINT "parent_key" UNIQUE("id","owner");` }];
    expect(findCompositeFkOrderViolations(late).map((v) => v.fk)).toEqual(['child_fk']);
    expect(findCompositeFkOrderViolations(late)[0]?.problem).toContain('later');

    const missing = [{ name: '0001_x.sql', sql: `CREATE TABLE "parent" (\n\t"id" uuid PRIMARY KEY NOT NULL\n);\n--> statement-breakpoint\n${fk}` }];
    expect(findCompositeFkOrderViolations(missing)[0]?.problem).toContain('no PRIMARY KEY or UNIQUE');

    const ordered = [{ name: '0001_x.sql', sql: `CREATE TABLE "parent" (\n\t"id" uuid PRIMARY KEY NOT NULL,\n\t"owner" uuid NOT NULL,\n\tCONSTRAINT "parent_key" UNIQUE("owner","id")\n);\n--> statement-breakpoint\n${fk}` }];
    expect(findCompositeFkOrderViolations(ordered)).toEqual([]);

    // A partial unique index cannot back a foreign key.
    const partial = [{ name: '0001_x.sql', sql: `CREATE UNIQUE INDEX "p" ON "parent" USING btree ("id","owner") WHERE "parent"."x" = 1;--> statement-breakpoint\n${fk}` }];
    expect(findCompositeFkOrderViolations(partial)).toHaveLength(1);
  });
});

describe('db:generate wrapper: geography normalisation', () => {
  const quotedTable = 'CREATE TABLE "places" (\n\t"id" uuid PRIMARY KEY NOT NULL,\n\t"location" "geography(Point,4326)" NOT NULL,\n\t"coarse" "geography(Point,4326)"\n);';

  it('rewrites only the exact quoted token, where a column type is written', () => {
    const { sql, replacements } = unquoteGeographyPoint(quotedTable);
    expect(replacements).toBe(2);
    expect(sql).toBe('CREATE TABLE "places" (\n\t"id" uuid PRIMARY KEY NOT NULL,\n\t"location" geography(Point,4326) NOT NULL,\n\t"coarse" geography(Point,4326)\n);');
    expect(unquoteGeographyPoint('ALTER TABLE "t" ADD COLUMN "loc" "geography(Point,4326)";').sql).toBe('ALTER TABLE "t" ADD COLUMN "loc" geography(Point,4326);');
    expect(unquoteGeographyPoint('ALTER TABLE "t" ALTER COLUMN "loc" SET DATA TYPE "geography(Point,4326)";').sql).toBe('ALTER TABLE "t" ALTER COLUMN "loc" SET DATA TYPE geography(Point,4326);');
  });

  it('leaves everything else alone: other geography types, string literals, comments and unquoted types', () => {
    const untouched = [
      'CREATE TABLE "t" (\n\t"a" "geography(Point,3857)" NOT NULL\n);', // different SRID: not the token
      'CREATE TABLE "t" (\n\t"a" "geography(Polygon,4326)" NOT NULL\n);', // different shape: not the token
      'CREATE TABLE "t" (\n\t"a" "geography(Point, 4326)" NOT NULL\n);', // different spelling: not the token
      'INSERT INTO "t" ("note") VALUES (\'"geography(Point,4326)"\');', // inside a string literal
      '-- "geography(Point,4326)" is quoted by drizzle-kit',
      'CREATE TABLE "t" (\n\t"a" geography(Point,4326) NOT NULL\n);', // already correct
    ];
    for (const sql of untouched) expect(unquoteGeographyPoint(sql)).toEqual({ sql, replacements: 0 });
  });

  it('is idempotent', () => {
    const once = unquoteGeographyPoint(quotedTable).sql;
    expect(unquoteGeographyPoint(once)).toEqual({ sql: once, replacements: 0 });
  });

  it('does not hide a quoted type it cannot fix: the post-check still reports it', () => {
    const { sql } = unquoteGeographyPoint('CREATE TABLE "t" (\n\t"a" "geography(Point,3857)" NOT NULL\n);');
    expect(findQuotedParenTypes(sql)).toEqual(['"a" "geography(Point,3857)"']);
  });

  it('detects the files a generate run created or changed by content, not by name or time', () => {
    const before = new Map([['0001_a.sql', 'h1'], ['0002_b.sql', 'h2']]);
    const after = new Map([['0001_a.sql', 'h1'], ['0002_b.sql', 'CHANGED'], ['0003_c.sql', 'h3']]);
    expect(changedFiles(before, after)).toEqual(['0002_b.sql', '0003_c.sql']);
    expect(changedFiles(after, after)).toEqual([]);
  });

  it('rewrites only files created or modified since the snapshot, and leaves earlier files byte for byte alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bb-migrations-'));
    try {
      writeFileSync(join(dir, '0001_old.sql'), quotedTable, 'utf8'); // existed before the run and was not touched by it
      writeFileSync(join(dir, '0002_edited.sql'), 'SELECT 1;', 'utf8'); // existed before, changed by the run
      const before = snapshotSqlFiles(dir);
      writeFileSync(join(dir, '0002_edited.sql'), quotedTable, 'utf8');
      writeFileSync(join(dir, '0003_new.sql'), `${quotedTable}\n--> statement-breakpoint\nALTER TABLE "places" ADD COLUMN "extra" "geography(Point,4326)";`, 'utf8');
      writeFileSync(join(dir, 'notes.txt'), quotedTable, 'utf8'); // not a .sql file

      const results = normaliseGeneratedMigrations(dir, before);
      expect(results.map((r) => [r.file, r.replacements])).toEqual([['0002_edited.sql', 2], ['0003_new.sql', 3]]);
      expect(results.every((r) => r.remainingQuotedTypes.length === 0)).toBe(true);
      expect(readFileSync(join(dir, '0001_old.sql'), 'utf8')).toBe(quotedTable);
      expect(readFileSync(join(dir, 'notes.txt'), 'utf8')).toBe(quotedTable);
      expect(readFileSync(join(dir, '0002_edited.sql'), 'utf8')).not.toContain('"geography(');
      expect(readdirSync(dir).sort()).toEqual(['0001_old.sql', '0002_edited.sql', '0003_new.sql', 'notes.txt']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
