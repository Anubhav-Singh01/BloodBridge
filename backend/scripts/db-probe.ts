import dotenv from 'dotenv';
import postgres from 'postgres';
import { GuardError, baseHost, parseTarget, resolveConfirmedTarget } from '../src/db/guard.js';
import { PROBE_STATEMENTS, connectionOptions, isPostgres15OrNewer, scrubSecrets } from './db-probe-queries.js';

dotenv.config({ quiet: true });

// Read-only probe: the first contact with a database (Batch 3.5, DATABASE.md section 11). It reports the server version,
// the resolved target, extension availability and whether the database is empty. It writes nothing:
//   - it runs only PROBE_STATEMENTS (single SELECT or SHOW statements) and no other SQL,
//   - all of them inside BEGIN READ ONLY, which PostgreSQL itself enforces, and it aborts if the session is not read-only,
//   - it goes through the same guard as every other db script (production refused, host must be confirmed),
//   - it never prints the connection string, the user or the password.

type Row = Record<string, unknown>;

function line(label: string, text: string): void {
  console.log(`${label.padEnd(30)} ${text}`);
}

const show = (value: unknown): string => (value === null || value === undefined ? '(not reported)' : String(value));
const yesNo = (value: unknown): string => (value === true ? 'yes' : value === false ? 'no' : show(value));

async function main(): Promise<number> {
  const env = process.env;

  let target;
  try {
    target = resolveConfirmedTarget(env, 'probe');
  } catch (error) {
    console.error(error instanceof GuardError ? `probe refused: ${error.message}` : 'probe refused (unexpected error).');
    return 1;
  }

  // The probe must only ever touch the dev branch, so it refuses if the target is the test database.
  if (env.TEST_DATABASE_URL) {
    try {
      const test = parseTarget(env.TEST_DATABASE_URL);
      if (baseHost(test.host) === baseHost(target.host) && test.database === target.database) {
        console.error('probe refused: the target is the same database as TEST_DATABASE_URL. The probe only touches the dev branch.');
        return 1;
      }
    } catch {
      console.error('probe refused: TEST_DATABASE_URL is set but is not a valid connection URL, so dev and test cannot be told apart.');
      return 1;
    }
  }

  const source = env.DATABASE_URL_DIRECT ? 'DATABASE_URL_DIRECT' : 'DATABASE_URL';
  const options = connectionOptions((env.DATABASE_URL_DIRECT || env.DATABASE_URL) as string);
  const secrets = [options.password, options.username];

  console.log('BloodBridge read-only database probe');
  line('target (host/database):', `${target.host}/${target.database}`);
  line('taken from:', source);
  line('endpoint kind:', /-pooler(?=\.)/.test(target.host) ? 'POOLED (pgbouncer)' : 'direct (not pooled)');
  line('NODE_ENV:', env.NODE_ENV ?? '(unset)');
  line('confirmation:', 'CONFIRMED (CONFIRM_DB_HOST matches the target host)');
  line('dev vs test:', env.TEST_DATABASE_URL ? 'TEST_DATABASE_URL is set and is a different database' : 'TEST_DATABASE_URL is not set');

  const watchdog = setTimeout(() => {
    console.error('probe: gave up after 60 seconds.');
    process.exit(1);
  }, 60_000);
  watchdog.unref();

  const sql = postgres(options);
  try {
    const result = await sql.begin('read only', async (tx) => {
      const run = async (statement: string): Promise<Row[]> => [...(await tx.unsafe(statement))] as Row[];

      // Fail closed: nothing else is sent unless PostgreSQL confirms the transaction is read-only.
      const readOnly = (await run(PROBE_STATEMENTS.readOnlyCheck))[0]?.transaction_read_only;
      if (readOnly !== 'on') throw new Error('The transaction is not read-only. Aborting before any other statement.');

      return {
        readOnly,
        version: (await run(PROBE_STATEMENTS.version))[0] ?? {},
        session: (await run(PROBE_STATEMENTS.session))[0] ?? {},
        neon: (await run(PROBE_STATEMENTS.neonIdentity))[0] ?? {},
        privileges: (await run(PROBE_STATEMENTS.privileges))[0] ?? {},
        available: await run(PROBE_STATEMENTS.extensionsAvailable),
        installed: await run(PROBE_STATEMENTS.extensionsInstalled),
        state: (await run(PROBE_STATEMENTS.databaseState))[0] ?? {},
        tables: await run(PROBE_STATEMENTS.userTables),
      };
    });

    const versionNum = Number(result.version.server_version_num);
    console.log('');
    line('transaction_read_only:', `${show(result.readOnly)} (BEGIN READ ONLY; no write was attempted)`);
    line('server_version:', show(result.version.server_version));
    line('server_version_num:', show(result.version.server_version_num));
    line('server banner:', show(result.version.banner));
    line('>= 15 (NULLS NOT DISTINCT):', isPostgres15OrNewer(versionNum) ? 'YES' : 'NO. The settings table needs a different unique index.');
    line('connected database:', show(result.session.database));
    line('current schema:', show(result.session.schema));
    line('in recovery (replica):', yesNo(result.session.in_recovery));
    line('server encoding / time zone:', `${show(result.session.server_encoding)} / ${show(result.session.time_zone)}`);
    line('Neon endpoint id:', show(result.neon.endpoint_id));
    line('Neon timeline id:', show(result.neon.timeline_id));
    line('Neon project id:', show(result.neon.project_id));
    console.log('');
    line('is_superuser:', show(result.privileges.is_superuser));
    line('member of neon_superuser:', yesNo(result.privileges.member_of_neon_superuser));
    line('can CREATE in database:', yesNo(result.privileges.can_create_in_database));
    line('can CREATE in schema public:', yesNo(result.privileges.can_create_in_public));
    for (const extension of result.available) {
      line(`extension ${show(extension.name)}:`, `available ${show(extension.default_version)}, installed ${show(extension.installed_version)}`);
    }
    for (const wanted of ['postgis', 'btree_gist']) {
      if (!result.available.some((extension) => extension.name === wanted)) line(`extension ${wanted}:`, 'NOT AVAILABLE on this server');
    }
    line('installed extensions:', result.installed.map((extension) => `${show(extension.name)} ${show(extension.version)}`).join(', ') || '(none)');
    console.log('');
    line('user schemas / tables / enums:', `${show(result.state.user_schemas)} / ${show(result.state.user_tables)} / ${show(result.state.public_enums)}`);
    line('drizzle migrations table:', yesNo(result.state.drizzle_migrations_table_exists));
    line('user tables listed:', result.tables.map((table) => `${show(table.schema)}.${show(table.name)}`).join(', ') || '(none)');
    console.log('');
    console.log('Result: the probe finished. Nothing was created, changed or deleted.');
    return 0;
  } catch (error) {
    const code = typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'unknown';
    const message = error instanceof Error ? scrubSecrets(error.message, secrets).slice(0, 300) : 'unexpected error';
    console.error(`probe failed (code ${code}): ${message}`);
    return 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

process.exitCode = await main();
