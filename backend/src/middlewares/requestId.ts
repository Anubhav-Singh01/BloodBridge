import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

// API.md 1.2: reuse a client-supplied X-Request-ID only if it is a short, safe token,
// otherwise generate one. The id is for log correlation only and is never trusted for anything else.
// It is sent back in the X-Request-ID header and in every error response, and it is written to
// every log line for the request, so one id lets you trace a failed request end to end.
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const supplied = req.get('X-Request-ID');
  const id = supplied !== undefined && SAFE_REQUEST_ID.test(supplied) ? supplied : randomUUID();
  req.requestId = id;
  res.setHeader('X-Request-ID', id);
  next();
}
