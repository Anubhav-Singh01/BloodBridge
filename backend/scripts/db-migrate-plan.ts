import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { GuardError, baseHost, parseTarget, resolveConfirmedTarget, resolveConfirmedTestTarget, type DbTarget, type GuardEnv } from '../src/db/guard.js';
import { TRACKING_COLUMNS } from './db-migrate-sql.js';
import { splitStatements, validateMigrationSet, type Classified } from './db-migrate-scan.js';

// The planning half of the migration runner: what to apply, and whether it is safe to. It sends nothing to a database.
// The only I/O here is reading the migrations folder.

export interface LoadedMigration {
  idx: number;
  tag: string;
  /** The journal timestamp. drizzle stores it as created_at, and so do we. */
  when: number;
  /** sha256 of the file text, the same as drizzle's own migrator computes. */
  hash: string;
  sql: string;
  /** The statements of the file, in order. Exactly these strings, and no others, are ever sent for this migration. */
  statements: readonly string[];
  classified: readonly Classified[];
}

const TAG = /^\d{4}_[a-z0-9_]+$/;

/** Reads the journal and every migration file, checks their integrity, and scans every statement. Never connects. */
export function loadMigrations(dir: string): { migrations: LoadedMigration[]; problems: string[] } {
  const problems: string[] = [];
  const journalPath = join(dir, 'meta', '_journal.json');
  if (!existsSync(journalPath)) return { migrations: [], problems: [`The journal ${journalPath} does not exist.`] };

  let entries: unknown;
  try {
    entries = (JSON.parse(readFileSync(journalPath, 'utf8')) as { entries?: unknown }).entries;
  } catch {
    return { migrations: [], problems: ['The journal is not valid JSON.'] };
  }
  if (!Array.isArray(entries) || entries.length === 0) return { migrations: [], problems: ['The journal has no entries.'] };

  const decoder = new TextDecoder('utf-8', { fatal: true });
  const loaded: Omit<LoadedMigration, 'classified'>[] = [];
  const seen = new Set<string>();
  let previousWhen = 0;
  entries.forEach((entry: unknown, position: number) => {
    const e = entry as { idx?: unknown; tag?: unknown; when?: unknown; breakpoints?: unknown };
    if (e.idx !== position) problems.push(`Journal entry ${position} has idx ${String(e.idx)}; idx must equal the position.`);
    if (typeof e.tag !== 'string' || !TAG.test(e.tag)) {
      problems.push(`Journal entry ${position} has an invalid tag.`);
      return;
    }
    if (seen.has(e.tag)) problems.push(`The tag ${e.tag} appears twice in the journal.`);
    seen.add(e.tag);
    if (typeof e.when !== 'number' || !Number.isSafeInteger(e.when) || e.when <= previousWhen) {
      problems.push(`${e.tag}: "when" must be an integer greater than the previous entry's.`);
    } else {
      previousWhen = e.when;
    }
    if (e.breakpoints !== true) problems.push(`${e.tag}: breakpoints must be true.`);

    const path = join(dir, `${e.tag}.sql`);
    if (!existsSync(path)) {
      problems.push(`${e.tag}: the file ${e.tag}.sql does not exist.`);
      return;
    }
    const bytes = readFileSync(path);
    if (bytes.includes(0)) problems.push(`${e.tag}: the file contains NUL bytes.`);
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) problems.push(`${e.tag}: the file starts with a byte order mark.`);
    let sql = '';
    try {
      sql = decoder.decode(bytes);
    } catch {
      problems.push(`${e.tag}: the file is not valid UTF-8.`);
    }
    loaded.push({
      idx: position,
      tag: e.tag,
      when: typeof e.when === 'number' ? e.when : 0,
      hash: createHash('sha256').update(sql).digest('hex'),
      sql,
      statements: splitStatements(sql),
    });
  });

  const tags = new Set(loaded.map((m) => m.tag));
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql'))) {
    if (!tags.has(file.replace(/\.sql$/, ''))) problems.push(`${file} is in the folder but not in the journal.`);
  }

  const scan = validateMigrationSet(loaded.map((m) => ({ tag: m.tag, statements: m.statements })));
  problems.push(...scan.problems);
  const migrations = loaded.map((m, i) => ({ ...m, classified: scan.migrations[i]?.classified ?? [] }));
  return { migrations, problems };
}

// ---------------------------------------------------------------------------------------------------------------------
// Arguments and target.

export type ParsedArgs = { ok: true; apply: boolean; confirmPlan: string | null } | { ok: false; message: string };

/** Only two arguments exist. There is no --force, --reset, --down, --to, --file or URL argument. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  let apply = false;
  let confirmPlan: string | null = null;
  for (const arg of argv) {
    if (arg === '--apply') {
      if (apply) return { ok: false, message: '--apply was given twice.' };
      apply = true;
    } else if (arg.startsWith('--confirm-plan=')) {
      if (confirmPlan !== null) return { ok: false, message: '--confirm-plan was given twice.' };
      const value = arg.slice('--confirm-plan='.length);
      if (!/^[0-9a-f]{12}$/.test(value)) return { ok: false, message: '--confirm-plan must be the 12 hex characters of the plan fingerprint.' };
      confirmPlan = value;
    } else {
      return { ok: false, message: `Unsupported argument. Allowed: --apply and --confirm-plan=<fingerprint>.` };
    }
  }
  if (confirmPlan !== null && !apply) return { ok: false, message: '--confirm-plan is only meaningful together with --apply.' };
  if (apply && confirmPlan === null) {
    return { ok: false, message: 'Applying needs --confirm-plan=<fingerprint>. Run the plan first (no arguments) and pass the fingerprint it prints.' };
  }
  return { ok: true, apply, confirmPlan };
}

export type TargetResult =
  | { ok: true; target: DbTarget; connectionString: string; endpointLabel: string; envVarName: string; confirmVarName: string; runtimeEndpoint: 'same' | 'different' | 'not set' | 'invalid' }
  | { ok: false; message: string };

/** The target checks that run before any connection to the DEV branch. */
export function checkTarget(env: GuardEnv): TargetResult {
  if (!env.DATABASE_URL_DIRECT) {
    return { ok: false, message: 'DATABASE_URL_DIRECT must be set. The runner never falls back to the pooled DATABASE_URL.' };
  }
  let target: DbTarget;
  try {
    // DATABASE_URL_DIRECT is set, so this resolves that URL and no other.
    target = resolveConfirmedTarget(env, 'migrate');
  } catch (error) {
    return { ok: false, message: error instanceof GuardError ? error.message : 'The target could not be resolved.' };
  }
  if (/-pooler(?=\.)/.test(target.host)) return { ok: false, message: 'The target is a pooled (-pooler) endpoint. Migrations need the direct endpoint.' };

  if (env.TEST_DATABASE_URL) {
    try {
      const test = parseTarget(env.TEST_DATABASE_URL);
      if (baseHost(test.host) === baseHost(target.host) && test.database === target.database) {
        return { ok: false, message: 'The target is the same database as TEST_DATABASE_URL. The runner only touches the dev branch.' };
      }
    } catch {
      return { ok: false, message: 'TEST_DATABASE_URL is set but is not a valid connection URL, so dev and test cannot be told apart.' };
    }
  }

  let runtimeEndpoint: 'same' | 'different' | 'not set' | 'invalid' = 'not set';
  if (env.DATABASE_URL) {
    try {
      const runtime = parseTarget(env.DATABASE_URL);
      runtimeEndpoint = baseHost(runtime.host) === baseHost(target.host) ? 'same' : 'different';
    } catch {
      runtimeEndpoint = 'invalid';
    }
  }
  const endpointLabel = target.host.split('.')[0] ?? '';
  return { ok: true, target, connectionString: env.DATABASE_URL_DIRECT, endpointLabel, envVarName: 'DATABASE_URL_DIRECT', confirmVarName: 'CONFIRM_DB_HOST', runtimeEndpoint };
}

/**
 * The target checks that run before any connection to the TEST branch (Batch 3.7, D1/D2/D3). A separate function
 * from checkTarget, so the dev and test paths can never be confused with each other; both feed the same
 * runMigrate (db-migrate-core.ts), which takes the checker as a parameter.
 */
export function checkTestTarget(env: GuardEnv): TargetResult {
  if (!env.TEST_DATABASE_URL) {
    return { ok: false, message: 'TEST_DATABASE_URL must be set. The test migration runner never falls back to the dev or pooled URL.' };
  }
  let target: DbTarget;
  try {
    // Refuses NODE_ENV=production, requires CONFIRM_TEST_DB_HOST to match, and refuses if this equals the dev target.
    target = resolveConfirmedTestTarget(env);
  } catch (error) {
    return { ok: false, message: error instanceof GuardError ? error.message : 'The test target could not be resolved.' };
  }
  if (/-pooler(?=\.)/.test(target.host)) {
    return { ok: false, message: 'The target is a pooled (-pooler) endpoint. The test migration runner needs the direct endpoint (D3).' };
  }
  const endpointLabel = target.host.split('.')[0] ?? '';
  // There is no separate pooled/direct pair to compare for the test branch, unlike DATABASE_URL vs DATABASE_URL_DIRECT.
  return { ok: true, target, connectionString: env.TEST_DATABASE_URL, endpointLabel, envVarName: 'TEST_DATABASE_URL', confirmVarName: 'CONFIRM_TEST_DB_HOST', runtimeEndpoint: 'not set' };
}

// ---------------------------------------------------------------------------------------------------------------------
// Server state, reconciliation and the plan fingerprint.

export interface AppliedRow {
  id: number;
  hash: string;
  createdAt: string;
  tag: string | null;
}

export interface ServerState {
  lockAcquired: boolean;
  serverVersionNum: number;
  inRecovery: boolean;
  database: string;
  endpointId: string | null;
  timelineId: string | null;
  isSuperuser: string;
  memberOfNeonSuperuser: boolean | null;
  canCreateInDatabase: boolean;
  canCreateInPublic: boolean;
  /** Extension name to its installed version (null when available but not installed). */
  extensions: ReadonlyMap<string, string | null>;
  trackingExists: boolean;
  trackingColumns: readonly string[];
  applied: readonly AppliedRow[];
  emptiness: { relations: number; customTypes: number; functions: number; otherSchemas: number };
}

export class PlanError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(problems.join(' '));
    this.name = 'PlanError';
    this.problems = problems;
  }
}

const isEmpty = (e: ServerState['emptiness']): boolean => e.relations === 0 && e.customTypes === 0 && e.functions === 0 && e.otherSchemas === 0;

/** Checks the server against the target and the pending work. Returns every problem found. */
export function checkServerState(state: ServerState, target: DbTarget, endpointLabel: string, pending: readonly LoadedMigration[]): string[] {
  const problems: string[] = [];
  if (!state.lockAcquired) problems.push('Another migration runner holds the advisory lock. Nothing was changed.');
  if (state.database !== target.database) problems.push(`The server reports database "${state.database}" but the target is "${target.database}".`);
  if (state.inRecovery) problems.push('The server is in recovery (a read replica), so it cannot be migrated.');
  if (!(state.serverVersionNum >= 150000)) problems.push(`PostgreSQL 15 or newer is required (NULLS NOT DISTINCT). The server reports version number ${state.serverVersionNum}.`);
  if (state.endpointId === null) problems.push('The server does not report a Neon endpoint id, so the target cannot be verified.');
  else if (state.endpointId !== endpointLabel) problems.push(`Endpoint identity mismatch: the host names ${endpointLabel} but the server reports ${state.endpointId}.`);

  if (pending.length > 0) {
    if (!state.canCreateInDatabase || !state.canCreateInPublic) problems.push('The role cannot CREATE in the database or in schema public.');
    if (state.isSuperuser !== 'on' && state.memberOfNeonSuperuser !== true) problems.push('The role is neither a superuser nor a member of neon_superuser, which CREATE EXTENSION needs.');
    for (const migration of pending) {
      for (const statement of migration.classified) {
        if (statement.kind === 'CREATE EXTENSION' && statement.name && !state.extensions.has(statement.name)) {
          problems.push(`The extension ${statement.name} is not available on this server.`);
        }
      }
    }
  }
  return problems;
}

/** Decides which migrations are applied and which are pending, or refuses. */
export function reconcile(
  migrations: readonly LoadedMigration[],
  state: ServerState,
): { ok: true; applied: LoadedMigration[]; pending: LoadedMigration[] } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  if (state.trackingExists) {
    if (state.trackingColumns.join(',') !== TRACKING_COLUMNS.join(',')) {
      problems.push(`The tracking table has unexpected columns (${state.trackingColumns.join(', ') || 'none'}); expected ${TRACKING_COLUMNS.join(', ')}. It is not adopted.`);
    }
    if (state.applied.length > migrations.length) problems.push(`The database records ${state.applied.length} migrations but the journal has ${migrations.length}.`);
    state.applied.forEach((row, i) => {
      const expected = migrations[i];
      if (!expected) return;
      if (row.hash !== expected.hash) problems.push(`Recorded migration ${i} (${row.tag ?? 'no tag'}) does not match ${expected.tag}: its file has changed since it was applied, or the order differs.`);
      else if (Number(row.createdAt) !== expected.when || row.tag !== expected.tag) problems.push(`Recorded migration ${i} has a different tag or timestamp than ${expected.tag}.`);
    });
  }
  const appliedCount = state.trackingExists ? state.applied.length : 0;
  if (appliedCount === 0 && !isEmpty(state.emptiness)) {
    problems.push('No migration is recorded, but the database is not empty. The runner will not adopt or overwrite an existing schema.');
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, applied: migrations.slice(0, appliedCount), pending: migrations.slice(appliedCount) };
}

export function planFingerprint(input: {
  host: string;
  database: string;
  endpointId: string;
  timelineId: string | null;
  serverVersionNum: number;
  applied: readonly string[];
  pending: readonly { tag: string; hash: string }[];
}): string {
  const canonical = JSON.stringify([
    'bloodbridge-migrate-plan-v1',
    input.host,
    input.database,
    input.endpointId,
    input.timelineId,
    input.serverVersionNum,
    input.applied,
    input.pending.map((p) => [p.tag, p.hash]),
  ]);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

// ---------------------------------------------------------------------------------------------------------------------
// What the database should contain afterwards, derived from the migrations themselves.

export interface ExpectedObjects {
  tables: string[];
  enums: string[];
  views: string[];
  functions: string[];
  triggers: string[];
  foreignKeys: number;
  exclusions: number;
  extensions: string[];
  transitionRows: number;
}

export function expectedObjects(migrations: readonly LoadedMigration[]): ExpectedObjects {
  const names = (kind: Classified['kind']): string[] =>
    migrations.flatMap((m) => m.classified.filter((c) => c.kind === kind && c.name !== undefined).map((c) => (c.name as string).toLowerCase())).sort();
  const all = migrations.flatMap((m) => m.classified);
  return {
    tables: names('CREATE TABLE'),
    enums: names('CREATE TYPE'),
    views: names('CREATE VIEW'),
    functions: [...new Set(names('CREATE FUNCTION'))],
    triggers: names('CREATE TRIGGER'),
    foreignKeys: all.filter((c) => c.kind === 'ALTER TABLE ADD CONSTRAINT' && c.constraint === 'FOREIGN KEY').length,
    exclusions: all.filter((c) => c.kind === 'ALTER TABLE ADD CONSTRAINT' && c.constraint === 'EXCLUDE').length,
    extensions: names('CREATE EXTENSION'),
    transitionRows: all.reduce((n, c) => n + (c.rows ?? 0), 0),
  };
}

export interface PostActual {
  tracking: readonly AppliedRow[];
  tables: readonly string[];
  enums: readonly string[];
  views: readonly string[];
  functions: readonly { name: string; securityDefiner: boolean; language: string; returns: string; args: number; hasConfig: boolean }[];
  triggers: readonly { table: string; name: string; functionName: string }[];
  constraints: Readonly<Record<string, number>>;
  extensions: readonly string[];
  transitionRows: number;
}

export interface PostCheck {
  name: string;
  ok: boolean;
  detail: string;
}

const difference = (a: readonly string[], b: readonly string[]): string[] => a.filter((x) => !b.includes(x));

function sameSet(label: string, expected: readonly string[], actual: readonly string[]): PostCheck {
  const missing = difference(expected, actual);
  const extra = difference(actual, expected);
  const ok = missing.length === 0 && extra.length === 0;
  return { name: label, ok, detail: ok ? `${expected.length} as expected` : `missing: ${missing.join(', ') || 'none'}; unexpected: ${extra.join(', ') || 'none'}` };
}

/** Layer 5 and the object counts: compares what the database now holds with what the migrations should have made. */
export function evaluatePost(migrations: readonly LoadedMigration[], expected: ExpectedObjects, actual: PostActual): PostCheck[] {
  const trackingOk =
    actual.tracking.length === migrations.length &&
    migrations.every((m, i) => {
      const row = actual.tracking[i];
      return row !== undefined && row.hash === m.hash && Number(row.createdAt) === m.when && row.tag === m.tag;
    });
  const badFunctions = actual.functions.filter((f) => f.securityDefiner || f.language !== 'plpgsql' || f.returns !== 'trigger' || f.args !== 0 || f.hasConfig);
  const strayTriggers = actual.triggers.filter((t) => !expected.functions.includes(t.functionName));
  return [
    { name: 'migration records match the journal', ok: trackingOk, detail: `${actual.tracking.length} recorded, ${migrations.length} in the journal` },
    sameSet('tables', expected.tables, actual.tables),
    sameSet('enums', expected.enums, actual.enums),
    sameSet('views', expected.views, actual.views),
    sameSet('bb_ functions', expected.functions, actual.functions.map((f) => f.name)),
    {
      name: 'functions are plpgsql triggers, not SECURITY DEFINER, no SET config, no parameters',
      ok: badFunctions.length === 0,
      detail: badFunctions.length === 0 ? `${actual.functions.length} checked` : `offending: ${badFunctions.map((f) => f.name).join(', ')}`,
    },
    sameSet('triggers', expected.triggers, actual.triggers.map((t) => t.name)),
    { name: 'every trigger calls one of the migration-defined functions', ok: strayTriggers.length === 0, detail: strayTriggers.length === 0 ? 'yes' : strayTriggers.map((t) => t.name).join(', ') },
    { name: 'foreign keys', ok: (actual.constraints.f ?? 0) === expected.foreignKeys, detail: `${actual.constraints.f ?? 0} found, ${expected.foreignKeys} expected` },
    { name: 'exclusion constraints', ok: (actual.constraints.x ?? 0) === expected.exclusions, detail: `${actual.constraints.x ?? 0} found, ${expected.exclusions} expected` },
    { name: 'extensions installed', ok: difference(expected.extensions, actual.extensions).length === 0, detail: `expected ${expected.extensions.join(', ')}` },
    { name: 'request_transitions rows', ok: actual.transitionRows === expected.transitionRows, detail: `${actual.transitionRows} found, ${expected.transitionRows} expected` },
  ];
}
