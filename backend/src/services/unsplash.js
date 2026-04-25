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
  };
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

export async function pickPhoto({ query, fallbackQuery, dayIndex = 0, stopSeed = 0 }) {
  const primaryResults = await searchPhotos(query);
  const fallbackResults = primaryResults.length > 0 || !fallbackQuery
    ? []
    : await searchPhotos(fallbackQuery);
  const results = primaryResults.length > 0 ? primaryResults : fallbackResults;

  if (results.length === 0) {
    return null;
  }

  // Combine dayIndex and a per-stop seed so stops on the same day get different photos.
  // Multiplying dayIndex by a prime (7) prevents periodicity across sort positions.
  const index = Math.abs(dayIndex * 7 + stopSeed) % results.length;
  return results[index];
}
