import { createApp } from './app.js';
import { env } from './config/env.js';
import { log } from './utils/logger.js';

const app = createApp();

const server = app.listen(env.PORT, (error?: Error) => {
  // Express 5 also passes a startup error (for example EADDRINUSE) to this callback.
  // Startup errors are handled by the 'error' listener below, so only report success here.
  if (error) {
    return;
  }
  log('info', 'server listening', { port: env.PORT, nodeEnv: env.NODE_ENV });
});

server.on('error', (error: Error) => {
  log('error', 'failed to start server', {
    port: env.PORT,
    error: error.message,
  });
  process.exit(1);
});

function shutdown(signal: string): void {
  log('info', 'shutting down', { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
