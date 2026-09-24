import type { Response } from 'express';

// API.md 1.1's success envelope: { success: true, data, meta }. `meta` is optional there, so it is
// left out of the JSON entirely when not given, the same way middlewares/errorHandler.ts already
// omits `details` when undefined.
export function sendSuccess<T>(res: Response, status: number, data: T, meta?: Record<string, unknown>): void {
  res.status(status).json(meta === undefined ? { success: true, data } : { success: true, data, meta });
}
