// Batch 3.8 demo seed (dev only, never test or production - see scripts/db-seed.ts). Every row is synthetic:
// fake names prefixed "DEMO", identifiers prefixed "demo-", no real person or facility. This file holds data
// only (no database access, no randomness) so the same content is produced every time it's imported.
//
// Every row that has no natural business key (facilities, patients, donation_history) gets a fixed, explicit id
// instead of leaving it to gen_random_uuid(), so scripts/db-seed.ts can upsert on that id and re-running the
// seed is a true no-op. Rows that do have a natural key (users.clerk_user_id, donors.user_id,
// blood_units.unit_uid, facility_memberships (user_id, facility_id)) upsert on that instead. These ids are
// hand-written constants, never generated - they are not meant to look like a real gen_random_uuid() output.
//
// DATABASE.md section 11: "It covers demo patients, donors, hospitals, blood banks, blood units and donation
// history. It contains no blood requests, because the urgency taxonomy is an open decision." This file matches
// that exactly: there is no demo blood_requests data here, and none should be added until that decision is made.

export const DEMO_IDS = {
  hospitalStaffUser: 'd0000000-0000-4000-8000-000000000001',
  bloodBankStaffUser: 'd0000000-0000-4000-8000-000000000002',
  donorUser1: 'd0000000-0000-4000-8000-000000000003',
  donorUser2: 'd0000000-0000-4000-8000-000000000004',
  hospitalFacility: 'd0000000-0000-4000-8000-000000000011',
  bloodBankFacility: 'd0000000-0000-4000-8000-000000000012',
  patient1: 'd0000000-0000-4000-8000-000000000021',
  donor1: 'd0000000-0000-4000-8000-000000000031',
  donor2: 'd0000000-0000-4000-8000-000000000032',
  donationHistory1: 'd0000000-0000-4000-8000-000000000041',
  donationHistory2: 'd0000000-0000-4000-8000-000000000042',
} as const;

export interface DemoUser {
  id: string;
  clerkUserId: string;
}

/** Natural key: users.clerk_user_id (UNIQUE). */
export const DEMO_USERS: readonly DemoUser[] = [
  { id: DEMO_IDS.hospitalStaffUser, clerkUserId: 'demo-hospital-staff' },
  { id: DEMO_IDS.bloodBankStaffUser, clerkUserId: 'demo-bloodbank-staff' },
  { id: DEMO_IDS.donorUser1, clerkUserId: 'demo-donor-1' },
  { id: DEMO_IDS.donorUser2, clerkUserId: 'demo-donor-2' },
];

export interface DemoFacility {
  id: string;
  facilityType: 'HOSPITAL' | 'BLOOD_BANK';
  name: string;
  createdBy: string;
  /** Bengaluru, India - the same demo coordinate already used by tests/db/helpers.ts's point() fixture. */
  lng: number;
  lat: number;
}

/** No natural key on facilities (name is not unique); upserts on the fixed id above. */
export const DEMO_FACILITIES: readonly DemoFacility[] = [
  { id: DEMO_IDS.hospitalFacility, facilityType: 'HOSPITAL', name: 'DEMO City General Hospital', createdBy: DEMO_IDS.hospitalStaffUser, lng: 77.5946, lat: 12.9716 },
  { id: DEMO_IDS.bloodBankFacility, facilityType: 'BLOOD_BANK', name: 'DEMO Central Blood Bank', createdBy: DEMO_IDS.bloodBankStaffUser, lng: 77.5946, lat: 12.9716 },
];

export interface DemoMembership {
  userId: string;
  facilityId: string;
  role: 'FACILITY_ADMIN';
}

/** Natural key: facility_memberships (user_id, facility_id) UNIQUE. Both are ACTIVE with joined_at set. */
export const DEMO_MEMBERSHIPS: readonly DemoMembership[] = [
  { userId: DEMO_IDS.hospitalStaffUser, facilityId: DEMO_IDS.hospitalFacility, role: 'FACILITY_ADMIN' },
  { userId: DEMO_IDS.bloodBankStaffUser, facilityId: DEMO_IDS.bloodBankFacility, role: 'FACILITY_ADMIN' },
];

export interface DemoPatient {
  id: string;
  createdBy: string;
}

/** No natural key; upserts on the fixed id above. age_band is fixed to ADULT. */
export const DEMO_PATIENTS: readonly DemoPatient[] = [{ id: DEMO_IDS.patient1, createdBy: DEMO_IDS.hospitalStaffUser }];

export interface DemoDonor {
  id: string;
  userId: string;
  bloodGroup: string;
}

/** Natural key: donors.user_id UNIQUE. */
export const DEMO_DONORS: readonly DemoDonor[] = [
  { id: DEMO_IDS.donor1, userId: DEMO_IDS.donorUser1, bloodGroup: 'O_POS' },
  { id: DEMO_IDS.donor2, userId: DEMO_IDS.donorUser2, bloodGroup: 'A_POS' },
];

export interface DemoBloodUnit {
  unitUid: string;
  facilityUnitCode: string;
  facilityId: string;
  bloodGroup: string;
  component: 'WHOLE_BLOOD';
  /** Relative to seed time, computed server-side (now() +/- interval), so the row never becomes stale. */
  collectedDaysAgo: number;
  expiresInDays: number;
}

/** Natural key: blood_units.unit_uid UNIQUE. Both AVAILABLE at the demo blood bank. */
export const DEMO_BLOOD_UNITS: readonly DemoBloodUnit[] = [
  { unitUid: 'DEMO-UNIT-0001', facilityUnitCode: 'DEMO-CODE-0001', facilityId: DEMO_IDS.bloodBankFacility, bloodGroup: 'O_POS', component: 'WHOLE_BLOOD', collectedDaysAgo: 1, expiresInDays: 30 },
  { unitUid: 'DEMO-UNIT-0002', facilityUnitCode: 'DEMO-CODE-0002', facilityId: DEMO_IDS.bloodBankFacility, bloodGroup: 'A_POS', component: 'WHOLE_BLOOD', collectedDaysAgo: 2, expiresInDays: 30 },
];

export interface DemoDonationHistory {
  id: string;
  donorId: string;
  facilityId: string;
  recordedBy: string;
  /** Relative to seed time, computed server-side. */
  donatedDaysAgo: number;
}

/** No natural key; upserts on the fixed id above. Both FACILITY_RECORDED and VERIFIED at the demo hospital. */
export const DEMO_DONATION_HISTORY: readonly DemoDonationHistory[] = [
  { id: DEMO_IDS.donationHistory1, donorId: DEMO_IDS.donor1, facilityId: DEMO_IDS.hospitalFacility, recordedBy: DEMO_IDS.hospitalStaffUser, donatedDaysAgo: 10 },
  { id: DEMO_IDS.donationHistory2, donorId: DEMO_IDS.donor2, facilityId: DEMO_IDS.hospitalFacility, recordedBy: DEMO_IDS.hospitalStaffUser, donatedDaysAgo: 20 },
];
