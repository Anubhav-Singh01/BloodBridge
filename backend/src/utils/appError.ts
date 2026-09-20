// An error the client is allowed to see. Throw it (or pass it to next()) when a request fails for
// a known reason, for example: throw new AppError(404, 'NOT_FOUND', 'Blood request not found.')
//
// `code` and `message` are sent to the client as-is, so never put secrets, SQL, file paths or other
// internal detail in them. `details` is optional and only for safe field-level information
// (for example validation problems), as described in API.md 1.1.
//
// Any other error (a bug, a failed database call, ...) is NOT an AppError and is turned into a
// generic 500 by middlewares/errorHandler.ts, with the real cause written to the server log only.
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
