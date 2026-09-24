import type { Request, Response } from 'express';
import type { ZodType } from 'zod';
import * as usersService from '../services/usersService.js';
import { AppError } from '../utils/appError.js';
import { sendSuccess } from '../utils/respond.js';
import { enrollRoleBodySchema, updateProfileBodySchema } from '../validators/users.validators.js';

// API.md 1.1: VALIDATION_ERROR with a { path, message } list. Every body/query/param goes through
// this, never a hand-rolled check (API.md 1.4).
function parseOrThrow<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    const details = result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
    throw new AppError(400, 'VALIDATION_ERROR', 'The request body is invalid.', details);
  }
  return result.data;
}

// requireAuth() (middlewares/auth.ts) runs before every handler in this file, so req.auth is always set.

export async function patchMe(req: Request, res: Response): Promise<void> {
  const body = parseOrThrow(updateProfileBodySchema, req.body);
  await usersService.updateProfile(req.auth!.userId, body);
  sendSuccess(res, 200, { updated: true });
}

export async function postEnrollRole(req: Request, res: Response): Promise<void> {
  const body = parseOrThrow(enrollRoleBodySchema, req.body);
  const result = await usersService.enrollRole(req.auth!.userId, body.role, req.requestId);
  // API.md 4.1: 201 on a first enrolment, 200 on an already-enrolled no-op.
  sendSuccess(res, result.enrolled ? 201 : 200, result);
}

export async function deleteMe(req: Request, res: Response): Promise<void> {
  const result = await usersService.requestDeletion(req.auth!.userId, 'USER_REQUEST', req.requestId);
  sendSuccess(res, result.status === 'pending' ? 201 : 200, result);
}
