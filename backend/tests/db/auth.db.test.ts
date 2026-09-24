import { beforeAll, describe, expect, it, vi } from 'vitest';

// Batch 3.10 live tests. Repositories/services under test (users, userRoles, dataDeletionRequests,
// webhookEvents, auditLogs repositories; usersService, clerkSyncService) import `db` from
// src/db/connection.js, which is always the runtime/dev pooled endpoint (env.DATABASE_URL) - never
// the test branch. This mock redirects that one import to a drizzle client built on THIS file's own
// already-guarded test-branch connection (tests/db/helpers.ts's `sql`, itself gated by
// resolveConfirmedTestTarget), so the application code under test runs completely unmodified while
// every statement it sends still goes only to the confirmed test branch. No source file is changed
// to make this possible.
vi.mock('../../src/db/connection.js', async () => {
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const schema = await import('../../src/db/schema/index.js');
  const { sql } = await import('./helpers.js');
  return { db: drizzle(sql, { schema }), sql, closePool: async () => undefined };
});

const { createUser, ensureRoleCodes, sql } = await import('./helpers.js');
const usersRepository = await import('../../src/repositories/users.repository.js');
const userRolesRepository = await import('../../src/repositories/userRoles.repository.js');
const dataDeletionRequestsRepository = await import('../../src/repositories/dataDeletionRequests.repository.js');
const webhookEventsRepository = await import('../../src/repositories/webhookEvents.repository.js');
const usersService = await import('../../src/services/usersService.js');
const clerkSyncService = await import('../../src/services/clerkSyncService.js');

beforeAll(async () => {
  await ensureRoleCodes();
});

describe('users.repository.upsertFromClerk: phone_verified_at (Batch 3.10 correction)', () => {
  it('unverified -> verified stamps phone_verified_at with a fresh timestamp', async () => {
    const clerkUserId = `clerk_${crypto.randomUUID().replace(/-/g, '')}`;
    await usersRepository.upsertFromClerk({ clerkUserId, fullName: 'Anu', email: null, phone: '+911234567890', phoneVerified: false });
    const [before] = await sql<{ phone_verified_at: Date | null }[]>`SELECT phone_verified_at FROM user_profiles up JOIN users u ON u.id = up.user_id WHERE u.clerk_user_id = ${clerkUserId}`;
    expect(before!.phone_verified_at).toBeNull();

    await usersRepository.upsertFromClerk({ clerkUserId, fullName: 'Anu', email: null, phone: '+911234567890', phoneVerified: true });
    const [after] = await sql<{ phone_verified_at: Date | null }[]>`SELECT phone_verified_at FROM user_profiles up JOIN users u ON u.id = up.user_id WHERE u.clerk_user_id = ${clerkUserId}`;
    expect(after!.phone_verified_at).not.toBeNull();
  });

  it('verified -> still verified preserves the existing timestamp instead of re-stamping it', async () => {
    const clerkUserId = `clerk_${crypto.randomUUID().replace(/-/g, '')}`;
    await usersRepository.upsertFromClerk({ clerkUserId, fullName: 'Anu', email: null, phone: '+911234567890', phoneVerified: true });
    const [first] = await sql<{ phone_verified_at: Date | null }[]>`SELECT phone_verified_at FROM user_profiles up JOIN users u ON u.id = up.user_id WHERE u.clerk_user_id = ${clerkUserId}`;
    expect(first!.phone_verified_at).not.toBeNull();

    // A second sync while still verified - same phone, still verified, some other field changed.
    await usersRepository.upsertFromClerk({ clerkUserId, fullName: 'Anu Updated', email: null, phone: '+911234567890', phoneVerified: true });
    const [second] = await sql<{ phone_verified_at: Date | null }[]>`SELECT phone_verified_at FROM user_profiles up JOIN users u ON u.id = up.user_id WHERE u.clerk_user_id = ${clerkUserId}`;
    expect(second!.phone_verified_at).toEqual(first!.phone_verified_at);
  });

  it('verified -> unverified clears phone_verified_at to NULL', async () => {
    const clerkUserId = `clerk_${crypto.randomUUID().replace(/-/g, '')}`;
    await usersRepository.upsertFromClerk({ clerkUserId, fullName: 'Anu', email: null, phone: '+911234567890', phoneVerified: true });
    await usersRepository.upsertFromClerk({ clerkUserId, fullName: 'Anu', email: null, phone: '+911234567890', phoneVerified: false });
    const [row] = await sql<{ phone_verified_at: Date | null }[]>`SELECT phone_verified_at FROM user_profiles up JOIN users u ON u.id = up.user_id WHERE u.clerk_user_id = ${clerkUserId}`;
    expect(row!.phone_verified_at).toBeNull();
  });
});

describe('userRoles.repository.enrollRole', () => {
  it('a first enrolment inserts exactly one user_roles row; a repeat is idempotent (no second row)', async () => {
    const userId = await createUser();
    const first = await userRolesRepository.enrollRole(userId, 'DONOR');
    expect(first).toEqual({ alreadyEnrolled: false });
    const second = await userRolesRepository.enrollRole(userId, 'DONOR');
    expect(second).toEqual({ alreadyEnrolled: true });

    const rows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ${userId} AND r.code = 'DONOR'`;
    expect(rows[0]!.n).toBe(1);
  });
});

describe('usersService.requestDeletion (idempotency and the DELETE /users/me contradiction fix)', () => {
  it('a first call creates exactly one PENDING row, sets DELETION_PENDING, and writes one audit row; a repeat changes nothing', async () => {
    const userId = await createUser();

    const first = await usersService.requestDeletion(userId, 'USER_REQUEST', 'corr-1');
    expect(first.status).toBe('pending');

    const [userRow] = await sql<{ status: string }[]>`SELECT status FROM users WHERE id = ${userId}`;
    expect(userRow!.status).toBe('DELETION_PENDING');

    const second = await usersService.requestDeletion(userId, 'USER_REQUEST', 'corr-2');
    expect(second).toEqual({ status: 'already_pending', requestId: first.requestId, requestedAt: first.requestedAt });

    const pendingRows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM data_deletion_requests WHERE user_id = ${userId} AND status = 'PENDING'`;
    expect(pendingRows[0]!.n).toBe(1);
    const auditRows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'DATA_DELETION_REQUESTED' AND entity_id = ${userId}`;
    expect(auditRows[0]!.n).toBe(1);
  });

  it('two concurrent requests for the same user never create two PENDING rows (the 23505 race path)', async () => {
    const userId = await createUser();
    const [a, b] = await Promise.all([usersService.requestDeletion(userId, 'USER_REQUEST'), usersService.requestDeletion(userId, 'CLERK_WEBHOOK')]);
    expect([a.status, b.status].sort()).toEqual(['already_pending', 'pending']);
    expect(a.requestId).toBe(b.requestId);

    const rows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM data_deletion_requests WHERE user_id = ${userId}`;
    expect(rows[0]!.n).toBe(1);
  });
});

describe('webhookEvents.repository: the idempotency gate', () => {
  it('recordIfNew returns the row only once for the same (provider, providerEventId); a genuine duplicate after markProcessed is skippable via findUnprocessed', async () => {
    const eventId = `evt_${crypto.randomUUID()}`;
    const first = await webhookEventsRepository.recordIfNew('clerk', eventId, 'user.created');
    expect(first).not.toBeNull();
    const second = await webhookEventsRepository.recordIfNew('clerk', eventId, 'user.created');
    expect(second).toBeNull();

    // Not yet processed: a retry should find it and be told to proceed, not skip it.
    const unprocessed = await webhookEventsRepository.findUnprocessed('clerk', eventId);
    expect(unprocessed).toEqual({ id: first!.id });

    await webhookEventsRepository.markProcessed(first!.id);
    const afterProcessed = await webhookEventsRepository.findUnprocessed('clerk', eventId);
    expect(afterProcessed).toBeNull();
  });
});

describe('clerkSyncService.handleClerkWebhookEvent: end to end against the real tables', () => {
  it('user.created creates a users+user_profiles row; the identical delivery replayed is a no-op duplicate', async () => {
    const clerkUserId = `clerk_${crypto.randomUUID().replace(/-/g, '')}`;
    const svixId = `msg_${crypto.randomUUID()}`;
    const event = { type: 'user.created', data: { id: clerkUserId, first_name: 'Anu', last_name: 'Bhav' } };

    const first = await clerkSyncService.handleClerkWebhookEvent(event, svixId);
    expect(first).toEqual({ outcome: 'processed', type: 'user.created' });

    const rows = await sql<{ full_name: string | null }[]>`SELECT full_name FROM user_profiles up JOIN users u ON u.id = up.user_id WHERE u.clerk_user_id = ${clerkUserId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.full_name).toBe('Anu Bhav');

    const replay = await clerkSyncService.handleClerkWebhookEvent(event, svixId);
    expect(replay).toEqual({ outcome: 'duplicate' });
    const rowsAfterReplay = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM users WHERE clerk_user_id = ${clerkUserId}`;
    expect(rowsAfterReplay[0]!.n).toBe(1);
  });

  it('user.deleted creates a PENDING deletion request for the matching local user', async () => {
    const clerkUserId = `clerk_${crypto.randomUUID().replace(/-/g, '')}`;
    await clerkSyncService.handleClerkWebhookEvent({ type: 'user.created', data: { id: clerkUserId } }, `msg_${crypto.randomUUID()}`);

    await clerkSyncService.handleClerkWebhookEvent({ type: 'user.deleted', data: { id: clerkUserId } }, `msg_${crypto.randomUUID()}`);

    const [userRow] = await sql<{ id: string; status: string }[]>`SELECT id, status FROM users WHERE clerk_user_id = ${clerkUserId}`;
    expect(userRow!.status).toBe('DELETION_PENDING');
    const pending = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM data_deletion_requests WHERE user_id = ${userRow!.id} AND status = 'PENDING' AND source = 'CLERK_WEBHOOK'`;
    expect(pending[0]!.n).toBe(1);
  });
});
