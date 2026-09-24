import express, { Router } from 'express';
import {
  deleteStaff,
  getFacilityById,
  getStaff,
  listFacilities,
  patchFacility,
  postAcceptStaffInvitation,
  postStaff,
  postVerification,
  registerFacility,
} from '../controllers/facilities.controller.js';
import { optionalAuth, requireAuth } from '../middlewares/auth.js';
import { requireFacilityAccess } from '../middlewares/facilityAuth.js';

export const facilitiesRouter = Router();

facilitiesRouter.use(express.json());

// API.md section 7. Registration is Auth; list/detail are Pub (with an admin-only full view on
// detail); everything else is F:ADMIN(id) via requireFacilityAccess.

facilitiesRouter.post('/api/v1/hospitals', requireAuth(), registerFacility('HOSPITAL'));
facilitiesRouter.post('/api/v1/blood-banks', requireAuth(), registerFacility('BLOOD_BANK'));

facilitiesRouter.get('/api/v1/hospitals', listFacilities('HOSPITAL'));
facilitiesRouter.get('/api/v1/blood-banks', listFacilities('BLOOD_BANK'));

facilitiesRouter.get('/api/v1/hospitals/:id', optionalAuth(), getFacilityById('HOSPITAL'));
facilitiesRouter.get('/api/v1/blood-banks/:id', optionalAuth(), getFacilityById('BLOOD_BANK'));

facilitiesRouter.patch('/api/v1/hospitals/:id', requireAuth(), requireFacilityAccess({ types: ['HOSPITAL'], adminOnly: true }), patchFacility);
facilitiesRouter.patch('/api/v1/blood-banks/:id', requireAuth(), requireFacilityAccess({ types: ['BLOOD_BANK'], adminOnly: true }), patchFacility);

facilitiesRouter.post('/api/v1/hospitals/:id/verification', requireAuth(), requireFacilityAccess({ types: ['HOSPITAL'], adminOnly: true }), postVerification);
facilitiesRouter.post('/api/v1/blood-banks/:id/verification', requireAuth(), requireFacilityAccess({ types: ['BLOOD_BANK'], adminOnly: true }), postVerification);

// Staff management applies to either facility type (API.md: "GET, POST, DELETE /facilities/:id/staff").
const STAFF_TYPES = ['HOSPITAL', 'BLOOD_BANK'] as const;
facilitiesRouter.get('/api/v1/facilities/:id/staff', requireAuth(), requireFacilityAccess({ types: STAFF_TYPES, adminOnly: true }), getStaff);
facilitiesRouter.post('/api/v1/facilities/:id/staff', requireAuth(), requireFacilityAccess({ types: STAFF_TYPES, adminOnly: true }), postStaff);
// The literal API.md path ("DELETE /facilities/:id/staff") does not say which member; :userId makes
// that explicit (a Batch 3.11 interpretation - see the implementation report).
facilitiesRouter.delete('/api/v1/facilities/:id/staff/:userId', requireAuth(), requireFacilityAccess({ types: STAFF_TYPES, adminOnly: true }), deleteStaff);

// Batch 3.11 addition (approved): the invited user accepts for themselves. Not facility-admin-gated -
// the caller is not yet a member, which is the whole point of this endpoint.
facilitiesRouter.post('/api/v1/facilities/:id/staff/accept', requireAuth(), postAcceptStaffInvitation);
