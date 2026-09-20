import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../utils/appError.js';
import { describeError, log } from '../utils/logger.js';

// The ONLY place that decides what an error response looks like, so nothing sensitive can leak
// by accident. Anything that is not an AppError becomes a generic 500 with a fixed message.
function toClientError(err: unknown): { status: number; code: string; message: string; details?: unknown } {
  if (err instanceof AppError) {
    return { status: err.status, code: err.code, message: err.message, details: err.details };
  }
  return { status: 500, code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' };
}

// Central error handler. Express calls it for every error thrown or passed to next(), including
// rejected promises from async handlers (Express 5). It must be registered after all routes.
export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  // If the response has already started, Express has to close the connection itself.
  if (res.headersSent) {
    next(err);
    return;
  }

  const { status, code, message, details } = toClientError(err);

  // Server-side only. Everything needed to debug is here, tagged with the request id:
  // search the log for the requestId shown in the client's error response.
  log(status >= 500 ? 'error' : 'warn', 'request failed', {
    requestId: req.requestId,
    method: req.method,
    path: req.path,
    status,
    code,
    error: describeError(err),
  });

  // API.md 1.1 error envelope. `details` is left out of the JSON when it is undefined.
  res.status(status).json({
    success: false,
    error: { code, message, details, requestId: req.requestId },
  });
}
