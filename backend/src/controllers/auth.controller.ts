import type { Request, Response } from 'express';
import { getAuthMe } from '../services/usersService.js';
import { sendSuccess } from '../utils/respond.js';

// requireAuth() (middlewares/auth.ts) runs before this on every route in this file, so req.auth is
// always set here.
export async function getMe(req: Request, res: Response): Promise<void> {
  const me = await getAuthMe(req.auth!.userId);
  sendSuccess(res, 200, me);
}
