import { config } from '../config.js';
import { searchPhotos } from './unsplash.js';

export async function lookupHotelPredictions(input) {
  const query = input?.trim();
  if (!query || query.length < 2) {
    throw Object.assign(new Error('Hotel query must be at least 2 characters'), {
      status: 400,
    });
  }

  if (!config.googlePlacesKey) {
    throw Object.assign(new Error('Google Places API key is not configured'), {
      status: 503,
    });
  }

  const response = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': config.googlePlacesKey,
    },
    body: JSON.stringify({
      input: query,
      includedPrimaryTypes: ['lodging'],
      languageCode: 'en',
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw Object.assign(new Error(body || 'Google Places lookup failed'), {
      status: 502,
    });
  }

  const payload = await response.json();
  return (payload.suggestions || [])
    .map((suggestion) => suggestion.placePrediction)
    .filter(Boolean)
    .map((prediction) => ({
      place: prediction.place,
      placeId: prediction.placeId,
      text: prediction.text?.text || prediction.structuredFormat?.mainText?.text || '',
      mainText: prediction.structuredFormat?.mainText?.text || '',
      secondaryText: prediction.structuredFormat?.secondaryText?.text || '',
    }));
}

export async function lookupPhotos(query) {
  return searchPhotos(query);
}

export async function lookupFlightDetails({ carrierCode, flightNumber, departureDate }) {
  if (!carrierCode?.trim() || !flightNumber?.trim() || !departureDate?.trim()) {
    throw Object.assign(new Error('carrierCode, flightNumber, and departureDate are required'), {
      status: 400,
    });
  }

  return {
    lookupStatus: 'manual_only',
    carrierCode: carrierCode.trim().toUpperCase(),
    flightNumber: flightNumber.trim(),
    departureDate,
    title: `${carrierCode.trim().toUpperCase()} ${flightNumber.trim()}`,
    note: 'No flight data provider is configured yet, so this lookup returns a normalized prefill only.',
  };
}
