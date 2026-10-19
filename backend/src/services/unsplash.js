import { config } from '../config.js';

// Plan 10 D1: Unsplash is the sole photo source. Google Place Photos was evaluated
// and rejected (mediocre UGC) even though the project already pays Google for place
// resolution.
const UNSPLASH_BASE_URL = 'https://api.unsplash.com';
const APP_NAME = 'trippy';

function buildReferralUrl(url) {
  if (!url) return '';
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}utm_source=${APP_NAME}&utm_medium=referral`;
}

function mapPhoto(photo) {
  return {
    id: photo.id,
    url: photo.urls?.regular || photo.urls?.full || '',
    alt: photo.alt_description || photo.description || '',
    altDescription: photo.alt_description || '',
    description: photo.description || '',
    photographer: photo.user?.name || '',
    photographerUrl: buildReferralUrl(photo.user?.links?.html || ''),
    unsplashUrl: buildReferralUrl(photo.links?.html || ''),
    downloadLocation: photo.links?.download_location || '',
    tags: Array.isArray(photo.tags)
      ? photo.tags.map((t) => (t?.title || '').toLowerCase()).filter(Boolean)
      : [],
  };
}

// Unsplash API terms require a hit to this endpoint every time a photo is displayed
// to a user (i.e. selected for a stop), separate from the search call. Non-blocking:
// a tracking failure must never affect photo selection.
export async function trackDownload(photo) {
  if (!photo?.downloadLocation || !config.unsplashAccessKey) return;
  try {
    await fetch(photo.downloadLocation, {
      headers: {
        Authorization: `Client-ID ${config.unsplashAccessKey}`,
        'Accept-Version': 'v1',
      },
    });
  } catch (err) {
    console.warn('[unsplash] download tracking failed', { error: err?.message });
  }
}

// Unsplash production tier is GRANTED at 1,000 requests/hour — CLOSED 2026-07-28
// (owner decision; see docs/DECISIONS.md). Do not add rate-limit workarounds,
// queues, or backoff premised on the old 50/hr demo tier. A throttled fetch simply
// leaves the photo NULL, which backfillTripPhotos (services/stops.js) recovers.
async function search(query) {
  if (!config.unsplashAccessKey) {
    throw Object.assign(new Error('Unsplash access key is not configured'), {
      status: 503,
    });
  }

  const url = new URL(`${UNSPLASH_BASE_URL}/search/photos`);
  url.searchParams.set('query', query);
  url.searchParams.set('per_page', '10');
  url.searchParams.set('orientation', 'landscape');
  url.searchParams.set('content_filter', 'high');

  const response = await fetch(url, {
    headers: {
      Authorization: `Client-ID ${config.unsplashAccessKey}`,
      'Accept-Version': 'v1',
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw Object.assign(new Error(body || 'Unsplash lookup failed'), {
      status: 502,
    });
  }

  const payload = await response.json();
  return Array.isArray(payload.results) ? payload.results.map(mapPhoto) : [];
}

export async function searchPhotos(query) {
  if (!query || query.trim().length < 2) {
    throw Object.assign(new Error('Photo query must be at least 2 characters'), {
      status: 400,
    });
  }

  return search(query.trim());
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'at', 'in', 'on', 'to', 'for', 'with',
  'near', 'best', 'top', 'travel', 'trip', 'tour', 'visit', 'place', 'spot',
  'local', 'famous', 'popular',
]);

function tokenize(str) {
  return String(str || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);
}

function significantTokens(query, city, country) {
  const excluded = new Set([...tokenize(city), ...tokenize(country), ...STOPWORDS]);
  return tokenize(query).filter((token) => !excluded.has(token));
}

// Plan 31 D-31-2: whole-word, plural-tolerant match over alt_description + description + tags (Plan 10 W2.1 specified description; search results carry no tags in practice).
function passesGate(photo, sigTokens) {
  if (sigTokens.length === 0) return true;
  const words = new Set(
    tokenize(`${photo.altDescription || ''} ${photo.description || ''} ${(photo.tags || []).join(' ')}`),
  );
  return sigTokens.some((token) => {
    if (words.has(token) || words.has(`${token}s`) || words.has(`${token}es`)) return true;
    if (token.endsWith('es') && words.has(token.slice(0, -2))) return true;
    return token.endsWith('s') && words.has(token.slice(0, -1));
  });
}

// First unused, gate-passing photo in Unsplash relevance order, or null.
function firstQualifying(pool, exclude, sigTokens) {
  for (const photo of pool) {
    if (exclude.has(photo.id)) continue;
    if (!passesGate(photo, sigTokens)) continue;
    return photo;
  }
  return null;
}

// Replaces the old index-hashing pickPhoto (dayIndex*7 + stopSeed) that picked an
// arbitrary result out of relevance order — that was the bug (Plan 10 Wave 2). Order:
//   1. Primary search of the full query; the first result that is unused within the
//      trip (excludeIds) and relevant (passesGate) wins.
//   2. Only if the primary search returned ZERO results: retry with the first 4 words,
//      then the first 3 words of the query (each skipped unless strictly shorter than
//      the last query sent), re-deriving the gate tokens from the shortened query.
//   3. Otherwise a broader, gate-free scene fallback. Primary results that all fail the
//      gate go straight here, with no retry.
// Plan 31 D-31-1: zero-result retry with a shortened query; reopens Plan 10 D2's tier count (owner-approved 2026-10-18).
// D-34-9 (Plan 34 W3): a model-authored broad fallback query was measured against this retry and not adopted; firing this retry on gate-fail as well was worse.
export async function selectPhoto({ query, sceneType, country, city, excludeIds = [] }) {
  const exclude = new Set(excludeIds);
  const sigTokens = significantTokens(query, city, country);

  const primary = await searchPhotos(query);
  const hit = firstQualifying(primary, exclude, sigTokens);
  if (hit) return hit;

  if (primary.length === 0) {
    const words = query.trim().split(/\s+/);
    let lastSentWords = words.length;
    for (const retryWords of [4, 3]) {
      if (retryWords >= lastSentWords) continue;
      const retryQuery = words.slice(0, retryWords).join(' ');
      lastSentWords = retryWords;
      const retried = await searchPhotos(retryQuery);
      const retryHit = firstQualifying(retried, exclude, significantTokens(retryQuery, city, country));
      if (retryHit) return retryHit;
    }
  }

  let fallbackQuery;
  if (sceneType && sceneType !== 'generic') {
    fallbackQuery = `${sceneType.replace(/_/g, ' ')} ${country || ''}`.trim();
  } else {
    fallbackQuery = `${city || ''} travel`.trim();
  }

  if (!fallbackQuery || fallbackQuery.length < 2) {
    return null;
  }

  const fallback = await searchPhotos(fallbackQuery);
  for (const photo of fallback) {
    if (exclude.has(photo.id)) continue;
    return photo;
  }

  return null;
}
