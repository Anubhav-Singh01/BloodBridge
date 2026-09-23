import { pgView, uuid } from 'drizzle-orm/pg-core';
import { tstz } from './columns.js';
import { geographyPoint } from './geography.js';

// The coarse-only view that patient-facing and public repositories read (DATABASE.md section 9). It exposes no
// exact coordinates. The view itself is created by hand in 0006_schema_c_guards.sql; `.existing()` tells
// drizzle-kit not to generate it, so this declaration only gives repositories typed access.
export const donorLocationsCoarse = pgView('donor_locations_coarse', {
  donorId: uuid('donor_id').notNull(),
  locationCoarse: geographyPoint('location_coarse').notNull(),
  updatedAt: tstz('updated_at').notNull(),
}).existing();
