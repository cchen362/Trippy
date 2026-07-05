import { getDb } from '../db/database.js';
import { config } from '../config.js';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const NOMINATIM_INTERVAL_MS = 1000;

// Providers whose cached coordinates are accurate enough to satisfy preferNominatim callers.
const ACCURATE_PROVIDERS = new Set(['nominatim', 'google_places']);

// Unresolved cache rows older than this are retried over the network instead of poisoning
// the lookup forever. Fresh unresolved rows still short-circuit to avoid hammering providers.
const NEGATIVE_CACHE_TTL_MS = 60 * 60 * 1000;

let nextNominatimRequestAt = 0;

// Curated place coordinates are OSM/WGS-84 reference values used as starting points only.
// They are labeled 'estimated' so repair runs can overwrite them with accurate Nominatim data.
const CURATED_PLACES = [
  {
    aliases: ['hongya cave', 'hongyadong', 'hongya cave chongqing', 'hongyadong chongqing'],
    city: 'chongqing',
    country: 'cn',
    name: 'Hongya Cave',
    address: 'Hongyadong, Yuzhong District, Chongqing, China',
    lat: 29.5605,
    lng: 106.5655,
    coordinateSystem: 'wgs84',
    providerId: 'curated:hongya-cave-chongqing',
    locationStatus: 'estimated',
    confidence: 0.72,
  },
  {
    aliases: ['luohan temple', 'arhat temple', 'luohan temple chongqing'],
    city: 'chongqing',
    country: 'cn',
    name: 'Luohan Temple',
    address: 'Luohan Temple, Yuzhong District, Chongqing, China',
    lat: 29.5557,
    lng: 106.5744,
    coordinateSystem: 'wgs84',
    providerId: 'curated:luohan-temple-chongqing',
    locationStatus: 'estimated',
    confidence: 0.72,
  },
  {
    aliases: [
      'jiefangbei',
      'jiefangbei pedestrian street',
      'jiefangbei chongqing',
      'people s liberation monument',
      "people's liberation monument",
      'liberation monument',
      'jiefangbei monument',
    ],
    city: 'chongqing',
    country: 'cn',
    name: 'Jiefangbei',
    address: 'Jiefangbei, Yuzhong District, Chongqing, China',
    lat: 29.5601096,
    lng: 106.5733569,
    coordinateSystem: 'wgs84',
    providerId: 'curated:jiefangbei-chongqing',
    locationStatus: 'estimated',
    confidence: 0.72,
  },
  {
    aliases: ['three gorges museum', 'chongqing three gorges museum', 'china three gorges museum'],
    city: 'chongqing',
    country: 'cn',
    name: 'Three Gorges Museum',
    address: 'Three Gorges Museum, 236 Renmin Road, Yuzhong District, Chongqing, China',
    lat: 29.5648943,
    lng: 106.5465582,
    coordinateSystem: 'wgs84',
    providerId: 'curated:three-gorges-museum-chongqing',
    locationStatus: 'estimated',
    confidence: 0.72,
  },
  {
    aliases: ['wulong karst landscape', 'wulong karst landscape day trip', 'wulong karst', 'wulong karst national geology park', 'three natural bridges'],
    city: 'chongqing',
    country: 'cn',
    name: 'Wulong Karst Landscape',
    address: 'Wulong Karst National Geology Park, Wulong District, Chongqing, China',
    lat: 29.4338639,
    lng: 107.8012806,
    coordinateSystem: 'wgs84',
    providerId: 'curated:wulong-karst-chongqing',
    locationStatus: 'estimated',
    confidence: 0.68,
  },
  {
    aliases: ['regent chongqing', 'regent hotel chongqing'],
    city: 'chongqing',
    country: 'cn',
    name: 'Regent Chongqing',
    address: 'Regent Chongqing, Jiangbei District, Chongqing, China',
    lat: 29.5578,
    lng: 106.5697,
    coordinateSystem: 'wgs84',
    providerId: 'curated:regent-chongqing',
    locationStatus: 'estimated',
    confidence: 0.72,
  },
  {
    aliases: ['raffles city chongqing', 'raffles city', 'chaotianmen raffles city'],
    city: 'chongqing',
    country: 'cn',
    name: 'Raffles City Chongqing',
    address: 'Raffles City Chongqing, Chaotianmen, Yuzhong District, Chongqing, China',
    lat: 29.5682,
    lng: 106.5876,
    coordinateSystem: 'wgs84',
    providerId: 'curated:raffles-city-chongqing',
    locationStatus: 'estimated',
    confidence: 0.72,
  },
  {
    aliases: ['chaotianmen dock', 'chaotianmen wharf', 'chaotianmen pier', 'chaotianmen dock chongqing'],
    city: 'chongqing',
    country: 'cn',
    name: 'Chaotianmen Dock',
    address: 'Chaotianmen Dock, Yuzhong District, Chongqing, China',
    lat: 29.5676,
    lng: 106.5870,
    coordinateSystem: 'wgs84',
    providerId: 'curated:chaotianmen-dock-chongqing',
    locationStatus: 'estimated',
    confidence: 0.72,
  },
];

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildPlaceQueryKey({ queryText, city, country }) {
  return [queryText, city, country].map(normalizeText).filter(Boolean).join('|');
}

function countryMatches(expected, actual) {
  if (!expected || !actual) return true;
  const normExpected = normalizeText(expected);
  const normActual = normalizeText(actual);
  if (normExpected === normActual) return true;
  return (normExpected === 'cn' && normActual === 'china') || (normExpected === 'china' && normActual === 'cn');
}

function placeNameMatches(expected, actual) {
  if (!expected || !actual) return true;
  const normExpected = normalizeText(expected);
  const normActual = normalizeText(actual);
  return normExpected === normActual || normExpected.replace(/\s+/g, '') === normActual.replace(/\s+/g, '');
}

function formatResolution({
  lat = null,
  lng = null,
  coordinateSystem = 'unknown',
  coordinateSource,
  locationStatus = 'unresolved',
  confidence = null,
  resolvedName = null,
  resolvedAddress = null,
  providerId = null,
  provider = null,
  countryCode = null,
}) {
  return {
    lat,
    lng,
    coordinateSystem,
    coordinateSource,
    locationStatus,
    confidence,
    resolvedName,
    resolvedAddress,
    providerId,
    provider,
    countryCode,
  };
}

// Strip cache-only bookkeeping fields (e.g. updatedAtMs) before returning to callers.
function stripInternalFields(resolution) {
  const { updatedAtMs, ...rest } = resolution;
  return rest;
}

function findCuratedPlace({ queryText, city, country }) {
  const query = normalizeText(queryText);
  const normalizedCity = normalizeText(city);

  return CURATED_PLACES.find((place) => (
    (!normalizedCity || placeNameMatches(place.city, city))
    && countryMatches(place.country, country)
    && place.aliases.some((alias) => normalizeText(alias) === query)
  ));
}

function uniqueValues(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = String(value || '').trim();
    const key = normalizeText(text);
    if (!text || !key || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

function normalizeAliasList(aliases = []) {
  if (!Array.isArray(aliases)) return [];
  return aliases
    .flatMap((alias) => Array.isArray(alias) ? alias : [alias])
    .map((alias) => String(alias || '').trim())
    .filter(Boolean);
}

function fromCurated(place) {
  return formatResolution({
    lat: place.lat,
    lng: place.lng,
    coordinateSystem: place.coordinateSystem,
    coordinateSource: 'curated',
    locationStatus: place.locationStatus,
    confidence: place.confidence,
    resolvedName: place.name,
    resolvedAddress: place.address,
    providerId: place.providerId,
    provider: 'curated',
    countryCode: place.country ? place.country.toUpperCase() : null,
  });
}

// SQLite datetime('now') writes 'YYYY-MM-DD HH:MM:SS' in UTC with no zone marker.
// Parse that as UTC; also accept values already stored in ISO form (with 'T'/'Z').
function cacheTimestampToEpochMs(value) {
  if (!value) return null;
  const text = String(value);
  const iso = /[TZ]/.test(text) ? text : `${text.replace(' ', 'T')}Z`;
  const epoch = Date.parse(iso);
  return Number.isFinite(epoch) ? epoch : null;
}

function cacheCoordinateSource(provider) {
  if (provider === 'nominatim') return 'manual_lookup';
  if (provider === 'google_places') return 'places';
  return 'cache';
}

function readCache(queryKey) {
  const row = getDb().prepare('SELECT * FROM place_resolution_cache WHERE query_key = ?').get(queryKey);
  if (!row) return null;
  const hasCoordinate = row.lat !== null && row.lng !== null;
  const resolution = formatResolution({
    lat: row.lat,
    lng: row.lng,
    coordinateSystem: row.coordinate_system,
    coordinateSource: cacheCoordinateSource(row.provider),
    locationStatus: hasCoordinate ? (row.confidence !== null && row.confidence < 0.7 ? 'estimated' : 'resolved') : 'unresolved',
    confidence: row.confidence,
    resolvedName: row.name,
    resolvedAddress: row.address,
    providerId: row.provider_id,
    provider: row.provider,
    countryCode: row.resolved_country,
  });
  // updatedAtMs is an internal field for negative-cache TTL checks; it is stripped
  // before the resolution is returned to callers (see resolvePlace).
  resolution.updatedAtMs = cacheTimestampToEpochMs(row.updated_at);
  return resolution;
}

function writeCache({ queryKey, queryText, city, country, provider, result, rawJson = null }) {
  getDb().prepare(`
    INSERT INTO place_resolution_cache (
      query_key, query_text, city, country, provider, provider_id, name, address,
      lat, lng, coordinate_system, confidence, raw_json, resolved_country, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(query_key) DO UPDATE SET
      query_text = excluded.query_text,
      city = excluded.city,
      country = excluded.country,
      provider = excluded.provider,
      provider_id = excluded.provider_id,
      name = excluded.name,
      address = excluded.address,
      lat = excluded.lat,
      lng = excluded.lng,
      coordinate_system = excluded.coordinate_system,
      confidence = excluded.confidence,
      raw_json = excluded.raw_json,
      resolved_country = excluded.resolved_country,
      updated_at = datetime('now')
  `).run(
    queryKey,
    queryText,
    city || null,
    country || null,
    provider,
    result.providerId || null,
    result.resolvedName || null,
    result.resolvedAddress || null,
    result.lat ?? null,
    result.lng ?? null,
    result.coordinateSystem || 'unknown',
    result.confidence ?? null,
    rawJson ? JSON.stringify(rawJson) : null,
    result.countryCode || null,
  );
}

async function waitForNominatimSlot() {
  const now = Date.now();
  const waitMs = Math.max(0, nextNominatimRequestAt - now);
  nextNominatimRequestAt = Math.max(now, nextNominatimRequestAt) + NOMINATIM_INTERVAL_MS;
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

function classifyNominatimResult(place, { queryText, city }) {
  const displayName = place.display_name || '';
  const name = place.name || displayName.split(',')[0] || queryText;
  const normalizedName = normalizeText(name);
  const normalizedQuery = normalizeText(queryText);
  const normalizedDisplay = normalizeText(displayName);
  const normalizedCity = normalizeText(city);
  const strongName = normalizedName === normalizedQuery
    || normalizedDisplay.startsWith(normalizedQuery)
    || normalizedDisplay.includes(normalizedQuery);
  const cityMatch = !normalizedCity || normalizedDisplay.includes(normalizedCity);

  return {
    locationStatus: strongName && cityMatch ? 'resolved' : 'estimated',
    confidence: strongName && cityMatch ? 0.78 : 0.55,
    name,
  };
}

function nominatimQueryTexts(queryText) {
  const original = String(queryText || '').trim();
  const variants = [original];
  const bracketPatterns = [
    /\(([^)]+)\)/g,
    /（([^）]+)）/g,
    /\[([^\]]+)\]/g,
    /【([^】]+)】/g,
  ];

  for (const pattern of bracketPatterns) {
    for (const match of original.matchAll(pattern)) {
      if (match[1]?.trim()) variants.push(match[1].trim());
    }
  }

  const stripped = original
    .replace(/\([^)]*\)/g, '')
    .replace(/（[^）]*）/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/【[^】]*】/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (stripped) variants.push(stripped);

  return [...new Set(variants.filter(Boolean))];
}

function resolverQueryTexts(queryText, aliases = []) {
  return uniqueValues([
    ...nominatimQueryTexts(queryText),
    ...normalizeAliasList(aliases).flatMap(nominatimQueryTexts),
  ]);
}

async function fetchNominatimPayload({ queryText, city, country }) {
  await waitForNominatimSlot();
  const canonicalCity = canonicalizeCity(city);
  const q = [queryText, canonicalCity].filter(Boolean).join(', ');
  const params = new URLSearchParams({
    q,
    format: 'jsonv2',
    limit: '1',
    addressdetails: '1',
  });
  const countryCode = String(country || '').trim().toLowerCase();
  if (/^[a-z]{2}$/.test(countryCode)) {
    params.set('countrycodes', countryCode);
  }

  const response = await fetch(`${NOMINATIM_URL}?${params.toString()}`, {
    headers: {
      Accept: 'application/json',
      'User-Agent': config.nominatimUserAgent,
    },
  });

  if (!response.ok) {
    throw Object.assign(new Error('Nominatim lookup failed'), { status: 502 });
  }

  return response.json();
}

function canonicalizeCity(city) {
  const normalized = normalizeText(city);
  const noSpace = normalized.replace(/\s+/g, '');
  if (noSpace === 'chongqing') return 'Chongqing';
  if (noSpace === 'chengdu') return 'Chengdu';
  return city;
}

async function searchNominatim({ queryText, city, country, aliases = [] }) {
  const attempts = [];

  for (const candidate of resolverQueryTexts(queryText, aliases)) {
    const payload = await fetchNominatimPayload({ queryText: candidate, city, country });
    attempts.push({ queryText: candidate, payload });

    const place = Array.isArray(payload) ? payload[0] : null;
    if (!place) continue;

    const lat = Number.parseFloat(place.lat);
    const lng = Number.parseFloat(place.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const classification = classifyNominatimResult(place, { queryText: candidate, city });
    return {
      result: formatResolution({
        lat,
        lng,
        coordinateSystem: 'wgs84',
        coordinateSource: 'manual_lookup',
        locationStatus: classification.locationStatus,
        confidence: classification.confidence,
        resolvedName: classification.name,
        resolvedAddress: place.display_name || null,
        providerId: place.osm_type && place.osm_id ? `${place.osm_type}:${place.osm_id}` : null,
        provider: 'nominatim',
        countryCode: place.address?.country_code ? place.address.country_code.toUpperCase() : null,
      }),
      rawJson: attempts,
    };
  }

  return { result: null, rawJson: attempts };
}

// Google Places Text Search fallback — only used when Nominatim (OSM) produces no result.
// Text Search is a single billed request per query and does not use session tokens.
async function searchGooglePlaces({ queryText, city, country }) {
  if (!config.googlePlacesKey) return null;

  const canonicalCity = canonicalizeCity(city);
  const textQuery = [queryText, canonicalCity].filter(Boolean).join(', ');
  const countryCode = String(country || '').trim().toUpperCase();
  const body = {
    textQuery,
    languageCode: 'en',
    pageSize: 1,
  };
  if (/^[A-Z]{2}$/.test(countryCode)) {
    body.regionCode = countryCode;
  }

  const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': config.googlePlacesKey,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.addressComponents',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw Object.assign(new Error(`Google Places searchText failed: ${detail || response.status}`), {
      status: 502,
    });
  }

  const payload = await response.json();
  const place = Array.isArray(payload.places) ? payload.places[0] : null;
  if (!place) return { result: null, rawJson: payload };

  const lat = place.location?.latitude;
  const lng = place.location?.longitude;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { result: null, rawJson: payload };
  }

  const countryComponent = (place.addressComponents || [])
    .find((component) => Array.isArray(component.types) && component.types.includes('country'));

  return {
    result: formatResolution({
      lat,
      lng,
      coordinateSystem: 'wgs84',
      coordinateSource: 'places',
      locationStatus: 'resolved',
      confidence: 0.9,
      resolvedName: place.displayName?.text || queryText,
      resolvedAddress: place.formattedAddress || null,
      providerId: place.id ? `google:${place.id}` : null,
      provider: 'google_places',
      countryCode: countryComponent?.shortText ? countryComponent.shortText.toUpperCase() : null,
    }),
    rawJson: payload,
  };
}

function unresolved() {
  return formatResolution({
    coordinateSystem: 'unknown',
    coordinateSource: null,
    locationStatus: 'unresolved',
    confidence: 0,
    provider: 'unresolved',
  });
}

export async function resolvePlace({ queryText, city, country, aliases = [], allowNetwork = true, preferNominatim = false } = {}) {
  const query = queryText?.trim();
  if (!query) {
    throw Object.assign(new Error('queryText is required'), { status: 400 });
  }

  const queryKey = buildPlaceQueryKey({ queryText: query, city, country });
  const lookupQueries = resolverQueryTexts(query, aliases);

  // Skip curated when preferNominatim is active and network is available — curated
  // coordinates are AI-estimated and unreliable for accurate map placement.
  const useFallbackChain = !preferNominatim || !allowNetwork;

  if (useFallbackChain) {
    const curated = lookupQueries
      .map((candidate) => findCuratedPlace({ queryText: candidate, city, country }))
      .find(Boolean);
    if (curated) return fromCurated(curated);
  }

  const cached = readCache(queryKey);
  if (cached) {
    const cacheAgeMs = cached.updatedAtMs === null ? Infinity : Date.now() - cached.updatedAtMs;
    const staleUnresolved = cached.locationStatus === 'unresolved'
      && allowNetwork
      && cacheAgeMs > NEGATIVE_CACHE_TTL_MS;

    if (!staleUnresolved) {
      // preferNominatim means "prefer accurate geocoders over AI-estimated sources":
      // short-circuit on successful cached rows from accurate providers (Nominatim or
      // Google Places), but never on unresolved rows so they can retry over the network.
      if (!preferNominatim) return stripInternalFields(cached);
      if (ACCURATE_PROVIDERS.has(cached.provider) && cached.locationStatus !== 'unresolved') {
        return stripInternalFields(cached);
      }
    }
  }

  if (!allowNetwork) {
    return unresolved();
  }

  let nominatimRaw = null;
  try {
    const { result, rawJson } = await searchNominatim({ queryText: query, city, country, aliases });
    nominatimRaw = rawJson;
    if (result) {
      writeCache({ queryKey, queryText: query, city, country, provider: 'nominatim', result, rawJson });
      return result;
    }
  } catch (error) {
    nominatimRaw = { error: error.message };
  }

  // Nominatim produced no result (or threw) — try Google Places Text Search.
  if (config.googlePlacesKey) {
    try {
      const google = await searchGooglePlaces({ queryText: query, city, country });
      if (google?.result) {
        writeCache({
          queryKey,
          queryText: query,
          city,
          country,
          provider: 'google_places',
          result: google.result,
          rawJson: google.rawJson,
        });
        return google.result;
      }
    } catch (error) {
      console.error('[placeResolver] Google Places searchText failed for "%s": %s', query, error.message);
    }
  }

  const fallback = unresolved();
  writeCache({ queryKey, queryText: query, city, country, provider: 'nominatim', result: fallback, rawJson: nominatimRaw });
  return fallback;
}

export function __resetPlaceResolverForTests() {
  nextNominatimRequestAt = 0;
}
