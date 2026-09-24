import type { Request } from 'express';
import { AppError } from './appError.js';

// Express types a route param as `string | string[]` (a repeated-segment edge case this app never
// uses). Every route here has exactly one segment per name, so anything other than a single string
// is treated as "not found" rather than trusted or guessed at.
export function requireParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new AppError(404, 'NOT_FOUND', 'Not found.');
  }
  return value;
}
