import express, { Router } from 'express';
import { postReject, postVerify } from '../controllers/donationRecords.controller.js';
import { requireAuth } from '../middlewares/auth.js';
import { requireDonationReviewAccess } from '../middlewares/donationAuth.js';

export const donationRecordsRouter = Router();

donationRecordsRouter.use(express.json());

donationRecordsRouter.post('/api/v1/donation-history/:donationId/verify', requireAuth(), requireDonationReviewAccess(), postVerify);
donationRecordsRouter.post('/api/v1/donation-history/:donationId/reject', requireAuth(), requireDonationReviewAccess(), postReject);
