import type postgres from 'postgres';
import { RESET_STATEMENT, tableSetMismatch } from './reset-tables.js';

// The live half of the reset safeguard. Sends exactly three fixed statements, in this order, and never anything
// built from a query result: an identity check, a table-list check, and (only if both pass) the one hard-coded
// TRUNCATE from reset-tables.ts. Fails closed: any mismatch throws before the TRUNCATE is ever sent.

const IDENTITY_QUERY =
  "SELECT current_database() AS database, pg_is_in_recovery() AS in_recovery, current_setting('neon.endpoint_id', true) AS endpoint_id";

// The same shape of query POST.tables (scripts/db-migrate-sql.ts) already uses: public-schema, non-extension-owned
// base tables. Used here only to CONFIRM the live set against the hard-coded allowlist, never to choose what to
// truncate — the mismatch check below only ever compares against the constants in reset-tables.ts.
const LIVE_TABLES_QUERY =
  "SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e') ORDER BY 1";

export class ResetRefusedError extends Error {}

export interface ResetTarget {
  /** The database name the connection is expected to report (checkTestTarget's target.database). */
  database: string;
  /** The Neon endpoint id label the connection is expected to report (checkTestTarget's target.endpointLabel). */
  endpointLabel: string;
}

/**
 * Re-checks identity live (D8) and re-checks the live public-schema table set against the hard-coded allowlist
 * (the approved safeguard), and only then runs the one hard-coded TRUNCATE. Throws ResetRefusedError, sending no
 * TRUNCATE, on any mismatch: wrong database, a replica, an endpoint-identity mismatch, or a table set that does
 * not exactly match reset-tables.ts (for example because db:test:migrate --apply has not been run yet).
 */
export async function verifyAndReset(sql: postgres.Sql, target: ResetTarget): Promise<void> {
  const identityRows = await sql.unsafe<{ database: string; in_recovery: boolean; endpoint_id: string | null }[]>(IDENTITY_QUERY);
  const identity = identityRows[0];
  if (!identity) throw new ResetRefusedError('reset refused: could not read server identity');
  if (identity.database !== target.database) {
    throw new ResetRefusedError(`reset refused: connected to database "${identity.database}", expected "${target.database}"`);
  }
  if (identity.in_recovery === true) throw new ResetRefusedError('reset refused: the server is in recovery (a replica)');
  if (identity.endpoint_id !== target.endpointLabel) {
    throw new ResetRefusedError(`reset refused: endpoint identity mismatch (server reports "${identity.endpoint_id}", expected "${target.endpointLabel}")`);
  }

  const liveTableRows = await sql.unsafe<{ name: string }[]>(LIVE_TABLES_QUERY);
  const liveTables = liveTableRows.map((row) => row.name);
  const mismatch = tableSetMismatch(liveTables);
  if (mismatch) {
    throw new ResetRefusedError(
      `reset refused: the live table set does not match the hard-coded allowlist (has db:test:migrate --apply been run?):\n  ${mismatch.join('\n  ')}`,
    );
  }

  await sql.unsafe(RESET_STATEMENT);
}
