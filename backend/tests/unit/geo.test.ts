import { describe, expect, it } from 'vitest';
import { snapToCoarseGrid } from '../../src/utils/geo.js';

// Batch 3.12 decision B: a deterministic ~1.5km meters-based grid, not decimal-degree rounding.

function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6378137;
  const latRad = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const dLat = (b.lat - a.lat) * (Math.PI / 180) * R;
  const dLng = (b.lng - a.lng) * (Math.PI / 180) * R * Math.cos(latRad);
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

describe('snapToCoarseGrid', () => {
  it('is deterministic: the same input always snaps to the same cell', () => {
    const point = { lat: 12.9716, lng: 77.5946 };
    expect(snapToCoarseGrid(point)).toEqual(snapToCoarseGrid(point));
  });

  it('snaps to within the grid cell size of the true point (well under 2km)', () => {
    const point = { lat: 12.9716, lng: 77.5946 };
    const snapped = snapToCoarseGrid(point);
    expect(distanceMeters(point, snapped)).toBeLessThan(2200); // grid diagonal is ~sqrt(2)*1500m
  });

  it('two points inside the same ~1.5km cell snap to the same coarse point', () => {
    // ~50m apart in longitude only (same latitude, so the lng meters-per-degree scale factor - which
    // is itself latitude-dependent - stays identical between the two points) - well inside a single
    // 1.5km cell.
    const a = { lat: 12.9716, lng: 77.5946 };
    const b = { lat: 12.9716, lng: 77.5946 + 0.0005 };
    expect(snapToCoarseGrid(a)).toEqual(snapToCoarseGrid(b));
  });

  it('two points far apart (different cities) snap to different coarse points', () => {
    const bengaluru = { lat: 12.9716, lng: 77.5946 };
    const delhi = { lat: 28.6139, lng: 77.209 };
    expect(snapToCoarseGrid(bengaluru)).not.toEqual(snapToCoarseGrid(delhi));
  });

  it('is a fixed real-world distance grid, not naive decimal-degree rounding: the same longitude cell width in degrees is much wider at high latitude than near the equator', () => {
    // A naive fixed-decimal-degree grid would use the same degree step at every latitude. This grid
    // is defined in meters, so covering the same real distance in longitude takes far more degrees
    // at high latitude (where a degree of longitude is a much shorter real distance) than near the
    // equator. Two points 400m apart (well under one 1.5km cell, so both pairs land in the same
    // cell) require a ~5.8x larger degree offset at lat 80 than at lat 1 - exactly 1/cos(80)/1/cos(1).
    const metersPerDegreeLngAt = (lat: number) => (Math.PI / 180) * 6378137 * Math.cos((lat * Math.PI) / 180);
    const offsetMeters = 400;
    const eqDeltaDeg = offsetMeters / metersPerDegreeLngAt(1);
    const hiDeltaDeg = offsetMeters / metersPerDegreeLngAt(80);

    expect(snapToCoarseGrid({ lat: 1, lng: 100 })).toEqual(snapToCoarseGrid({ lat: 1, lng: 100 + eqDeltaDeg }));
    expect(snapToCoarseGrid({ lat: 80, lng: 100 })).toEqual(snapToCoarseGrid({ lat: 80, lng: 100 + hiDeltaDeg }));
    expect(hiDeltaDeg).toBeGreaterThan(eqDeltaDeg * 5);
  });

  it('snaps a point in the southern/western hemisphere consistently', () => {
    const point = { lat: -23.5505, lng: -46.6333 };
    const snapped = snapToCoarseGrid(point);
    expect(distanceMeters(point, snapped)).toBeLessThan(2200);
  });
});
