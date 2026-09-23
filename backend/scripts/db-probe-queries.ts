// The parts of the read-only database probe (scripts/db-probe.ts) that need no connection, so they can be unit tested
// offline. Nothing in this file opens a connection or reads the environment.

/**
 * Every statement the probe may send, and nothing else. Each is a single SELECT or SHOW: no writes, no DDL, no SET,
 * no function with side effects. The probe also runs them inside BEGIN READ ONLY, so PostgreSQL itself refuses a write.
 */
export const PROBE_STATEMENTS = {
  readOnlyCheck: 'SHOW transaction_read_only',
  version:
    "SELECT current_setting('server_version') AS server_version, current_setting('server_version_num')::int AS server_version_num, version() AS banner",
  session:
    "SELECT current_database() AS database, current_schema() AS schema, pg_is_in_recovery() AS in_recovery, current_setting('server_encoding') AS server_encoding, current_setting('TimeZone') AS time_zone",
  // Neon sets these settings on its compute. missing_ok = true returns NULL on a server that does not define them.
  neonIdentity:
    "SELECT current_setting('neon.endpoint_id', true) AS endpoint_id, current_setting('neon.timeline_id', true) AS timeline_id, current_setting('neon.project_id', true) AS project_id",
  // What the migration runner will need later. The role name itself is deliberately not selected.
  privileges:
    "SELECT current_setting('is_superuser') AS is_superuser, has_database_privilege(current_database(), 'CREATE') AS can_create_in_database, has_schema_privilege('public', 'CREATE') AS can_create_in_public, (SELECT pg_has_role(oid, 'MEMBER') FROM pg_roles WHERE rolname = 'neon_superuser') AS member_of_neon_superuser",
  extensionsAvailable:
    "SELECT name, default_version, installed_version FROM pg_available_extensions WHERE name IN ('postgis', 'btree_gist') ORDER BY name",
  extensionsInstalled: 'SELECT extname AS name, extversion AS version FROM pg_extension ORDER BY extname',
  databaseState:
    "SELECT (SELECT count(*)::int FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname <> 'information_schema') AS user_schemas, (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r', 'p') AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema') AS user_tables, (SELECT count(*)::int FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typtype = 'e' AND n.nspname = 'public') AS public_enums, to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS drizzle_migrations_table_exists",
  userTables:
    "SELECT n.nspname AS schema, c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r', 'p') AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' ORDER BY 1, 2 LIMIT 50",
} as const;

/** PostgreSQL 15 added UNIQUE ... NULLS NOT DISTINCT, which the `settings` table uses (DATABASE.md 2.8). */
export const MIN_POSTGRES_VERSION_NUM = 150000;

export function isPostgres15OrNewer(serverVersionNum: number): boolean {
  return Number.isInteger(serverVersionNum) && serverVersionNum >= MIN_POSTGRES_VERSION_NUM;
}

export interface ProbeConnectionOptions {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  // An object, not 'require': postgres.js turns off certificate verification for the string 'require'.
  ssl: { rejectUnauthorized: true };
  max: 1;
  // Neon's pooled endpoint runs pgbouncer in transaction mode, which does not support prepared statements.
  prepare: false;
  // Stops postgres.js from sending its own catalog query on connect, so only PROBE_STATEMENTS reach the server.
  fetch_types: false;
  connect_timeout: number;
  idle_timeout: number;
  max_lifetime: number;
  connection: { application_name: string };
}

/**
 * Builds explicit connection options from a connection string. The string itself is never handed to the driver: postgres.js
 * forwards unknown query parameters (such as Neon's channel_binding) to the server as startup parameters, which fails.
 */
export function connectionOptions(connectionString: string): ProbeConnectionOptions {
  const url = new URL(connectionString);
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    database: decodeURIComponent(url.pathname.replace(/^\//, '')),
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    ssl: { rejectUnauthorized: true },
    max: 1,
    prepare: false,
    fetch_types: false,
    connect_timeout: 20,
    idle_timeout: 5,
    max_lifetime: 60,
    connection: { application_name: 'bloodbridge-db-probe' },
  };
}

/** Removes anything that looks like a connection string, and each given secret (also URL-encoded), from a message. */
export function scrubSecrets(text: string, secrets: string[]): string {
  let scrubbed = text.replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted url]');
  for (const secret of secrets) {
    if (!secret) continue;
    for (const variant of new Set([secret, encodeURIComponent(secret)])) scrubbed = scrubbed.split(variant).join('[redacted]');
  }
  return scrubbed;
}
