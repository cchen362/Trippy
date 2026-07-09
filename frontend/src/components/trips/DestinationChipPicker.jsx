import { useRef, useState } from 'react';
import CityInput from '../logistics/CityInput.jsx';
import { bookingsApi } from '../../services/bookingsApi.js';

export default function DestinationChipPicker({ chips, onChange, lookupCities }) {
  const [query, setQuery] = useState('');
  const sessionTokenRef = useRef(null);
  if (!sessionTokenRef.current) {
    sessionTokenRef.current = crypto.randomUUID();
  }

  const fetchBoundsForChip = async (placeId, label) => {
    try {
      const { bounds } = await bookingsApi.lookupDestinationBounds(placeId, sessionTokenRef.current);
      if (!bounds) return;
      onChange((current) =>
        current.map((chip) =>
          (chip.placeId === placeId || chip.label === label) ? { ...chip, bounds } : chip
        )
      );
    } catch {
      // Bounds are an enrichment, not a requirement — chip stays fully functional without them.
    }
  };

  // All chip mutations use functional updates so an in-flight async bounds fetch (which
  // resolves after the add and patches via its own functional update) can never be
  // clobbered by a stale snapshot — the exact "chip added then lost on async resolve"
  // failure Plan 9 guards against. The dup check is authoritative inside the updater.
  const addChip = (suggestion) => {
    const city = suggestion.label?.trim();
    setQuery('');
    if (!city) return;
    const newChip = {
      label: city,
      countryCode: suggestion.countryCode || null,
      kind: suggestion.kind || null,
      placeId: suggestion.placeId ?? null,
      bounds: null,
    };
    onChange((prev) =>
      prev.some((chip) => chip.label.toLowerCase() === city.toLowerCase())
        ? prev
        : [...prev, newChip]
    );
    if (newChip.placeId) {
      fetchBoundsForChip(newChip.placeId, newChip.label);
    }
  };

  const addFreeText = (text) => {
    const city = text?.trim();
    setQuery('');
    if (!city) return;
    onChange((prev) =>
      prev.some((chip) => chip.label.toLowerCase() === city.toLowerCase())
        ? prev
        : [...prev, { label: city, countryCode: null, kind: 'freetext', placeId: null, bounds: null }]
    );
  };

  const removeChip = (label) => {
    onChange((prev) => prev.filter((chip) => chip.label !== label));
  };

  return (
    <div className="sm:col-span-2">
      <CityInput
        value={query}
        onChange={setQuery}
        onCitySelect={addChip}
        onFreeTextCommit={addFreeText}
        lookupCities={lookupCities ? (q) => lookupCities(q, sessionTokenRef.current) : lookupCities}
        placeholder="e.g. Chengdu"
        label="Destinations"
      />
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-3">
          {chips.map((chip) => (
            <button
              key={chip.label}
              type="button"
              onClick={() => removeChip(chip.label)}
              className="px-3 py-1.5 rounded-full font-mono text-[11px] tracking-[0.22em] uppercase transition-colors flex items-center gap-2"
              style={{ background: 'var(--ink-mid)', border: '1px solid var(--gold)', color: 'var(--gold)' }}
            >
              {chip.label}
              {chip.kind === 'freetext' && (
                <span
                  className="font-mono uppercase text-[10px] tracking-[0.22em]"
                  style={{ color: 'var(--cream-dim)' }}
                >
                  FREETEXT
                </span>
              )}
              <span aria-hidden="true">×</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
