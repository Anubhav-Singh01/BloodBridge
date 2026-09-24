import { eq } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { donorLocations } from '../db/schema/index.js';
import type { GeoPoint } from '../db/schema/geography.js';

/**
 * Upserts the one donor_locations row. Both points are plain GeoPoint values - the geographyPoint
 * custom type (src/db/schema/geography.ts) encodes them to EWKB itself; no raw SQL is written here.
 * Called only with an already-snapped coarse point (utils/geo.ts) - never the exact point twice.
 */
export async function upsert(donorId: string, exact: GeoPoint, coarse: GeoPoint): Promise<void> {
  await db
    .insert(donorLocations)
    .values({ donorId, locationExact: exact, locationCoarse: coarse })
    .onConflictDoUpdate({ target: donorLocations.donorId, set: { locationExact: exact, locationCoarse: coarse, updatedAt: new Date() } });
}

/** Exact location. Only ever called server-side (Batch 3.12: never echoed in any API response). */
export async function findExactByDonorId(donorId: string): Promise<GeoPoint | undefined> {
  const [row] = await db.select({ locationExact: donorLocations.locationExact }).from(donorLocations).where(eq(donorLocations.donorId, donorId)).limit(1);
  return row?.locationExact;
}
