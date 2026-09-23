import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../config/env.js';
import * as schema from './schema/index.js';

// The connection the running server holds for its whole lifetime, shared by every request. This is distinct
// from the one-shot connections the db scripts (scripts/db-probe.ts, scripts/db-migrate.ts) open and close for
// themselves: those use DATABASE_URL_DIRECT and a pool of one. This module uses DATABASE_URL, the pooled
// endpoint (.env.example), which is meant for exactly this kind of long-lived, many-request use.
//
// Pool sizing lives only here, so it can be changed later without touching any caller.
export const RUNTIME_POOL_CONFIG = {
  max: 10,
  idle_timeout: 20,
} as const;

/**
 * Splits a connection string into the fields postgres.js accepts directly, instead of passing the string itself.
 * postgres.js forwards any query parameter it does not recognise (for example Neon's channel_binding) to the
 * server as a startup parameter, which the server then rejects (the same issue scripts/db-probe-queries.ts
 * works around). Building the options object from the parsed URL avoids that.
 */
function connectionOptionsFrom(databaseUrl: string) {
  const url = new URL(databaseUrl);
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    database: decodeURIComponent(url.pathname.replace(/^\//, '')),
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}

export const sql = postgres({
  ...connectionOptionsFrom(env.DATABASE_URL),
  ...RUNTIME_POOL_CONFIG,
  // Neon's pooled endpoint (DATABASE_URL) runs pgbouncer in transaction mode, which does not support prepared
  // statements (the same reasoning as scripts/db-probe-queries.ts).
  prepare: false,
  // An object, not the string 'require': postgres.js turns off certificate verification for that string.
  ssl: { rejectUnauthorized: true },
});

export const db = drizzle(sql, { schema });

/** Closes every idle and in-use connection. Called once, during shutdown (src/server.ts). */
export async function closePool(): Promise<void> {
  await sql.end({ timeout: 5 });
}
