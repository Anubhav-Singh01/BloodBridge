type Level = 'info' | 'warn' | 'error';

// Minimal structured logger: one JSON line per event. No logging library is used in Phase 2.
// Logs stay on the server, so they may contain full error details, but never put secrets,
// request bodies or personal data in `fields` on purpose.
export function log(level: Level, message: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, time: new Date().toISOString(), message, ...fields });
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}

// Turns anything that was thrown into a loggable object, including the stack trace.
export function describeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return { value: String(err) };
}
