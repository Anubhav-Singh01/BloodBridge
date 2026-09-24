import type { Request, Response } from 'express';
import type { ZodType } from 'zod';
import * as donorsService from '../services/donorsService.js';
import { AppError } from '../utils/appError.js';
import { sendSuccess } from '../utils/respond.js';
import {
  donorProfileBodySchema,
  listDonationHistoryQuerySchema,
  reportSelfDonationBodySchema,
  setAvailabilityBodySchema,
  setDonorLocationBodySchema,
  submitDonorVerificationBodySchema,
} from '../validators/donors.validators.js';

function parseOrThrow<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const details = result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
    throw new AppError(400, 'VALIDATION_ERROR', 'The request is invalid.', details);
  }
  return result.data;
}

// requireAuth() + requireRole('DONOR') run before every handler here. requireDonorProfile() (which
// sets req.donor) runs before every one of them EXCEPT putMe, which is how a donor profile gets
// created in the first place.

export async function putMe(req: Request, res: Response): Promise<void> {
  const body = parseOrThrow(donorProfileBodySchema, req.body);
  const donor = await donorsService.createOrUpdateProfile(req.auth!.userId, body, req.requestId);
  sendSuccess(res, 200, donor);
}

export async function getVerification(req: Request, res: Response): Promise<void> {
  const verification = await donorsService.getVerification(req.donor!.id);
  sendSuccess(res, 200, verification ?? null);
}

export async function postVerification(req: Request, res: Response): Promise<void> {
  const body = parseOrThrow(submitDonorVerificationBodySchema, req.body);
  const result = await donorsService.submitVerification(req.donor!.id, body, req.requestId);
  sendSuccess(res, 200, result);
}

export async function patchAvailability(req: Request, res: Response): Promise<void> {
  const body = parseOrThrow(setAvailabilityBodySchema, req.body);
  await donorsService.setAvailability(req.donor!.id, { availabilityStatus: body.availabilityStatus, until: body.until ? new Date(body.until) : null });
  sendSuccess(res, 200, { updated: true });
}

export async function putLocation(req: Request, res: Response): Promise<void> {
  const body = parseOrThrow(setDonorLocationBodySchema, req.body);
  await donorsService.setLocation(req.donor!.id, body);
  // Batch 3.12 decision B: never echo exact coordinates, even the donor's own just-submitted ones.
  sendSuccess(res, 200, { saved: true });
}

export async function postDonations(req: Request, res: Response): Promise<void> {
  const body = parseOrThrow(reportSelfDonationBodySchema, req.body);
  const result = await donorsService.reportSelfDonation(req.donor!.id, new Date(body.donatedAt), req.requestId);
  sendSuccess(res, 201, result);
}

export async function getHistory(req: Request, res: Response): Promise<void> {
  const query = parseOrThrow(listDonationHistoryQuerySchema, req.query);
  const page = await donorsService.getHistoryPage(req.donor!.id, query.limit, query.cursor);
  sendSuccess(res, 200, { items: page.items }, { pageInfo: { limit: query.limit, nextCursor: page.nextCursor, hasMore: page.nextCursor !== null } });
}
