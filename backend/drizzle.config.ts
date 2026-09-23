import { defineConfig } from 'drizzle-kit';

// Used only by `npm run db:generate` (scripts/db-generate.ts, which runs `drizzle-kit generate` and then fixes the
// geography type drizzle-kit quotes) and `npm run db:check`. Both work offline from the schema files.
// There are deliberately no dbCredentials: migrations are applied by our own guarded runner (Batch 3.5),
// never by `drizzle-kit push` (DATABASE.md section 11).
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  // Ignore the tables PostGIS creates itself (spatial_ref_sys, ...) if the schema is ever introspected.
  extensionsFilters: ['postgis'],
});
