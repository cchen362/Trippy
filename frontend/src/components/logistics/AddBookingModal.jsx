import { useEffect, useState } from 'react';
import { cityFromAirportString, cityFromIata, canonicalCity } from '../../utils/airports.js';
import CityInput from './CityInput.jsx';

const DEFAULT_FORM = {
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
  detailsJson: {},
};

function cityFromSecondaryText(value) {
  if (!value) return '';
  const parts = value.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length <= 1) return parts[0] || '';
  const country = parts.at(-1);
  const stateOrRegion = parts.at(-2);
  const city = parts.at(-3);
  if (country === 'USA') return stateOrRegion || city || '';
  return city || stateOrRegion || '';
}

function hotelSuggestionName(suggestion) {
  const main = suggestion.mainText || suggestion.text || '';
  if (!main || /\b(?:beach|dc|resort|hotel|chengdu|bangkok|new york|shanghai|tokyo|singapore)\b/i.test(main)) {
    return main;
  }
  const city = cityFromSecondaryText(suggestion.secondaryText);
  if (!city || main.toLowerCase().includes(city.toLowerCase())) return main;
  return `${main} ${city}`;
}

function isGenericHotelName(name, fallbackName) {
  if (!name || !fallbackName) return false;
  const normalizedName = name.trim().toLowerCase();
  const normalizedFallback = fallbackName.trim().toLowerCase();
  return normalizedFallback.startsWith(`${normalizedName} `);
}

function withDefaultTime(datetimeStr, defaultTime) {
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

function normalizeForm(form) {
  const shared = {
    confirmationRef: form.confirmationRef,
    bookingSource: form.bookingSource,
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

  if (form.type === 'train') {
    const fromStation = form.originStation || form.fromCity || '';
    const toStation = form.destinationStation || form.toCity || '';
    const title = [form.trainNumber, fromStation && toStation ? `${fromStation} → ${toStation}` : fromStation || toStation]
      .filter(Boolean).join(' ');
    return {
      type: 'train',
      title: title || 'Train',
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
function hydrateFormFromBooking(booking) {
  const dj = booking.detailsJson || {};
  const base = {
    ...DEFAULT_FORM,
    type: booking.type || 'other',
    confirmationRef: booking.confirmationRef || '',
    bookingSource: booking.bookingSource || '',
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

  if (booking.type === 'train') {
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

export default function AddBookingModal({
  open,
  onClose,
  onSubmit,
  saving,
  lookupHotels,
  lookupHotelDetails,
  lookupFlight,
  lookupCities,
  booking,        // when provided, opens in edit mode
}) {
  const isEditing = Boolean(booking);
  const [form, setForm] = useState(() => booking ? hydrateFormFromBooking(booking) : DEFAULT_FORM);
  const [error, setError] = useState(null);
  const [suggestions, setSuggestions] = useState([]);
  const [searchingHotels, setSearchingHotels] = useState(false);
  const [searchingFlight, setSearchingFlight] = useState(false);
  const [selectedHotelText, setSelectedHotelText] = useState('');
  // Session token for Google Places Autocomplete — generated on first hotel keystroke,
  // carried through to the Place Details call, then discarded. One UUID per search session.
  const [hotelSessionToken, setHotelSessionToken] = useState(null);

  // Sync form state when the booking prop changes (switching between edit targets
  // or transitioning from create to edit mode).
  useEffect(() => {
    if (open) {
      setForm(booking ? hydrateFormFromBooking(booking) : DEFAULT_FORM);
      setError(null);
      setSuggestions([]);
      setSelectedHotelText('');
      setHotelSessionToken(null);
    }
  }, [open, booking]);

  useEffect(() => {
    if (!open || form.type !== 'hotel' || form.hotelName.trim().length < 3) {
      setSuggestions([]);
      return;
    }
    if (selectedHotelText && form.hotelName === selectedHotelText) {
      setSuggestions([]);
      return;
    }
    const timer = setTimeout(async () => {
      setSearchingHotels(true);
      try {
        const response = await lookupHotels(form.hotelName, hotelSessionToken);
        setSuggestions(response.suggestions || []);
      } catch {
        setSuggestions([]);
      } finally {
        setSearchingHotels(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [form.hotelName, form.type, hotelSessionToken, lookupHotels, open, selectedHotelText]);

  if (!open) return null;

  const handleFlightLookup = async () => {
    setSearchingFlight(true);
    setError(null);
    try {
      const response = await lookupFlight({
        flightQuery: form.flightQuery,
        departureDate: form.departureDate,
      });
      const f = response.flight;
      const arrivalIata = f.detailsJson?.providerPayload?.arrival?.airport?.iata;
      const departureIata = f.detailsJson?.providerPayload?.departure?.airport?.iata;
      const destinationCity = canonicalCity(
        (arrivalIata && cityFromIata(arrivalIata)) || cityFromAirportString(f.destination),
      ) || null;
      const originCity = canonicalCity(
        (departureIata && cityFromIata(departureIata)) || cityFromAirportString(f.origin),
      ) || null;
      setForm((current) => ({
        ...current,
        carrierCode: f.carrierCode || current.carrierCode,
        flightNumber: f.flightNumber || current.flightNumber,
        airlineName: f.airlineName || current.airlineName,
        origin: f.origin || current.origin,
        destination: f.destination || current.destination,
        departure: f.startDatetime || current.departure,
        arrival: f.endDatetime || current.arrival,
        terminalOrigin: current.terminalOrigin,
        detailsJson: {
          ...current.detailsJson,
          ...f.detailsJson,
          lookupStatus: f.lookupStatus,
          note: f.note,
          provider: f.provider,
          airlineName: f.airlineName,
          aircraft: f.aircraft,
          destinationCity,
          originCity,
        },
      }));
    } catch (err) {
      setError(err.message);
    } finally {
      setSearchingFlight(false);
    }
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError(null);
    try {
      await onSubmit(normalizeForm(form));
      if (!isEditing) setForm(DEFAULT_FORM);
      setSuggestions([]);
      onClose();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleTypeChange = (type) => {
    setSelectedHotelText('');
    setSuggestions([]);
    setHotelSessionToken(null);
    // Reset all fields; preserve only the shared booking fields
    setForm({
      ...DEFAULT_FORM,
      type,
      confirmationRef: form.confirmationRef,
      bookingSource: form.bookingSource,
    });
  };

  const handleHotelNameChange = (value) => {
    setSelectedHotelText('');
    setForm((current) => ({ ...current, hotelName: value }));
    // Start a new Places session on first keystroke after a reset
    if (!hotelSessionToken) setHotelSessionToken(crypto.randomUUID());
  };

  const handleHotelSuggestionSelect = async (suggestion) => {
    const fallbackTitle = hotelSuggestionName(suggestion);
    setSelectedHotelText(fallbackTitle);
    setSuggestions([]);
    setSearchingHotels(true);
    setForm((current) => ({
      ...current,
      hotelName: fallbackTitle,
      hotelAddress: suggestion.secondaryText || current.hotelAddress,
    }));
    try {
      const response = suggestion.placeId && lookupHotelDetails
        ? await lookupHotelDetails(suggestion.placeId, hotelSessionToken)
        : null;
      // Session complete — details call closed it. Next search needs a fresh token.
      setHotelSessionToken(null);
      const place = response?.place;
      const cleanTitle = place?.name && !isGenericHotelName(place.name, fallbackTitle)
        ? place.name
        : fallbackTitle;
      setSelectedHotelText(cleanTitle);
      setForm((current) => ({
        ...current,
        hotelName: cleanTitle,
        hotelAddress: place?.address || suggestion.secondaryText || current.hotelAddress,
        hotelCity: place?.city || current.hotelCity,
        detailsJson: {
          ...current.detailsJson,
          placeId: suggestion.placeId,
          place: suggestion.place,
          placeText: suggestion.text,
          suggestionName: fallbackTitle,
          displayName: cleanTitle,
          formattedAddress: place?.address || suggestion.secondaryText || '',
          city: place?.city || current.detailsJson?.city || null,
        },
      }));
    } catch {
      setForm((current) => ({
        ...current,
        detailsJson: {
          ...current.detailsJson,
          placeId: suggestion.placeId,
          place: suggestion.place,
          placeText: suggestion.text,
          suggestionName: fallbackTitle,
        },
      }));
    } finally {
      setSearchingHotels(false);
    }
  };

  const field = (key) => ({
    value: form[key],
    onChange: (e) => setForm((c) => ({ ...c, [key]: e.target.value })),
    className: 'modal-input',
  });

  return (
    <div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-4">
      <div className="w-full max-w-3xl rounded-[22px] border" style={{ background: 'var(--ink-surface)', borderColor: 'var(--ink-border)' }}>
        <form onSubmit={handleSubmit} className="p-5 sm:p-7">
          <div className="flex items-start justify-between gap-4 mb-6">
            <div>
              <p className="font-mono text-[11px] tracking-[0.28em] uppercase mb-2" style={{ color: 'var(--gold)' }}>
                {isEditing ? 'Edit Booking' : 'Add Booking'}
              </p>
              <h2 className="font-display italic text-3xl" style={{ color: 'var(--cream)' }}>
                {isEditing ? 'Update the details.' : 'Keep the logistics elegant.'}
              </h2>
            </div>
            <button type="button" onClick={onClose} className="font-mono text-xs tracking-[0.24em] uppercase" style={{ color: 'var(--cream-dim)' }}>
              Close
            </button>
          </div>

          {/* Type selector — locked in edit mode to prevent reshaping detailsJson */}
          <div className="flex flex-wrap gap-2 mb-6">
            {['hotel', 'flight', 'train', 'other'].map((type) => (
              <button
                key={type}
                type="button"
                onClick={isEditing ? undefined : () => handleTypeChange(type)}
                disabled={isEditing}
                className="px-4 py-2 rounded-full border font-mono text-[11px] tracking-[0.22em] uppercase"
                style={{
                  color: form.type === type ? 'var(--gold)' : 'var(--cream-mute)',
                  borderColor: form.type === type ? 'var(--gold-line)' : 'var(--ink-border)',
                  background: form.type === type ? 'var(--gold-soft)' : 'transparent',
                  cursor: isEditing ? 'default' : 'pointer',
                }}
              >
                {type}
              </button>
            ))}
          </div>

          {/* ── Hotel ── */}
          {form.type === 'hotel' && (
            <div className="grid sm:grid-cols-2 gap-4">
              <label className="block sm:col-span-2">
                <span className="modal-label">Hotel Name</span>
                <input
                  value={form.hotelName}
                  onChange={(e) => handleHotelNameChange(e.target.value)}
                  className="modal-input"
                  placeholder="e.g. The Peninsula Tokyo"
                />
                {suggestions.length > 0 && (
                  <div className="mt-2 rounded-xl border overflow-hidden" style={{ borderColor: 'var(--ink-border)' }}>
                    {suggestions.slice(0, 4).map((suggestion) => (
                      <button
                        key={`${suggestion.placeId}-${suggestion.text}`}
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => handleHotelSuggestionSelect(suggestion)}
                        className="block w-full text-left px-4 py-3 border-b last:border-b-0"
                        style={{ borderColor: 'var(--ink-border)', color: 'var(--cream-dim)' }}
                      >
                        <span className="font-mono text-xs block" style={{ color: 'var(--cream)' }}>
                          {hotelSuggestionName(suggestion)}
                        </span>
                        {suggestion.secondaryText && (
                          <span className="font-body text-base">{suggestion.secondaryText}</span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
                {searchingHotels && (
                  <p className="mt-2 font-mono text-[11px] tracking-[0.22em] uppercase" style={{ color: 'var(--cream-mute)' }}>
                    Searching hotels...
                  </p>
                )}
              </label>

              <label className="block sm:col-span-2">
                <span className="modal-label">Address</span>
                <input {...field('hotelAddress')} placeholder="Auto-filled from search, or enter manually" />
              </label>

              <label className="block sm:col-span-2">
                <span className="modal-label">City</span>
                <input
                  value={form.detailsJson?.city || form.hotelCity}
                  onChange={(e) => setForm((c) => ({
                    ...c,
                    hotelCity: e.target.value,
                    detailsJson: { ...c.detailsJson, city: e.target.value || null },
                  }))}
                  className="modal-input"
                  placeholder="Auto-filled from search, or enter city name"
                />
              </label>

              <label className="block">
                <span className="modal-label">Check In</span>
                <input type="datetime-local" {...field('checkIn')} />
              </label>

              <label className="block">
                <span className="modal-label">Check Out</span>
                <input type="datetime-local" {...field('checkOut')} />
              </label>

              <label className="block">
                <span className="modal-label">Confirmation Ref</span>
                <input {...field('confirmationRef')} />
              </label>

              <label className="block">
                <span className="modal-label">Booked Via</span>
                <input {...field('bookingSource')} />
              </label>
            </div>
          )}

          {/* ── Flight ── */}
          {form.type === 'flight' && (
            <div className="grid sm:grid-cols-2 gap-4">
              <label className="block">
                <span className="modal-label">Flight Number</span>
                <input {...field('flightQuery')} placeholder="e.g. SQ317 or CZ6099" />
              </label>

              <label className="block">
                <span className="modal-label">Departure Date</span>
                <input type="date" {...field('departureDate')} />
              </label>

              <div className="sm:col-span-2 flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleFlightLookup}
                  className="modal-action"
                  disabled={searchingFlight || !form.flightQuery.trim()}
                >
                  {searchingFlight ? 'Looking up...' : 'Lookup Flight'}
                </button>
                {form.detailsJson?.lookupStatus === 'found' && (
                  <span className="font-mono text-[11px] tracking-[0.22em] uppercase" style={{ color: 'var(--gold)' }}>
                    Schedule found
                  </span>
                )}
                {form.detailsJson?.lookupStatus === 'manual_only' && (
                  <span className="font-mono text-[11px] tracking-[0.22em] uppercase" style={{ color: 'var(--cream-mute)' }}>
                    Not found — fill in manually
                  </span>
                )}
              </div>

              <label className="block sm:col-span-2">
                <span className="modal-label">Airline</span>
                <input {...field('airlineName')} placeholder="Auto-filled by lookup" />
              </label>

              <label className="block">
                <span className="modal-label">Origin</span>
                <input {...field('origin')} placeholder="e.g. SIN - Changi" />
              </label>

              <label className="block">
                <span className="modal-label">Destination</span>
                <input {...field('destination')} placeholder="e.g. NRT - Narita" />
              </label>

              <label className="block">
                <span className="modal-label">Departure</span>
                <input type="datetime-local" {...field('departure')} />
              </label>

              <label className="block">
                <span className="modal-label">Arrival</span>
                <input type="datetime-local" {...field('arrival')} />
              </label>

              <label className="block sm:col-span-2">
                <span className="modal-label">Terminal</span>
                <input {...field('terminalOrigin')} placeholder="e.g. Terminal 3" />
              </label>

              <label className="block">
                <span className="modal-label">Confirmation Ref</span>
                <input {...field('confirmationRef')} />
              </label>

              <label className="block">
                <span className="modal-label">Booked Via</span>
                <input {...field('bookingSource')} />
              </label>
            </div>
          )}

          {/* ── Train ── */}
          {form.type === 'train' && (
            <div className="grid sm:grid-cols-2 gap-4">
              <label className="block sm:col-span-2">
                <span className="modal-label">Train Number</span>
                <input {...field('trainNumber')} placeholder="e.g. G8694 or D3212" />
              </label>

              <CityInput
                value={form.fromCity}
                onChange={(v) => setForm((c) => ({ ...c, fromCity: v }))}
                onCitySelect={(city) => setForm((c) => ({ ...c, fromCity: city }))}
                lookupCities={lookupCities}
                placeholder="e.g. Chengdu"
                label="From — City"
              />

              <label className="block">
                <span className="modal-label">From — Station</span>
                <input {...field('originStation')} placeholder="e.g. Chengdu East" />
              </label>

              <CityInput
                value={form.toCity}
                onChange={(v) => setForm((c) => ({ ...c, toCity: v }))}
                onCitySelect={(city) => setForm((c) => ({ ...c, toCity: city }))}
                lookupCities={lookupCities}
                placeholder="e.g. Chongqing"
                label="To — City"
              />

              <label className="block">
                <span className="modal-label">To — Station</span>
                <input {...field('destinationStation')} placeholder="e.g. Chongqing North" />
              </label>

              <label className="block">
                <span className="modal-label">Departure</span>
                <input type="datetime-local" {...field('trainDeparture')} />
              </label>

              <label className="block">
                <span className="modal-label">Arrival</span>
                <input type="datetime-local" {...field('trainArrival')} />
              </label>

              <label className="block sm:col-span-2">
                <span className="modal-label">Seat Class</span>
                <input {...field('seatClass')} placeholder="e.g. Business / 商务座, Second / 二等座" />
              </label>

              <label className="block">
                <span className="modal-label">Confirmation Ref</span>
                <input {...field('confirmationRef')} />
              </label>

              <label className="block">
                <span className="modal-label">Booked Via</span>
                <input {...field('bookingSource')} />
              </label>
            </div>
          )}

          {/* ── Other ── */}
          {form.type === 'other' && (
            <div className="grid sm:grid-cols-2 gap-4">
              <label className="block sm:col-span-2">
                <span className="modal-label">Name</span>
                <input {...field('name')} placeholder="e.g. Museum entry, Car rental" />
              </label>

              <label className="block">
                <span className="modal-label">Start</span>
                <input type="datetime-local" {...field('otherStart')} />
              </label>

              <label className="block">
                <span className="modal-label">End</span>
                <input type="datetime-local" {...field('otherEnd')} />
              </label>

              <label className="block sm:col-span-2">
                <span className="modal-label">Location</span>
                <input {...field('location')} placeholder="Address or venue" />
              </label>

              <label className="block sm:col-span-2">
                <span className="modal-label">Notes</span>
                <input {...field('notes')} placeholder="Any additional details" />
              </label>

              <label className="block">
                <span className="modal-label">Confirmation Ref</span>
                <input {...field('confirmationRef')} />
              </label>

              <label className="block">
                <span className="modal-label">Booked Via</span>
                <input {...field('bookingSource')} />
              </label>
            </div>
          )}

          {error && <p className="mt-4 font-mono text-xs" style={{ color: '#e05a5a' }}>{error}</p>}

          <div className="mt-6 flex justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-3 rounded-xl border font-mono text-xs tracking-[0.22em] uppercase"
              style={{ color: 'var(--cream-dim)', borderColor: 'var(--ink-border)' }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-5 py-3 rounded-xl font-mono text-xs tracking-[0.22em] uppercase"
              style={{ background: 'var(--gold)', color: 'var(--ink-deep)', opacity: saving ? 0.7 : 1 }}
            >
              {saving ? 'Saving...' : isEditing ? 'Save Changes' : 'Save Booking'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
