import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../utils/appError.js';

// Runs when no route matched. It hands a 404 to the central error handler, so the response format
// and the logging are the same as for every other error.
export function notFound(_req: Request, _res: Response, next: NextFunction): void {
  next(new AppError(404, 'NOT_FOUND', 'Route not found.'));
}
