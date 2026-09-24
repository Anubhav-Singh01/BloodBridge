import type { GeoPoint } from '../db/schema/geography.js';

// DATABASE.md section 9: donor_locations.location_coarse is "snapped to a fixed grid (about 1-2 km)
// at write time... not random noise applied on read, since repeated queries would defeat that."
//
// Batch 3.12 decision B: not naive decimal-degree rounding (a degree of longitude shrinks toward
// the poles, so a fixed decimal-degree grid is not a fixed *distance* grid). This snaps in local
// meters instead - the same distance grid at any latitude - and stores the result through the same
// geography(Point,4326)/EWKB encoding every other point in this schema already uses
// (src/db/schema/geography.ts); no PostGIS SQL function is invoked, consistent with how that file
// already does all point I/O in plain JS.

const CELL_METERS = 1500; // ~1.5 km: within DATABASE.md's "about 1-2 km".
const EARTH_RADIUS_METERS = 6378137; // WGS84 equatorial radius.
const METERS_PER_DEGREE_LAT = (Math.PI / 180) * EARTH_RADIUS_METERS;

/**
 * Snaps a point to the nearest lower corner of a fixed CELL_METERS x CELL_METERS grid, using a
 * local equirectangular approximation (accurate to well under the grid size itself at this scale).
 * Deterministic: the same input always snaps to the same cell, and a query for the same true
 * location always lands on the same coarse point, unlike per-read random noise.
 */
export function snapToCoarseGrid(point: GeoPoint): GeoPoint {
  const latRad = (point.lat * Math.PI) / 180;
  const metersPerDegreeLng = METERS_PER_DEGREE_LAT * Math.cos(latRad);

  const latMeters = point.lat * METERS_PER_DEGREE_LAT;
  const lngMeters = point.lng * metersPerDegreeLng;

  const snappedLatMeters = Math.floor(latMeters / CELL_METERS) * CELL_METERS;
  const snappedLngMeters = Math.floor(lngMeters / CELL_METERS) * CELL_METERS;

  return {
    lat: snappedLatMeters / METERS_PER_DEGREE_LAT,
    lng: snappedLngMeters / metersPerDegreeLng,
  };
}
