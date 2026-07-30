// D-24-3 — the Google place-identity invariant lives in exactly one place. Both
// mappers that surface a stop to a client (mapData.js formatMapStop, trips.js
// mapStop) call this same function; neither may inline or duplicate a clause.
// The frontend receives the pre-decided, nullable `googlePlaceId` and never
// re-derives the rule (review §4, Plan 24 D-24-3).
//
// Returning null here is a CORRECT outcome, not a coverage gap: an OSM or
// `user_pin` stop has no Google place identity, so it gets a coordinate-only
// Google link — the right output for that stop, and settled by the same
// 2026-07-26 place-naming ruling recorded in docs/DECISIONS.md. Do not treat a
// null return as something to backfill or "improve" with a Google lookup.
//
// Pure function over a raw snake_case `stops` DB row. No DB access, no I/O, and
// deliberately no camelCase fallback: both callers pass raw rows, so accepting
// a camelCase shape too would silently return null for a mis-shaped caller
// instead of surfacing the bug.
export function googlePlaceIdForStop(row) {
  if (!row) return null;

  // Clause 1 — positive allowlist on `provider_id`, not a denylist. The OSM
  // resolver emits an UNPREFIXED identifier (`way:<id>` / `node:<id>`, F11), so a
  // denylist keyed on an `osm:` prefix would miss every real OSM row and treat it
  // as Google. Discovery's trusted capture path also stamps a hard-coded
  // `coordinate_source: 'places'` on non-Google identities — `way:*`, `node:*`,
  // `curated:*` all pass through that label (F12) — so gating on
  // `coordinate_source` alone would send those non-Google IDs to Google too.
  // Only a literal `google:` prefix with a real ID after it counts.
  const providerId = row.provider_id;
  if (typeof providerId !== 'string' || !providerId.startsWith('google:')) return null;
  const bareId = providerId.slice('google:'.length);
  if (!bareId) return null;

  // Clause 2 — `location_status` must be 'resolved'. This is prevention, not
  // repair: an unresolved or merely estimated row's stored provider_id is not an
  // attested identity for the coordinates being linked to. Per the plan, zero
  // rows violate this today — the guard exists for the case that would otherwise
  // silently slip through, not because it is currently firing.
  if (row.location_status !== 'resolved') return null;

  // Clause 3 — `coordinate_source` must be 'places'. This is the provenance tag
  // stamped by the Google Places resolution path specifically.
  if (row.coordinate_source !== 'places') return null;

  // Clause 4 — `coordinate_system` must be 'wgs84'. Google Maps deep links always
  // expect WGS-84; a GCJ-02 (or otherwise non-WGS-84) stored datum paired with a
  // Google place ID would misplace the pin relative to the ID's real location.
  if (row.coordinate_system !== 'wgs84') return null;

  // Clause 5 — lat/lng must both be finite numbers. A place ID without usable
  // coordinates cannot be paired with a coordinate-based deep link at all.
  if (!Number.isFinite(row.lat) || !Number.isFinite(row.lng)) return null;

  return bareId;
}
