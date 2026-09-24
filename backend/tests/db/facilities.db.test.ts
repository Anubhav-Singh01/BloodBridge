import { beforeAll, describe, expect, it, vi } from 'vitest';

// Batch 3.11 live tests. Same technique as tests/db/auth.db.test.ts: the one module every new
// repository imports `db` from (src/db/connection.js) is redirected to a drizzle client built on
// this file's own already-guarded test-branch connection (tests/db/helpers.ts's `sql`), so the
// application code under test runs completely unmodified while every statement still goes only to
// the confirmed test branch. No source file is changed to make this possible, and no new DB/
// migration mechanism is introduced.
vi.mock('../../src/db/connection.js', async () => {
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const schema = await import('../../src/db/schema/index.js');
  const { sql } = await import('./helpers.js');
  return { db: drizzle(sql, { schema }), sql, closePool: async () => undefined };
});

const { createUser, sql } = await import('./helpers.js');
const facilitiesRepository = await import('../../src/repositories/facilities.repository.js');
const facilityMembershipsRepository = await import('../../src/repositories/facilityMemberships.repository.js');
const facilityVerificationsRepository = await import('../../src/repositories/facilityVerifications.repository.js');
const facilitiesService = await import('../../src/services/facilitiesService.js');

let ownerId: string;

beforeAll(async () => {
  ownerId = await createUser();
});

describe('registerFacility (facilities.repository + facilityMemberships.repository)', () => {
  it('creates exactly one facilities row, one specialized (hospitals) row, and one ACTIVE FACILITY_ADMIN membership', async () => {
    const creator = await createUser();
    const { id } = await facilitiesRepository.registerFacility({ facilityType: 'HOSPITAL', name: 'DEMO Test Hospital', createdBy: creator });
    await facilityMembershipsRepository.createActiveAdmin(creator, id);

    const facilityRows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM facilities WHERE id = ${id}`;
    expect(facilityRows[0]!.n).toBe(1);
    const hospitalRows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM hospitals WHERE facility_id = ${id}`;
    expect(hospitalRows[0]!.n).toBe(1);

    const membership = await facilityMembershipsRepository.findActiveMembership(creator, id);
    expect(membership).toMatchObject({ role: 'FACILITY_ADMIN' });
    expect(membership!.joinedAt).not.toBeNull();
  });

  it('a BLOOD_BANK registration creates a blood_banks row, never a hospitals row', async () => {
    const creator = await createUser();
    const { id } = await facilitiesRepository.registerFacility({ facilityType: 'BLOOD_BANK', name: 'DEMO Test Blood Bank', createdBy: creator });
    const bankRows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM blood_banks WHERE facility_id = ${id}`;
    expect(bankRows[0]!.n).toBe(1);
    const hospitalRows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM hospitals WHERE facility_id = ${id}`;
    expect(hospitalRows[0]!.n).toBe(0);
  });
});

describe('facility-scoped authorization data: findActiveMembership only ever sees ACTIVE', () => {
  it('an INVITED membership is invisible to findActiveMembership; ACTIVE is visible', async () => {
    const { id: facilityId } = await facilitiesRepository.registerFacility({ facilityType: 'HOSPITAL', name: 'DEMO Auth Hospital', createdBy: ownerId });
    await facilityMembershipsRepository.createActiveAdmin(ownerId, facilityId);
    const invitee = await createUser();

    await facilityMembershipsRepository.inviteStaff(facilityId, invitee, 'STAFF', ownerId);
    expect(await facilityMembershipsRepository.findActiveMembership(invitee, facilityId)).toBeUndefined();

    await facilityMembershipsRepository.acceptInvitation(invitee, facilityId);
    expect(await facilityMembershipsRepository.findActiveMembership(invitee, facilityId)).toMatchObject({ role: 'STAFF' });
  });
});

describe('membership lifecycle: invite -> accept -> remove, and removed-membership re-invite', () => {
  it('invite creates INVITED (joinedAt null); accept sets ACTIVE (joinedAt set); remove sets REMOVED, never deletes the row', async () => {
    const { id: facilityId } = await facilitiesRepository.registerFacility({ facilityType: 'HOSPITAL', name: 'DEMO Lifecycle Hospital', createdBy: ownerId });
    await facilityMembershipsRepository.createActiveAdmin(ownerId, facilityId);
    const staff = await createUser();

    const invited = await facilityMembershipsRepository.inviteStaff(facilityId, staff, 'STAFF', ownerId);
    const afterInvite = await facilityMembershipsRepository.findMembership(staff, facilityId);
    expect(afterInvite).toMatchObject({ id: invited.id, status: 'INVITED', joinedAt: null });

    const accepted = await facilityMembershipsRepository.acceptInvitation(staff, facilityId);
    expect(accepted).toMatchObject({ id: invited.id, status: 'ACTIVE' });
    expect(accepted.joinedAt).not.toBeNull();

    await facilityMembershipsRepository.removeMembership(facilityId, staff);
    const afterRemove = await facilityMembershipsRepository.findMembership(staff, facilityId);
    expect(afterRemove).toMatchObject({ id: invited.id, status: 'REMOVED' }); // same row id: never deleted
  });

  it('re-inviting a REMOVED person reuses the same row (the unique (user_id, facility_id) constraint), not a new one', async () => {
    const { id: facilityId } = await facilitiesRepository.registerFacility({ facilityType: 'HOSPITAL', name: 'DEMO Reinvite Hospital', createdBy: ownerId });
    await facilityMembershipsRepository.createActiveAdmin(ownerId, facilityId);
    const staff = await createUser();

    const first = await facilityMembershipsRepository.inviteStaff(facilityId, staff, 'STAFF', ownerId);
    await facilityMembershipsRepository.acceptInvitation(staff, facilityId);
    await facilityMembershipsRepository.removeMembership(facilityId, staff);

    const reinvited = await facilityMembershipsRepository.inviteStaff(facilityId, staff, 'FACILITY_ADMIN', ownerId);
    expect(reinvited.id).toBe(first.id);

    const rows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM facility_memberships WHERE user_id = ${staff} AND facility_id = ${facilityId}`;
    expect(rows[0]!.n).toBe(1);
    const row = await facilityMembershipsRepository.findMembership(staff, facilityId);
    expect(row).toMatchObject({ status: 'INVITED', role: 'FACILITY_ADMIN' });
  });

  it('inviting someone who already has an ACTIVE or INVITED membership is rejected (409 ALREADY_MEMBER)', async () => {
    const { id: facilityId } = await facilitiesRepository.registerFacility({ facilityType: 'HOSPITAL', name: 'DEMO Conflict Hospital', createdBy: ownerId });
    await facilityMembershipsRepository.createActiveAdmin(ownerId, facilityId);
    const staff = await createUser();
    await facilityMembershipsRepository.inviteStaff(facilityId, staff, 'STAFF', ownerId);
    await expect(facilityMembershipsRepository.inviteStaff(facilityId, staff, 'STAFF', ownerId)).rejects.toMatchObject({ status: 409, code: 'ALREADY_MEMBER' });
  });
});

describe('the last-FACILITY_ADMIN guard (Batch 3.11 review item 1)', () => {
  it('refuses to remove the sole ACTIVE FACILITY_ADMIN with 409 LAST_FACILITY_ADMIN', async () => {
    const admin = await createUser();
    const { id: facilityId } = await facilitiesRepository.registerFacility({ facilityType: 'HOSPITAL', name: 'DEMO Sole Admin Hospital', createdBy: admin });
    await facilityMembershipsRepository.createActiveAdmin(admin, facilityId);

    await expect(facilityMembershipsRepository.removeMembership(facilityId, admin)).rejects.toMatchObject({ status: 409, code: 'LAST_FACILITY_ADMIN' });
    // Still ACTIVE - the refused removal must not have partially applied.
    expect(await facilityMembershipsRepository.findActiveMembership(admin, facilityId)).toMatchObject({ role: 'FACILITY_ADMIN' });
  });

  it('allows removal once a second ACTIVE FACILITY_ADMIN exists, and then refuses removing the last one', async () => {
    const adminA = await createUser();
    const adminB = await createUser();
    const { id: facilityId } = await facilitiesRepository.registerFacility({ facilityType: 'HOSPITAL', name: 'DEMO Two Admins Hospital', createdBy: adminA });
    await facilityMembershipsRepository.createActiveAdmin(adminA, facilityId);
    await facilityMembershipsRepository.createActiveAdmin(adminB, facilityId);

    await expect(facilityMembershipsRepository.removeMembership(facilityId, adminA)).resolves.toBeUndefined();
    expect(await facilityMembershipsRepository.findActiveMembership(adminA, facilityId)).toBeUndefined();

    // Now adminB is the only one left.
    await expect(facilityMembershipsRepository.removeMembership(facilityId, adminB)).rejects.toMatchObject({ status: 409, code: 'LAST_FACILITY_ADMIN' });
  });

  it('removing the last ACTIVE STAFF (not an admin) is never blocked by this guard', async () => {
    const { id: facilityId } = await facilitiesRepository.registerFacility({ facilityType: 'HOSPITAL', name: 'DEMO Staff Removal Hospital', createdBy: ownerId });
    await facilityMembershipsRepository.createActiveAdmin(ownerId, facilityId);
    const staff = await createUser();
    await facilityMembershipsRepository.inviteStaff(facilityId, staff, 'STAFF', ownerId);
    await facilityMembershipsRepository.acceptInvitation(staff, facilityId);
    await expect(facilityMembershipsRepository.removeMembership(facilityId, staff)).resolves.toBeUndefined();
  });
});

describe('facility_verifications: create-or-update (upsert) semantics', () => {
  it('a second submission updates the same row (exactly one row per facility) and resets PENDING, clearing reviewedBy/reviewedAt', async () => {
    const { id: facilityId } = await facilitiesRepository.registerFacility({ facilityType: 'HOSPITAL', name: 'DEMO Verification Hospital', createdBy: ownerId });

    const first = await facilityVerificationsRepository.upsertSubmission(facilityId, { license: 'A' });
    // Simulate a previous review having happened, to prove a new submission clears it.
    await sql`UPDATE facility_verifications SET status = 'VERIFIED', reviewed_by = ${ownerId}, reviewed_at = now() WHERE id = ${first.id}`;

    const second = await facilityVerificationsRepository.upsertSubmission(facilityId, { license: 'B' });
    expect(second.id).toBe(first.id); // same row, not a second one

    const rows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM facility_verifications WHERE facility_id = ${facilityId}`;
    expect(rows[0]!.n).toBe(1);

    const row = await facilityVerificationsRepository.findByFacilityId(facilityId);
    expect(row).toMatchObject({ status: 'PENDING', reviewedBy: null, reviewedAt: null, registrationMetadata: { license: 'B' } });
  });

  it('facilitiesService.submitVerification drives the same upsert end to end', async () => {
    const { id: facilityId } = await facilitiesRepository.registerFacility({ facilityType: 'HOSPITAL', name: 'DEMO Service Verification Hospital', createdBy: ownerId });
    await facilitiesService.submitVerification(facilityId, ownerId, { a: 1 });
    await facilitiesService.submitVerification(facilityId, ownerId, { a: 2 });
    const rows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM facility_verifications WHERE facility_id = ${facilityId}`;
    expect(rows[0]!.n).toBe(1);
    const auditRows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'FACILITY_VERIFICATION_SUBMITTED' AND entity_id = ${facilityId}`;
    expect(auditRows[0]!.n).toBe(2); // every submission is audited, not only the first
  });
});

describe('verification-relevant field reset behavior (facilities.repository.updateProfile)', () => {
  it('a name change resets verification_status to UNDER_REVIEW', async () => {
    const { id: facilityId } = await facilitiesRepository.registerFacility({ facilityType: 'HOSPITAL', name: 'DEMO Reset Hospital', createdBy: ownerId });
    await sql`UPDATE facilities SET verification_status = 'VERIFIED', location = ST_SetSRID(ST_MakePoint(0, 0), 4326)::geography WHERE id = ${facilityId}`;

    await facilitiesRepository.updateProfile(facilityId, { name: 'DEMO Reset Hospital (renamed)' }, true);
    const row = await facilitiesRepository.findById(facilityId);
    expect(row!.verificationStatus).toBe('UNDER_REVIEW');
  });

  it('a contact-only change does not touch verification_status', async () => {
    const { id: facilityId } = await facilitiesRepository.registerFacility({ facilityType: 'HOSPITAL', name: 'DEMO Contact Hospital', createdBy: ownerId });
    await sql`UPDATE facilities SET verification_status = 'VERIFIED', location = ST_SetSRID(ST_MakePoint(0, 0), 4326)::geography WHERE id = ${facilityId}`;

    await facilitiesRepository.updateProfile(facilityId, { contact: '+911234567890' }, false);
    const row = await facilitiesRepository.findById(facilityId);
    expect(row!.verificationStatus).toBe('VERIFIED');
    expect(row!.contact).toBe('+911234567890');
  });
});

describe('public visibility (facilities.repository.listPublic / findById)', () => {
  it('a PENDING facility never appears in listPublic; a VERIFIED + ACTIVE one does', async () => {
    const { id: pendingId } = await facilitiesRepository.registerFacility({ facilityType: 'HOSPITAL', name: 'DEMO Pending Visibility Hospital', createdBy: ownerId });
    const { id: verifiedId } = await facilitiesRepository.registerFacility({ facilityType: 'HOSPITAL', name: 'DEMO Verified Visibility Hospital', createdBy: ownerId });
    await sql`UPDATE facilities SET verification_status = 'VERIFIED', location = ST_SetSRID(ST_MakePoint(0, 0), 4326)::geography WHERE id = ${verifiedId}`;

    const page = await facilitiesRepository.listPublic('HOSPITAL', 100);
    const ids = page.items.map((f) => f.id);
    expect(ids).toContain(verifiedId);
    expect(ids).not.toContain(pendingId);
  });

  it('facilitiesService.getFacilityDetail returns null for an unrelated caller when not VERIFIED, and the public view when VERIFIED', async () => {
    const { id: facilityId } = await facilitiesRepository.registerFacility({ facilityType: 'HOSPITAL', name: 'DEMO Detail Visibility Hospital', createdBy: ownerId });
    const stranger = await createUser();

    expect(await facilitiesService.getFacilityDetail('HOSPITAL', facilityId, stranger)).toBeNull();

    await sql`UPDATE facilities SET verification_status = 'VERIFIED', location = ST_SetSRID(ST_MakePoint(0, 0), 4326)::geography WHERE id = ${facilityId}`;
    const detail = await facilitiesService.getFacilityDetail('HOSPITAL', facilityId, stranger);
    expect(detail).toMatchObject({ id: facilityId });
    expect(detail).not.toHaveProperty('verificationStatus'); // public view only
  });
});

describe('cursor pagination (facilities.repository.listPublic)', () => {
  it('pages through a set of VERIFIED facilities with no duplicates and no gaps', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { id } = await facilitiesRepository.registerFacility({ facilityType: 'BLOOD_BANK', name: `DEMO Page Bank ${i}`, createdBy: ownerId });
      await sql`UPDATE facilities SET verification_status = 'VERIFIED', location = ST_SetSRID(ST_MakePoint(0, 0), 4326)::geography, created_at = now() + (${i} || ' seconds')::interval WHERE id = ${id}`;
      ids.push(id);
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await facilitiesRepository.listPublic('BLOOD_BANK', 2, cursor);
      seen.push(...result.items.map((f) => f.id));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }

    const seenOfOurs = seen.filter((id) => ids.includes(id));
    expect(new Set(seenOfOurs).size).toBe(seenOfOurs.length); // no duplicates
    expect(seenOfOurs.sort()).toEqual([...ids].sort()); // no gaps: all 5 were seen exactly once
  });
});
