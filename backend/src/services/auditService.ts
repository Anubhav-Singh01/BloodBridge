import * as auditLogsRepository from '../repositories/auditLogs.repository.js';

// The single, centralized path for every audit_logs write in the app. Nothing else calls
// repositories/auditLogs.repository.ts directly - controllers and services call record() here,
// so there is exactly one place that decides the shape of an audit entry.

export interface AuditEvent {
  /** null for a system/automated action (for example a webhook-driven sync). */
  actorId: string | null;
  /** Upper-case code, e.g. ROLE_ENROLLED. Must match audit_logs_action_format (^[A-Z][A-Z0-9_]*$). */
  action: string;
  /** Upper-case code, e.g. USER. Required whenever entityId is given (audit_logs_entity_needs_type). */
  entityType?: string | undefined;
  entityId?: string | undefined;
  /** API.md 1.2: the X-Request-ID of the call that caused this entry. */
  correlationId?: string | undefined;
  details?: Record<string, unknown> | undefined;
}

export async function record(event: AuditEvent): Promise<void> {
  await auditLogsRepository.insert({
    actorId: event.actorId,
    action: event.action,
    entityType: event.entityType ?? null,
    entityId: event.entityId ?? null,
    correlationId: event.correlationId ?? null,
    details: event.details ?? {},
  });
}
