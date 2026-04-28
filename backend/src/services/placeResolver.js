import { getDb } from '../db/database.js';
import { config } from '../config.js';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const NOMINATIM_INTERVAL_MS = 1000;

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
  };
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
  });
}

function readCache(queryKey) {
  const row = getDb().prepare('SELECT * FROM place_resolution_cache WHERE query_key = ?').get(queryKey);
  if (!row) return null;
  const hasCoordinate = row.lat !== null && row.lng !== null;
  return formatResolution({
    lat: row.lat,
    lng: row.lng,
    coordinateSystem: row.coordinate_system,
    coordinateSource: row.provider === 'nominatim' ? 'manual_lookup' : 'cache',
    locationStatus: hasCoordinate ? (row.confidence !== null && row.confidence < 0.7 ? 'estimated' : 'resolved') : 'unresolved',
    confidence: row.confidence,
    resolvedName: row.name,
    resolvedAddress: row.address,
    providerId: row.provider_id,
    provider: row.provider,
  });
}

function writeCache({ queryKey, queryText, city, country, provider, result, rawJson = null }) {
  getDb().prepare(`
    INSERT INTO place_resolution_cache (
      query_key, query_text, city, country, provider, provider_id, name, address,
      lat, lng, coordinate_system, confidence, raw_json, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
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
  );
}

function scoreDiscoveryMatch(item, queryText) {
  const query = normalizeText(queryText);
  const name = normalizeText(item?.name);
  if (!query || !name) return 0;
  if (name === query) return 1;
  if (name.includes(query) || query.includes(name)) return 0.86;
  return 0;
}

function findDiscoveryCacheMatch({ queryText, city }) {
  const destinationKey = normalizeText(city).replace(/\s+/g, '');
  if (!destinationKey) return null;
  const row = getDb().prepare('SELECT result_json FROM global_discovery_cache WHERE destination = ?').get(destinationKey);
  if (!row) return null;

  let categories;
  try {
    categories = JSON.parse(row.result_json);
  } catch {
    return null;
  }

  let best = null;
  for (const category of categories || []) {
    for (const item of category.items || []) {
      const score = scoreDiscoveryMatch(item, queryText);
      if (score > (best?.score || 0) && Number.isFinite(item.lat) && Number.isFinite(item.lng)) {
        best = { item, score };
      }
    }
  }
  return best?.score >= 0.85 ? best : null;
}

function fromDiscovery(match) {
  return formatResolution({
    lat: match.item.lat,
    lng: match.item.lng,
    coordinateSystem: 'wgs84',
    coordinateSource: 'discovery',
    locationStatus: 'estimated',
    confidence: Math.min(match.score, 0.68),
    resolvedName: match.item.name,
    resolvedAddress: null,
    providerId: `discovery:${normalizeText(match.item.name).replace(/\s+/g, '-')}`,
    provider: 'discovery_cache',
  });
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
      }),
      rawJson: attempts,
    };
  }

  return { result: null, rawJson: attempts };
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

  // Skip curated and discovery when preferNominatim is active and network is available —
  // these sources are AI-estimated and unreliable for accurate map placement.
  const useFallbackChain = !preferNominatim || !allowNetwork;

  if (useFallbackChain) {
    const curated = lookupQueries
      .map((candidate) => findCuratedPlace({ queryText: candidate, city, country }))
      .find(Boolean);
    if (curated) return fromCurated(curated);
  }

  const cached = readCache(queryKey);
  if (cached) {
    if (!preferNominatim) return cached;
    // With preferNominatim, only short-circuit on a previous successful Nominatim result
    if (cached.provider === 'nominatim' && cached.locationStatus !== 'unresolved') return cached;
  }

  if (useFallbackChain) {
    const discoveryMatch = lookupQueries
      .map((candidate) => findDiscoveryCacheMatch({ queryText: candidate, city }))
      .find(Boolean);
    if (discoveryMatch) {
      const result = fromDiscovery(discoveryMatch);
      writeCache({ queryKey, queryText: query, city, country, provider: 'discovery_cache', result });
      return result;
    }
  }

  if (!allowNetwork) {
    return unresolved();
  }

  try {
    const { result, rawJson } = await searchNominatim({ queryText: query, city, country, aliases });
    if (result) {
      writeCache({ queryKey, queryText: query, city, country, provider: 'nominatim', result, rawJson });
      return result;
    }
    const fallback = unresolved();
    writeCache({ queryKey, queryText: query, city, country, provider: 'nominatim', result: fallback, rawJson });
    return fallback;
  } catch (error) {
    const fallback = unresolved();
    writeCache({
      queryKey,
      queryText: query,
      city,
      country,
      provider: 'nominatim',
      result: fallback,
      rawJson: { error: error.message },
    });
    return fallback;
  }
}

export function __resetPlaceResolverForTests() {
  nextNominatimRequestAt = 0;
}
