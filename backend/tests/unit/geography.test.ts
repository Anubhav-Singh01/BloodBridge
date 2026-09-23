import { describe, expect, it } from 'vitest';
import { pointFromEwkbHex, pointToEwkbHex } from '../../src/db/schema/geography.js';

// POINT(1 2) with SRID 4326, as PostGIS prints it: ST_AsEWKB(ST_SetSRID(ST_MakePoint(1, 2), 4326)).
const KNOWN_HEX = '0101000020E6100000000000000000F03F0000000000000040';

describe('geography point encoding', () => {
  it('encodes to the known PostGIS EWKB value', () => {
    expect(pointToEwkbHex({ lng: 1, lat: 2 })).toBe(KNOWN_HEX);
  });

  it('decodes the known PostGIS EWKB value', () => {
    expect(pointFromEwkbHex(KNOWN_HEX)).toEqual({ lng: 1, lat: 2 });
  });

  it('round-trips real coordinates exactly (longitude first)', () => {
    const point = { lng: 80.9462, lat: 26.8467 };
    expect(pointFromEwkbHex(pointToEwkbHex(point))).toEqual(point);
  });

  it('accepts lower-case hex from a driver', () => {
    expect(pointFromEwkbHex(KNOWN_HEX.toLowerCase())).toEqual({ lng: 1, lat: 2 });
  });

  it('rejects out-of-range or non-finite coordinates', () => {
    for (const bad of [{ lng: 181, lat: 0 }, { lng: -181, lat: 0 }, { lng: 0, lat: 91 }, { lng: 0, lat: -91 }, { lng: Number.NaN, lat: 0 }, { lng: 0, lat: Number.POSITIVE_INFINITY }]) {
      expect(() => pointToEwkbHex(bad)).toThrow(RangeError);
    }
  });

  it('rejects values that are not a little-endian point with SRID 4326', () => {
    expect(() => pointFromEwkbHex('')).toThrow();
    expect(() => pointFromEwkbHex(KNOWN_HEX.slice(0, -2))).toThrow();
    expect(() => pointFromEwkbHex(KNOWN_HEX.replace('E6100000', 'E7100000'))).toThrow(); // another SRID
    expect(() => pointFromEwkbHex('00' + KNOWN_HEX.slice(2))).toThrow(); // big-endian marker
  });
});
