import { clerkMiddleware } from '@clerk/express';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { env } from './config/env.js';
import { errorHandler } from './middlewares/errorHandler.js';
import { notFound } from './middlewares/notFound.js';
import { requestId } from './middlewares/requestId.js';
import { authRouter } from './routes/auth.routes.js';
import { facilitiesRouter } from './routes/facilities.routes.js';
import { infraRouter } from './routes/infra.routes.js';
import { usersRouter } from './routes/users.routes.js';
import { webhooksRouter } from './routes/webhooks.routes.js';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.disable('etag');

  // Order matters: requestId first so every later step (and every log line) has the id.
  app.use(requestId);
  app.use(helmet());
  // API.md 1.4: CORS allow-list built from FRONTEND_URL.
  app.use(cors({ origin: [new URL(env.FRONTEND_URL).origin], exposedHeaders: ['X-Request-ID'] }));
  // Batch 3.10: reads the Clerk session (cookie or Authorization: Bearer) if present and attaches it
  // for getAuth() to read; it does not itself reject an unauthenticated request. middlewares/auth.ts's
  // requireAuth() is what actually enforces auth per route, and reads only our own DB for roles/status
  // (API.md 2: authorization is always evaluated from our database, never from JWT claims).
  app.use(clerkMiddleware());

  // Infrastructure endpoints live outside /api/v1 (API.md section 3).
  app.use(infraRouter);
  // Webhooks also live outside /api/v1 (API.md section 12), and before the other business routers
  // since it needs the raw request body, not JSON-parsed.
  app.use(webhooksRouter);
  app.use(authRouter);
  app.use(usersRouter);
  app.use(facilitiesRouter);

  // Error handling comes last: unknown routes become a 404, and every error ends up in errorHandler.
  app.use(notFound);
  app.use(errorHandler);

  return app;
}
