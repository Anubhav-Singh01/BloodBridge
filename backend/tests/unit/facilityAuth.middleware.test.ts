import type { NextFunction, Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Batch 3.11. requireFacilityAccess tested against mocked repositories - no database. Proves:
// facility access comes only from facility_memberships (never a global role), object-scoping
// returns 404 (not 403) for anything the caller has no relationship to, adminOnly requires the
// FACILITY_ADMIN role specifically, and requireOperational is enforced when a route opts in.

vi.mock('../../src/repositories/facilities.repository.js', () => ({ findById: vi.fn() }));
vi.mock('../../src/repositories/facilityMemberships.repository.js', () => ({ findActiveMembership: vi.fn() }));

const facilitiesRepository = await import('../../src/repositories/facilities.repository.js');
const facilityMembershipsRepository = await import('../../src/repositories/facilityMemberships.repository.js');
const { requireFacilityAccess } = await import('../../src/middlewares/facilityAuth.js');

function fakeReq(auth: { userId: string } | undefined, id = 'facility-1'): Request {
  return { auth: auth as never, params: { id } } as unknown as Request;
}
function fakeRes(): Response {
  return {} as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('requireFacilityAccess', () => {
  it('rejects with 401 when requireAuth has not run (no req.auth)', async () => {
    const next = vi.fn() as NextFunction;
    await requireFacilityAccess({ types: ['HOSPITAL'] })(fakeReq(undefined), fakeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 401 }));
    expect(facilitiesRepository.findById).not.toHaveBeenCalled();
  });

  it('returns 404 (not 403) when the facility does not exist', async () => {
    vi.mocked(facilitiesRepository.findById).mockResolvedValue(undefined);
    const next = vi.fn() as NextFunction;
    await requireFacilityAccess({ types: ['HOSPITAL'] })(fakeReq({ userId: 'u1' }), fakeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
    expect(facilityMembershipsRepository.findActiveMembership).not.toHaveBeenCalled();
  });

  it('returns 404 when the facility exists but is the wrong type for this route', async () => {
    vi.mocked(facilitiesRepository.findById).mockResolvedValue({
      id: 'facility-1',
      facilityType: 'BLOOD_BANK',
      name: 'x',
      registrationNo: null,
      contact: null,
      address: null,
      hasLocation: false,
      verificationStatus: 'PENDING',
      status: 'ACTIVE',
      createdBy: 'u0',
      createdAt: new Date(),
    });
    const next = vi.fn() as NextFunction;
    await requireFacilityAccess({ types: ['HOSPITAL'] })(fakeReq({ userId: 'u1' }), fakeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
  });

  const activeHospital = {
    id: 'facility-1',
    facilityType: 'HOSPITAL' as const,
    name: 'x',
    registrationNo: null,
    contact: null,
    address: null,
    hasLocation: true,
    verificationStatus: 'PENDING' as const,
    status: 'ACTIVE' as const,
    createdBy: 'u0',
    createdAt: new Date(),
  };

  it('returns 404 (not 403) when the caller has no ACTIVE membership at this facility', async () => {
    vi.mocked(facilitiesRepository.findById).mockResolvedValue(activeHospital);
    vi.mocked(facilityMembershipsRepository.findActiveMembership).mockResolvedValue(undefined);
    const next = vi.fn() as NextFunction;
    await requireFacilityAccess({ types: ['HOSPITAL'] })(fakeReq({ userId: 'u1' }), fakeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
  });

  it('returns 403 when adminOnly is set and the membership role is STAFF, not FACILITY_ADMIN', async () => {
    vi.mocked(facilitiesRepository.findById).mockResolvedValue(activeHospital);
    vi.mocked(facilityMembershipsRepository.findActiveMembership).mockResolvedValue({ id: 'm1', userId: 'u1', facilityId: 'facility-1', role: 'STAFF', status: 'ACTIVE', joinedAt: new Date() });
    const next = vi.fn() as NextFunction;
    await requireFacilityAccess({ types: ['HOSPITAL'], adminOnly: true })(fakeReq({ userId: 'u1' }), fakeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
  });

  it('passes through and sets req.facility for a FACILITY_ADMIN, even while PENDING/UNDER_REVIEW (Batch 3.11 decision 4)', async () => {
    vi.mocked(facilitiesRepository.findById).mockResolvedValue(activeHospital); // verificationStatus: PENDING
    vi.mocked(facilityMembershipsRepository.findActiveMembership).mockResolvedValue({ id: 'm1', userId: 'u1', facilityId: 'facility-1', role: 'FACILITY_ADMIN', status: 'ACTIVE', joinedAt: new Date() });
    const req = fakeReq({ userId: 'u1' });
    const next = vi.fn() as NextFunction;
    await requireFacilityAccess({ types: ['HOSPITAL'], adminOnly: true })(req, fakeRes(), next);
    expect(next).toHaveBeenCalledWith();
    expect(req.facility).toEqual({ id: 'facility-1', facilityType: 'HOSPITAL', status: 'ACTIVE', verificationStatus: 'PENDING', membershipRole: 'FACILITY_ADMIN' });
  });

  it('requireOperational: true rejects a FACILITY_ADMIN when the facility is not yet VERIFIED', async () => {
    vi.mocked(facilitiesRepository.findById).mockResolvedValue(activeHospital); // still PENDING
    vi.mocked(facilityMembershipsRepository.findActiveMembership).mockResolvedValue({ id: 'm1', userId: 'u1', facilityId: 'facility-1', role: 'FACILITY_ADMIN', status: 'ACTIVE', joinedAt: new Date() });
    const next = vi.fn() as NextFunction;
    await requireFacilityAccess({ types: ['HOSPITAL'], requireOperational: true })(fakeReq({ userId: 'u1' }), fakeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
  });

  it('requireOperational: true passes once the facility is ACTIVE and VERIFIED', async () => {
    vi.mocked(facilitiesRepository.findById).mockResolvedValue({ ...activeHospital, verificationStatus: 'VERIFIED' });
    vi.mocked(facilityMembershipsRepository.findActiveMembership).mockResolvedValue({ id: 'm1', userId: 'u1', facilityId: 'facility-1', role: 'STAFF', status: 'ACTIVE', joinedAt: new Date() });
    const next = vi.fn() as NextFunction;
    await requireFacilityAccess({ types: ['HOSPITAL'], requireOperational: true })(fakeReq({ userId: 'u1' }), fakeRes(), next);
    expect(next).toHaveBeenCalledWith();
  });
});
