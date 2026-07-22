import { useId } from 'react';
import { wgs84ToGcj02 } from '../../utils/coordinates.js';

const VW = 600;
const VH = 300;
// Route region — a top-right hero band inside the 600x300 viewBox. It is deliberately
// confined to the UPPER portion (Y1=146 of 300) so a data-driven route never dips into
// the bottom-anchored title/date in TripCard's copy layer. The card is drawn with
// preserveAspectRatio=slice into a 264px (desktop) / 236px (mobile) tall card with no
// vertical crop, so viewBox-y 146 maps to ~128px (desktop) / ~115px (mobile) — clear of
// the title band that begins ~160px down. The right/wide extent keeps E-W trips legible;
// the overlay's dark-left wedge keeps the copy legible over the route.
const REGION_X0 = 250;
const REGION_X1 = 500;
const REGION_Y0 = 36;
const REGION_Y1 = 146;
const REGION_PAD = 0.08; // fractional padding applied inside the region on the long axis
// Labels always point INWARD (toward the region centre) so they never run off the
// card's right edge on the narrow mobile viewport, where preserveAspectRatio=slice
// crops the viewBox to roughly x[96..503]. A node right of centre anchors its label
// to the left; a node left of centre anchors right.
const ANCHOR_FLIP_X = (REGION_X0 + REGION_X1) / 2;

function isLocated(node) {
  return Number.isFinite(node?.lat) && Number.isFinite(node?.lng);
}

// Whether this trip has any renderable route geometry (≥1 located node). TripCard
// uses this to decide the typographic fallback in its copy layer — the fallback's
// gold cue must sit ABOVE the legibility overlay, which only the copy layer can.
export function hasLocatedGeo(destinationsGeo) {
  return (destinationsGeo || []).some(isLocated);
}

function sameCountry(a, b) {
  const ca = (a || '').toUpperCase() || null;
  const cb = (b || '').toUpperCase() || null;
  return ca === cb;
}

// Collapse consecutive/duplicate located nodes that share the exact same lat/lng —
// keeps a route from drawing a zero-length segment onto itself.
function dedupeLocated(nodes) {
  const out = [];
  for (const node of nodes) {
    const prev = out[out.length - 1];
    if (prev && prev.lat === node.lat && prev.lng === node.lng) continue;
    out.push(node);
  }
  return out;
}

// Invariant 6: never silently mix coordinate frames. GCJ-02 (mainland-China provider
// output) and WGS-84 (everywhere else) disagree by up to a few hundred meters, which
// reads as a visibly wrong bearing at this schematic scale once a trip crosses the
// China border (e.g. Shanghai + Okinawa). We only have the forward wgs84->gcj02
// transform (no inverse), so if ANY node in the trip is already gcj02, we push every
// wgs84/null/unknown node through wgs84ToGcj02 so the whole set shares one frame.
// wgs84ToGcj02 no-ops outside mainland China, so non-China nodes are unaffected either way.
function unifyCoordinateFrame(nodes) {
  const hasGcj02 = nodes.some((n) => n.coordinateSystem === 'gcj02');
  if (!hasGcj02) return nodes;
  return nodes.map((n) => {
    if (n.coordinateSystem === 'gcj02') return n;
    const converted = wgs84ToGcj02(n.lat, n.lng);
    return { ...n, lat: converted.lat, lng: converted.lng };
  });
}

// Fit the trip's own lng/lat bounding box into the route region with a single uniform
// scale (so real bearings/shape are preserved) rather than stretching each axis
// independently. A tight cluster (small span) gets scaled UP to fill the region, so a
// 3-city cluster like Shanghai/Suzhou/Hangzhou still reads as spread out, not cramped.
function buildProjector(nodes) {
  const lats = nodes.map((n) => n.lat);
  const lngs = nodes.map((n) => n.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);

  const regionW = (REGION_X1 - REGION_X0) * (1 - REGION_PAD);
  const regionH = (REGION_Y1 - REGION_Y0) * (1 - REGION_PAD);
  const regionCx = (REGION_X0 + REGION_X1) / 2;
  const regionCy = (REGION_Y0 + REGION_Y1) / 2;

  const lngSpan = maxLng - minLng;
  const latSpan = maxLat - minLat;
  const EPS = 1e-6;

  let scale;
  if (lngSpan < EPS && latSpan < EPS) {
    scale = 0; // degenerate — caller treats this as a single-node case
  } else if (lngSpan < EPS) {
    scale = regionH / latSpan;
  } else if (latSpan < EPS) {
    scale = regionW / lngSpan;
  } else {
    scale = Math.min(regionW / lngSpan, regionH / latSpan);
  }

  const midLng = (minLng + maxLng) / 2;
  const midLat = (minLat + maxLat) / 2;

  return (lat, lng) => {
    const x = lngSpan < EPS ? regionCx : regionCx + (lng - midLng) * scale;
    const y = latSpan < EPS ? regionCy : regionCy - (lat - midLat) * scale;
    return [x, y];
  };
}

function buildGraticule() {
  const paths = [];
  for (let i = 0; i < 5; i++) {
    const bx = 150 + i * 105;
    paths.push(`M ${bx} -20 Q ${bx + 34} ${VH / 2} ${bx} ${VH + 20}`);
  }
  for (let j = 0; j < 3; j++) {
    const by = 70 + j * 85;
    paths.push(`M 120 ${by} Q ${VW / 2} ${by - 26} ${VW + 20} ${by}`);
  }
  return paths;
}

function groundPath(a, b) {
  const cxp = (a[0] + b[0]) / 2 + (b[1] - a[1]) * 0.12;
  const cyp = (a[1] + b[1]) / 2 - (b[0] - a[0]) * 0.12;
  return `M ${a[0]} ${a[1]} Q ${cxp} ${cyp} ${b[0]} ${b[1]}`;
}

function airPath(a, b) {
  const mx = (a[0] + b[0]) / 2;
  const my = (a[1] + b[1]) / 2 - 62;
  return `M ${a[0]} ${a[1]} Q ${mx} ${my} ${b[0]} ${b[1]}`;
}

const LABEL_MIN_GAP = 16; // ~1.45x the 11px label, enough to keep a dense cluster legible
const LABEL_OFFSET = 13; // node → label gap
const LABEL_CHAR_W = 6.6; // DM Mono advance at font-size 11 (monospace, so exact enough)

function labelAnchor(x) {
  return x > ANCHOR_FLIP_X ? 'end' : 'start';
}

// Estimated horizontal extent [xMin, xMax] of a node's label, accounting for anchor side.
function labelExtent(p) {
  const w = (p.name || '').length * LABEL_CHAR_W;
  if (labelAnchor(p.x) === 'end') {
    const right = p.x - LABEL_OFFSET;
    return [right - w, right];
  }
  const left = p.x + LABEL_OFFSET;
  return [left, left + w];
}

// GLOBAL label de-collision — not per-side. Inward-pointing labels on close nodes
// (e.g. a Shanghai/Suzhou cluster at the same latitude) can point toward each other
// and overlap across anchor sides, which a per-side pass never catches. Sort by y and
// push any label down whose x-range overlaps an already-placed label within one
// line-height, regardless of which side each is anchored.
function layoutLabels(points) {
  const meta = points.map((p, idx) => ({ idx, y: p.y + 3.5, ext: labelExtent(p) }));
  const order = meta.slice().sort((a, b) => a.y - b.y);
  const placed = [];
  for (const m of order) {
    for (const q of placed) {
      const overlapsX = m.ext[0] < q.ext[1] && q.ext[0] < m.ext[1];
      if (overlapsX && m.y - q.y < LABEL_MIN_GAP) {
        m.y = q.y + LABEL_MIN_GAP;
      }
    }
    placed.push(m);
  }
  const labelY = new Array(points.length);
  meta.forEach((m) => { labelY[m.idx] = m.y; });
  return labelY;
}

export default function TripRouteCover({ destinationsGeo = [], status = 'upcoming' }) {
  const reactId = useId();
  const muted = status === 'past';
  const active = status === 'active';

  const located = dedupeLocated(unifyCoordinateFrame((destinationsGeo || []).filter(isLocated)));

  // 0 located nodes → no SVG cover at all. The designed typographic state (gold
  // hairline above the title) is rendered by TripCard in its copy layer, ABOVE the
  // legibility overlay — a cue placed here would be painted over and read as blank.
  if (located.length === 0) {
    return null;
  }

  const accent = muted ? 'rgba(240,234,216,0.34)' : '#c9a84c';
  const accentSoft = muted ? 'rgba(240,234,216,0.14)' : 'rgba(201,168,76,0.3)';
  const glowStart = muted ? 'rgba(240,234,216,0.05)' : 'rgba(201,168,76,0.14)';
  const routeAlpha = active ? 1 : (muted ? 0.6 : 0.82);
  const strokeWidth = active ? 1.7 : 1.4;
  const glowId = `route-glow-${reactId.replace(/[:]/g, '')}`;
  const graticulePaths = buildGraticule();

  if (located.length === 1) {
    const only = located[0];
    const x = (REGION_X0 + REGION_X1) / 2;
    const y = (REGION_Y0 + REGION_Y1) / 2;
    const anchor = labelAnchor(x);
    const lx = anchor === 'end' ? x - LABEL_OFFSET : x + LABEL_OFFSET;
    return (
      <svg className="absolute inset-0 w-full h-full" viewBox={`0 0 ${VW} ${VH}`} preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        <defs>
          <radialGradient id={glowId} cx="0.5" cy="0.5" r="0.5">
            <stop offset="0%" stopColor={glowStart} />
            <stop offset="100%" stopColor="rgba(201,168,76,0)" />
          </radialGradient>
        </defs>
        <g stroke="rgba(240,234,216,0.05)" strokeWidth="1" fill="none">
          {graticulePaths.map((d, i) => <path key={i} d={d} />)}
        </g>
        <ellipse cx={x} cy={y} rx={150} ry={120} fill={`url(#${glowId})`} />
        <circle cx={x} cy={y} r={8} fill="none" stroke={accentSoft} strokeWidth="1" />
        <circle cx={x} cy={y} r={3.4} fill={accent} fillOpacity={routeAlpha} />
        <text
          x={lx}
          y={y + 3.5}
          textAnchor={anchor}
          fill={muted ? 'rgba(240,234,216,0.34)' : 'rgba(240,234,216,0.62)'}
          fontFamily="'DM Mono', monospace"
          fontSize="11"
          letterSpacing="1.4"
        >
          {(only.name || '').toUpperCase()}
        </text>
      </svg>
    );
  }

  const project = buildProjector(located);
  const points = located.map((n) => {
    const [x, y] = project(n.lat, n.lng);
    return { x, y, name: n.name, countryCode: n.countryCode };
  });

  const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const cy = points.reduce((s, p) => s + p.y, 0) / points.length;

  const segments = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const isAir = !sameCountry(a.countryCode, b.countryCode);
    segments.push({
      key: `${i}`,
      d: isAir ? airPath([a.x, a.y], [b.x, b.y]) : groundPath([a.x, a.y], [b.x, b.y]),
      isAir,
    });
  }

  const labelY = layoutLabels(points);

  return (
    <svg className="absolute inset-0 w-full h-full" viewBox={`0 0 ${VW} ${VH}`} preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <radialGradient id={glowId} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0%" stopColor={glowStart} />
          <stop offset="100%" stopColor="rgba(201,168,76,0)" />
        </radialGradient>
      </defs>
      <g stroke="rgba(240,234,216,0.05)" strokeWidth="1" fill="none">
        {graticulePaths.map((d, i) => <path key={i} d={d} />)}
      </g>
      <ellipse cx={cx} cy={cy} rx={150} ry={120} fill={`url(#${glowId})`} />
      {segments.map((seg) => (
        <path
          key={seg.key}
          d={seg.d}
          fill="none"
          stroke={accent}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeOpacity={routeAlpha}
          strokeDasharray={seg.isAir ? '2 6' : 'none'}
        />
      ))}
      {points.map((p, idx) => {
        const primary = idx === 0;
        const anchor = labelAnchor(p.x);
        const lx = anchor === 'end' ? p.x - LABEL_OFFSET : p.x + LABEL_OFFSET;
        return (
          <g key={idx}>
            <circle cx={p.x} cy={p.y} r={primary ? 8 : 6.5} fill="none" stroke={accentSoft} strokeWidth="1" />
            <circle cx={p.x} cy={p.y} r={primary ? 3.4 : 2.6} fill={accent} fillOpacity={routeAlpha} />
            <text
              x={lx}
              y={labelY[idx]}
              textAnchor={anchor}
              fill={muted ? 'rgba(240,234,216,0.34)' : 'rgba(240,234,216,0.62)'}
              fontFamily="'DM Mono', monospace"
              fontSize="11"
              letterSpacing="1.4"
            >
              {(p.name || '').toUpperCase()}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
