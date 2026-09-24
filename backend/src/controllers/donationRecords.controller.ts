import type { Request, Response } from 'express';
import * as donationRecordsService from '../services/donationRecordsService.js';
import { sendSuccess } from '../utils/respond.js';
import { requireParam } from '../utils/params.js';

// requireAuth() + requireDonationReviewAccess() (middlewares/donationAuth.ts) run before both
// handlers here, so req.donation is always set.

export async function postVerify(req: Request, res: Response): Promise<void> {
  const result = await donationRecordsService.verifyDonation(requireParam(req, 'donationId'), req.auth!.userId, req.requestId);
  sendSuccess(res, 200, result);
}

export async function postReject(req: Request, res: Response): Promise<void> {
  const result = await donationRecordsService.rejectDonation(requireParam(req, 'donationId'), req.auth!.userId, req.requestId);
  sendSuccess(res, 200, result);
}
