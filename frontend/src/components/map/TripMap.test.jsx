// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import TripMap from './TripMap.jsx';

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
