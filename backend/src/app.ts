import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { env } from './config/env.js';
import { errorHandler } from './middlewares/errorHandler.js';
import { notFound } from './middlewares/notFound.js';
import { requestId } from './middlewares/requestId.js';
import { infraRouter } from './routes/infra.routes.js';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.disable('etag');

  // Order matters: requestId first so every later step (and every log line) has the id.
  app.use(requestId);
  app.use(helmet());
  // API.md 1.4: CORS allow-list built from FRONTEND_URL.
  app.use(cors({ origin: [new URL(env.FRONTEND_URL).origin], exposedHeaders: ['X-Request-ID'] }));

  // Infrastructure endpoints live outside /api/v1 (API.md section 3).
  // The versioned API is added in later phases.
  app.use(infraRouter);

  // Error handling comes last: unknown routes become a 404, and every error ends up in errorHandler.
  app.use(notFound);
  app.use(errorHandler);

  return app;
}
