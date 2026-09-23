// Safety guard for every script that touches a database (migrate, seed, probe, reset, tests).
// It works on connection strings but only ever exposes the host and the database name, never the
// user, the password or the query string, and it never opens a connection.

export type DbAction = 'migrate' | 'seed' | 'probe' | 'reset';

export interface DbTarget {
  host: string;
  database: string;
}

export interface GuardEnv {
  NODE_ENV?: string | undefined;
  DATABASE_URL?: string | undefined;
  DATABASE_URL_DIRECT?: string | undefined;
  TEST_DATABASE_URL?: string | undefined;
  CONFIRM_DB_HOST?: string | undefined;
  CONFIRM_TEST_DB_HOST?: string | undefined;
}

export class GuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuardError';
  }
}

export function parseTarget(connectionString: string): DbTarget {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new GuardError('The database URL is not a valid URL.');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new GuardError('The database URL must start with postgres:// or postgresql://.');
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!url.hostname || !database) {
    throw new GuardError('The database URL must include a host and a database name.');
  }
  return { host: url.hostname.toLowerCase(), database };
}

export function formatTarget(target: DbTarget): string {
  return `${target.host}/${target.database}`;
}

// Neon's pooled endpoint adds "-pooler" to the first host label. Ignoring it lets us recognise
// the same database behind the pooled and the direct host.
export function baseHost(host: string): string {
  return host.replace(/-pooler(?=\.)/, '');
}

function refuseInProduction(env: GuardEnv, what: string): void {
  if (env.NODE_ENV === 'production') {
    throw new GuardError(`Refusing to run ${what} when NODE_ENV=production.`);
  }
}

// The confirmation must be the bare host. Anything that looks like a URL is rejected without being echoed,
// because someone may have pasted the whole connection string, password included.
function readConfirmation(value: string | undefined, variable: string, target: DbTarget, what: string): string {
  const confirmed = value?.trim().toLowerCase();
  if (!confirmed) {
    throw new GuardError(`Set ${variable}=${target.host} to confirm you want to run ${what} against ${formatTarget(target)}.`);
  }
  if (/[/@:]/.test(confirmed)) {
    throw new GuardError(`${variable} must be the host only (no scheme, credentials, port or path).`);
  }
  return confirmed;
}

/** The database that migrate, seed, probe and reset would act on. Throws unless it is explicitly confirmed. */
export function resolveConfirmedTarget(env: GuardEnv, action: DbAction): DbTarget {
  refuseInProduction(env, `"${action}"`);
  const url = env.DATABASE_URL_DIRECT || env.DATABASE_URL;
  if (!url) {
    throw new GuardError('Set DATABASE_URL_DIRECT (or DATABASE_URL) to the dev branch connection string.');
  }
  const target = parseTarget(url);
  const confirmed = readConfirmation(env.CONFIRM_DB_HOST, 'CONFIRM_DB_HOST', target, `"${action}"`);
  if (confirmed !== target.host) {
    throw new GuardError(`CONFIRM_DB_HOST does not match the target host, so "${action}" was not run. Target: ${formatTarget(target)}.`);
  }
  return target;
}

/** The test database. It must be confirmed and must not be the dev database. */
export function resolveConfirmedTestTarget(env: GuardEnv): DbTarget {
  refuseInProduction(env, 'database tests');
  if (!env.TEST_DATABASE_URL) {
    throw new GuardError('Set TEST_DATABASE_URL to the test branch connection string.');
  }
  const target = parseTarget(env.TEST_DATABASE_URL);
  for (const devUrl of [env.DATABASE_URL_DIRECT, env.DATABASE_URL]) {
    if (!devUrl) continue;
    const dev = parseTarget(devUrl);
    if (baseHost(dev.host) === baseHost(target.host) && dev.database === target.database) {
      throw new GuardError('TEST_DATABASE_URL points at the same database as the development URL. Tests must use the separate test branch.');
    }
  }
  const confirmed = readConfirmation(env.CONFIRM_TEST_DB_HOST, 'CONFIRM_TEST_DB_HOST', target, 'database tests');
  if (confirmed !== target.host) {
    throw new GuardError(`CONFIRM_TEST_DB_HOST does not match the test host, so the tests were not run. Target: ${formatTarget(target)}.`);
  }
  return target;
}
