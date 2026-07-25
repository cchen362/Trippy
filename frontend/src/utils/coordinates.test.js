import { describe, expect, it } from 'vitest';
import { gcj02ToWgs84, wgs84ToGcj02, toDisplayCoordinates } from './coordinates.js';

// Plan 24 W3 (D-24-6 / F4) — this file is NEW; it did not exist before Wave 3.
// Review §10 "Frontend unit — coordinates helper" is the normative list.
describe('gcj02ToWgs84 / wgs84ToGcj02', () => {
  it('gcj02ToWgs84 round-trips through wgs84ToGcj02 within ~1e-6', () => {
    const originalLat = 29.560110;
    const originalLng = 106.573357;
    const gcj = wgs84ToGcj02(originalLat, originalLng);
    const backToWgs = gcj02ToWgs84(gcj.lat, gcj.lng);
    expect(backToWgs.lat).toBeCloseTo(originalLat, 6);
    expect(backToWgs.lng).toBeCloseTo(originalLng, 6);
  });

  // Backend-agreement anchor: real measured pair from the dev database
  // (People's Liberation Monument, Chongqing). Stored WGS-84 converts to
  // this exact GCJ-02 pair in production. Pins frontend/backend agreement
  // on real data (review §10).
  it('wgs84ToGcj02 agrees with the real measured backend conversion (Chongqing Liberation Monument)', () => {
    const result = wgs84ToGcj02(29.560110, 106.573357);
    expect(result.lat).toBeCloseTo(29.557226, 5);
    expect(result.lng).toBeCloseTo(106.577047, 5);
  });

  it('coordinates outside the China bbox pass through unchanged in both directions', () => {
    const lat = 40.7128; // New York, well outside the China bbox (lng is negative)
    const lng = -74.0060;
    expect(wgs84ToGcj02(lat, lng)).toEqual({ lat, lng });
    expect(gcj02ToWgs84(lat, lng)).toEqual({ lat, lng });
  });
});

describe('toDisplayCoordinates', () => {
  // CRITICAL guard called out in the file's own header comment: a stop
  // already stored as gcj02 must not be converted again when the target is
  // also gcj02 — converting twice would double-shift the pin.
  it('a gcj02-stored stop under a gcj02 target is NOT double-converted', () => {
    const stop = { lat: 29.557226, lng: 106.577047, coordinateSystem: 'gcj02' };
    const result = toDisplayCoordinates(stop, { coordinateSystem: 'gcj02' });
    expect(result).toEqual({ lat: stop.lat, lng: stop.lng });
  });

  it('a wgs84-stored stop under a wgs84 target is untouched', () => {
    const stop = { lat: 29.560110, lng: 106.573357, coordinateSystem: 'wgs84' };
    const result = toDisplayCoordinates(stop, { coordinateSystem: 'wgs84' });
    expect(result).toEqual({ lat: stop.lat, lng: stop.lng });
  });

  // Deliberate: Plan 24 G6 (Today linking unknown-datum coordinates that Maps
  // refuses to render) is explicitly out of scope. The frontend twin has no
  // equivalent to the backend's unknown-datum nulling — an 'unknown'-system
  // stop passes through unconverted for both wgs84 and gcj02 targets. Do NOT
  // "fix" this without reopening G6 as its own decision.
  it('an unknown-datum stop passes through unconverted for both wgs84 and gcj02 targets (deliberate, G6 out of scope)', () => {
    const stop = { lat: 10, lng: 20, coordinateSystem: 'unknown' };
    expect(toDisplayCoordinates(stop, { coordinateSystem: 'wgs84' })).toEqual({ lat: 10, lng: 20 });
    expect(toDisplayCoordinates(stop, { coordinateSystem: 'gcj02' })).toEqual({ lat: 10, lng: 20 });
  });
});
