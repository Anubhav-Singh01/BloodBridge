import { beforeEach, describe, expect, it, vi } from 'vitest';

// Batch 3.11. facilitiesService's business logic against mocked repositories/auditService - no
// database, matching the pattern already established for usersService.test.ts.

vi.mock('../../src/repositories/facilities.repository.js', () => ({
  registerFacility: vi.fn(),
  findById: vi.fn(),
  updateProfile: vi.fn(),
  listPublic: vi.fn(),
}));
vi.mock('../../src/repositories/facilityMemberships.repository.js', () => ({
  createActiveAdmin: vi.fn(),
  findActiveMembership: vi.fn(),
  findMembership: vi.fn(),
  acceptInvitation: vi.fn(),
  removeMembership: vi.fn(),
  inviteStaff: vi.fn(),
  listByFacility: vi.fn(),
}));
vi.mock('../../src/repositories/facilityVerifications.repository.js', () => ({ upsertSubmission: vi.fn() }));
vi.mock('../../src/services/auditService.js', () => ({ record: vi.fn() }));

const facilitiesRepository = await import('../../src/repositories/facilities.repository.js');
const facilityMembershipsRepository = await import('../../src/repositories/facilityMemberships.repository.js');
const facilityVerificationsRepository = await import('../../src/repositories/facilityVerifications.repository.js');
const auditService = await import('../../src/services/auditService.js');
const facilitiesService = await import('../../src/services/facilitiesService.js');

const hospitalRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 'facility-1',
  facilityType: 'HOSPITAL' as const,
  name: 'DEMO Hospital',
  registrationNo: null,
  contact: null,
  address: null,
  hasLocation: false,
  verificationStatus: 'PENDING' as const,
  status: 'ACTIVE' as const,
  createdBy: 'user-1',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('registerFacility', () => {
  it('creates the facility, an ACTIVE FACILITY_ADMIN membership for the creator, and audits FACILITY_REGISTERED', async () => {
    vi.mocked(facilitiesRepository.registerFacility).mockResolvedValue({ id: 'facility-1' });
    vi.mocked(facilitiesRepository.findById).mockResolvedValue(hospitalRow());

    await facilitiesService.registerFacility('HOSPITAL', 'user-1', { name: 'DEMO Hospital' }, 'corr-1');

    expect(facilitiesRepository.registerFacility).toHaveBeenCalledWith(expect.objectContaining({ facilityType: 'HOSPITAL', createdBy: 'user-1' }));
    expect(facilityMembershipsRepository.createActiveAdmin).toHaveBeenCalledWith('user-1', 'facility-1');
    expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'user-1', action: 'FACILITY_REGISTERED', entityId: 'facility-1', correlationId: 'corr-1' }));
  });
});

describe('getFacilityDetail', () => {
  it('returns null for a nonexistent facility or a type mismatch', async () => {
    vi.mocked(facilitiesRepository.findById).mockResolvedValue(undefined);
    expect(await facilitiesService.getFacilityDetail('HOSPITAL', 'facility-1')).toBeNull();

    vi.mocked(facilitiesRepository.findById).mockResolvedValue(hospitalRow({ facilityType: 'BLOOD_BANK' }));
    expect(await facilitiesService.getFacilityDetail('HOSPITAL', 'facility-1')).toBeNull();
  });

  it('returns the full view for the facility\'s own FACILITY_ADMIN, even while unverified', async () => {
    vi.mocked(facilitiesRepository.findById).mockResolvedValue(hospitalRow({ verificationStatus: 'PENDING' }));
    vi.mocked(facilityMembershipsRepository.findActiveMembership).mockResolvedValue({ id: 'm1', userId: 'user-1', facilityId: 'facility-1', role: 'FACILITY_ADMIN', status: 'ACTIVE', joinedAt: new Date() });
    const result = await facilitiesService.getFacilityDetail('HOSPITAL', 'facility-1', 'user-1');
    expect(result).toMatchObject({ verificationStatus: 'PENDING', registrationNo: null });
  });

  it('returns the public view (no registrationNo/verificationStatus) for an unrelated caller when VERIFIED', async () => {
    vi.mocked(facilitiesRepository.findById).mockResolvedValue(hospitalRow({ verificationStatus: 'VERIFIED' }));
    vi.mocked(facilityMembershipsRepository.findActiveMembership).mockResolvedValue(undefined);
    const result = await facilitiesService.getFacilityDetail('HOSPITAL', 'facility-1', 'some-other-user');
    expect(result).toEqual({ id: 'facility-1', facilityType: 'HOSPITAL', name: 'DEMO Hospital', contact: null, address: null, hasLocation: false, status: 'ACTIVE' });
  });

  it('returns null for an unrelated caller when the facility is not yet VERIFIED', async () => {
    vi.mocked(facilitiesRepository.findById).mockResolvedValue(hospitalRow({ verificationStatus: 'PENDING' }));
    vi.mocked(facilityMembershipsRepository.findActiveMembership).mockResolvedValue(undefined);
    expect(await facilitiesService.getFacilityDetail('HOSPITAL', 'facility-1', 'some-other-user')).toBeNull();
  });
});

describe('updateFacilityProfile', () => {
  it('resets verification_status to UNDER_REVIEW when a verification-relevant field is patched', async () => {
    await facilitiesService.updateFacilityProfile('facility-1', { name: 'New Name' });
    expect(facilitiesRepository.updateProfile).toHaveBeenCalledWith('facility-1', { name: 'New Name' }, true);
  });

  it('does NOT reset verification_status when only contact is patched', async () => {
    await facilitiesService.updateFacilityProfile('facility-1', { contact: '+911234567890' });
    expect(facilitiesRepository.updateProfile).toHaveBeenCalledWith('facility-1', { contact: '+911234567890' }, false);
  });

  it('resets verification_status when location is patched, even alongside contact', async () => {
    await facilitiesService.updateFacilityProfile('facility-1', { contact: 'x', location: { lat: 1, lng: 1 } });
    expect(facilitiesRepository.updateProfile).toHaveBeenCalledWith('facility-1', expect.anything(), true);
  });
});

describe('submitVerification', () => {
  it('upserts the submission and audits FACILITY_VERIFICATION_SUBMITTED', async () => {
    vi.mocked(facilityVerificationsRepository.upsertSubmission).mockResolvedValue({ id: 'v1' });
    const result = await facilitiesService.submitVerification('facility-1', 'user-1', { license: 'X' }, 'corr-1');
    expect(result).toEqual({ id: 'v1', status: 'PENDING' });
    expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'user-1', action: 'FACILITY_VERIFICATION_SUBMITTED', entityId: 'facility-1' }));
  });
});

describe('acceptInvitation', () => {
  it('a genuine INVITED -> ACTIVE transition is audited', async () => {
    vi.mocked(facilityMembershipsRepository.findMembership).mockResolvedValue({ id: 'm1', userId: 'user-1', facilityId: 'facility-1', role: 'STAFF', status: 'INVITED', joinedAt: null });
    vi.mocked(facilityMembershipsRepository.acceptInvitation).mockResolvedValue({ id: 'm1', userId: 'user-1', facilityId: 'facility-1', role: 'STAFF', status: 'ACTIVE', joinedAt: new Date() });
    await facilitiesService.acceptInvitation('user-1', 'facility-1');
    expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'STAFF_INVITATION_ACCEPTED' }));
  });

  it('an idempotent repeat (already ACTIVE) is not re-audited', async () => {
    vi.mocked(facilityMembershipsRepository.findMembership).mockResolvedValue({ id: 'm1', userId: 'user-1', facilityId: 'facility-1', role: 'STAFF', status: 'ACTIVE', joinedAt: new Date() });
    vi.mocked(facilityMembershipsRepository.acceptInvitation).mockResolvedValue({ id: 'm1', userId: 'user-1', facilityId: 'facility-1', role: 'STAFF', status: 'ACTIVE', joinedAt: new Date() });
    await facilitiesService.acceptInvitation('user-1', 'facility-1');
    expect(auditService.record).not.toHaveBeenCalled();
  });
});

describe('removeStaff', () => {
  it('removes the membership and audits STAFF_REMOVED', async () => {
    await facilitiesService.removeStaff('facility-1', 'target-user', 'admin-user', 'corr-1');
    expect(facilityMembershipsRepository.removeMembership).toHaveBeenCalledWith('facility-1', 'target-user');
    expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'admin-user', action: 'STAFF_REMOVED', details: { removedUserId: 'target-user' } }));
  });
});
