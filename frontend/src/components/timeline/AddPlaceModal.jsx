import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';

const EMPTY_FORM = {
  title: '',
  time: '',
  type: 'experience',
  note: '',
  duration: '',
};

const TYPE_OPTIONS = [
  { value: 'experience', label: 'Experience' },
  { value: 'food', label: 'Food' },
  { value: 'culture', label: 'Culture' },
  { value: 'nature', label: 'Nature' },
  { value: 'shopping', label: 'Shopping' },
  { value: 'booked', label: 'Booked' },
];

export default function AddPlaceModal({ open, day, saving, onClose, onSubmit, lookupPlaces, lookupPlaceDetails }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState(null);
  const [suggestions, setSuggestions] = useState([]);
  const [searching, setSearching] = useState(false);
  const [selectedTitle, setSelectedTitle] = useState('');
  const [pickedPlace, setPickedPlace] = useState(null);
  // Session token for Google Places Autocomplete — generated on first keystroke,
  // carried through to the Place Details call, then discarded.
  const [sessionToken, setSessionToken] = useState(null);
  const canSubmit = useMemo(() => form.title.trim().length > 0, [form.title]);
  const near = day?.city || day?.resolvedCity || '';

  useEffect(() => {
    if (open) {
      setForm(EMPTY_FORM);
      setError(null);
      setSuggestions([]);
      setSelectedTitle('');
      setPickedPlace(null);
      setSessionToken(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open || !lookupPlaces || form.title.trim().length < 3) {
      setSuggestions([]);
      return;
    }
    if (selectedTitle && form.title === selectedTitle) {
      setSuggestions([]);
      return;
    }
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const response = await lookupPlaces(form.title, sessionToken, near);
        setSuggestions(response.suggestions || []);
      } catch {
        setSuggestions([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [form.title, lookupPlaces, near, open, selectedTitle, sessionToken]);

  if (!open) return null;

  const set = (key) => (event) => {
    setForm((current) => ({ ...current, [key]: event.target.value }));
  };

  const handleTitleChange = (event) => {
    const value = event.target.value;
    setSelectedTitle('');
    setPickedPlace(null);
    setForm((current) => ({ ...current, title: value }));
    // Start a new Places session on first keystroke after a reset
    if (!sessionToken) setSessionToken(crypto.randomUUID());
  };

  const handleSuggestionSelect = async (suggestion) => {
    const fallbackTitle = suggestion.mainText || suggestion.text || '';
    setSelectedTitle(fallbackTitle);
    setSuggestions([]);
    setForm((current) => ({ ...current, title: fallbackTitle }));
    if (!suggestion.placeId || !lookupPlaceDetails) return;
    setSearching(true);
    try {
      const response = await lookupPlaceDetails(suggestion.placeId, sessionToken);
      // Session complete — details call closed it. Next search needs a fresh token.
      setSessionToken(null);
      const place = response?.place;
      const cleanTitle = place?.name || fallbackTitle;
      setSelectedTitle(cleanTitle);
      setForm((current) => ({ ...current, title: cleanTitle }));
      if (place && Number.isFinite(place.lat) && Number.isFinite(place.lng)) {
        setPickedPlace({
          placeId: place.placeId || suggestion.placeId,
          name: cleanTitle,
          address: place.address || '',
          city: place.city || '',
          lat: place.lat,
          lng: place.lng,
        });
      }
    } catch {
      // Leave the picked title in place; submission falls back to free-text resolution.
    } finally {
      setSearching(false);
    }
  };

  const handleTitleKeyDown = (event) => {
    if (event.key === 'Enter' && suggestions.length > 0) {
      event.preventDefault();
    }
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!canSubmit) return;
    setSuggestions([]);
    setError(null);

    const title = form.title.trim();
    const hasPickedCoordinates = pickedPlace
      && title === pickedPlace.name
      && Number.isFinite(pickedPlace.lat)
      && Number.isFinite(pickedPlace.lng);

    const payload = {
      title,
      locationQuery: title,
      type: form.type,
      time: form.time || null,
      note: form.note.trim() || null,
      duration: form.duration.trim() || null,
    };

    if (hasPickedCoordinates) {
      Object.assign(payload, {
        lat: pickedPlace.lat,
        lng: pickedPlace.lng,
        coordinateSystem: 'wgs84',
        coordinateSource: 'places',
        locationStatus: 'resolved',
        locationConfidence: 0.95,
        providerId: `google:${pickedPlace.placeId}`,
        resolvedName: pickedPlace.name,
        resolvedAddress: pickedPlace.address,
        locationQuery: pickedPlace.name,
      });
    }

    try {
      await onSubmit(payload);
      setForm(EMPTY_FORM);
      setPickedPlace(null);
      setSuggestions([]);
      onClose();
    } catch (err) {
      setError(err.message || 'Could not add this place');
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-4">
      <div className="w-full max-w-xl rounded-[22px] border" style={{ background: 'var(--ink-surface)', borderColor: 'var(--ink-border)' }}>
        <form onSubmit={handleSubmit} className="p-5 sm:p-7">
          <div className="flex items-start justify-between gap-4 mb-6">
            <div>
              <p className="font-mono text-[11px] tracking-[0.28em] uppercase mb-2" style={{ color: 'var(--gold)' }}>
                Add Place
              </p>
              <h2 className="font-display italic text-3xl" style={{ color: 'var(--cream)' }}>
                {day?.city || day?.resolvedCity || 'New stop'}
              </h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="w-10 h-10 inline-flex items-center justify-center rounded-full border"
              style={{ color: 'var(--cream-dim)', borderColor: 'var(--ink-border)', background: 'rgba(255,255,255,0.02)' }}
              aria-label="Close add place"
              title="Close"
            >
              <X size={17} />
            </button>
          </div>

          <div className="grid gap-4">
            <label className="block relative">
              <span className="modal-label">Place Name</span>
              <input
                type="text"
                value={form.title}
                onChange={handleTitleChange}
                onKeyDown={handleTitleKeyDown}
                placeholder="Raffles City Chongqing"
                required
                autoFocus
                autoComplete="off"
                className="modal-input"
              />
              {suggestions.length > 0 && (
                <div
                  className="mt-2 rounded-xl border overflow-hidden overflow-y-auto"
                  style={{ borderColor: 'var(--ink-border)', maxHeight: '208px' }}
                >
                  {suggestions.slice(0, 5).map((suggestion) => (
                    <button
                      key={`${suggestion.placeId}-${suggestion.text}`}
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => handleSuggestionSelect(suggestion)}
                      className="block w-full text-left px-4 py-3 border-b last:border-b-0"
                      style={{ borderColor: 'var(--ink-border)', color: 'var(--cream-dim)' }}
                    >
                      <span className="font-mono text-xs block truncate" style={{ color: 'var(--cream)' }}>
                        {suggestion.mainText || suggestion.text}
                      </span>
                      {suggestion.secondaryText && (
                        <span className="font-body text-base block truncate">{suggestion.secondaryText}</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
              {searching && suggestions.length === 0 && (
                <p className="mt-2 font-mono text-[11px] tracking-[0.22em] uppercase" style={{ color: 'var(--cream-mute)' }}>
                  Searching...
                </p>
              )}
            </label>

            <div className="grid sm:grid-cols-2 gap-4">
              <label className="block">
                <span className="modal-label">Time</span>
                <input
                  type="time"
                  value={form.time}
                  onChange={set('time')}
                  className="modal-input"
                />
              </label>

              <label className="block">
                <span className="modal-label">Duration</span>
                <input
                  type="text"
                  value={form.duration}
                  onChange={set('duration')}
                  placeholder="1.5 hours"
                  className="modal-input"
                />
              </label>
            </div>

            <label className="block">
              <span className="modal-label">Type</span>
              <select value={form.type} onChange={set('type')} className="modal-input">
                {TYPE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="modal-label">Note</span>
              <textarea
                value={form.note}
                onChange={set('note')}
                placeholder="Tickets, directions, dish to try..."
                rows={3}
                className="modal-input"
                style={{ resize: 'none', lineHeight: 1.5 }}
              />
            </label>
          </div>

          {error && <p className="mt-4 font-mono text-xs" style={{ color: '#e05a5a' }}>{error}</p>}

          <div className="mt-6 flex items-center justify-end gap-3">
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
              disabled={!canSubmit || saving}
              className="px-5 py-3 rounded-xl font-mono text-xs tracking-[0.22em] uppercase inline-flex items-center gap-2"
              style={{ background: 'var(--gold)', color: 'var(--ink-deep)', opacity: !canSubmit || saving ? 0.6 : 1 }}
            >
              {saving ? 'Adding...' : 'Add Place'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
