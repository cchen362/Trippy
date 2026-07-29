// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import TripMap, { applyCoincidentOffsets } from './TripMap.jsx';

// Trivial linear projection: exact round-trip, easy-to-verify pixel math.
// 1 degree === 100000 px; y is flipped (screen-space y grows downward, lat grows "up").
const SCALE = 100000;
const project = ({ lat, lng }) => ({ x: lng * SCALE, y: -lat * SCALE });
const unproject = ({ x, y }) => ({ lat: -y / SCALE, lng: x / SCALE });

function pixelDistance(a, b) {
  const pa = project({ lat: a.displayLat, lng: a.displayLng });
  const pb = project({ lat: b.displayLat, lng: b.displayLng });
  return Math.hypot(pa.x - pb.x, pa.y - pb.y);
}

const OSM_CONFIG = {
  tileProvider: 'osm',
  tileUrl: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  tileSubdomains: ['a', 'b', 'c'],
  tileAttribution: '© OpenStreetMap contributors',
  coordinateSystem: 'wgs84',
  deepLinkProvider: 'google',
};

const AMAP_CONFIG = {
  tileProvider: 'amap',
  tileUrl: 'https://wprd0{s}.is.autonavi.com/appmaptile?x={x}&y={y}&z={z}&lang=zh_cn&size=1&scl=1&style=7',
  tileSubdomains: ['1', '2', '3', '4'],
  tileAttribution: '© AutoNavi',
  coordinateSystem: 'gcj02',
  deepLinkProvider: 'amap',
};

describe('TripMap tile provider remount', () => {
  // react-leaflet's TileLayer reactively re-applies `url` (via layer.setUrl) on prop
  // changes, but @react-leaflet/core's updateGridLayer only ever touches `opacity` and
  // `zIndex` — `subdomains` is read once at construction and never re-applied. Leaflet's
  // GridLayer picks a subdomain letter/number from that stale array when building each
  // tile URL, so switching from OSM (subdomains ['a','b','c']) to AMap (subdomains
  // ['1','2','3','4']) without a remount produces a broken tile URL like
  // "wprd0b.is.autonavi.com" (OSM's 'b' spliced into AMap's numeric-subdomain template).
  // Keying TileLayer on `mapConfig.tileProvider` forces React to unmount the old Leaflet
  // layer and construct a fresh one with the new provider's subdomains.
  it('uses the new provider subdomains (not stale ones) when mapConfig switches provider across a day-switch', async () => {
    const { container, rerender } = render(<TripMap stops={[]} mapConfig={OSM_CONFIG} />);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const osmTileSrc = container.querySelector('.leaflet-tile-pane img')?.src;
    expect(osmTileSrc).toMatch(/^https:\/\/[abc]\.tile\.openstreetmap\.org\//);

    rerender(<TripMap stops={[]} mapConfig={AMAP_CONFIG} />);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const amapTileSrc = container.querySelector('.leaflet-tile-pane img')?.src;
    // A correct AMap subdomain is a single digit 1-4 right after "wprd0". A stale OSM
    // subdomain (a/b/c) leaking through would fail this pattern.
    expect(amapTileSrc).toMatch(/^https:\/\/wprd0[1-4]\.is\.autonavi\.com\//);
  });
});

describe('applyCoincidentOffsets', () => {
  // Plan 27 W3: two stops resolved to the same coordinate stack in DOM order and only the top
  // one is hit-testable — its popup, "Open in maps" link, and "Move pin" button become
  // unreachable from the map. These tests exercise the pure geometry in isolation with a
  // trivial linear projection so the pixel math is exact and doesn't depend on Leaflet.
  const stopA = { id: 'a', displayLat: 30.6574, displayLng: 104.0803, canRenderMarker: true };
  const stopB = { id: 'b', displayLat: 30.6574, displayLng: 104.0803, canRenderMarker: true };
  const stopC = { id: 'c', displayLat: 30.6574, displayLng: 104.0803, canRenderMarker: true };
  const stopD = { id: 'd', displayLat: 30.6710, displayLng: 104.0430, canRenderMarker: true };

  it('returns a lone stop as the identical object reference (common path stays byte-identical)', () => {
    const result = applyCoincidentOffsets([stopA, stopD], project, unproject);
    expect(result[0]).toBe(stopA);
    expect(result[1]).toBe(stopD);
  });

  it('returns the same array reference (no multi-member groups at all)', () => {
    const stops = [stopA, stopD];
    const result = applyCoincidentOffsets(stops, project, unproject);
    expect(result).toBe(stops);
  });

  it('fans two coincident stops 30px apart (2x the 15px radius) without mutating originals', () => {
    const originalA = { ...stopA };
    const originalB = { ...stopB };

    const [offsetA, offsetB] = applyCoincidentOffsets([stopA, stopB], project, unproject);

    expect(offsetA).not.toBe(stopA);
    expect(offsetB).not.toBe(stopB);
    // Member 0 sits straight up from center (angle -PI/2), so only its latitude moves;
    // member 1 sits straight down, so it moves in the same axis but the opposite way.
    // Together the pair must land at two distinct points, even though any single
    // coordinate component can coincidentally match the original for one member.
    expect(offsetA.displayLat).not.toBe(stopA.displayLat);
    expect(`${offsetA.displayLat}:${offsetA.displayLng}`).not.toBe(`${offsetB.displayLat}:${offsetB.displayLng}`);
    expect(`${offsetA.displayLat}:${offsetA.displayLng}`).not.toBe(`${stopA.displayLat}:${stopA.displayLng}`);

    expect(pixelDistance(offsetA, offsetB)).toBeCloseTo(30, 1);

    // originals untouched
    expect(stopA).toEqual(originalA);
    expect(stopB).toEqual(originalB);
  });

  it('preserves array length and order, cloning only the coincident members', () => {
    const stops = [stopD, stopA, stopB];
    const result = applyCoincidentOffsets(stops, project, unproject);

    expect(result).toHaveLength(3);
    expect(result[0]).toBe(stopD); // lone stop untouched, order preserved
    expect(result[1]).not.toBe(stopA);
    expect(result[1].id).toBe('a');
    expect(result[2]).not.toBe(stopB);
    expect(result[2].id).toBe('b');
  });

  it('fans a three-member group into three mutually distinct positions', () => {
    const [offsetA, offsetB, offsetC] = applyCoincidentOffsets([stopA, stopB, stopC], project, unproject);

    const positions = [offsetA, offsetB, offsetC].map((s) => `${s.displayLat}:${s.displayLng}`);
    expect(new Set(positions).size).toBe(3);

    // each pair should be equidistant from the true center at the 15px radius
    const center = { displayLat: stopA.displayLat, displayLng: stopA.displayLng };
    [offsetA, offsetB, offsetC].forEach((s) => {
      expect(pixelDistance(s, center)).toBeCloseTo(15, 1);
    });
  });
});

describe('TripMap coincident pin rendering', () => {
  // DOM-level proof that the fan-out actually reaches the marker layer: two stops sharing
  // a coordinate plus one well-separated stop should render three markers at three
  // distinct screen positions, not two stacked plus one apart.
  function stopMarkerIcons(container) {
    return Array.from(container.querySelectorAll('.leaflet-marker-icon'))
      .filter((el) => el.innerHTML.includes('viewBox="0 0 32 32"'));
  }

  it('renders three stop markers at three distinct positions when two stops are coincident', async () => {
    const stops = [
      {
        id: 'stop-1',
        title: 'Coincident One',
        routeNumber: 1,
        type: 'sight',
        canRenderMarker: true,
        displayLat: 30.6574,
        displayLng: 104.0803,
      },
      {
        id: 'stop-2',
        title: 'Coincident Two',
        routeNumber: 2,
        type: 'sight',
        canRenderMarker: true,
        displayLat: 30.6574,
        displayLng: 104.0803,
      },
      {
        id: 'stop-3',
        title: 'Separated',
        routeNumber: 3,
        type: 'sight',
        canRenderMarker: true,
        displayLat: 30.6710,
        displayLng: 104.0430,
      },
    ];

    const { container } = render(<TripMap stops={stops} mapConfig={OSM_CONFIG} />);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const icons = stopMarkerIcons(container);
    expect(icons).toHaveLength(3);

    // jsdom has no CSS-transform 3D support, so Leaflet positions markers with
    // plain left/top instead of translate3d — read those instead of style.transform.
    const positions = icons.map((el) => `${el.style.left}:${el.style.top}`);
    expect(new Set(positions).size).toBe(3);
  });
});
