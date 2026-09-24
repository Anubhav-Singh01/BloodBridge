import express, { Router } from 'express';
import { getHistory, getVerification, patchAvailability, postDonations, postVerification, putLocation, putMe } from '../controllers/donors.controller.js';
import { requireAuth, requireRole } from '../middlewares/auth.js';
import { requireDonorProfile } from '../middlewares/donorAuth.js';

export const donorsRouter = Router();

donorsRouter.use(express.json());

// API.md section 5. Role:DONOR on every route (the self-enrollment flow itself is Batch 3.10's
// POST /users/me/roles, reused unmodified).
const donorGuard = [requireAuth(), requireRole('DONOR')];

donorsRouter.put('/api/v1/donors/me', ...donorGuard, putMe);
donorsRouter.get('/api/v1/donors/me/verification', ...donorGuard, requireDonorProfile(), getVerification);
donorsRouter.post('/api/v1/donors/me/verification', ...donorGuard, requireDonorProfile(), postVerification);
donorsRouter.patch('/api/v1/donors/me/availability', ...donorGuard, requireDonorProfile(), patchAvailability);
donorsRouter.put('/api/v1/donors/me/location', ...donorGuard, requireDonorProfile(), putLocation);
donorsRouter.get('/api/v1/donors/me/history', ...donorGuard, requireDonorProfile(), getHistory);
donorsRouter.post('/api/v1/donors/me/donations', ...donorGuard, requireDonorProfile(), postDonations);
