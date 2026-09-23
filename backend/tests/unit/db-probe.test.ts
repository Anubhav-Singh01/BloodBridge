import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROBE_STATEMENTS, connectionOptions, isPostgres15OrNewer, scrubSecrets } from '../../scripts/db-probe-queries.js';

// Fake values only. The reserved .invalid domain can never resolve, so nothing here can reach a real host.
const FAKE_URL = 'postgresql://app_user:p%40ss%2Fword@ep-example-1234-pooler.region.example.invalid/devdb?sslmode=require&channel_binding=require';

const WRITE_OR_SESSION_KEYWORD = /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|COPY|VACUUM|ANALYZE|REINDEX|CLUSTER|REFRESH|CALL|DO|SET|RESET|LISTEN|NOTIFY|LOCK|INTO|BEGIN|COMMIT|ROLLBACK)\b/i;
const SIDE_EFFECT_FUNCTION = /\b(nextval|setval|set_config|pg_advisory\w*|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_sleep\w*|lo_\w+|dblink\w*|pg_create\w*|pg_drop\w*|pg_switch\w*)\b/i;
// Quoted literals are text, not executable SQL: has_schema_privilege('public', 'CREATE') only names a privilege. So the keyword
// scan runs on the statement with its literals blanked out. The single-statement rule still applies to the raw text.
const withoutLiterals = (sql: string): string => sql.replace(/'[^']*'/g, "''");
const isReadOnlyStatement = (sql: string): boolean => {
  const code = withoutLiterals(sql);
  return /^(SELECT|SHOW)\b/i.test(sql) && !sql.includes(';') && !WRITE_OR_SESSION_KEYWORD.test(code) && !SIDE_EFFECT_FUNCTION.test(code);
};

describe('db probe: the statements it may send', () => {
  it('has exactly the statements the report needs, each a single read-only SELECT or SHOW', () => {
    expect(Object.keys(PROBE_STATEMENTS).sort()).toEqual([
      'databaseState', 'extensionsAvailable', 'extensionsInstalled', 'neonIdentity', 'privileges', 'readOnlyCheck', 'session', 'userTables', 'version',
    ]);
    for (const [name, sql] of Object.entries(PROBE_STATEMENTS)) expect({ name, readOnly: isReadOnlyStatement(sql) }).toEqual({ name, readOnly: true });
  });

  it('the read-only check does reject writes, DDL, session changes and side-effect functions (checks the check)', () => {
    const bad = [
      'INSERT INTO t VALUES (1)', 'UPDATE t SET a = 1', 'DELETE FROM t', 'CREATE TABLE t (a int)', 'ALTER TABLE t ADD COLUMN b int',
      'DROP TABLE t', 'TRUNCATE t', 'SET default_transaction_read_only = off', 'SELECT 1 INTO t', "SELECT set_config('a', 'b', false)",
      "SELECT nextval('s')", 'SELECT pg_advisory_lock(1)', 'SELECT pg_terminate_backend(1)', 'SELECT 1; DROP TABLE t', 'COMMIT', 'CREATE EXTENSION postgis',
    ];
    for (const sql of bad) expect({ sql, readOnly: isReadOnlyStatement(sql) }).toEqual({ sql, readOnly: false });
    // Reading a setting is fine even though its name contains "set".
    expect(isReadOnlyStatement("SELECT current_setting('server_version')")).toBe(true);
  });

  it('does not report a TLS status: pg_stat_ssl describes the proxy-to-compute hop on Neon, not the client connection', () => {
    expect(Object.values(PROBE_STATEMENTS).join('\n')).not.toMatch(/pg_stat_ssl|pg_stat_get_activity/i);
    expect(readFileSync(join(import.meta.dirname, '../../scripts/db-probe.ts'), 'utf8')).not.toMatch(/TLS:|tls_version|\.tls\b/);
  });

  it('does not select the role name or any credential', () => {
    const all = Object.values(PROBE_STATEMENTS).join('\n');
    expect(all).not.toMatch(/\bcurrent_user\b|\bsession_user\b|\busename\b|\brolpassword\b|\bpg_authid\b|\bpg_shadow\b|\bpg_user\b/i);
  });
});

describe('db probe: connection options', () => {
  it('parses the URL itself, decodes credentials, and never forwards unknown query parameters to the server', () => {
    const options = connectionOptions(FAKE_URL);
    expect(options.host).toBe('ep-example-1234-pooler.region.example.invalid');
    expect(options.port).toBe(5432);
    expect(options.database).toBe('devdb');
    expect(options.username).toBe('app_user');
    expect(options.password).toBe('p@ss/word');
    expect(JSON.stringify(options)).not.toMatch(/channel_binding|sslmode/);
    expect(connectionOptions('postgresql://u:p@host.example.invalid:6543/db').port).toBe(6543);
  });

  it('verifies the server certificate, and never uses prepared statements or the automatic catalog query', () => {
    const options = connectionOptions(FAKE_URL);
    // postgres.js turns certificate verification OFF for the string 'require', so it must be an object.
    expect(options.ssl).toEqual({ rejectUnauthorized: true });
    expect(options.prepare).toBe(false);
    expect(options.fetch_types).toBe(false);
    expect(options.max).toBe(1);
    expect(options.connection).toEqual({ application_name: 'bloodbridge-db-probe' });
  });
});

describe('db probe: secrets and version rules', () => {
  it('scrubs the password, the user, their URL-encoded forms and any connection string from an error message', () => {
    const message = `password authentication failed for user "app_user" using p@ss/word (p%40ss%2Fword) at ${FAKE_URL}`;
    const scrubbed = scrubSecrets(message, ['p@ss/word', 'app_user']);
    expect(scrubbed).not.toMatch(/app_user|p@ss|p%40ss|postgresql:\/\//);
    expect(scrubbed).toContain('[redacted');
    expect(scrubSecrets('connect ECONNREFUSED', ['', 'x'])).toBe('connect ECONNREFUSED');
  });

  it('requires PostgreSQL 15 or newer for NULLS NOT DISTINCT', () => {
    expect(isPostgres15OrNewer(140012)).toBe(false);
    expect(isPostgres15OrNewer(149999)).toBe(false);
    expect(isPostgres15OrNewer(150000)).toBe(true);
    expect(isPostgres15OrNewer(170004)).toBe(true);
    expect(isPostgres15OrNewer(Number.NaN)).toBe(false);
  });
});

describe('db probe: the runner is wired the way it claims', () => {
  const source = readFileSync(join(import.meta.dirname, '../../scripts/db-probe.ts'), 'utf8');

  it('goes through the guard, uses a read-only transaction, and aborts unless PostgreSQL confirms it', () => {
    expect(source).toContain("resolveConfirmedTarget(env, 'probe')");
    expect(source).toContain("sql.begin('read only'");
    expect(source).toContain('transaction_read_only');
    expect(source).toContain("if (readOnly !== 'on') throw");
  });

  it('sends SQL only through one call site, and only statements from the fixed list', () => {
    expect(source.match(/\.unsafe\(/g)).toHaveLength(1);
    expect(source).toContain('tx.unsafe(statement)');
    expect(source.match(/run\(PROBE_STATEMENTS\.\w+\)/g)).toHaveLength(Object.keys(PROBE_STATEMENTS).length);
    expect(source).not.toMatch(/\bsql`|\btx`/);
  });

  it('never prints the connection string, the user, the password or the raw URL', () => {
    expect(source).not.toMatch(/\$\{[^}]*(options\.(host|username|password)|env\.DATABASE|connectionString)/);
    expect(source).not.toMatch(/console\.(log|error)\([^)]*(env\.DATABASE|options\b)/);
  });
});
