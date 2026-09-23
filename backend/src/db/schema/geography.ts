import { customType } from 'drizzle-orm/pg-core';

export interface GeoPoint {
  /** Longitude in degrees, -180 to 180. */
  lng: number;
  /** Latitude in degrees, -90 to 90. */
  lat: number;
}

const SRID_WGS84 = 4326;
// Little-endian EWKB point that carries an SRID: type POINT (1) with the SRID flag (0x20000000).
const POINT_WITH_SRID = 0x20000001;

function assertValid({ lng, lat }: GeoPoint): void {
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || lng < -180 || lng > 180 || lat < -90 || lat > 90) {
    // PostGIS wants longitude first. Swapped arguments are the classic mistake, so fail loudly.
    throw new RangeError('Invalid coordinates: longitude must be -180..180 and latitude -90..90.');
  }
}

/** Encodes a point as EWKB hex, which PostGIS accepts as a geography(Point,4326) value. */
export function pointToEwkbHex(point: GeoPoint): string {
  assertValid(point);
  const buffer = Buffer.alloc(25);
  buffer.writeUInt8(1, 0); // little endian
  buffer.writeUInt32LE(POINT_WITH_SRID, 1);
  buffer.writeUInt32LE(SRID_WGS84, 5);
  buffer.writeDoubleLE(point.lng, 9);
  buffer.writeDoubleLE(point.lat, 17);
  return buffer.toString('hex').toUpperCase();
}

/** Decodes the EWKB hex PostGIS returns for a geography(Point,4326) value. */
export function pointFromEwkbHex(hex: string): GeoPoint {
  const buffer = Buffer.from(hex, 'hex');
  if (
    buffer.length !== 25 ||
    buffer.readUInt8(0) !== 1 ||
    buffer.readUInt32LE(1) !== POINT_WITH_SRID ||
    buffer.readUInt32LE(5) !== SRID_WGS84
  ) {
    throw new Error('Unsupported geography value: expected a little-endian EWKB point with SRID 4326.');
  }
  return { lng: buffer.readDoubleLE(9), lat: buffer.readDoubleLE(17) };
}

// geography(Point,4326) column (DATABASE.md section 1). Read and written as EWKB hex, so no SQL functions are needed.
export const geographyPoint = customType<{ data: GeoPoint; driverData: string }>({
  dataType: () => 'geography(Point,4326)',
  toDriver: (value) => pointToEwkbHex(value),
  fromDriver: (value) => pointFromEwkbHex(value),
});
