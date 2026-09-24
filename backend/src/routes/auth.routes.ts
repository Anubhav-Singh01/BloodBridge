import { Router } from 'express';
import { getMe } from '../controllers/auth.controller.js';
import { requireAuth } from '../middlewares/auth.js';

export const authRouter = Router();

authRouter.get('/api/v1/auth/me', requireAuth(), getMe);
