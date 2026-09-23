import type { GuardEnv } from '../src/db/guard.js';
import { connectionOptions, scrubSecrets } from './db-probe-queries.js';
import { BOOTSTRAP, FIXED_STATEMENTS, POST, PREFLIGHT, SESSION, TRACKING_INSERT, type FixedGroup } from './db-migrate-sql.js';
import {
  checkServerState,
  checkTarget,
  evaluatePost,
  expectedObjects,
  loadMigrations,
  parseArgs,
  planFingerprint,
  reconcile,
  type AppliedRow,
  type LoadedMigration,
  type PostActual,
  type ServerState,
  type TargetResult,
} from './db-migrate-plan.js';

// The migration runner's whole flow, with the database driver abstracted away so it can be tested offline against a fake.
//
// Two rules make the write path hard to reach:
//   1. SQL reaches the driver at exactly one place, the gatekeeper below. It refuses any statement that is not either
//      one of the fixed constants in db-migrate-sql.ts or, for a migration, the exact text the scanner accepted.
//   2. A writable transaction is opened at exactly one place, applyPending, which runs only after every check has passed
//      and the plan fingerprint has been confirmed. Plan mode (no arguments) never reaches it.

export type Row = Record<string, unknown>;
export type Origin = { type: 'fixed'; group: FixedGroup } | { type: 'migration'; tag: string; index: number };

export interface RawTx {
  unsafe(statement: string, params?: readonly (string | number)[]): Promise<Row[]>;
}
export interface RawDb {
  begin<T>(mode: 'read only' | 'read write', work: (tx: RawTx) => Promise<T>): Promise<T>;
  end(): Promise<void>;
}
export interface Io {
  line(label: string, text: string): void;
  text(message: string): void;
  error(message: string): void;
}

export function migrateConnectionOptions(connectionString: string) {
  return {
    ...connectionOptions(connectionString),
    // The advisory lock is held by the session, so the connection must not be closed for being idle between phases.
    idle_timeout: 0,
    max_lifetime: 900,
    connection: { application_name: 'bloodbridge-db-migrate' },
  };
}
export type MigrateConnectionOptions = ReturnType<typeof migrateConnectionOptions>;

export interface RunInput {
  env: GuardEnv;
  argv: readonly string[];
  migrationsDir: string;
  /** Creates the database handle. Called only after every offline check has passed. */
  connect: (options: MigrateConnectionOptions) => RawDb;
  io: Io;
  /**
   * Resolves and validates the target before connecting. Defaults to the dev-branch check (checkTarget).
   * Batch 3.7's db-test-migrate.ts passes checkTestTarget here instead (D2), sharing this whole engine rather
   * than duplicating it.
   */
  checkTarget?: (env: GuardEnv) => TargetResult;
}

// ---------------------------------------------------------------------------------------------------------------------
// The gatekeeper.

export class RefusedStatementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefusedStatementError';
  }
}

export function assertSendable(statement: string, origin: Origin, migrations: readonly LoadedMigration[]): void {
  if (origin.type === 'fixed') {
    if (!FIXED_STATEMENTS[origin.group].has(statement)) throw new RefusedStatementError(`refused: that text is not in the fixed "${origin.group}" statements`);
    return;
  }
  const expected = migrations.find((m) => m.tag === origin.tag)?.statements[origin.index];
  if (expected === undefined || expected !== statement) {
    throw new RefusedStatementError(`refused: that text is not statement ${origin.index + 1} of ${origin.tag} as the scanner accepted it`);
  }
}

export interface Tx {
  run(statement: string, origin: Origin, params?: readonly (string | number)[]): Promise<Row[]>;
}
export interface GuardedDb {
  readOnly<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
  readWrite<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
  end(): Promise<void>;
}

export function guardedDb(raw: RawDb, migrations: readonly LoadedMigration[]): GuardedDb {
  const wrap = (tx: RawTx): Tx => ({
    async run(statement, origin, params) {
      assertSendable(statement, origin, migrations);
      return tx.unsafe(statement, params);
    },
  });
  return {
    readOnly: (work) => raw.begin('read only', (tx) => work(wrap(tx))),
    readWrite: (work) => raw.begin('read write', (tx) => work(wrap(tx))),
    end: () => raw.end(),
  };
}

const fixed = (group: FixedGroup): Origin => ({ type: 'fixed', group });

// ---------------------------------------------------------------------------------------------------------------------
// Reading the server (always read-only).

const str = (value: unknown): string => (value === null || value === undefined ? '' : String(value));
const nullable = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

async function readServerState(tx: Tx): Promise<ServerState> {
  const rows = (statement: string): Promise<Row[]> => tx.run(statement, fixed('preflight'));
  const one = async (statement: string): Promise<Row> => (await rows(statement))[0] ?? {};

  // Fail closed: nothing else is sent unless PostgreSQL confirms the transaction is read-only.
  if ((await one(PREFLIGHT.readOnlyCheck)).transaction_read_only !== 'on') throw new Error('The transaction is not read-only. Aborting before any other statement.');

  const lock = await one(PREFLIGHT.advisoryLock);
  const server = await one(PREFLIGHT.server);
  const privileges = await one(PREFLIGHT.privileges);
  const available = await rows(PREFLIGHT.extensionsAvailable);
  const trackingExists = (await one(PREFLIGHT.trackingExists)).present === true;
  const trackingColumns = trackingExists ? (await rows(PREFLIGHT.trackingColumns)).map((r) => str(r.name)) : [];
  const applied: AppliedRow[] = trackingExists
    ? (await rows(PREFLIGHT.trackingRows)).map((r) => ({ id: Number(r.id), hash: str(r.hash), createdAt: str(r.created_at), tag: nullable(r.tag) }))
    : [];
  const emptiness = await one(PREFLIGHT.emptiness);

  return {
    lockAcquired: lock.locked === true,
    serverVersionNum: Number(server.server_version_num),
    inRecovery: server.in_recovery === true,
    database: str(server.database),
    endpointId: nullable(server.endpoint_id),
    timelineId: nullable(server.timeline_id),
    isSuperuser: str(privileges.is_superuser),
    memberOfNeonSuperuser: privileges.member_of_neon_superuser === null || privileges.member_of_neon_superuser === undefined ? null : privileges.member_of_neon_superuser === true,
    canCreateInDatabase: privileges.can_create_in_database === true,
    canCreateInPublic: privileges.can_create_in_public === true,
    extensions: new Map(available.map((r) => [str(r.name), nullable(r.installed_version)] as const)),
    trackingExists,
    trackingColumns,
    applied,
    emptiness: {
      relations: Number(emptiness.relations),
      customTypes: Number(emptiness.custom_types),
      functions: Number(emptiness.functions),
      otherSchemas: Number(emptiness.other_schemas),
    },
  };
}

async function readPostActual(tx: Tx): Promise<PostActual> {
  const rows = (statement: string): Promise<Row[]> => tx.run(statement, fixed('post'));
  if ((await tx.run(PREFLIGHT.readOnlyCheck, fixed('preflight')))[0]?.transaction_read_only !== 'on') throw new Error('The verification transaction is not read-only.');
  const constraints: Record<string, number> = {};
  for (const r of await rows(POST.constraints)) constraints[str(r.type)] = Number(r.n);
  return {
    tracking: (await rows(POST.trackingRows)).map((r) => ({ id: Number(r.id), hash: str(r.hash), createdAt: str(r.created_at), tag: nullable(r.tag) })),
    tables: (await rows(POST.tables)).map((r) => str(r.name)),
    enums: (await rows(POST.enums)).map((r) => str(r.name)),
    views: (await rows(POST.views)).map((r) => str(r.name)),
    functions: (await rows(POST.functions)).map((r) => ({
      name: str(r.name),
      securityDefiner: r.security_definer === true,
      language: str(r.language),
      returns: str(r.returns),
      args: Number(r.args),
      hasConfig: r.has_config === true,
    })),
    triggers: (await rows(POST.triggers)).map((r) => ({ table: str(r.table_name), name: str(r.name), functionName: str(r.function_name) })),
    constraints,
    extensions: (await rows(POST.extensions)).map((r) => str(r.name)),
    transitionRows: Number((await rows(POST.transitions))[0]?.n),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Writing. The only code in this file that opens a writable transaction.

async function applyPending(
  db: GuardedDb,
  state: ServerState,
  pending: readonly LoadedMigration[],
  io: Io,
  describe: (error: unknown) => string,
): Promise<boolean> {
  // The session lock must still be held: the connection could have been replaced since the plan was read.
  const held = await db.readOnly(async (tx) => (await tx.run(PREFLIGHT.advisoryLockHeld, fixed('preflight')))[0]?.held === true);
  if (!held) {
    io.error('migrate stopped: the advisory lock is no longer held by this session. Nothing was changed.');
    return false;
  }

  if (!state.trackingExists) {
    io.text('Creating the tracking table (the first write)...');
    try {
      await db.readWrite(async (tx) => {
        await tx.run(SESSION.lockTimeout, fixed('session'));
        await tx.run(SESSION.statementTimeout, fixed('session'));
        await tx.run(BOOTSTRAP.createSchema, fixed('bootstrap'));
        await tx.run(BOOTSTRAP.createTable, fixed('bootstrap'));
      });
    } catch (error) {
      io.error(`migrate stopped while creating the tracking table: ${describe(error)}`);
      return false;
    }
  }

  for (const migration of pending) {
    // Where the transaction was when it failed, for the report. A holder object, because the callback assigns to it.
    const progress: { stage: 'preparing' | 'recording' | number } = { stage: 'preparing' };
    try {
      await db.readWrite(async (tx) => {
        await tx.run(SESSION.lockTimeout, fixed('session'));
        await tx.run(SESSION.statementTimeout, fixed('session'));
        if ((await tx.run(SESSION.readOnlyCheck, fixed('session')))[0]?.transaction_read_only !== 'off') throw new Error('The write transaction is unexpectedly read-only.');
        for (let index = 0; index < migration.statements.length; index += 1) {
          const statement = migration.statements[index];
          if (statement === undefined) continue;
          progress.stage = index;
          await tx.run(statement, { type: 'migration', tag: migration.tag, index });
        }
        progress.stage = 'recording';
        await tx.run(TRACKING_INSERT, fixed('tracking-insert'), [migration.hash, migration.when, migration.tag]);
      });
    } catch (error) {
      const stage = progress.stage;
      const where =
        typeof stage === 'number'
          ? `statement ${stage + 1}: ${(migration.statements[stage] ?? '').replace(/\s+/g, ' ').slice(0, 100)}`
          : stage === 'recording'
            ? 'recording the migration'
            : 'preparing the transaction, before any statement';
      io.error(`migrate stopped at ${migration.tag}, ${where}`);
      io.error(`  ${describe(error)}`);
      io.error(`  ${migration.tag} was rolled back completely. Earlier migrations stay applied and recorded. Nothing was retried.`);
      return false;
    }
    io.line(`applied ${migration.tag}:`, `${migration.statements.length} statements, recorded`);
  }
  return true;
}

// ---------------------------------------------------------------------------------------------------------------------
// The flow.

export async function runMigrate(input: RunInput): Promise<number> {
  const { env, io } = input;
  const args = parseArgs(input.argv);
  if (!args.ok) {
    io.error(`migrate refused: ${args.message}`);
    return 1;
  }

  // Offline: nothing has touched the network yet.
  const loaded = loadMigrations(input.migrationsDir);
  if (loaded.problems.length > 0) {
    io.error('migrate refused: the migration files did not pass the offline checks:');
    for (const problem of loaded.problems) io.error(`  - ${problem}`);
    return 1;
  }
  const migrations = loaded.migrations;
  const target = (input.checkTarget ?? checkTarget)(env);
  if (!target.ok) {
    io.error(`migrate refused: ${target.message}`);
    return 1;
  }

  io.text('BloodBridge migration runner');
  io.line('target (host/database):', `${target.target.host}/${target.target.database}`);
  io.line('taken from:', `${target.envVarName} (direct, not pooled)`);
  io.line('NODE_ENV:', env.NODE_ENV ?? '(unset)');
  io.line('confirmation:', `CONFIRMED (${target.confirmVarName} matches the target host)`);
  if (target.runtimeEndpoint !== 'not set') {
    io.line('runtime DATABASE_URL:', `${target.runtimeEndpoint} endpoint as the target (informational; the runner does not use it)`);
  }
  io.line('migrations on disk:', `${migrations.length}, ${migrations.reduce((n, m) => n + m.statements.length, 0)} statements, all passed the scanner`);

  const options = migrateConnectionOptions(target.connectionString);
  const secrets = [options.password, options.username];
  const describe = (error: unknown): string => {
    const code = typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'no code';
    const message = error instanceof Error ? scrubSecrets(error.message, secrets).slice(0, 300) : 'unexpected error';
    return `(${code}) ${message}`;
  };

  const db = guardedDb(input.connect(options), migrations);
  let lockHeld = false;
  try {
    const state = await db.readOnly(readServerState);
    lockHeld = state.lockAcquired;

    io.line('server version number:', String(state.serverVersionNum));
    io.line('Neon endpoint / timeline:', `${state.endpointId ?? '(none)'} / ${state.timelineId ?? '(none)'}`);

    const reconciled = reconcile(migrations, state);
    const problems = [...checkServerState(state, target.target, target.endpointLabel, reconciled.ok ? reconciled.pending : migrations), ...(reconciled.ok ? [] : reconciled.problems)];
    if (problems.length > 0) {
      io.error('migrate refused. Nothing was changed:');
      for (const problem of problems) io.error(`  - ${problem}`);
      return 1;
    }
    if (!reconciled.ok || state.endpointId === null) return 1; // unreachable: covered by the problems above

    const { applied, pending } = reconciled;
    const fingerprint = planFingerprint({
      host: target.target.host,
      database: target.target.database,
      endpointId: state.endpointId,
      timelineId: state.timelineId,
      serverVersionNum: state.serverVersionNum,
      applied: applied.map((m) => m.tag),
      pending: pending.map((m) => ({ tag: m.tag, hash: m.hash })),
    });

    io.line('applied:', applied.length === 0 ? 'none' : applied.map((m) => m.tag).join(', '));
    if (pending.length === 0) io.line('pending:', 'none');
    for (const m of pending) {
      const kinds = new Map<string, number>();
      for (const c of m.classified) kinds.set(c.kind, (kinds.get(c.kind) ?? 0) + 1);
      io.line('pending:', `${m.tag}  ${m.statements.length} statements  sha256 ${m.hash.slice(0, 12)}...`);
      io.text(`    ${[...kinds].map(([kind, n]) => `${n} ${kind}`).join(', ')}`);
    }
    io.line('plan fingerprint:', fingerprint);

    if (!args.apply) {
      if (pending.length === 0) {
        const checks = evaluatePost(migrations, expectedObjects(migrations), await db.readOnly(readPostActual));
        reportChecks(io, checks);
        return checks.every((c) => c.ok) ? 0 : 1;
      }
      io.text('Plan mode: no write was attempted. To apply, run again with --apply --confirm-plan=' + fingerprint);
      return 0;
    }

    if (args.confirmPlan !== fingerprint) {
      io.error(`migrate refused: --confirm-plan does not match the plan fingerprint (${fingerprint}). The database, the files or the plan changed since it was reviewed. Nothing was changed.`);
      return 1;
    }
    if (pending.length === 0) {
      io.text('Nothing is pending. No write was attempted.');
      return 0;
    }

    const ok = await applyPending(db, state, pending, io, describe);
    if (!ok) return 1;

    io.text('Verifying (read-only)...');
    const checks = evaluatePost(migrations, expectedObjects(migrations), await db.readOnly(readPostActual));
    reportChecks(io, checks);
    return checks.every((c) => c.ok) ? 0 : 1;
  } catch (error) {
    io.error(`migrate failed: ${describe(error)}`);
    return 1;
  } finally {
    if (lockHeld) {
      try {
        await db.readOnly(async (tx) => tx.run(PREFLIGHT.advisoryUnlock, fixed('preflight')));
      } catch {
        // Closing the session releases the lock anyway.
      }
    }
    try {
      await db.end();
    } catch {
      // Nothing left to do.
    }
  }
}

function reportChecks(io: Io, checks: readonly { name: string; ok: boolean; detail: string }[]): void {
  for (const check of checks) io.line(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name}:`, check.detail);
  io.text(checks.every((c) => c.ok) ? 'All verification checks passed.' : 'Some verification checks FAILED. Nothing was repaired automatically.');
}
