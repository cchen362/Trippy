import { config } from '../config.js';

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

function passesGate(photo, sigTokens) {
  if (sigTokens.length === 0) return true;
  const haystack = `${photo.alt || ''} ${(photo.tags || []).join(' ')}`.toLowerCase();
  return sigTokens.some((token) => haystack.includes(token));
}

// Replaces the old index-hashing pickPhoto (dayIndex*7 + stopSeed) that picked an
// arbitrary result out of relevance order — that was the bug (Plan 10 Wave 2). Results
// from searchPhotos are already Unsplash-relevance-ordered; selectPhoto walks that order
// and returns the first result that is both unused within the trip (excludeIds) and
// relevant to the query (passesGate), falling back to a broader, gate-free search when
// nothing in the primary pool qualifies.
export async function selectPhoto({ query, sceneType, country, city, excludeIds = [] }) {
  const exclude = new Set(excludeIds);
  const sigTokens = significantTokens(query, city, country);

  const primary = await searchPhotos(query);
  for (const photo of primary) {
    if (exclude.has(photo.id)) continue;
    if (!passesGate(photo, sigTokens)) continue;
    return photo;
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
