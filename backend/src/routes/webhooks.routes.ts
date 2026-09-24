import express, { Router } from 'express';
import { postClerkWebhook } from '../controllers/webhooks.controller.js';

export const webhooksRouter = Router();

// Outside /api/v1 (API.md section 12 gives the bare path "/webhooks/clerk", the same convention as
// the infra endpoints in section 3). express.raw() here, not express.json(): see
// controllers/webhooks.controller.ts for why the exact raw bytes matter.
webhooksRouter.post('/webhooks/clerk', express.raw({ type: 'application/json' }), postClerkWebhook);
