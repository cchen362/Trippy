import { useEffect, useState } from 'react';

const DEFAULT_FORM = {
  type: 'hotel',
  title: '',
  confirmationRef: '',
  bookingSource: '',
  startDatetime: '',
  endDatetime: '',
  origin: '',
  destination: '',
  terminalOrStation: '',
  carrierCode: '',
  flightNumber: '',
  departureDate: '',
  detailsJson: {},
};

function normalizeForm(form) {
  return {
    type: form.type,
    title: form.title,
    confirmationRef: form.confirmationRef,
    bookingSource: form.bookingSource,
    startDatetime: form.startDatetime || null,
    endDatetime: form.endDatetime || null,
    origin: form.origin || null,
    destination: form.destination || null,
    terminalOrStation: form.terminalOrStation || null,
    detailsJson: form.type === 'flight'
      ? {
        carrierCode: form.carrierCode,
        flightNumber: form.flightNumber,
        departureDate: form.departureDate,
      }
      : form.detailsJson,
  };
}

export default function AddBookingModal({
  open,
  onClose,
  onSubmit,
  saving,
  lookupHotels,
  lookupFlight,
}) {
  const [form, setForm] = useState(DEFAULT_FORM);
  const [error, setError] = useState(null);
  const [suggestions, setSuggestions] = useState([]);
  const [searchingHotels, setSearchingHotels] = useState(false);
  const [searchingFlight, setSearchingFlight] = useState(false);

  useEffect(() => {
    if (!open || form.type !== 'hotel' || form.title.trim().length < 3) {
      setSuggestions([]);
      return;
    }

    const timer = setTimeout(async () => {
      setSearchingHotels(true);
      try {
        const response = await lookupHotels(form.title);
        setSuggestions(response.suggestions || []);
      } catch {
        setSuggestions([]);
      } finally {
        setSearchingHotels(false);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [form.title, form.type, lookupHotels, open]);

  if (!open) return null;

  const handleFlightLookup = async () => {
    setSearchingFlight(true);
    setError(null);
    try {
      const response = await lookupFlight({
        carrierCode: form.carrierCode,
        flightNumber: form.flightNumber,
        departureDate: form.departureDate,
      });
      setForm((current) => ({
        ...current,
        title: response.flight.title || current.title,
        startDatetime: current.startDatetime || `${form.departureDate}T09:00:00`,
        detailsJson: {
          ...current.detailsJson,
          lookupStatus: response.flight.lookupStatus,
          note: response.flight.note,
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
      setForm(DEFAULT_FORM);
      setSuggestions([]);
      onClose();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-4">
      <div className="w-full max-w-3xl rounded-[22px] border" style={{ background: 'var(--ink-surface)', borderColor: 'var(--ink-border)' }}>
        <form onSubmit={handleSubmit} className="p-5 sm:p-7">
          <div className="flex items-start justify-between gap-4 mb-6">
            <div>
              <p className="font-mono text-[11px] tracking-[0.28em] uppercase mb-2" style={{ color: 'var(--gold)' }}>
                Add Booking
              </p>
              <h2 className="font-display italic text-3xl" style={{ color: 'var(--cream)' }}>
                Keep the logistics elegant.
              </h2>
            </div>
            <button type="button" onClick={onClose} className="font-mono text-xs tracking-[0.24em] uppercase" style={{ color: 'var(--cream-dim)' }}>
              Close
            </button>
          </div>

          <div className="flex flex-wrap gap-2 mb-6">
            {['hotel', 'flight', 'train', 'other'].map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => setForm((current) => ({ ...current, type }))}
                className="px-4 py-2 rounded-full border font-mono text-[11px] tracking-[0.22em] uppercase"
                style={{
                  color: form.type === type ? 'var(--gold)' : 'var(--cream-dim)',
                  borderColor: form.type === type ? 'var(--gold-line)' : 'var(--ink-border)',
                  background: form.type === type ? 'var(--gold-soft)' : 'transparent',
                }}
              >
                {type}
              </button>
            ))}
          </div>

          <div className="grid sm:grid-cols-2 gap-4">
            <label className="block sm:col-span-2">
              <span className="modal-label">Title</span>
              <input
                value={form.title}
                onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
                className="modal-input"
              />
              {form.type === 'hotel' && suggestions.length > 0 && (
                <div className="mt-2 rounded-xl border overflow-hidden" style={{ borderColor: 'var(--ink-border)' }}>
                  {suggestions.slice(0, 4).map((suggestion) => (
                    <button
                      key={`${suggestion.placeId}-${suggestion.text}`}
                      type="button"
                      onClick={() => {
                        setForm((current) => ({
                          ...current,
                          title: suggestion.mainText || suggestion.text,
                          destination: suggestion.secondaryText || current.destination,
                        }));
                        setSuggestions([]);
                      }}
                      className="block w-full text-left px-4 py-3 border-b last:border-b-0"
                      style={{ borderColor: 'var(--ink-border)', color: 'var(--cream-dim)' }}
                    >
                      <span className="font-mono text-xs block" style={{ color: 'var(--cream)' }}>{suggestion.mainText || suggestion.text}</span>
                      <span className="font-body text-base">{suggestion.secondaryText}</span>
                    </button>
                  ))}
                </div>
              )}
              {form.type === 'hotel' && searchingHotels && (
                <p className="mt-2 font-mono text-[11px] tracking-[0.22em] uppercase" style={{ color: 'var(--cream-mute)' }}>
                  Searching hotels...
                </p>
              )}
            </label>

            <label className="block">
              <span className="modal-label">Confirmation Ref</span>
              <input value={form.confirmationRef} onChange={(event) => setForm((current) => ({ ...current, confirmationRef: event.target.value }))} className="modal-input" />
            </label>

            <label className="block">
              <span className="modal-label">Booked Via</span>
              <input value={form.bookingSource} onChange={(event) => setForm((current) => ({ ...current, bookingSource: event.target.value }))} className="modal-input" />
            </label>

            {form.type === 'flight' && (
              <>
                <label className="block">
                  <span className="modal-label">Carrier Code</span>
                  <input value={form.carrierCode} onChange={(event) => setForm((current) => ({ ...current, carrierCode: event.target.value }))} className="modal-input" />
                </label>
                <label className="block">
                  <span className="modal-label">Flight Number</span>
                  <input value={form.flightNumber} onChange={(event) => setForm((current) => ({ ...current, flightNumber: event.target.value }))} className="modal-input" />
                </label>
                <label className="block">
                  <span className="modal-label">Departure Date</span>
                  <input type="date" value={form.departureDate} onChange={(event) => setForm((current) => ({ ...current, departureDate: event.target.value }))} className="modal-input" />
                </label>
                <div className="flex items-end">
                  <button type="button" onClick={handleFlightLookup} className="w-full modal-action" disabled={searchingFlight}>
                    {searchingFlight ? 'Looking up...' : 'Lookup Flight'}
                  </button>
                </div>
              </>
            )}

            <label className="block">
              <span className="modal-label">Start</span>
              <input type="datetime-local" value={form.startDatetime} onChange={(event) => setForm((current) => ({ ...current, startDatetime: event.target.value }))} className="modal-input" />
            </label>

            <label className="block">
              <span className="modal-label">End</span>
              <input type="datetime-local" value={form.endDatetime} onChange={(event) => setForm((current) => ({ ...current, endDatetime: event.target.value }))} className="modal-input" />
            </label>

            <label className="block">
              <span className="modal-label">Origin</span>
              <input value={form.origin} onChange={(event) => setForm((current) => ({ ...current, origin: event.target.value }))} className="modal-input" />
            </label>

            <label className="block">
              <span className="modal-label">Destination</span>
              <input value={form.destination} onChange={(event) => setForm((current) => ({ ...current, destination: event.target.value }))} className="modal-input" />
            </label>

            <label className="block sm:col-span-2">
              <span className="modal-label">Terminal / Station</span>
              <input value={form.terminalOrStation} onChange={(event) => setForm((current) => ({ ...current, terminalOrStation: event.target.value }))} className="modal-input" />
            </label>
          </div>

          {error && <p className="mt-4 font-mono text-xs" style={{ color: '#e05a5a' }}>{error}</p>}

          <div className="mt-6 flex justify-end gap-3">
            <button type="button" onClick={onClose} className="px-4 py-3 rounded-xl border font-mono text-xs tracking-[0.22em] uppercase" style={{ color: 'var(--cream-dim)', borderColor: 'var(--ink-border)' }}>
              Cancel
            </button>
            <button type="submit" disabled={saving} className="px-5 py-3 rounded-xl font-mono text-xs tracking-[0.22em] uppercase" style={{ background: 'var(--gold)', color: 'var(--ink-deep)', opacity: saving ? 0.7 : 1 }}>
              {saving ? 'Saving...' : 'Save Booking'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
