import dotenv from 'dotenv';
import { z } from 'zod';

// Loads backend/.env when present. Real .env files are git-ignored. Values are never logged.
dotenv.config({ quiet: true });

// Phase 2 reads only these four variables. The other variables listed in .env.example
// (DATABASE_URL, CLERK_*, GOOGLE_MAPS_API_KEY, ...) are reserved and are deliberately not parsed
// here, so no secret enters the typed config and nothing can connect to a service with it.
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(5000),
  FRONTEND_URL: z.url({ protocol: /^https?$/ }).default('http://localhost:5173'),
  BACKEND_URL: z.url({ protocol: /^https?$/ }).default('http://localhost:5000'),
});

export type Env = z.infer<typeof envSchema>;

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Fail fast at startup, before the server listens. Only variable names and validation
  // messages are printed, never the values, because a value may be a secret.
  const problems = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
  console.error(`Invalid environment configuration (values are never printed):\n - ${problems.join('\n - ')}`);
  process.exit(1);
}

export const env: Env = parsed.data;
