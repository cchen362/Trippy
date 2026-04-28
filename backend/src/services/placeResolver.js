import { getDb } from '../db/database.js';
import { config } from '../config.js';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const NOMINATIM_INTERVAL_MS = 1000;

let nextNominatimRequestAt = 0;

const CURATED_PLACES = [
  {
    aliases: ['hongya cave', 'hongyadong', 'hongya cave chongqing', 'hongyadong chongqing'],
    city: 'chongqing',
    country: 'cn',
    name: 'Hongya Cave',
    address: 'Hongyadong, Yuzhong District, Chongqing, China',
    lat: 29.5605,
    lng: 106.5655,
    coordinateSystem: 'gcj02',
    providerId: 'curated:hongya-cave-chongqing',
    locationStatus: 'user_confirmed',
    confidence: 0.99,
  },
  {
    aliases: ['luohan temple', 'arhat temple', 'luohan temple chongqing'],
    city: 'chongqing',
    country: 'cn',
    name: 'Luohan Temple',
    address: 'Luohan Temple, Yuzhong District, Chongqing, China',
    lat: 29.5597,
    lng: 106.5740,
    coordinateSystem: 'gcj02',
    providerId: 'curated:luohan-temple-chongqing',
    locationStatus: 'user_confirmed',
    confidence: 0.98,
  },
  {
    aliases: ['jiefangbei', 'jiefangbei pedestrian street', 'jiefangbei chongqing'],
    city: 'chongqing',
    country: 'cn',
    name: 'Jiefangbei',
    address: 'Jiefangbei, Yuzhong District, Chongqing, China',
    lat: 29.5580,
    lng: 106.5772,
    coordinateSystem: 'gcj02',
    providerId: 'curated:jiefangbei-chongqing',
    locationStatus: 'user_confirmed',
    confidence: 0.98,
  },
  {
    aliases: ['regent chongqing', 'regent hotel chongqing'],
    city: 'chongqing',
    country: 'cn',
    name: 'Regent Chongqing',
    address: 'Regent Chongqing, Jiangbei District, Chongqing, China',
    lat: 29.5578,
    lng: 106.5697,
    coordinateSystem: 'gcj02',
    providerId: 'curated:regent-chongqing',
    locationStatus: 'user_confirmed',
    confidence: 0.99,
  },
  {
    aliases: ['raffles city chongqing', 'raffles city', 'chaotianmen raffles city'],
    city: 'chongqing',
    country: 'cn',
    name: 'Raffles City Chongqing',
    address: 'Raffles City Chongqing, Chaotianmen, Yuzhong District, Chongqing, China',
    lat: 29.5682,
    lng: 106.5876,
    coordinateSystem: 'gcj02',
    providerId: 'curated:raffles-city-chongqing',
    locationStatus: 'user_confirmed',
    confidence: 0.99,
  },
  {
    aliases: ['chaotianmen dock', 'chaotianmen wharf', 'chaotianmen pier', 'chaotianmen dock chongqing'],
    city: 'chongqing',
    country: 'cn',
    name: 'Chaotianmen Dock',
    address: 'Chaotianmen Dock, Yuzhong District, Chongqing, China',
    lat: 29.5676,
    lng: 106.5870,
    coordinateSystem: 'gcj02',
    providerId: 'curated:chaotianmen-dock-chongqing',
    locationStatus: 'user_confirmed',
    confidence: 0.98,
  },
];

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
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
    (!normalizedCity || normalizeText(place.city) === normalizedCity)
    && countryMatches(place.country, country)
    && place.aliases.some((alias) => normalizeText(alias) === query)
  ));
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
  const isExact = match.score >= 1;
  return formatResolution({
    lat: match.item.lat,
    lng: match.item.lng,
    coordinateSystem: 'unknown',
    coordinateSource: 'discovery',
    locationStatus: isExact ? 'resolved' : 'estimated',
    confidence: isExact ? 0.82 : 0.68,
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

async function searchNominatim({ queryText, city, country }) {
  await waitForNominatimSlot();
  const q = [queryText, city, country].filter(Boolean).join(', ');
  const params = new URLSearchParams({
    q,
    format: 'jsonv2',
    limit: '1',
    addressdetails: '1',
  });

  const response = await fetch(`${NOMINATIM_URL}?${params.toString()}`, {
    headers: {
      Accept: 'application/json',
      'User-Agent': config.nominatimUserAgent,
    },
  });

  if (!response.ok) {
    throw Object.assign(new Error('Nominatim lookup failed'), { status: 502 });
  }

  const payload = await response.json();
  const place = Array.isArray(payload) ? payload[0] : null;
  if (!place) return { result: null, rawJson: payload };

  const lat = Number.parseFloat(place.lat);
  const lng = Number.parseFloat(place.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { result: null, rawJson: payload };

  const classification = classifyNominatimResult(place, { queryText, city });
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

export async function resolvePlace({ queryText, city, country, allowNetwork = true } = {}) {
  const query = queryText?.trim();
  if (!query) {
    throw Object.assign(new Error('queryText is required'), { status: 400 });
  }

  const queryKey = buildPlaceQueryKey({ queryText: query, city, country });
  const curated = findCuratedPlace({ queryText: query, city, country });
  if (curated) return fromCurated(curated);

  const cached = readCache(queryKey);
  if (cached) return cached;

  const discoveryMatch = findDiscoveryCacheMatch({ queryText: query, city });
  if (discoveryMatch) {
    const result = fromDiscovery(discoveryMatch);
    writeCache({ queryKey, queryText: query, city, country, provider: 'discovery_cache', result });
    return result;
  }

  if (!allowNetwork) {
    return unresolved();
  }

  try {
    const { result, rawJson } = await searchNominatim({ queryText: query, city, country });
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
