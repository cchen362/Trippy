import { cityFromAirportString, cityFromIata, canonicalCity } from '../../utils/airports.js';

// train/bus/ferry share one form (route + station + departure/arrival + seat/class);
// this just relabels the section for whichever type is active.
const TRANSIT_LABEL = { train: 'Train', bus: 'Bus', ferry: 'Ferry' };

export const DEFAULT_FORM = {
  type: 'hotel',
  // hotel
  hotelName: '',
  hotelAddress: '',
  hotelCity: '',
  checkIn: '',
  checkOut: '',
  // flight
  flightQuery: '',
  departureDate: '',
  airlineName: '',
  origin: '',
  destination: '',
  departure: '',
  arrival: '',
  terminalOrigin: '',
  carrierCode: '',
  flightNumber: '',
  // train
  trainNumber: '',
  fromCity: '',
  originStation: '',
  toCity: '',
  destinationStation: '',
  trainDeparture: '',
  trainArrival: '',
  seatClass: '',
  // other
  name: '',
  otherStart: '',
  otherEnd: '',
  location: '',
  notes: '',
  // shared
  confirmationRef: '',
  bookingSource: '',
  showInItinerary: null,
  originTz: '',
  destinationTz: '',
  detailsJson: {},
};

export function withDefaultTime(datetimeStr, defaultTime) {
  if (!datetimeStr) return null;
  // If user already picked a datetime-local value with a non-midnight time, honour it
  if (datetimeStr.includes('T')) {
    const timePart = datetimeStr.split('T')[1];
    if (timePart && timePart !== '00:00') return datetimeStr;
    // Has T but time is 00:00 — apply default
    return `${datetimeStr.split('T')[0]}T${defaultTime}`;
  }
  // Date-only value
  return `${datetimeStr}T${defaultTime}`;
}

export function defaultShowInItinerary(form) {
  if (['hotel', 'flight', 'train', 'bus', 'ferry'].includes(form.type)) return true;
  if (form.type === 'other') return Boolean(form.otherStart && form.location.trim());
  return false;
}

export function showInItineraryValue(form) {
  return form.showInItinerary ?? defaultShowInItinerary(form);
}

export function normalizeForm(form) {
  const shared = {
    confirmationRef: form.confirmationRef,
    bookingSource: form.bookingSource,
    showInItinerary: showInItineraryValue(form),
    originTz:      form.originTz      || null,
    destinationTz: form.destinationTz || null,
  };

  if (form.type === 'hotel') {
    const hotelCity = form.detailsJson?.city || form.hotelCity || null;
    return {
      type: 'hotel',
      title: form.hotelName || '',
      ...shared,
      startDatetime: withDefaultTime(form.checkIn, '15:00'),
      endDatetime: withDefaultTime(form.checkOut, '11:00'),
      origin: null,
      destination: form.hotelAddress || null,
      terminalOrStation: null,
      detailsJson: { ...form.detailsJson, city: hotelCity },
    };
  }

  if (form.type === 'flight') {
    const title = form.flightNumber
      ? `${form.carrierCode ? form.carrierCode + ' ' : ''}${form.flightNumber}`.trim()
      : form.flightQuery.trim();
    // Extract destination city: prefer explicit city stored at lookup time, else parse from airport string
    const destinationCity = canonicalCity(
      form.detailsJson?.destinationCity || cityFromAirportString(form.destination),
    ) || null;
    const originCity = canonicalCity(
      form.detailsJson?.originCity || cityFromAirportString(form.origin),
    ) || null;
    return {
      type: 'flight',
      title: title || form.flightQuery.trim(),
      ...shared,
      startDatetime: form.departure || null,
      endDatetime: form.arrival || null,
      origin: form.origin || null,
      destination: form.destination || null,
      terminalOrStation: form.terminalOrigin || null,
      detailsJson: {
        ...form.detailsJson,
        carrierCode: form.carrierCode,
        flightNumber: form.flightNumber,
        departureDate: form.departureDate,
        airlineName: form.airlineName,
        originCity,
        destinationCity,
      },
    };
  }

  if (['train', 'bus', 'ferry'].includes(form.type)) {
    const fromStation = form.originStation || form.fromCity || '';
    const toStation = form.destinationStation || form.toCity || '';
    const title = [form.trainNumber, fromStation && toStation ? `${fromStation} → ${toStation}` : fromStation || toStation]
      .filter(Boolean).join(' ');
    return {
      type: form.type,
      title: title || TRANSIT_LABEL[form.type],
      ...shared,
      startDatetime: form.trainDeparture || null,
      endDatetime: form.trainArrival || null,
      origin: form.fromCity || form.originStation || null,
      destination: form.toCity || form.destinationStation || null,
      terminalOrStation: null,
      detailsJson: {
        ...form.detailsJson,
        trainNumber: form.trainNumber || null,
        originStation: form.originStation || null,
        destinationStation: form.destinationStation || null,
        originCity: canonicalCity(form.fromCity) || null,
        destinationCity: canonicalCity(form.toCity) || null,
        seatClass: form.seatClass || null,
      },
    };
  }

  // other
  return {
    type: 'other',
    title: form.name || '',
    ...shared,
    startDatetime: form.otherStart || null,
    endDatetime: form.otherEnd || null,
    origin: null,
    destination: form.location || null,
    terminalOrStation: null,
    detailsJson: {
      ...form.detailsJson,
      note: form.notes || null,
    },
  };
}

// Reverse of normalizeForm — reconstructs form state from a persisted booking.
// Preserves detailsJson so rich metadata (placeId, providerPayload) survives edits.
export function hydrateFormFromBooking(booking) {
  const dj = booking.detailsJson || {};
  const base = {
    ...DEFAULT_FORM,
    type: booking.type || 'other',
    confirmationRef: booking.confirmationRef || '',
    bookingSource: booking.bookingSource || '',
    showInItinerary: booking.showInItinerary ?? null,
    originTz:      booking.originTz      || '',
    destinationTz: booking.destinationTz || '',
    detailsJson: dj,
  };

  if (booking.type === 'hotel') {
    return {
      ...base,
      hotelName: booking.title || '',
      hotelAddress: booking.destination || '',
      hotelCity: dj.city || '',
      checkIn: booking.startDatetime || '',
      checkOut: booking.endDatetime || '',
    };
  }

  if (booking.type === 'flight') {
    const carrierCode = dj.carrierCode || '';
    const flightNumber = dj.flightNumber || '';
    return {
      ...base,
      flightQuery: carrierCode && flightNumber ? `${carrierCode}${flightNumber}` : booking.title || '',
      departureDate: dj.departureDate || '',
      airlineName: dj.airlineName || '',
      origin: booking.origin || '',
      destination: booking.destination || '',
      departure: booking.startDatetime || '',
      arrival: booking.endDatetime || '',
      terminalOrigin: booking.terminalOrStation || '',
      carrierCode,
      flightNumber,
    };
  }

  if (['train', 'bus', 'ferry'].includes(booking.type)) {
    return {
      ...base,
      trainNumber: dj.trainNumber || '',
      fromCity: dj.originCity || booking.origin || '',
      originStation: dj.originStation || '',
      toCity: dj.destinationCity || booking.destination || '',
      destinationStation: dj.destinationStation || '',
      trainDeparture: booking.startDatetime || '',
      trainArrival: booking.endDatetime || '',
      seatClass: dj.seatClass || '',
    };
  }

  // other
  return {
    ...base,
    name: booking.title || '',
    otherStart: booking.startDatetime || '',
    otherEnd: booking.endDatetime || '',
    location: booking.destination || '',
    notes: dj.note || '',
  };
}

export function resolveBookingMode(mode, booking) {
  return mode ?? (booking ? 'edit' : 'create');
}

// Draft-mode type change: re-map the current form into the new type, retaining
// only type-agnostic canonical fields (confirmationRef, bookingSource, start/end
// datetimes, origin/destination text, timezones). Type-specific fields with no
// equivalent slot in the new type are cleared — nothing stale survives in detailsJson.
export function draftFormForType(form, type) {
  const canonical = normalizeForm(form);
  return hydrateFormFromBooking({
    type,
    confirmationRef: canonical.confirmationRef,
    bookingSource: canonical.bookingSource,
    startDatetime: canonical.startDatetime,
    endDatetime: canonical.endDatetime,
    origin: canonical.origin,
    destination: canonical.destination,
    originTz: canonical.originTz,
    destinationTz: canonical.destinationTz,
    detailsJson: {},          // <-- load-bearing: clears all previous-type detailsJson keys
    showInItinerary: null,
  });
}
