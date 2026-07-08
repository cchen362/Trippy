// Shared geography-identity helpers (Plan 8, Wave 1).
// canonicalGeoKey is the single source of truth for folding a free-text place
// label into a DB/cache-safe key. The frontend mirrors this algorithm verbatim
// (frontend/src/utils/geoIdentity.js) — any change here must be ported there too.
import { IATA_CITY, CITY_ALIASES } from './airports.js';

// Suffixes stripped at most once, from the whitespace-tokenized (unfolded) label,
// case-insensitive, longest match first — so "Ho Chi Minh City" only loses "City"
// once, and "Kaohsiung City" reduces to "Kaohsiung" for scope comparison.
const ADMIN_SUFFIXES = [
  'special municipality',
  'metropolitan city',
  'municipality',
  'prefecture',
  'city',
  'shi',
];

/**
 * Folds a free-text place label into a stable, punctuation-insensitive key.
 * Strips diacritics, lowercases, and removes everything that isn't a Unicode
 * letter or number — CJK and other scripts survive via \p{L}.
 * @param {string|null|undefined} label
 * @returns {string}
 */
export function canonicalGeoKey(label) {
  return String(label ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * Removes at most one trailing administrative suffix (e.g. "City", "Municipality")
 * from a label, operating on whitespace tokens before folding. Case-insensitive.
 * Never strips a suffix if doing so would leave an empty label.
 * @param {string} label
 * @returns {string}
 */
function stripAdminSuffix(label) {
  const trimmed = String(label ?? '').trim();
  if (!trimmed) return trimmed;
  const lower = trimmed.toLowerCase();
  for (const suffix of ADMIN_SUFFIXES) {
    if (lower === suffix) continue; // stripping would leave an empty label
    if (lower.endsWith(` ${suffix}`)) {
      const stripped = trimmed.slice(0, trimmed.length - suffix.length).trim();
      if (stripped) return stripped;
    }
  }
  return trimmed;
}

/**
 * True when two place labels refer to the same geography once each side is
 * folded (and, if needed, has a single trailing admin suffix like "City" or
 * "Municipality" removed independently). No substring/prefix matching —
 * "Bali" and "Balikpapan" are distinct.
 * @param {string|null|undefined} a
 * @param {string|null|undefined} b
 * @returns {boolean}
 */
export function scopesMatch(a, b) {
  const foldedA = canonicalGeoKey(a);
  const foldedB = canonicalGeoKey(b);
  const strippedFoldedA = canonicalGeoKey(stripAdminSuffix(a));
  const strippedFoldedB = canonicalGeoKey(stripAdminSuffix(b));

  return (
    foldedA === foldedB
    || strippedFoldedA === foldedB
    || foldedA === strippedFoldedB
    || strippedFoldedA === strippedFoldedB
  );
}

// Built once at module load from the known city vocabulary — IATA hub cities,
// alias target names (e.g. "Ho Chi Minh City"), and the alias labels themselves
// (e.g. "Saigon", "HCMC") since those are exactly the alternate names users type
// in free-text fields — each folded through canonicalGeoKey.
const KNOWN_CITY_KEYS = new Set([
  ...Object.values(IATA_CITY),
  ...Object.values(CITY_ALIASES),
  ...Object.keys(CITY_ALIASES),
].map(canonicalGeoKey));

/**
 * True when the label folds to a known city name (an IATA hub city or a
 * recognised alias). Used to distinguish city-level labels from broader or
 * more granular geography (regions, districts, etc.).
 * @param {string|null|undefined} label
 * @returns {boolean}
 */
export function knownCityLabel(label) {
  return KNOWN_CITY_KEYS.has(canonicalGeoKey(label));
}
