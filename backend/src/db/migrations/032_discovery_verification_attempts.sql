-- Plan 26 W3.1: per-attempt verification telemetry.
--
-- Additive only — one new table, no changes to any existing table.
--
-- Before this migration, two verification outcomes existed only as console
-- log lines and were lost the moment they scrolled off: the empty-country
-- destination case (discoveryVerify.js:149, "cannot country-check, recording
-- not trusting") and the W2.3 Google escalation result (placeResolver.js:743,
-- whether escalating past a weak Nominatim hit won). This table gives both a
-- durable row instead of a grep target, and generalizes to every provider
-- interaction the resolver makes during verification (Nominatim issues one
-- HTTP request per query variant tried — see resolverQueryTexts — so one
-- lookup can produce several attempt rows).
--
-- One row is written per provider interaction; outcome/reason describe the
-- verification decision for the WHOLE lookup the attempt belongs to, so they
-- repeat identically across every attempt row of that lookup. That
-- redundancy is deliberate: it makes a single row self-describing when W3.4
-- groups by reason without having to join back to a parent lookup record
-- that doesn't otherwise exist.
--
-- reason is a fixed vocabulary (enforced in application code, not a CHECK
-- constraint, to match this codebase's existing convention for enum-shaped
-- text columns elsewhere in the schema):
--   ok                        - confident hit, place marked verified
--   no_result                 - provider returned nothing / locationStatus 'unresolved'
--   weak_match                - resolved but not a strong ('resolved') hit
--   country_mismatch          - resolved country did not match destination country
--   empty_destination_country - destination has no country to check against (W2.2)
--   resolver_error            - resolvePlace threw
--   budget_exhausted          - daily resolver-request budget ran out before the provider was called
CREATE TABLE IF NOT EXISTS discovery_verification_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  place_id INTEGER NOT NULL REFERENCES discovery_places(id) ON DELETE CASCADE,
  destination_id INTEGER NOT NULL REFERENCES discovery_destinations(id) ON DELETE CASCADE,
  attempted_at TEXT NOT NULL,
  source_field TEXT NOT NULL,          -- 'name' | 'local_name': which catalogue field seeded this lookup
  provider TEXT,
  query_variant TEXT,
  escalated INTEGER NOT NULL DEFAULT 0,
  network_requests INTEGER NOT NULL DEFAULT 0,
  location_status TEXT,
  match_score REAL,
  returned_name TEXT,
  returned_country TEXT,
  error TEXT,
  outcome TEXT NOT NULL,               -- 'verified' | 'unverified'
  reason TEXT NOT NULL,
  reverification INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_discovery_verification_attempts_place
  ON discovery_verification_attempts(place_id, id);

CREATE INDEX IF NOT EXISTS idx_discovery_verification_attempts_destination
  ON discovery_verification_attempts(destination_id, attempted_at);
