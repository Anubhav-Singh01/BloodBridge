// Every statement the migration runner may send that is NOT read from a migration file. Nothing else is ever sent.
// Each group is a fixed set of constants: the runner's gatekeeper refuses any other text (scripts/db-migrate-core.ts).

/** A fixed key for the session-level advisory lock that stops two runners working at once. */
export const ADVISORY_LOCK_KEY = 1470813205;

export const MIGRATIONS_TABLE = 'drizzle.__drizzle_migrations';
/** The columns the tracking table must have, in order: drizzle's three plus tag and applied_at. */
export const TRACKING_COLUMNS = ['id', 'hash', 'created_at', 'tag', 'applied_at'] as const;

// Not owned by an extension. PostGIS, for example, creates spatial_ref_sys, which is not ours.
const NOT_EXTENSION_OWNED = (catalog: 'pg_class' | 'pg_type' | 'pg_proc', alias: string): string =>
  `NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = '${catalog}'::regclass AND d.objid = ${alias}.oid AND d.deptype = 'e')`;

/** Read-only. Sent inside BEGIN READ ONLY. Each is one SELECT or SHOW. */
export const PREFLIGHT = {
  readOnlyCheck: 'SHOW transaction_read_only',
  advisoryLock: `SELECT pg_try_advisory_lock(${ADVISORY_LOCK_KEY}) AS locked`,
  advisoryLockHeld: `SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted AND ((classid::bigint << 32) | objid::bigint) = ${ADVISORY_LOCK_KEY}) AS held`,
  advisoryUnlock: `SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY}) AS unlocked`,
  server:
    "SELECT current_setting('server_version_num')::int AS server_version_num, pg_is_in_recovery() AS in_recovery, current_database() AS database, current_setting('neon.endpoint_id', true) AS endpoint_id, current_setting('neon.timeline_id', true) AS timeline_id",
  privileges:
    "SELECT current_setting('is_superuser') AS is_superuser, has_database_privilege(current_database(), 'CREATE') AS can_create_in_database, has_schema_privilege('public', 'CREATE') AS can_create_in_public, (SELECT pg_has_role(oid, 'MEMBER') FROM pg_roles WHERE rolname = 'neon_superuser') AS member_of_neon_superuser",
  extensionsAvailable: 'SELECT name, installed_version FROM pg_available_extensions ORDER BY name',
  trackingExists: `SELECT to_regclass('${MIGRATIONS_TABLE}') IS NOT NULL AS present`,
  trackingColumns:
    "SELECT column_name AS name FROM information_schema.columns WHERE table_schema = 'drizzle' AND table_name = '__drizzle_migrations' ORDER BY ordinal_position",
  trackingRows: `SELECT id::int AS id, hash, created_at::text AS created_at, tag FROM ${MIGRATIONS_TABLE} ORDER BY created_at, id`,
  // "Empty" for a first run: nothing that is not extension-owned, apart from the tracking table and its sequence.
  emptiness: `SELECT (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f') AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND NOT (n.nspname = 'drizzle' AND c.relname IN ('__drizzle_migrations', '__drizzle_migrations_id_seq')) AND ${NOT_EXTENSION_OWNED('pg_class', 'c')}) AS relations, (SELECT count(*)::int FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typtype IN ('e', 'd') AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND ${NOT_EXTENSION_OWNED('pg_type', 't')}) AS custom_types, (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND ${NOT_EXTENSION_OWNED('pg_proc', 'p')}) AS functions, (SELECT count(*)::int FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname NOT IN ('information_schema', 'public', 'drizzle')) AS other_schemas`,
} as const;

/** Read-only checks after the last migration. */
export const POST = {
  trackingRows: PREFLIGHT.trackingRows,
  tables: `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND ${NOT_EXTENSION_OWNED('pg_class', 'c')} ORDER BY 1`,
  enums: "SELECT t.typname AS name FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typtype = 'e' ORDER BY 1",
  views: `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'v' AND ${NOT_EXTENSION_OWNED('pg_class', 'c')} ORDER BY 1`,
  functions:
    "SELECT p.proname AS name, p.prosecdef AS security_definer, l.lanname AS language, t.typname AS returns, p.pronargs::int AS args, p.proconfig IS NOT NULL AS has_config FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang JOIN pg_type t ON t.oid = p.prorettype WHERE n.nspname = 'public' AND p.proname ~ '^bb_' ORDER BY 1",
  triggers: `SELECT c.relname AS table_name, t.tgname AS name, p.proname AS function_name FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_proc p ON p.oid = t.tgfoid WHERE NOT t.tgisinternal AND n.nspname = 'public' AND ${NOT_EXTENSION_OWNED('pg_class', 'c')} ORDER BY 1, 2`,
  constraints:
    "SELECT c.contype::text AS type, count(*)::int AS n FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'public' AND c.contype IN ('f', 'x') GROUP BY 1 ORDER BY 1",
  extensions: 'SELECT extname AS name FROM pg_extension ORDER BY 1',
  transitions: 'SELECT count(*)::int AS n FROM public.request_transitions',
} as const;

/** Session settings for each write transaction. LOCAL: they end with the transaction. */
export const SESSION = {
  readOnlyCheck: PREFLIGHT.readOnlyCheck,
  lockTimeout: "SET LOCAL lock_timeout = '10s'",
  statementTimeout: "SET LOCAL statement_timeout = '120s'",
} as const;

/** The first write, and only after the confirmation. Idempotent, and never a DROP. */
export const BOOTSTRAP = {
  createSchema: 'CREATE SCHEMA IF NOT EXISTS drizzle',
  createTable: `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (id serial PRIMARY KEY, hash text NOT NULL UNIQUE, created_at bigint NOT NULL, tag text NOT NULL UNIQUE, applied_at timestamptz NOT NULL DEFAULT now())`,
} as const;

/** Recording a migration, in the same transaction as the migration itself. Parameters: hash, created_at, tag. */
export const TRACKING_INSERT = `INSERT INTO ${MIGRATIONS_TABLE} (hash, created_at, tag) VALUES ($1, $2, $3)`;

export type FixedGroup = 'preflight' | 'post' | 'session' | 'bootstrap' | 'tracking-insert';

export const FIXED_STATEMENTS: Readonly<Record<FixedGroup, ReadonlySet<string>>> = {
  preflight: new Set(Object.values(PREFLIGHT)),
  post: new Set(Object.values(POST)),
  session: new Set(Object.values(SESSION)),
  bootstrap: new Set(Object.values(BOOTSTRAP)),
  'tracking-insert': new Set([TRACKING_INSERT]),
};
