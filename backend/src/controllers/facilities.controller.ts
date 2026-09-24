import type { Request, Response } from 'express';
import type { ZodType } from 'zod';
import * as facilitiesService from '../services/facilitiesService.js';
import type { FacilityType } from '../repositories/facilities.repository.js';
import { AppError } from '../utils/appError.js';
import { requireParam } from '../utils/params.js';
import { sendSuccess } from '../utils/respond.js';
import {
  inviteStaffBodySchema,
  listFacilitiesQuerySchema,
  registerFacilityBodySchema,
  submitVerificationBodySchema,
  updateFacilityBodySchema,
} from '../validators/facilities.validators.js';

function parseOrThrow<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const details = result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
    throw new AppError(400, 'VALIDATION_ERROR', 'The request is invalid.', details);
  }
  return result.data;
}

// Each factory is parametrized by facilityType because the type is implied by the route path
// (/hospitals vs /blood-banks, API.md section 7), never accepted from the client.

export function registerFacility(facilityType: FacilityType) {
  return async function registerFacilityHandler(req: Request, res: Response): Promise<void> {
    const body = parseOrThrow(registerFacilityBodySchema, req.body);
    const facility = await facilitiesService.registerFacility(facilityType, req.auth!.userId, body, req.requestId);
    sendSuccess(res, 201, facility);
  };
}

export function listFacilities(facilityType: FacilityType) {
  return async function listFacilitiesHandler(req: Request, res: Response): Promise<void> {
    const query = parseOrThrow(listFacilitiesQuerySchema, req.query);
    const page = await facilitiesService.listFacilities(facilityType, query.limit, query.cursor);
    sendSuccess(res, 200, { items: page.items }, { pageInfo: { limit: query.limit, nextCursor: page.nextCursor, hasMore: page.nextCursor !== null } });
  };
}

export function getFacilityById(facilityType: FacilityType) {
  return async function getFacilityByIdHandler(req: Request, res: Response): Promise<void> {
    const facility = await facilitiesService.getFacilityDetail(facilityType, requireParam(req, 'id'), req.auth?.userId);
    if (!facility) throw new AppError(404, 'NOT_FOUND', 'Facility not found.');
    sendSuccess(res, 200, facility);
  };
}

// requireFacilityAccess (middlewares/facilityAuth.ts) runs before every handler below, so
// req.facility is always set.

export async function patchFacility(req: Request, res: Response): Promise<void> {
  const body = parseOrThrow(updateFacilityBodySchema, req.body);
  await facilitiesService.updateFacilityProfile(req.facility!.id, body);
  sendSuccess(res, 200, { updated: true });
}

export async function postVerification(req: Request, res: Response): Promise<void> {
  const body = parseOrThrow(submitVerificationBodySchema, req.body);
  const result = await facilitiesService.submitVerification(req.facility!.id, req.auth!.userId, body.registrationMetadata, req.requestId);
  sendSuccess(res, 200, result);
}

export async function getStaff(req: Request, res: Response): Promise<void> {
  const staff = await facilitiesService.listStaff(req.facility!.id);
  sendSuccess(res, 200, { items: staff });
}

export async function postStaff(req: Request, res: Response): Promise<void> {
  const body = parseOrThrow(inviteStaffBodySchema, req.body);
  const result = await facilitiesService.inviteStaff(req.facility!.id, body.userId, body.role, req.auth!.userId, req.requestId);
  sendSuccess(res, 201, result);
}

export async function deleteStaff(req: Request, res: Response): Promise<void> {
  await facilitiesService.removeStaff(req.facility!.id, requireParam(req, 'userId'), req.auth!.userId, req.requestId);
  sendSuccess(res, 200, { removed: true });
}

// requireAuth() (not requireFacilityAccess) runs before this: the caller is not yet a member, which
// is the whole point of accepting.
export async function postAcceptStaffInvitation(req: Request, res: Response): Promise<void> {
  const result = await facilitiesService.acceptInvitation(req.auth!.userId, requireParam(req, 'id'), req.requestId);
  sendSuccess(res, 200, result);
}
