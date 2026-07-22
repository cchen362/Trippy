// @vitest-environment jsdom
import { describe, expect, it, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import TripRouteCover, { hasLocatedGeo } from './TripRouteCover.jsx';

afterEach(() => {
  cleanup();
});

const unlocated = [
  { name: 'Taipei', countryCode: 'TW', lat: null, lng: null, coordinateSystem: null },
  { name: 'Kaohsiung', countryCode: 'TW', lat: null, lng: null, coordinateSystem: null },
];

const oneLocated = [
  { name: 'Taipei', countryCode: 'TW', lat: 25.0330, lng: 121.5654, coordinateSystem: 'wgs84' },
  { name: 'Kaohsiung', countryCode: 'TW', lat: null, lng: null, coordinateSystem: null },
];

const twoSameCountry = [
  { name: 'Taipei', countryCode: 'TW', lat: 25.0330, lng: 121.5654, coordinateSystem: 'wgs84' },
  { name: 'Kaohsiung', countryCode: 'TW', lat: 22.6273, lng: 120.3014, coordinateSystem: 'wgs84' },
];

const twoDifferentCountry = [
  { name: 'Taipei', countryCode: 'TW', lat: 25.0330, lng: 121.5654, coordinateSystem: 'wgs84' },
  { name: 'Okinawa', countryCode: 'JP', lat: 26.2124, lng: 127.6809, coordinateSystem: 'wgs84' },
];

const threeMixedLocated = [
  { name: 'Taipei', countryCode: 'TW', lat: 25.0330, lng: 121.5654, coordinateSystem: 'wgs84' },
  { name: 'Somewhere Unresolved', countryCode: null, lat: null, lng: null, coordinateSystem: null },
  { name: 'Kaohsiung', countryCode: 'TW', lat: 22.6273, lng: 120.3014, coordinateSystem: 'wgs84' },
];

describe('TripRouteCover', () => {
  it('renders nothing (no svg) when there are zero located nodes — TripCard owns the typographic fallback', () => {
    const { container } = render(<TripRouteCover destinationsGeo={unlocated} status="upcoming" />);
    expect(container.querySelector('svg')).toBeNull();
    expect(container).toBeEmptyDOMElement();
  });

  it('hasLocatedGeo predicts whether a route/single-node will render', () => {
    expect(hasLocatedGeo(unlocated)).toBe(false);
    expect(hasLocatedGeo([])).toBe(false);
    expect(hasLocatedGeo(undefined)).toBe(false);
    expect(hasLocatedGeo(oneLocated)).toBe(true);
    expect(hasLocatedGeo(twoSameCountry)).toBe(true);
  });

  it('renders an svg with a single node label and no route path for one located node', () => {
    const { container } = render(<TripRouteCover destinationsGeo={oneLocated} status="upcoming" />);
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
    const texts = svg.querySelectorAll('text');
    expect(texts.length).toBe(1);
    expect(texts[0].textContent).toBe('TAIPEI');
    expect(svg.querySelectorAll('path[stroke]').length).toBe(0);
  });

  it('draws a solid segment for two located nodes in the same country', () => {
    const { container } = render(<TripRouteCover destinationsGeo={twoSameCountry} status="upcoming" />);
    const svg = container.querySelector('svg');
    const routePaths = Array.from(svg.querySelectorAll('path')).filter((p) => p.getAttribute('stroke') === '#c9a84c');
    expect(routePaths.length).toBe(1);
    expect(routePaths[0].getAttribute('stroke-dasharray')).toBe('none');
  });

  it('draws a dashed segment for two located nodes in different countries', () => {
    const { container } = render(<TripRouteCover destinationsGeo={twoDifferentCountry} status="upcoming" />);
    const svg = container.querySelector('svg');
    const routePaths = Array.from(svg.querySelectorAll('path')).filter((p) => p.getAttribute('stroke') === '#c9a84c');
    expect(routePaths.length).toBe(1);
    expect(routePaths[0].getAttribute('stroke-dasharray')).toBe('2 6');
  });

  it('never renders gold when muted (status=past); uses muted cream instead', () => {
    const { container } = render(<TripRouteCover destinationsGeo={twoSameCountry} status="past" />);
    const svg = container.querySelector('svg');
    expect(svg.innerHTML).not.toContain('#c9a84c');
    const routePaths = Array.from(svg.querySelectorAll('path')).filter((p) => p.getAttribute('stroke') === 'rgba(240,234,216,0.34)');
    expect(routePaths.length).toBe(1);
  });

  it('excludes null lat/lng nodes from projection — 3 destinations, 2 located, renders a 2-node route', () => {
    const { container } = render(<TripRouteCover destinationsGeo={threeMixedLocated} status="upcoming" />);
    const svg = container.querySelector('svg');
    const texts = svg.querySelectorAll('text');
    expect(texts.length).toBe(2);
    const names = Array.from(texts).map((t) => t.textContent);
    expect(names).toEqual(['TAIPEI', 'KAOHSIUNG']);
    const routePaths = Array.from(svg.querySelectorAll('path')).filter((p) => p.getAttribute('stroke') === '#c9a84c');
    expect(routePaths.length).toBe(1);
  });
});
