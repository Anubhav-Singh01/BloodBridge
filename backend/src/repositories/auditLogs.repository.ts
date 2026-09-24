import { db } from '../db/connection.js';
import { auditLogs } from '../db/schema/index.js';

export interface AuditLogInsert {
  actorId: string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  correlationId?: string | null;
  details?: Record<string, unknown>;
}

/** The only function that writes to audit_logs. Called only through services/auditService.ts. */
export async function insert(row: AuditLogInsert): Promise<void> {
  await db.insert(auditLogs).values({
    actorId: row.actorId,
    action: row.action,
    entityType: row.entityType ?? null,
    entityId: row.entityId ?? null,
    correlationId: row.correlationId ?? null,
    details: row.details ?? {},
  });
}
