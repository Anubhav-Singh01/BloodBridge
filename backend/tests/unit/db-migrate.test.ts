import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterAll, describe, expect, it } from 'vitest';
import type { GuardEnv } from '../../src/db/guard.js';
import { RefusedStatementError, assertSendable, guardedDb, runMigrate, type Io, type RawDb, type RawTx, type Row } from '../../scripts/db-migrate-core.js';
import { BOOTSTRAP, FIXED_STATEMENTS, POST, PREFLIGHT, SESSION, TRACKING_INSERT } from '../../scripts/db-migrate-sql.js';
import {
  checkServerState,
  checkTarget,
  evaluatePost,
  expectedObjects,
  loadMigrations,
  parseArgs,
  planFingerprint,
  reconcile,
  type LoadedMigration,
  type PostActual,
  type ServerState,
} from '../../scripts/db-migrate-plan.js';

// Offline only. Nothing here opens a connection: the runner is driven against a fake database, and every host is a
// reserved .invalid name that can never resolve.

const realDir = join(import.meta.dirname, '../../drizzle');
const real = loadMigrations(realDir);
const migrations = real.migrations;
const allStatements = migrations.flatMap((m) => m.statements);

const temporary: string[] = [];
afterAll(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});
function copyOfRealFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bb-migrate-'));
  temporary.push(dir);
  cpSync(realDir, dir, { recursive: true });
  return dir;
}
function newFolder(entries: { tag: string; sql: string | Buffer }[], journalEntries?: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'bb-migrate-'));
  temporary.push(dir);
  mkdirSync(join(dir, 'meta'));
  for (const e of entries) writeFileSync(join(dir, `${e.tag}.sql`), e.sql);
  const journal = journalEntries ?? entries.map((e, i) => ({ idx: i, version: '7', when: 1000 + i, tag: e.tag, breakpoints: true }));
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({ version: '7', dialect: 'postgresql', entries: journal }));
  return dir;
}

const HOST = 'ep-example-1234.region.example.invalid';
const baseEnv = (over: Record<string, string | undefined> = {}): GuardEnv => ({
  NODE_ENV: 'development',
  DATABASE_URL_DIRECT: `postgresql://app_user:p%40ss@${HOST}/devdb?sslmode=require&channel_binding=require`,
  DATABASE_URL: 'postgresql://app_user:p%40ss@ep-example-1234-pooler.region.example.invalid/devdb',
  CONFIRM_DB_HOST: HOST,
  ...over,
});

describe('the migrations folder is loaded and checked offline', () => {
  it('loads the real folder with no problem, and hashes every file exactly as drizzle does', () => {
    expect(real.problems).toEqual([]);
    expect(migrations).toHaveLength(7);
    const theirs = readMigrationFiles({ migrationsFolder: realDir });
    expect(migrations.map((m) => m.hash)).toEqual(theirs.map((t) => t.hash));
    expect(migrations.map((m) => m.when)).toEqual(theirs.map((t) => t.folderMillis));
  });

  it('has no statement text repeated anywhere, so a statement identifies its place in the set', () => {
    expect(new Set(allStatements).size).toBe(allStatements.length);
  });

  const okSql = 'CREATE EXTENSION IF NOT EXISTS postgis;';
  const problemsOf = (dir: string): string[] => loadMigrations(dir).problems;

  it('accepts a minimal valid folder', () => {
    expect(problemsOf(newFolder([{ tag: '0000_a', sql: okSql }]))).toEqual([]);
  });

  it('refuses a journal or file that is inconsistent', () => {
    const entry = (over: object) => [{ idx: 0, version: '7', when: 1000, tag: '0000_a', breakpoints: true, ...over }];
    const cases: Record<string, string[]> = {
      'wrong idx': problemsOf(newFolder([{ tag: '0000_a', sql: okSql }], entry({ idx: 3 }))),
      'breakpoints false': problemsOf(newFolder([{ tag: '0000_a', sql: okSql }], entry({ breakpoints: false }))),
      'non-integer when': problemsOf(newFolder([{ tag: '0000_a', sql: okSql }], entry({ when: 'x' }))),
      'path in the tag': problemsOf(newFolder([{ tag: '0000_a', sql: okSql }], entry({ tag: '../0000_a' }))),
      'tag without the four digits': problemsOf(newFolder([{ tag: 'a', sql: okSql }], entry({ tag: 'a' }))),
      'missing file': problemsOf(newFolder([], entry({}))),
      'NUL byte': problemsOf(newFolder([{ tag: '0000_a', sql: Buffer.from(`${okSql}\u0000`) }])),
      'byte order mark': problemsOf(newFolder([{ tag: '0000_a', sql: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(okSql)]) }])),
      'invalid UTF-8': problemsOf(newFolder([{ tag: '0000_a', sql: Buffer.from([0x43, 0xff, 0xfe]) }])),
    };
    for (const [label, problems] of Object.entries(cases)) expect({ label, refused: problems.length > 0 }).toEqual({ label, refused: true });
  });

  it('refuses duplicate tags, non-increasing timestamps, a file missing from the journal, and a missing or empty journal', () => {
    const two = [{ tag: '0000_a', sql: okSql }, { tag: '0001_b', sql: 'CREATE EXTENSION IF NOT EXISTS btree_gist;' }];
    const journalOf = (whens: number[], tags = ['0000_a', '0001_b']) => tags.map((tag, i) => ({ idx: i, version: '7', when: whens[i], tag, breakpoints: true }));
    expect(problemsOf(newFolder(two, journalOf([1000, 1000]))).join(' ')).toContain('"when"');
    expect(problemsOf(newFolder(two, journalOf([2000, 1000]))).join(' ')).toContain('"when"');
    expect(problemsOf(newFolder(two, journalOf([1000, 2000], ['0000_a', '0000_a']))).join(' ')).toContain('twice');
    expect(problemsOf(newFolder(two, journalOf([1000], ['0000_a']))).join(' ')).toContain('not in the journal');
    expect(problemsOf(newFolder([], [])).join(' ')).toContain('no entries');
    const noJournal = mkdtempSync(join(tmpdir(), 'bb-migrate-'));
    temporary.push(noJournal);
    expect(problemsOf(noJournal).join(' ')).toContain('does not exist');
  });

  it('reports a dangerous statement from the scanner, and does so before any connection is possible', () => {
    const problems = problemsOf(newFolder([{ tag: '0000_a', sql: `${okSql}\n--> statement-breakpoint\nDROP TABLE "users";` }]));
    expect(problems.join(' ')).toMatch(/0000_a, statement 2: \[statement\]/);
  });
});

describe('arguments: only --apply with the reviewed fingerprint can write', () => {
  it('accepts no arguments (a plan) and --apply with a 12-hex fingerprint', () => {
    expect(parseArgs([])).toEqual({ ok: true, apply: false, confirmPlan: null });
    expect(parseArgs(['--apply', '--confirm-plan=0123456789ab'])).toEqual({ ok: true, apply: true, confirmPlan: '0123456789ab' });
    expect(parseArgs(['--confirm-plan=0123456789ab', '--apply'])).toEqual({ ok: true, apply: true, confirmPlan: '0123456789ab' });
  });
  it('refuses everything else, including every argument that would make it more dangerous', () => {
    const bad = [
      ['--apply'], ['--confirm-plan=0123456789ab'], ['--apply', '--confirm-plan=xyz'], ['--apply', '--confirm-plan=0123456789ABCD'], ['--apply', '--confirm-plan='], ['--apply', '--apply', '--confirm-plan=0123456789ab'],
      ['--force'], ['--reset'], ['--down'], ['--to=0003'], ['--file=x.sql'], ['--url=postgres://x'], ['--dry-run'], ['push'], ['--push'], ['--drop'], ['-y'], ['--apply', '--force', '--confirm-plan=0123456789ab'],
    ];
    for (const argv of bad) expect({ argv, ok: parseArgs(argv).ok }).toEqual({ argv, ok: false });
  });
});

describe('the target: direct endpoint only, confirmed, never the test database', () => {
  it('accepts a confirmed direct endpoint and reports the runtime URL without using it', () => {
    const result = checkTarget(baseEnv());
    expect(result).toMatchObject({ ok: true, endpointLabel: 'ep-example-1234', runtimeEndpoint: 'same' });
    expect(checkTarget(baseEnv({ DATABASE_URL: 'postgresql://u:p@ep-other-9999-pooler.region.example.invalid/devdb' }))).toMatchObject({ ok: true, runtimeEndpoint: 'different' });
    expect(checkTarget(baseEnv({ DATABASE_URL: undefined }))).toMatchObject({ ok: true, runtimeEndpoint: 'not set' });
    expect(checkTarget(baseEnv({ DATABASE_URL: 'not a url' }))).toMatchObject({ ok: true, runtimeEndpoint: 'invalid' });
    expect(checkTarget(baseEnv({ TEST_DATABASE_URL: 'postgresql://u:p@ep-test-5678.region.example.invalid/testdb' }))).toMatchObject({ ok: true });
  });
  it('refuses a missing direct URL (no fallback to the pooled one), a pooled host, production, and a missing or wrong confirmation', () => {
    const pooledHost = 'ep-example-1234-pooler.region.example.invalid';
    const refused: Record<string, GuardEnv> = {
      'no direct URL, only the pooled DATABASE_URL': baseEnv({ DATABASE_URL_DIRECT: undefined, CONFIRM_DB_HOST: 'ep-example-1234-pooler.region.example.invalid' }),
      'empty direct URL': baseEnv({ DATABASE_URL_DIRECT: '' }),
      'pooled host as the direct URL': baseEnv({ DATABASE_URL_DIRECT: `postgresql://u:p@${pooledHost}/devdb`, CONFIRM_DB_HOST: pooledHost }),
      'NODE_ENV=production': baseEnv({ NODE_ENV: 'production' }),
      'no confirmation': baseEnv({ CONFIRM_DB_HOST: undefined }),
      'wrong confirmation': baseEnv({ CONFIRM_DB_HOST: 'ep-someone-else.region.example.invalid' }),
      'confirmation that is a URL': baseEnv({ CONFIRM_DB_HOST: `postgresql://u:p@${HOST}/devdb` }),
      'not a URL': baseEnv({ DATABASE_URL_DIRECT: 'nonsense' }),
    };
    for (const [label, env] of Object.entries(refused)) expect({ label, ok: checkTarget(env).ok }).toEqual({ label, ok: false });
  });
  it('refuses when the target is the test database, or the test URL cannot be told apart', () => {
    expect(checkTarget(baseEnv({ TEST_DATABASE_URL: `postgresql://u:p@${HOST}/devdb` })).ok).toBe(false);
    expect(checkTarget(baseEnv({ TEST_DATABASE_URL: 'postgresql://u:p@ep-example-1234-pooler.region.example.invalid/devdb' })).ok).toBe(false);
    expect(checkTarget(baseEnv({ TEST_DATABASE_URL: 'garbage' })).ok).toBe(false);
  });
});

const EMPTY = { relations: 0, customTypes: 0, functions: 0, otherSchemas: 0 };
const TRACKING = ['id', 'hash', 'created_at', 'tag', 'applied_at'];
function state(over: Partial<ServerState> = {}): ServerState {
  return {
    lockAcquired: true,
    serverVersionNum: 180006,
    inRecovery: false,
    database: 'devdb',
    endpointId: 'ep-example-1234',
    timelineId: 'tl-1',
    isSuperuser: 'off',
    memberOfNeonSuperuser: true,
    canCreateInDatabase: true,
    canCreateInPublic: true,
    extensions: new Map<string, string | null>([['postgis', null], ['btree_gist', null], ['plpgsql', '1.0']]),
    trackingExists: false,
    trackingColumns: [],
    applied: [],
    emptiness: EMPTY,
    ...over,
  };
}
const appliedRows = (n: number) => migrations.slice(0, n).map((m, i) => ({ id: i + 1, hash: m.hash, createdAt: String(m.when), tag: m.tag }));
const target = { host: HOST, database: 'devdb' };

describe('reconciling the journal with the database', () => {
  it('a first run on an empty database has everything pending', () => {
    const r = reconcile(migrations, state());
    expect(r).toMatchObject({ ok: true });
    expect(r.ok && r.pending.map((m) => m.tag)).toEqual(migrations.map((m) => m.tag));
    expect(r.ok && r.applied).toEqual([]);
  });
  it('an existing tracking table with no rows on an empty database also has everything pending', () => {
    expect(reconcile(migrations, state({ trackingExists: true, trackingColumns: TRACKING }))).toMatchObject({ ok: true });
  });
  it('a recorded prefix leaves exactly the suffix pending, and a full record leaves nothing', () => {
    const three = reconcile(migrations, state({ trackingExists: true, trackingColumns: TRACKING, applied: appliedRows(3), emptiness: { ...EMPTY, relations: 30 } }));
    expect(three.ok && three.applied.map((m) => m.tag)).toEqual(migrations.slice(0, 3).map((m) => m.tag));
    expect(three.ok && three.pending.map((m) => m.tag)).toEqual(migrations.slice(3).map((m) => m.tag));
    const all = reconcile(migrations, state({ trackingExists: true, trackingColumns: TRACKING, applied: appliedRows(7), emptiness: { ...EMPTY, relations: 41 } }));
    expect(all.ok && all.pending).toEqual([]);
  });
  const refusedWith = (s: ServerState, text: RegExp): void => {
    const r = reconcile(migrations, s);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.problems.join(' ')).toMatch(text);
  };
  it('refuses an applied migration whose file has changed', () => {
    const rows = appliedRows(3).map((r, i) => (i === 1 ? { ...r, hash: 'f'.repeat(64) } : r));
    refusedWith(state({ trackingExists: true, trackingColumns: TRACKING, applied: rows, emptiness: { ...EMPTY, relations: 5 } }), /has changed since it was applied/);
  });
  it('refuses recorded migrations that are out of order, unknown, extra, or carry a different tag or timestamp', () => {
    const rows = appliedRows(3);
    refusedWith(state({ trackingExists: true, trackingColumns: TRACKING, applied: [rows[1]!, rows[0]!, rows[2]!], emptiness: { ...EMPTY, relations: 5 } }), /changed since|order/);
    refusedWith(state({ trackingExists: true, trackingColumns: TRACKING, applied: [...appliedRows(7), { id: 8, hash: 'a'.repeat(64), createdAt: '1', tag: '0007_unknown' }], emptiness: { ...EMPTY, relations: 5 } }), /records 8 migrations/);
    refusedWith(state({ trackingExists: true, trackingColumns: TRACKING, applied: [{ ...rows[0]!, tag: '0000_other' }], emptiness: { ...EMPTY, relations: 5 } }), /different tag or timestamp/);
    refusedWith(state({ trackingExists: true, trackingColumns: TRACKING, applied: [{ ...rows[0]!, createdAt: '5' }], emptiness: { ...EMPTY, relations: 5 } }), /different tag or timestamp/);
  });
  it('refuses a tracking table with unexpected columns, and a database that is not empty when nothing is recorded', () => {
    refusedWith(state({ trackingExists: true, trackingColumns: ['id', 'hash', 'created_at'] }), /unexpected columns/);
    for (const emptiness of [{ ...EMPTY, relations: 1 }, { ...EMPTY, customTypes: 1 }, { ...EMPTY, functions: 1 }, { ...EMPTY, otherSchemas: 1 }]) {
      refusedWith(state({ emptiness }), /not empty/);
      refusedWith(state({ trackingExists: true, trackingColumns: TRACKING, emptiness }), /not empty/);
    }
  });
});

describe('the server checks that must pass before anything is planned', () => {
  const problems = (over: Partial<ServerState>, pending = migrations): string => checkServerState(state(over), target, 'ep-example-1234', pending).join(' | ');
  it('passes on a healthy dev server', () => {
    expect(problems({})).toBe('');
  });
  it('refuses a busy lock, the wrong database, a replica, and PostgreSQL older than 15', () => {
    expect(problems({ lockAcquired: false })).toMatch(/holds the advisory lock/);
    expect(problems({ database: 'other' })).toMatch(/reports database "other"/);
    expect(problems({ inRecovery: true })).toMatch(/recovery/);
    expect(problems({ serverVersionNum: 140012 })).toMatch(/PostgreSQL 15/);
    expect(problems({ serverVersionNum: 149999 })).toMatch(/PostgreSQL 15/);
    expect(problems({ serverVersionNum: 150000 })).toBe('');
    expect(problems({ serverVersionNum: Number.NaN })).toMatch(/PostgreSQL 15/);
  });
  it('refuses an endpoint identity mismatch, and a server that does not report one', () => {
    expect(problems({ endpointId: 'ep-someone-else-9999' })).toMatch(/Endpoint identity mismatch/);
    expect(problems({ endpointId: null })).toMatch(/does not report a Neon endpoint id/);
  });
  it('checks privileges and extension availability only when something is pending', () => {
    expect(problems({ canCreateInDatabase: false })).toMatch(/cannot CREATE/);
    expect(problems({ canCreateInPublic: false })).toMatch(/cannot CREATE/);
    expect(problems({ isSuperuser: 'off', memberOfNeonSuperuser: false })).toMatch(/neon_superuser/);
    expect(problems({ isSuperuser: 'off', memberOfNeonSuperuser: null })).toMatch(/neon_superuser/);
    expect(problems({ isSuperuser: 'on', memberOfNeonSuperuser: false })).toBe('');
    expect(problems({ extensions: new Map([['btree_gist', null]]) })).toMatch(/postgis is not available/);
    expect(problems({ canCreateInPublic: false, memberOfNeonSuperuser: false, extensions: new Map() }, [])).toBe('');
  });
});

describe('the plan fingerprint binds an approval to the exact plan', () => {
  const base = { host: HOST, database: 'devdb', endpointId: 'ep-example-1234', timelineId: 'tl-1', serverVersionNum: 180006, applied: ['0000_a'], pending: [{ tag: '0001_b', hash: 'h1' }, { tag: '0002_c', hash: 'h2' }] };
  it('is 12 hex characters and stable', () => {
    expect(planFingerprint(base)).toMatch(/^[0-9a-f]{12}$/);
    expect(planFingerprint({ ...base })).toBe(planFingerprint(base));
  });
  it('changes when the host, database, endpoint, branch timeline, server version, applied set, or any pending tag, hash or order changes', () => {
    const fp = planFingerprint(base);
    const variants = [
      { ...base, host: 'other.example.invalid' }, { ...base, database: 'other' }, { ...base, endpointId: 'ep-other' }, { ...base, timelineId: 'tl-2' }, { ...base, timelineId: null }, { ...base, serverVersionNum: 170000 },
      { ...base, applied: [] }, { ...base, applied: ['0000_x'] }, { ...base, pending: [{ tag: '0001_b', hash: 'h1' }] }, { ...base, pending: [{ tag: '0001_b', hash: 'h1x' }, { tag: '0002_c', hash: 'h2' }] },
      { ...base, pending: [{ tag: '0002_c', hash: 'h2' }, { tag: '0001_b', hash: 'h1' }] }, { ...base, pending: [{ tag: '0001_b', hash: 'h1' }, { tag: '0002_cx', hash: 'h2' }] },
    ];
    for (const v of variants) expect(planFingerprint(v)).not.toBe(fp);
  });
});

describe('what the database should hold afterwards is derived from the migrations', () => {
  const expected = expectedObjects(migrations);
  it('counts the real objects', () => {
    expect(expected.tables).toHaveLength(41);
    expect(expected.enums).toHaveLength(36);
    expect(expected.views).toEqual(['donor_locations_coarse']);
    expect(expected.functions).toHaveLength(15);
    expect(expected.triggers).toHaveLength(57);
    expect(expected.foreignKeys).toBe(76);
    expect(expected.exclusions).toBe(3);
    expect(expected.extensions).toEqual(['btree_gist', 'postgis']);
    expect(expected.transitionRows).toBe(29);
  });

  const good = (): PostActual => ({
    tracking: appliedRows(7),
    tables: expected.tables,
    enums: expected.enums,
    views: expected.views,
    functions: expected.functions.map((name) => ({ name, securityDefiner: false, language: 'plpgsql', returns: 'trigger', args: 0, hasConfig: false })),
    triggers: expected.triggers.map((name) => ({ table: 't', name, functionName: expected.functions[0] ?? '' })),
    constraints: { f: 76, x: 3 },
    extensions: ['btree_gist', 'plpgsql', 'postgis'],
    transitionRows: 29,
  });
  const failing = (actual: PostActual): string[] => evaluatePost(migrations, expected, actual).filter((c) => !c.ok).map((c) => c.name);

  it('passes when the database matches', () => {
    expect(failing(good())).toEqual([]);
  });
  it('fails, naming the check, for each kind of drift', () => {
    expect(failing({ ...good(), tracking: appliedRows(6) })).toEqual(['migration records match the journal']);
    expect(failing({ ...good(), tracking: appliedRows(7).map((r, i) => (i === 2 ? { ...r, hash: 'x' } : r)) })).toEqual(['migration records match the journal']);
    expect(failing({ ...good(), tables: [...expected.tables, 'stray'] })).toEqual(['tables']);
    expect(failing({ ...good(), tables: expected.tables.slice(1) })).toEqual(['tables']);
    expect(failing({ ...good(), enums: [] })).toEqual(['enums']);
    expect(failing({ ...good(), views: [] })).toEqual(['views']);
    expect(failing({ ...good(), functions: good().functions.slice(1) })).toContain('bb_ functions');
    expect(failing({ ...good(), triggers: good().triggers.slice(1) })).toEqual(['triggers']);
    expect(failing({ ...good(), constraints: { f: 75, x: 3 } })).toEqual(['foreign keys']);
    expect(failing({ ...good(), constraints: { f: 76, x: 2 } })).toEqual(['exclusion constraints']);
    expect(failing({ ...good(), extensions: ['plpgsql'] })).toEqual(['extensions installed']);
    expect(failing({ ...good(), transitionRows: 28 })).toEqual(['request_transitions rows']);
  });
  it('fails on a function that is SECURITY DEFINER, not plpgsql, not a trigger, has parameters or its own SET, and on a stray trigger function', () => {
    const one = (patch: object): PostActual => ({ ...good(), functions: good().functions.map((f, i) => (i === 0 ? { ...f, ...patch } : f)) });
    for (const patch of [{ securityDefiner: true }, { language: 'sql' }, { returns: 'int4' }, { args: 1 }, { hasConfig: true }]) {
      expect(failing(one(patch))).toEqual(['functions are plpgsql triggers, not SECURITY DEFINER, no SET config, no parameters']);
    }
    expect(failing({ ...good(), triggers: [{ table: 't', name: expected.triggers[0] ?? '', functionName: 'evil' }, ...good().triggers.slice(1)] })).toEqual(['every trigger calls one of the migration-defined functions']);
  });
});

describe('the fixed statements are all the runner sends besides migration text', () => {
  // Quoted literals are text, not SQL: has_schema_privilege('public', 'CREATE') only names a privilege.
  const code = (sql: string): string => sql.replace(/'[^']*'/g, "''");
  const WRITE = /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|COPY|VACUUM|ANALYZE|REINDEX|CLUSTER|REFRESH|CALL|DO|SET|RESET|LISTEN|NOTIFY|LOCK|INTO|BEGIN|COMMIT|ROLLBACK)\b/i;
  const SIDE_EFFECT = /\b(nextval|setval|set_config|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_sleep\w*|lo_\w+|dblink\w*|pg_create\w*|pg_drop\w*|pg_switch\w*)\b/i;

  it('makes every preflight and post-check statement a single read-only SELECT or SHOW', () => {
    for (const [group, list] of Object.entries({ preflight: PREFLIGHT, post: POST })) {
      for (const [name, sql] of Object.entries(list)) {
        expect({ group, name, ok: /^(SELECT|SHOW)\b/i.test(sql) && !sql.includes(';') && !WRITE.test(code(sql)) && !SIDE_EFFECT.test(code(sql)) }).toEqual({ group, name, ok: true });
      }
    }
  });
  it('holds only advisory-lock functions, the two session settings, the two idempotent bootstrap statements and one parameterised insert', () => {
    expect(Object.values(SESSION).filter((s) => s !== 'SHOW transaction_read_only')).toEqual(["SET LOCAL lock_timeout = '10s'", "SET LOCAL statement_timeout = '120s'"]);
    expect(BOOTSTRAP.createSchema).toBe('CREATE SCHEMA IF NOT EXISTS drizzle');
    expect(BOOTSTRAP.createTable).toMatch(/^CREATE TABLE IF NOT EXISTS drizzle\.__drizzle_migrations \(id serial PRIMARY KEY, hash text NOT NULL UNIQUE, created_at bigint NOT NULL, tag text NOT NULL UNIQUE, applied_at timestamptz NOT NULL DEFAULT now\(\)\)$/);
    expect(TRACKING_INSERT).toBe('INSERT INTO drizzle.__drizzle_migrations (hash, created_at, tag) VALUES ($1, $2, $3)');
    for (const set of Object.values(FIXED_STATEMENTS)) for (const sql of set) expect(code(sql)).not.toMatch(/\b(DROP|TRUNCATE|DELETE|UPDATE)\b/i);
    expect(PREFLIGHT.advisoryLock).toContain('pg_try_advisory_lock');
    expect(PREFLIGHT.advisoryUnlock).toContain('pg_advisory_unlock');
  });
});

describe('the gatekeeper: the only way SQL reaches the driver', () => {
  const first = migrations[1]!;
  const okOrigin = { type: 'migration' as const, tag: first.tag, index: 0 };
  const statement = first.statements[0] ?? '';
  it('passes the exact fixed statements in their own group and the exact scanned migration statement', () => {
    expect(() => assertSendable(PREFLIGHT.server, { type: 'fixed', group: 'preflight' }, migrations)).not.toThrow();
    expect(() => assertSendable(BOOTSTRAP.createSchema, { type: 'fixed', group: 'bootstrap' }, migrations)).not.toThrow();
    expect(() => assertSendable(TRACKING_INSERT, { type: 'fixed', group: 'tracking-insert' }, migrations)).not.toThrow();
    expect(() => assertSendable(statement, okOrigin, migrations)).not.toThrow();
  });
  it('refuses a migration statement altered by one character, moved to another place, or sent under a fixed group', () => {
    expect(() => assertSendable(`${statement} `, okOrigin, migrations)).toThrow(RefusedStatementError);
    expect(() => assertSendable(statement.replace('CREATE', 'CREATE '), okOrigin, migrations)).toThrow(RefusedStatementError);
    expect(() => assertSendable(statement, { ...okOrigin, index: 1 }, migrations)).toThrow(RefusedStatementError);
    expect(() => assertSendable(statement, { ...okOrigin, tag: migrations[2]?.tag ?? '' }, migrations)).toThrow(RefusedStatementError);
    expect(() => assertSendable(statement, { type: 'migration', tag: 'unknown', index: 0 }, migrations)).toThrow(RefusedStatementError);
    expect(() => assertSendable(statement, { type: 'migration', tag: first.tag, index: 9999 }, migrations)).toThrow(RefusedStatementError);
    expect(() => assertSendable(statement, { type: 'fixed', group: 'preflight' }, migrations)).toThrow(RefusedStatementError);
  });
  it('refuses any other text, and a fixed statement under the wrong group', () => {
    for (const sql of ['DROP TABLE users', 'DROP SCHEMA public CASCADE', 'TRUNCATE users', 'DELETE FROM drizzle.__drizzle_migrations', 'UPDATE drizzle.__drizzle_migrations SET hash = 1', 'COMMIT', 'SELECT 1', '']) {
      for (const group of ['preflight', 'post', 'session', 'bootstrap', 'tracking-insert'] as const) {
        expect(() => assertSendable(sql, { type: 'fixed', group }, migrations)).toThrow(RefusedStatementError);
      }
    }
    expect(() => assertSendable(BOOTSTRAP.createTable, { type: 'fixed', group: 'preflight' }, migrations)).toThrow(RefusedStatementError);
    expect(() => assertSendable(TRACKING_INSERT, { type: 'fixed', group: 'bootstrap' }, migrations)).toThrow(RefusedStatementError);
    expect(() => assertSendable(PREFLIGHT.server, { type: 'fixed', group: 'bootstrap' }, migrations)).toThrow(RefusedStatementError);
  });
  it('never hands a refused statement to the driver', async () => {
    const reached: string[] = [];
    const raw: RawDb = {
      async begin(_mode, work) {
        return work({ unsafe: async (sql: string) => (reached.push(sql), []) } as RawTx);
      },
      end: async () => undefined,
    };
    const db = guardedDb(raw, migrations);
    await expect(db.readWrite((tx) => tx.run('DROP TABLE users', { type: 'fixed', group: 'bootstrap' }))).rejects.toThrow(RefusedStatementError);
    await expect(db.readOnly((tx) => tx.run(statement, { type: 'migration', tag: first.tag, index: 1 }))).rejects.toThrow(RefusedStatementError);
    expect(reached).toEqual([]);
    await db.readOnly((tx) => tx.run(PREFLIGHT.server, { type: 'fixed', group: 'preflight' }));
    expect(reached).toEqual([PREFLIGHT.server]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The whole flow against a fake database.

class CaptureIo implements Io {
  out: string[] = [];
  err: string[] = [];
  line(label: string, text: string): void {
    this.out.push(`${label} ${text}`);
  }
  text(message: string): void {
    this.out.push(message);
  }
  error(message: string): void {
    this.err.push(message);
  }
}

const pgError = (code: string, message: string): Error => Object.assign(new Error(message), { code });

interface Catalog {
  tables: string[];
  enums: string[];
  views: string[];
  functions: Row[];
  triggers: Row[];
  constraints: Row[];
  extensions: string[];
  transitions: number;
}

/** A stand-in for PostgreSQL that enforces what matters here: read-only transactions, rollback, and unknown SQL. */
class FakeDb implements RawDb {
  cfg = {
    serverVersionNum: 180006,
    inRecovery: false,
    database: 'devdb',
    endpointId: 'ep-example-1234' as string | null,
    timelineId: 'tl-1',
    isSuperuser: 'off',
    memberOfNeonSuperuser: true as boolean | null,
    canCreateInDatabase: true,
    canCreateInPublic: true,
    available: ['postgis', 'btree_gist', 'plpgsql'],
    lockFree: true,
    emptiness: { ...EMPTY },
    // What the server answers to SHOW transaction_read_only in a read-only and in a write transaction. Normally on and off.
    readOnlyAnswer: 'on',
    writeAnswer: 'off',
    // null: answer truthfully. false: pretend the session lost its advisory lock (for example a replaced connection).
    lockHeldAnswer: null as boolean | null,
  };
  trackingExists = false;
  trackingColumns: string[] = [...TRACKING];
  tracking: { id: number; hash: string; createdAt: string; tag: string | null }[] = [];
  lockHeld = false;
  begins: ('read only' | 'read write')[] = [];
  sent: string[] = [];
  committed: string[] = [];
  failOn: string | null = null;
  patchCatalog: ((catalog: Catalog) => void) | null = null;
  ended = false;
  private readonly known = new Set<string>();

  constructor(private readonly all: readonly LoadedMigration[]) {
    for (const m of all) for (const s of m.statements) this.known.add(s);
  }

  markApplied(count: number): void {
    this.trackingExists = true;
    this.tracking = appliedRows(count);
    this.cfg.emptiness = { ...EMPTY, relations: count > 0 ? 30 : 0 };
  }

  private catalog(): Catalog {
    const done = this.tracking.length === this.all.length;
    const e = expectedObjects(this.all);
    const catalog: Catalog = done
      ? {
          tables: e.tables,
          enums: e.enums,
          views: e.views,
          functions: e.functions.map((name) => ({ name, security_definer: false, language: 'plpgsql', returns: 'trigger', args: 0, has_config: false })),
          triggers: e.triggers.map((name) => ({ table_name: 't', name, function_name: e.functions[0] })),
          constraints: [{ type: 'f', n: e.foreignKeys }, { type: 'x', n: e.exclusions }],
          extensions: ['btree_gist', 'plpgsql', 'postgis'],
          transitions: e.transitionRows,
        }
      : { tables: [], enums: [], views: [], functions: [], triggers: [], constraints: [], extensions: ['plpgsql'], transitions: 0 };
    this.patchCatalog?.(catalog);
    return catalog;
  }

  async begin<T>(mode: 'read only' | 'read write', work: (tx: RawTx) => Promise<T>): Promise<T> {
    this.begins.push(mode);
    const pendingStatements: string[] = [];
    const pendingRows: { hash: string; createdAt: string; tag: string }[] = [];
    let bootstrap = false;
    const tx: RawTx = {
      unsafe: async (statement, params) => {
        this.sent.push(statement);
        if (mode === 'read only' && !/^(SELECT|SHOW)\b/i.test(statement)) throw pgError('25006', 'cannot execute a write in a read-only transaction');
        const c = this.cfg;
        switch (statement) {
          case PREFLIGHT.readOnlyCheck:
            return [{ transaction_read_only: mode === 'read only' ? c.readOnlyAnswer : c.writeAnswer }];
          case PREFLIGHT.advisoryLock:
            if (!c.lockFree) return [{ locked: false }];
            this.lockHeld = true;
            return [{ locked: true }];
          case PREFLIGHT.advisoryLockHeld:
            return [{ held: c.lockHeldAnswer ?? this.lockHeld }];
          case PREFLIGHT.advisoryUnlock:
            this.lockHeld = false;
            return [{ unlocked: true }];
          case PREFLIGHT.server:
            return [{ server_version_num: c.serverVersionNum, in_recovery: c.inRecovery, database: c.database, endpoint_id: c.endpointId, timeline_id: c.timelineId }];
          case PREFLIGHT.privileges:
            return [{ is_superuser: c.isSuperuser, can_create_in_database: c.canCreateInDatabase, can_create_in_public: c.canCreateInPublic, member_of_neon_superuser: c.memberOfNeonSuperuser }];
          case PREFLIGHT.extensionsAvailable:
            return c.available.map((name) => ({ name, installed_version: null }));
          case PREFLIGHT.trackingExists:
            return [{ present: this.trackingExists }];
          case PREFLIGHT.trackingColumns:
            return this.trackingColumns.map((name) => ({ name }));
          case PREFLIGHT.trackingRows:
            return this.tracking.map((r) => ({ id: r.id, hash: r.hash, created_at: r.createdAt, tag: r.tag }));
          case PREFLIGHT.emptiness:
            return [{ relations: c.emptiness.relations, custom_types: c.emptiness.customTypes, functions: c.emptiness.functions, other_schemas: c.emptiness.otherSchemas }];
          case POST.tables:
            return this.catalog().tables.map((name) => ({ name }));
          case POST.enums:
            return this.catalog().enums.map((name) => ({ name }));
          case POST.views:
            return this.catalog().views.map((name) => ({ name }));
          case POST.functions:
            return this.catalog().functions;
          case POST.triggers:
            return this.catalog().triggers;
          case POST.constraints:
            return this.catalog().constraints;
          case POST.extensions:
            return this.catalog().extensions.map((name) => ({ name }));
          case POST.transitions:
            return [{ n: this.catalog().transitions }];
          case SESSION.lockTimeout:
          case SESSION.statementTimeout:
            return [];
          case BOOTSTRAP.createSchema:
            return [];
          case BOOTSTRAP.createTable:
            bootstrap = true;
            return [];
          case TRACKING_INSERT:
            pendingRows.push({ hash: String(params?.[0]), createdAt: String(params?.[1]), tag: String(params?.[2]) });
            return [];
          default:
            if (!this.known.has(statement)) throw new Error(`fake database: unexpected statement: ${statement.slice(0, 80)}`);
            if (this.failOn === statement) throw pgError('42P07', 'relation already exists');
            pendingStatements.push(statement);
            return [];
        }
      },
    };
    // If the work throws, nothing pending is kept: that is the rollback.
    const result = await work(tx);
    if (bootstrap) this.trackingExists = true;
    for (const r of pendingRows) this.tracking.push({ id: this.tracking.length + 1, hash: r.hash, createdAt: r.createdAt, tag: r.tag });
    if (pendingStatements.length > 0) this.cfg.emptiness = { ...EMPTY, relations: 30 };
    this.committed.push(...pendingStatements);
    return result;
  }
  async end(): Promise<void> {
    this.ended = true;
  }
}

interface RunResult {
  code: number;
  out: string;
  err: string;
  connects: number;
}
async function run(db: FakeDb, argv: string[], options: { env?: GuardEnv; dir?: string } = {}): Promise<RunResult> {
  const io = new CaptureIo();
  let connects = 0;
  const code = await runMigrate({
    env: options.env ?? baseEnv(),
    argv,
    migrationsDir: options.dir ?? realDir,
    connect: () => {
      connects += 1;
      return db;
    },
    io,
  });
  return { code, out: io.out.join('\n'), err: io.err.join('\n'), connects };
}
const fingerprintOf = (out: string): string => /plan fingerprint:\s+([0-9a-f]{12})/.exec(out)?.[1] ?? '';
const writes = (db: FakeDb): number => db.begins.filter((m) => m === 'read write').length;

describe('plan mode has no writable database path', () => {
  it('sends only fixed read-only statements inside read-only transactions, and prints the fingerprint', async () => {
    const db = new FakeDb(migrations);
    const r = await run(db, []);
    expect(r.code).toBe(0);
    expect(db.begins.length).toBeGreaterThan(0);
    expect(db.begins.every((m) => m === 'read only')).toBe(true);
    expect(writes(db)).toBe(0);
    expect(db.sent.every((s) => FIXED_STATEMENTS.preflight.has(s) || FIXED_STATEMENTS.post.has(s))).toBe(true);
    expect(db.sent.some((s) => allStatements.includes(s))).toBe(false);
    expect(db.committed).toEqual([]);
    expect(db.tracking).toEqual([]);
    expect(db.trackingExists).toBe(false);
    expect(fingerprintOf(r.out)).toMatch(/^[0-9a-f]{12}$/);
    expect(r.out).toContain('Plan mode: no write was attempted');
    expect(r.out.match(/pending:\s+0\d{3}_/g)).toHaveLength(7);
    expect(db.lockHeld).toBe(false); // released
    expect(db.ended).toBe(true);
  });

  it('would refuse a write even if one were attempted, because the fake enforces read-only like PostgreSQL does', async () => {
    const db = new FakeDb(migrations);
    await expect(db.begin('read only', async (tx) => tx.unsafe(BOOTSTRAP.createSchema))).rejects.toThrow(/read-only/);
  });

  it('never prints the connection string, the user or the password', async () => {
    const r = await run(new FakeDb(migrations), []);
    expect(`${r.out}\n${r.err}`).not.toMatch(/app_user|p%40ss|p@ss|postgresql:\/\/|channel_binding|sslmode/);
  });
});

describe('apply needs the reviewed fingerprint, and refuses everything else before writing', () => {
  it('refuses --apply without --confirm-plan before even connecting', async () => {
    const db = new FakeDb(migrations);
    const r = await run(db, ['--apply']);
    expect(r).toMatchObject({ code: 1, connects: 0 });
    expect(r.err).toContain('--confirm-plan');
    expect(db.begins).toEqual([]);
  });
  it('refuses a fingerprint that does not match the plan, with no write', async () => {
    const db = new FakeDb(migrations);
    const r = await run(db, ['--apply', '--confirm-plan=000000000000']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/does not match the plan fingerprint/);
    expect(writes(db)).toBe(0);
    expect(db.trackingExists).toBe(false);
  });
  it('invalidates an approval when the branch, the timeline, the server version or the applied set changes', async () => {
    for (const change of [(d: FakeDb) => (d.cfg.timelineId = 'tl-2'), (d: FakeDb) => (d.cfg.serverVersionNum = 170004), (d: FakeDb) => d.markApplied(2)]) {
      const db = new FakeDb(migrations);
      const fp = fingerprintOf((await run(db, [])).out);
      change(db);
      const r = await run(db, ['--apply', `--confirm-plan=${fp}`]);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/does not match the plan fingerprint/);
      expect(writes(db)).toBe(0);
    }
  });
  it('invalidates an approval when a migration file changes after the plan', async () => {
    const dir = copyOfRealFolder();
    const db = new FakeDb(migrations);
    const fp = fingerprintOf((await run(db, [], { dir })).out);
    writeFileSync(join(dir, '0006_schema_c_guards.sql'), `${readFileSync(join(dir, '0006_schema_c_guards.sql'), 'utf8')}\n-- edited after the plan\n`);
    const r = await run(db, ['--apply', `--confirm-plan=${fp}`], { dir });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/does not match the plan fingerprint/);
    expect(writes(db)).toBe(0);
  });
});

describe('a confirmed apply', () => {
  it('bootstraps once, applies each migration in its own transaction in journal order, records it in that transaction, then verifies read-only', async () => {
    const db = new FakeDb(migrations);
    const fp = fingerprintOf((await run(db, [])).out);
    const beforeWrites = db.begins.length;
    const r = await run(db, ['--apply', `--confirm-plan=${fp}`]);
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
    const sequence = db.begins.slice(beforeWrites);
    expect(sequence).toEqual(['read only', 'read only', 'read write', ...Array<'read write'>(7).fill('read write'), 'read only', 'read only']);
    expect(writes(db)).toBe(1 + 7);
    expect(db.committed).toEqual(allStatements);
    expect(db.tracking.map((t) => [t.tag, t.hash, t.createdAt])).toEqual(migrations.map((m) => [m.tag, m.hash, String(m.when)]));
    expect(db.sent.filter((s) => s === SESSION.lockTimeout)).toHaveLength(8);
    expect(db.sent.filter((s) => s === SESSION.statementTimeout)).toHaveLength(8);
    expect(db.sent.filter((s) => s === BOOTSTRAP.createTable)).toHaveLength(1);
    expect(r.out).toContain('All verification checks passed.');
    expect(r.out).not.toContain('FAIL');
    expect(db.lockHeld).toBe(false);
  });

  it('is idempotent: a second plan has nothing pending, verifies read-only, and never writes', async () => {
    const db = new FakeDb(migrations);
    const fp = fingerprintOf((await run(db, [])).out);
    await run(db, ['--apply', `--confirm-plan=${fp}`]);
    const writesBefore = writes(db);
    const again = await run(db, []);
    expect(again.code).toBe(0);
    expect(again.out).toContain('pending: none');
    expect(again.out).toContain('All verification checks passed.');
    expect(writes(db)).toBe(writesBefore);
    const fp2 = fingerprintOf(again.out);
    const noop = await run(db, ['--apply', `--confirm-plan=${fp2}`]);
    expect(noop.code).toBe(0);
    expect(noop.out).toContain('Nothing is pending');
    expect(writes(db)).toBe(writesBefore);
  });

  it('stops at the first failing statement, rolls that migration back completely, and sends nothing after it', async () => {
    const db = new FakeDb(migrations);
    const failing = migrations[3]?.statements[5] ?? '';
    db.failOn = failing;
    const fp = fingerprintOf((await run(db, [])).out);
    const r = await run(db, ['--apply', `--confirm-plan=${fp}`]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('migrate stopped at 0003_schema_b, statement 6');
    expect(r.err).toContain('(42P07)');
    expect(r.err).toContain('rolled back completely');
    expect(db.tracking.map((t) => t.tag)).toEqual(migrations.slice(0, 3).map((m) => m.tag));
    expect(db.committed).toEqual(migrations.slice(0, 3).flatMap((m) => m.statements));
    const notSent = new Set([...migrations[3]?.statements.slice(6) ?? [], ...migrations.slice(4).flatMap((m) => m.statements)]);
    expect(db.sent.some((s) => notSent.has(s))).toBe(false);
    expect(writes(db)).toBe(1 + 3 + 1);
    expect(db.lockHeld).toBe(false);
    expect(r.out).not.toContain('All verification checks passed.');
  });

  it('resumes after a failure: the failed migration is the first pending one, and nothing is applied twice', async () => {
    const db = new FakeDb(migrations);
    db.failOn = migrations[3]?.statements[5] ?? '';
    const fp1 = fingerprintOf((await run(db, [])).out);
    await run(db, ['--apply', `--confirm-plan=${fp1}`]);
    db.failOn = null;
    const plan = await run(db, []);
    expect(plan.out).toContain('applied: 0000_extensions, 0001_schema_a, 0002_schema_a_guards');
    expect(plan.out.match(/pending:\s+0\d{3}_/g)).toHaveLength(4);
    const fp2 = fingerprintOf(plan.out);
    expect(fp2).not.toBe(fp1);
    const r = await run(db, ['--apply', `--confirm-plan=${fp2}`]);
    expect(r.code).toBe(0);
    expect(db.tracking).toHaveLength(7);
    expect(db.committed).toEqual(allStatements);
    expect(new Set(db.committed).size).toBe(db.committed.length);
  });

  it('reports failed verification and repairs nothing', async () => {
    const db = new FakeDb(migrations);
    db.patchCatalog = (c) => c.tables.push('stray_table');
    const fp = fingerprintOf((await run(db, [])).out);
    const r = await run(db, ['--apply', `--confirm-plan=${fp}`]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/FAIL\s+tables:/);
    expect(r.out).toContain('Nothing was repaired automatically');
    // From the first verification statement on, only read-only verification statements and the lock release are sent.
    const verificationStart = db.sent.findIndex((s) => FIXED_STATEMENTS.post.has(s));
    expect(verificationStart).toBeGreaterThan(0);
    expect(db.sent.slice(verificationStart).every((s) => FIXED_STATEMENTS.post.has(s) || s === PREFLIGHT.advisoryUnlock)).toBe(true);
    expect(db.sent.slice(verificationStart).some((s) => allStatements.includes(s))).toBe(false);
  });
});

describe('the runner refuses, with no write, when the database is not what the plan assumes', () => {
  const refusedFor = async (configure: (db: FakeDb) => void, message: RegExp, argv: string[] = []): Promise<void> => {
    const db = new FakeDb(migrations);
    configure(db);
    const r = await run(db, argv);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(message);
    expect(writes(db)).toBe(0);
    expect(db.committed).toEqual([]);
  };
  it('endpoint identity mismatch is a hard refusal, and so is a server that reports no endpoint id', async () => {
    await refusedFor((d) => (d.cfg.endpointId = 'ep-someone-else-9999'), /Endpoint identity mismatch/);
    await refusedFor((d) => (d.cfg.endpointId = null), /does not report a Neon endpoint id/);
  });
  it('a replica, PostgreSQL 14, a different database, a busy lock', async () => {
    await refusedFor((d) => (d.cfg.inRecovery = true), /recovery/);
    await refusedFor((d) => (d.cfg.serverVersionNum = 140012), /PostgreSQL 15/);
    await refusedFor((d) => (d.cfg.database = 'other'), /reports database/);
    await refusedFor((d) => (d.cfg.lockFree = false), /advisory lock/);
  });
  it('a database that is not empty and has no migration record, at every kind of leftover object', async () => {
    for (const emptiness of [{ ...EMPTY, relations: 3 }, { ...EMPTY, customTypes: 1 }, { ...EMPTY, functions: 2 }, { ...EMPTY, otherSchemas: 1 }]) {
      await refusedFor((d) => (d.cfg.emptiness = emptiness), /not empty/);
    }
  });
  it('a tracking table of an unknown shape, an edited applied migration, an unknown recorded migration', async () => {
    await refusedFor((d) => { d.markApplied(3); d.trackingColumns = ['id', 'hash', 'created_at']; }, /unexpected columns/);
    await refusedFor((d) => { d.markApplied(3); d.tracking[1] = { ...d.tracking[1]!, hash: 'b'.repeat(64) }; }, /has changed since it was applied/);
    await refusedFor((d) => { d.markApplied(7); d.tracking.push({ id: 8, hash: 'c'.repeat(64), createdAt: '1', tag: '0007_unknown' }); }, /records 8 migrations/);
  });
  it('an edited applied migration FILE: the recorded hash no longer matches, so the run is refused', async () => {
    const dir = copyOfRealFolder();
    writeFileSync(join(dir, '0001_schema_a.sql'), `${readFileSync(join(dir, '0001_schema_a.sql'), 'utf8')}\n-- edited later\n`);
    const db = new FakeDb(migrations);
    db.markApplied(3);
    const r = await run(db, [], { dir });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/has changed since it was applied/);
    expect(writes(db)).toBe(0);
  });
  it('a role that cannot create objects or extensions, and an extension the server does not offer', async () => {
    await refusedFor((d) => (d.cfg.canCreateInPublic = false), /cannot CREATE/);
    await refusedFor((d) => (d.cfg.memberOfNeonSuperuser = false), /neon_superuser/);
    await refusedFor((d) => (d.cfg.available = ['btree_gist']), /postgis is not available/);
  });
});

describe('the runner fails closed when PostgreSQL does not confirm the transaction mode', () => {
  it('sends nothing else if a read-only transaction is not confirmed to be read-only', async () => {
    const db = new FakeDb(migrations);
    db.cfg.readOnlyAnswer = 'off';
    const r = await run(db, []);
    expect(r.code).toBe(1);
    expect(r.err).toContain('not read-only');
    expect(db.sent).toEqual([PREFLIGHT.readOnlyCheck]);
    expect(writes(db)).toBe(0);
  });

  it('stops before any write if the session no longer holds the advisory lock', async () => {
    const db = new FakeDb(migrations);
    const fp = fingerprintOf((await run(db, [])).out);
    db.cfg.lockHeldAnswer = false;
    const r = await run(db, ['--apply', `--confirm-plan=${fp}`]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('no longer held');
    expect(writes(db)).toBe(0);
    expect(db.trackingExists).toBe(false);
  });

  it('stops before any migration statement if a write transaction turns out to be read-only', async () => {
    const db = new FakeDb(migrations);
    const fp = fingerprintOf((await run(db, [])).out);
    db.cfg.writeAnswer = 'on';
    const r = await run(db, ['--apply', `--confirm-plan=${fp}`]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('preparing the transaction, before any statement');
    expect(r.err).toContain('unexpectedly read-only');
    expect(db.sent.some((s) => allStatements.includes(s))).toBe(false);
    expect(db.committed).toEqual([]);
  });
});

describe('the runner refuses before connecting at all', () => {
  it('when the target checks fail', async () => {
    const cases: Record<string, GuardEnv> = {
      'no direct URL': baseEnv({ DATABASE_URL_DIRECT: undefined }),
      production: baseEnv({ NODE_ENV: 'production' }),
      'no confirmation': baseEnv({ CONFIRM_DB_HOST: undefined }),
      'pooled host': baseEnv({ DATABASE_URL_DIRECT: 'postgresql://u:p@ep-example-1234-pooler.region.example.invalid/devdb', CONFIRM_DB_HOST: 'ep-example-1234-pooler.region.example.invalid' }),
      'target is the test database': baseEnv({ TEST_DATABASE_URL: `postgresql://u:p@${HOST}/devdb` }),
    };
    for (const [label, env] of Object.entries(cases)) {
      const db = new FakeDb(migrations);
      const r = await run(db, [], { env });
      expect({ label, code: r.code, connects: r.connects }).toEqual({ label, code: 1, connects: 0 });
    }
  });

  it('when a migration file contains a dangerous statement, however it is disguised', async () => {
    const dir = copyOfRealFolder();
    const original = readFileSync(join(dir, '0006_schema_c_guards.sql'), 'utf8');
    const fn = (inner: string): string => `CREATE OR REPLACE FUNCTION bb_evil() RETURNS trigger LANGUAGE plpgsql AS $$\nBEGIN\n  ${inner}\n  RETURN NEW;\nEND;\n$$;`;
    const attacks = [
      fn("EXECUTE 'DROP TABLE users';"), fn("COPY users TO PROGRAM 'id';"), fn('COMMIT;'), fn('DROP TABLE users;'), fn('TRUNCATE users;'), fn('DELETE FROM users;'), fn("UPDATE users SET status = 'X';"),
      fn('INSERT INTO users (id) VALUES (1);'), fn('ALTER TABLE users DROP COLUMN status;'), fn('GRANT ALL ON users TO PUBLIC;'), fn('CREATE EXTENSION dblink;'), fn('SET search_path = evil;'), fn('PERFORM pg_sleep(60);'),
      'CREATE OR REPLACE FUNCTION bb_evil() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN RETURN NEW; END; $$;',
      'DROP TABLE "users";', 'TRUNCATE "users";', 'DELETE FROM "users";', 'CREATE TABLE "x" ("id" int DEFAULT nextval(\'s\'));', 'CREATE EXTENSION IF NOT EXISTS dblink;',
      'CREATE TRIGGER t BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION pg_sleep();',
    ];
    for (const attack of attacks) {
      writeFileSync(join(dir, '0006_schema_c_guards.sql'), `${original}\n--> statement-breakpoint\n${attack}\n`);
      const db = new FakeDb(migrations);
      const r = await run(db, [], { dir });
      expect({ attack: attack.slice(0, 70), code: r.code, connects: r.connects }).toEqual({ attack: attack.slice(0, 70), code: 1, connects: 0 });
      expect(r.err).toContain('did not pass the offline checks');
      expect(db.begins).toEqual([]);
    }
  });
});

describe('the runner source is wired the way it claims', () => {
  const read = (name: string): string => readFileSync(join(import.meta.dirname, '../../scripts', name), 'utf8');
  const core = read('db-migrate-core.ts');
  const entry = read('db-migrate.ts');
  // Comments that describe what is absent (for example "there is no --force") must not trip the checks for its absence.
  const code = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
  const all = ['db-migrate-core.ts', 'db-migrate.ts', 'db-migrate-plan.ts', 'db-migrate-scan.ts', 'db-migrate-sql.ts'].map((name) => code(read(name))).join('\n');

  it('hands SQL to the driver at exactly one place in the core and one in the driver adapter', () => {
    expect(core.match(/\.unsafe\(/g)).toHaveLength(1);
    expect(core).toContain('assertSendable(statement, origin, migrations);\n      return tx.unsafe(statement, params);');
    expect(entry.match(/\.unsafe\(/g)).toHaveLength(1);
  });

  it('opens a writable transaction only inside applyPending, which is reached once, after the fingerprint check', () => {
    const start = core.indexOf('async function applyPending');
    const end = core.indexOf('export async function runMigrate');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const outside = core.slice(0, start) + core.slice(end);
    expect(outside.match(/\.readWrite\(/g)).toBeNull();
    expect(core.slice(start, end).match(/db\.readWrite\(/g)).toHaveLength(2);
    expect(core.match(/await applyPending\(/g)).toHaveLength(1);
    const check = core.indexOf('args.confirmPlan !== fingerprint');
    const call = core.indexOf('await applyPending(');
    expect(check).toBeGreaterThan(0);
    expect(call).toBeGreaterThan(check);
    expect(core.indexOf('if (!args.apply)')).toBeLessThan(check);
  });

  it('runs every offline check before connecting, and only asks the driver for a handle after them', () => {
    const connect = core.indexOf('input.connect(options)');
    for (const marker of ['parseArgs(input.argv)', 'loadMigrations(input.migrationsDir)', 'checkTarget(env)']) expect(core.indexOf(marker)).toBeLessThan(connect);
    expect(connect).toBeGreaterThan(0);
  });

  it('uses no drizzle-kit, no drizzle migrator, no shell or process spawning, and never prints a URL or credentials', () => {
    expect(all).not.toMatch(/drizzle-kit|drizzle-orm|child_process|execSync|execFile|spawn/);
    expect(all).not.toMatch(/console\.(log|error)\([^)]*(options|password|username|connectionString|DATABASE_URL)/);
    expect(all).not.toMatch(/\$\{[^}]*(options\.(host|username|password)|env\.DATABASE|connectionString)/);
    expect(entry).not.toMatch(/dotenv.*override|quiet:\s*false/);
  });

  it('has no argument, flag or code path for force, reset, down, drop or recreate', () => {
    expect(code(core) + code(read('db-migrate-plan.ts'))).not.toMatch(/--force|--reset|--down|--drop|recreate|db:reset/i);
    const packageJson = JSON.parse(readFileSync(join(import.meta.dirname, '../../package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(packageJson.scripts['db:migrate']).toBe('tsx scripts/db-migrate.ts');
    expect(Object.values(packageJson.scripts).join(' ')).not.toMatch(/drizzle-kit (push|pull|migrate|studio|drop)/);
  });
});

describe('the tests themselves stay offline', () => {
  it('uses only reserved .invalid hosts and a fake driver', () => {
    const source = readFileSync(join(import.meta.dirname, 'db-migrate.test.ts'), 'utf8');
    expect(source).not.toMatch(new RegExp('neon' + '\\.tech'));
    expect(source).not.toMatch(/^import .*'postgres'/m);
    expect(existsSync(realDir)).toBe(true);
  });
});
