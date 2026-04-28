import { find as tzFind } from 'geo-tz';
import { config } from '../config.js';
import { searchPhotos } from './unsplash.js';

export async function lookupHotelPredictions(input, sessionToken) {
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
      ...(sessionToken ? { sessionToken } : {}),
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

export async function lookupHotelDetails(placeId, sessionToken) {
  const normalizedPlaceId = placeId?.trim();
  if (!normalizedPlaceId) {
    throw Object.assign(new Error('placeId is required'), { status: 400 });
  }

  if (!config.googlePlacesKey) {
    throw Object.assign(new Error('Google Places API key is not configured'), {
      status: 503,
    });
  }

  // sessionToken on the details call signals Google this completes the session — billing discount applied.
  const detailsUrl = sessionToken
    ? `https://places.googleapis.com/v1/places/${encodeURIComponent(normalizedPlaceId)}?sessionToken=${encodeURIComponent(sessionToken)}`
    : `https://places.googleapis.com/v1/places/${encodeURIComponent(normalizedPlaceId)}`;
  const response = await fetch(detailsUrl, {
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': config.googlePlacesKey,
      'X-Goog-FieldMask': 'id,displayName,formattedAddress,addressComponents,location',
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw Object.assign(new Error(body || 'Google Places details lookup failed'), {
      status: 502,
    });
  }

  const place = await response.json();
  let tz = null;
  if (place.location?.latitude != null && place.location?.longitude != null) {
    tz = tzFind(place.location.latitude, place.location.longitude)[0] || null;
  }
  return {
    placeId: place.id || normalizedPlaceId,
    name: place.displayName?.text || '',
    address: place.formattedAddress || '',
    city: extractCityFromAddressComponents(place.addressComponents),
    tz,
  };
}

/**
 * Extracts a city name from a Google Places addressComponents array.
 * Tries locality first (most cities globally), then administrative_area_level_2
 * (used for prefecture-level cities in China like Chongqing, Chengdu).
 */
function extractCityFromAddressComponents(components) {
  if (!Array.isArray(components)) return null;
  const find = (type) => components.find((c) => c.types?.includes(type))?.longText ?? null;
  return find('locality') || find('administrative_area_level_2') || find('administrative_area_level_1') || null;
}

export async function lookupCityPredictions(input) {
  const query = input?.trim();
  if (!query || query.length < 2) {
    throw Object.assign(new Error('City query must be at least 2 characters'), { status: 400 });
  }

  if (!config.googlePlacesKey) {
    throw Object.assign(new Error('Google Places API key is not configured'), { status: 503 });
  }

  const response = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': config.googlePlacesKey,
    },
    body: JSON.stringify({
      input: query,
      includedPrimaryTypes: ['locality', 'administrative_area_level_2'],
      languageCode: 'en',
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw Object.assign(new Error(body || 'Google Places city lookup failed'), { status: 502 });
  }

  const payload = await response.json();
  return (payload.suggestions || [])
    .map((s) => s.placePrediction)
    .filter(Boolean)
    .map((p) => ({
      city: p.structuredFormat?.mainText?.text || p.text?.text || '',
      country: p.structuredFormat?.secondaryText?.text || '',
    }));
}

export async function lookupPhotos(query) {
  return searchPhotos(query);
}

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function cleanFlightPart(value) {
  return value?.trim().replace(/[\s-]+/g, '').toUpperCase() || '';
}

export function normalizeFlightQuery({ carrierCode, flightNumber, flightQuery }) {
  const combined = cleanFlightPart(flightQuery);

  if (combined) {
    const match = combined.match(/^([A-Z]{2,3})([0-9]{1,4}[A-Z]?)$/);
    if (!match) {
      throw badRequest('Flight number must include an airline code followed by a flight number');
    }

    return {
      carrierCode: match[1],
      flightNumber: match[2],
      flightDesignator: `${match[1]}${match[2]}`,
    };
  }

  const normalizedCarrier = cleanFlightPart(carrierCode);
  const normalizedNumber = cleanFlightPart(flightNumber);
  if (!normalizedCarrier || !normalizedNumber) {
    throw badRequest('Flight number must include an airline code and departure date');
  }
  if (!/^[A-Z]{2,3}$/.test(normalizedCarrier) || !/^[0-9]{1,4}[A-Z]?$/.test(normalizedNumber)) {
    throw badRequest('Flight number must include an airline code followed by a flight number');
  }

  return {
    carrierCode: normalizedCarrier,
    flightNumber: normalizedNumber,
    flightDesignator: `${normalizedCarrier}${normalizedNumber}`,
  };
}

function manualFlightPrefill({ carrierCode, flightNumber, departureDate, note }) {
  return {
    lookupStatus: 'manual_only',
    carrierCode,
    flightNumber,
    departureDate,
    title: `${carrierCode} ${flightNumber}`,
    note: note || 'No flight data provider is configured yet, so this lookup returns a normalized prefill only.',
  };
}

function formatAirport(airport) {
  if (!airport) return null;
  const code = airport.iata || airport.icao;
  if (code && airport.name) return `${code} - ${airport.name}`;
  return code || airport.name || null;
}

function toDatetimeLocal(value) {
  if (!value || typeof value !== 'string') return null;
  return value.replace(' ', 'T').slice(0, 16);
}

function scheduledLocal(point) {
  return point?.scheduledTime?.local
    || point?.scheduledTimeLocal
    || point?.scheduled
    || point?.time?.local
    || null;
}

function normalizeAeroDataBoxFlight(rawFlight, normalized, departureDate) {
  const airlineCode = rawFlight.airline?.iata || normalized.carrierCode;
  const rawNumber = rawFlight.number || rawFlight.flightNumber || normalized.flightDesignator;
  const flightNumberOnly = String(rawNumber).replace(/^[A-Z]{2,3}\s*/i, '') || normalized.flightNumber;
  const aircraft = rawFlight.aircraft?.model || rawFlight.aircraft?.icao || rawFlight.aircraft?.reg || null;

  return {
    lookupStatus: 'found',
    provider: 'aerodatabox',
    title: `${airlineCode.toUpperCase()} ${flightNumberOnly}`,
    carrierCode: airlineCode.toUpperCase(),
    flightNumber: flightNumberOnly,
    departureDate,
    origin: formatAirport(rawFlight.departure?.airport),
    destination: formatAirport(rawFlight.arrival?.airport),
    startDatetime: toDatetimeLocal(scheduledLocal(rawFlight.departure)),
    endDatetime: toDatetimeLocal(scheduledLocal(rawFlight.arrival)),
    originTz:      rawFlight.departure?.airport?.timeZone || null,
    destinationTz: rawFlight.arrival?.airport?.timeZone  || null,
    airlineName: rawFlight.airline?.name || null,
    aircraft,
    detailsJson: {
      provider: 'aerodatabox',
      providerPayload: rawFlight,
    },
  };
}

async function lookupAeroDataBoxFlight(normalized, departureDate) {
  const host = config.aerodataboxApiHost || 'aerodatabox.p.rapidapi.com';
  const url = `https://${host}/flights/number/${encodeURIComponent(normalized.flightDesignator)}/${encodeURIComponent(departureDate)}?dateLocalRole=Departure&withAircraftImage=false&withLocation=false&withFlightPlan=false`;
  let response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'X-RapidAPI-Host': host,
        'X-RapidAPI-Key': config.aerodataboxApiKey,
      },
    });
  } catch {
    return manualFlightPrefill({
      ...normalized,
      departureDate,
      note: 'Flight schedule lookup is unavailable right now. You can still enter the details manually.',
    });
  }

  if (response.status === 204) {
    return manualFlightPrefill({
      ...normalized,
      departureDate,
      note: 'No matching flight schedule was found. You can still enter the details manually.',
    });
  }

  if (!response.ok) {
    return manualFlightPrefill({
      ...normalized,
      departureDate,
      note: 'Flight schedule lookup is unavailable right now. You can still enter the details manually.',
    });
  }

  const payload = await response.json();
  const flights = Array.isArray(payload) ? payload : payload?.flights || [];
  const flight = flights[0];
  if (!flight) {
    return manualFlightPrefill({
      ...normalized,
      departureDate,
      note: 'No matching flight schedule was found. You can still enter the details manually.',
    });
  }

  return normalizeAeroDataBoxFlight(flight, normalized, departureDate);
}

export async function lookupFlightDetails({ carrierCode, flightNumber, flightQuery, departureDate }) {
  if (!departureDate?.trim()) {
    throw Object.assign(new Error('departureDate is required'), {
      status: 400,
    });
  }

  const normalized = normalizeFlightQuery({ carrierCode, flightNumber, flightQuery });
  const trimmedDate = departureDate.trim();

  if (config.flightDataProvider !== 'aerodatabox' || !config.aerodataboxApiKey) {
    return manualFlightPrefill({ ...normalized, departureDate: trimmedDate });
  }

  return lookupAeroDataBoxFlight(normalized, trimmedDate);
}
