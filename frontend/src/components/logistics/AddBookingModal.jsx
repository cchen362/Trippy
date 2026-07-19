import { useEffect, useState } from 'react';
import { cityFromAirportString, cityFromIata, canonicalCity } from '../../utils/airports.js';
import {
  DEFAULT_FORM,
  normalizeForm,
  hydrateFormFromBooking,
  showInItineraryValue,
  resolveBookingMode,
  draftFormForType,
} from './bookingForm.js';

const COMMON_TZ_OPTIONS = [
  { value: '',                         label: 'Device timezone (default)' },
  { value: 'UTC',                      label: 'UTC' },
  { value: 'Europe/London',            label: 'London (GMT/BST)' },
  { value: 'Europe/Paris',             label: 'Paris (CET/CEST)' },
  { value: 'Europe/Istanbul',          label: 'Istanbul (TRT)' },
  { value: 'Asia/Dubai',               label: 'Dubai (GST)' },
  { value: 'Asia/Kolkata',             label: 'India (IST)' },
  { value: 'Asia/Bangkok',             label: 'Bangkok (ICT)' },
  { value: 'Asia/Singapore',           label: 'Singapore (SGT)' },
  { value: 'Asia/Shanghai',            label: 'China (CST)' },
  { value: 'Asia/Tokyo',               label: 'Tokyo (JST)' },
  { value: 'Asia/Seoul',               label: 'Seoul (KST)' },
  { value: 'Asia/Kuala_Lumpur',        label: 'Kuala Lumpur (MYT)' },
  { value: 'Australia/Sydney',         label: 'Sydney (AEST/AEDT)' },
  { value: 'Pacific/Auckland',         label: 'Auckland (NZST/NZDT)' },
  { value: 'America/New_York',         label: 'New York (ET)' },
  { value: 'America/Los_Angeles',      label: 'Los Angeles (PT)' },
  { value: 'America/Sao_Paulo',        label: 'São Paulo (BRT)' },
];

function TzSelect({ label, value, onChange }) {
  return (
    <label className="block">
      <span className="modal-label">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="modal-input">
        {COMMON_TZ_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
    </label>
  );
}
import CityInput from './CityInput.jsx';
import { stripComponentSuffix } from './hotelName.js';
import ModalShell from '../shell/ModalShell.jsx';

// train/bus/ferry share one form (route + station + departure/arrival + seat/class);
// this just relabels the section for whichever type is active.
const TRANSIT_LABEL = { train: 'Train', bus: 'Bus', ferry: 'Ferry' };

const FORM_ID = 'add-booking-form';

export default function AddBookingModal({
  open,
  onClose,
  onSubmit,
  saving,
  lookupHotels,
  lookupHotelDetails,
  lookupFlight,
  lookupCities,
  booking,        // when provided, opens in edit mode (or seeds a draft, see `mode`)
  mode,           // "create" | "edit" | "draft" — defaults based on `booking` presence
}) {
  const resolvedMode = resolveBookingMode(mode, booking);
  const isEditing = resolvedMode === 'edit';
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
        originTz:      f.originTz      || current.originTz,
        destinationTz: f.destinationTz || current.destinationTz,
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
    if (resolvedMode === 'draft') {
      // Draft mode: an unconfirmed extraction may be misclassified — retain the
      // type-agnostic canonical fields (route/times/tz/confirmationRef) and
      // remap them into the new type instead of wiping the form.
      setForm(draftFormForType(form, type));
      return;
    }
    // Reset all fields; preserve only the shared booking fields
    setForm({
      ...DEFAULT_FORM,
      type,
      confirmationRef: form.confirmationRef,
      bookingSource: form.bookingSource,
      showInItinerary: null,
    });
  };

  const handleHotelNameChange = (value) => {
    setSelectedHotelText('');
    setForm((current) => ({ ...current, hotelName: value }));
    // Start a new Places session on first keystroke after a reset
    if (!hotelSessionToken) setHotelSessionToken(crypto.randomUUID());
  };

  const handleHotelSuggestionSelect = async (suggestion) => {
    const fallbackTitle = suggestion.mainText || suggestion.text || '';
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
      // Prefer Places' official name; only fall back to the (conservatively
      // suffix-stripped) suggestion text when the details call didn't return one.
      const cleanTitle = place?.name
        ? place.name
        : stripComponentSuffix(
            fallbackTitle,
            [place?.sublocality, place?.locality, place?.adminAreas?.aal1, place?.adminAreas?.aal2].filter(Boolean),
          );
      setSelectedHotelText(cleanTitle);
      setForm((current) => ({
        ...current,
        hotelName: cleanTitle,
        hotelAddress: place?.address || suggestion.secondaryText || current.hotelAddress,
        hotelCity: place?.city || current.hotelCity,
        originTz:      place?.tz || current.originTz,
        destinationTz: place?.tz || current.destinationTz,
        detailsJson: {
          ...current.detailsJson,
          placeId: suggestion.placeId,
          place: suggestion.place,
          placeText: suggestion.text,
          suggestionName: fallbackTitle,
          displayName: cleanTitle,
          formattedAddress: place?.address || suggestion.secondaryText || '',
          city: place?.city || current.detailsJson?.city || null,
          tz: place?.tz || current.detailsJson?.tz || null,
          lat: Number.isFinite(place?.lat) ? place.lat : current.detailsJson?.lat ?? null,
          lng: Number.isFinite(place?.lng) ? place.lng : current.detailsJson?.lng ?? null,
          countryCode: place?.countryCode ?? current.detailsJson?.countryCode ?? null,
          locality: place?.locality ?? null,
          sublocality: place?.sublocality ?? null,
          adminAreas: place?.adminAreas ?? null,
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
  const showInItinerary = showInItineraryValue(form);

  return (
    <ModalShell
      open={open}
      onRequestClose={onClose}
      eyebrow={isEditing ? 'Edit Booking' : 'Add Booking'}
      headline={isEditing ? 'Update the details.' : 'Keep the logistics elegant.'}
      maxWidth="3xl"
      footer={(
        <div className="flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-3 rounded-xl font-mono text-xs tracking-[0.22em] uppercase border"
            style={{ color: 'var(--cream-dim)', borderColor: 'var(--ink-border)' }}
          >
            Cancel
          </button>
          <button
            type="submit"
            form={FORM_ID}
            disabled={saving}
            className="px-5 py-3 rounded-xl font-mono text-xs tracking-[0.22em] uppercase"
            style={{ background: 'var(--gold)', color: 'var(--ink-deep)', opacity: saving ? 0.7 : 1 }}
          >
            {saving ? 'Saving...' : isEditing ? 'Save Changes' : 'Save Booking'}
          </button>
        </div>
      )}
    >
      <form id={FORM_ID} onSubmit={handleSubmit} className="pb-5 sm:pb-7">
          {/* Type selector — locked in edit mode to prevent reshaping detailsJson */}
          <div className="flex flex-wrap gap-2 mb-1">
            {['hotel', 'flight', 'train', 'bus', 'ferry', 'other'].map((type) => (
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
          {isEditing && (
            <p className="font-mono text-[10px] tracking-[0.14em] mt-1" style={{ color: 'rgba(240,234,216,0.35)' }}>
              Type is fixed for saved bookings
            </p>
          )}
          <div className="mb-6" />

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
                          {suggestion.mainText || suggestion.text}
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
                <span className="modal-label">Area / locality</span>
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

              <div className="sm:col-span-2 pt-4" style={{ borderTop: '1px solid var(--ink-border)' }}>
                <span className="modal-section-label">Reference</span>
              </div>

              <label className="block opacity-70">
                <span className="modal-label">Confirmation Ref</span>
                <input {...field('confirmationRef')} />
              </label>

              <label className="block opacity-70">
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

              <div className="sm:col-span-2 pt-4" style={{ borderTop: '1px solid var(--ink-border)' }}>
                <span className="modal-section-label">Reference</span>
              </div>

              <label className="block opacity-70">
                <span className="modal-label">Confirmation Ref</span>
                <input {...field('confirmationRef')} />
              </label>

              <label className="block opacity-70">
                <span className="modal-label">Booked Via</span>
                <input {...field('bookingSource')} />
              </label>
            </div>
          )}

          {/* ── Train / Bus / Ferry ── */}
          {['train', 'bus', 'ferry'].includes(form.type) && (
            <div className="grid sm:grid-cols-2 gap-4">
              <label className="block sm:col-span-2">
                <span className="modal-label">{TRANSIT_LABEL[form.type]} Number</span>
                <input {...field('trainNumber')} placeholder="e.g. G8694 or D3212" />
              </label>

              <CityInput
                value={form.fromCity}
                onChange={(v) => setForm((c) => ({ ...c, fromCity: v }))}
                onCitySelect={({ label }) => setForm((c) => ({ ...c, fromCity: label }))}
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
                onCitySelect={({ label }) => setForm((c) => ({ ...c, toCity: label }))}
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

              <div className="sm:col-span-2 pt-4" style={{ borderTop: '1px solid var(--ink-border)' }}>
                <span className="modal-section-label">Reference</span>
              </div>

              <div className="opacity-70">
                <TzSelect
                  label="Departure Timezone"
                  value={form.originTz}
                  onChange={(v) => setForm((c) => ({ ...c, originTz: v }))}
                />
              </div>

              <div className="opacity-70">
                <TzSelect
                  label="Arrival Timezone"
                  value={form.destinationTz}
                  onChange={(v) => setForm((c) => ({ ...c, destinationTz: v }))}
                />
              </div>

              <label className="block opacity-70">
                <span className="modal-label">Confirmation Ref</span>
                <input {...field('confirmationRef')} />
              </label>

              <label className="block opacity-70">
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

              <div className="sm:col-span-2 pt-4" style={{ borderTop: '1px solid var(--ink-border)' }}>
                <span className="modal-section-label">Reference</span>
              </div>

              <div className="opacity-70">
                <TzSelect
                  label="Timezone"
                  value={form.originTz}
                  onChange={(v) => setForm((c) => ({ ...c, originTz: v, destinationTz: v }))}
                />
              </div>

              <label className="block opacity-70">
                <span className="modal-label">Confirmation Ref</span>
                <input {...field('confirmationRef')} />
              </label>

              <label className="block opacity-70">
                <span className="modal-label">Booked Via</span>
                <input {...field('bookingSource')} />
              </label>
            </div>
          )}

          <label className="mt-5 flex items-center gap-3 rounded-xl border px-4 py-3" style={{ borderColor: 'var(--ink-border)', color: 'var(--cream-dim)' }}>
            <input
              type="checkbox"
              checked={showInItinerary}
              onChange={(e) => setForm((current) => ({ ...current, showInItinerary: e.target.checked }))}
              style={{ width: 18, height: 18, accentColor: 'var(--gold)' }}
            />
            <span className="font-mono text-[11px] tracking-[0.18em] uppercase">
              Show in itinerary
            </span>
          </label>

          {error && <p className="mt-4 font-mono text-xs" style={{ color: '#e05a5a' }}>{error}</p>}
      </form>
    </ModalShell>
  );
}
