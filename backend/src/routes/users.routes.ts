import express, { Router } from 'express';
import { deleteMe, patchMe, postEnrollRole } from '../controllers/users.controller.js';
import { requireAuth } from '../middlewares/auth.js';

export const usersRouter = Router();

// Scoped to this router only (not applied globally in app.ts): routes/webhooks.routes.ts needs the
// raw, unparsed body instead, and keeping each router responsible for its own body parser avoids
// any ordering dependency between the two.
usersRouter.use(express.json());

usersRouter.patch('/api/v1/users/me', requireAuth(), patchMe);
usersRouter.post('/api/v1/users/me/roles', requireAuth(), postEnrollRole);
// Batch 3.10 decision: this is the one route that must accept an already-DELETION_PENDING caller,
// so a repeat call is idempotent instead of being rejected purely for already being pending.
usersRouter.delete('/api/v1/users/me', requireAuth({ allowDeletionPending: true }), deleteMe);
