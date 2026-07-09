import { useState } from 'react';
import CityInput from '../logistics/CityInput.jsx';

export default function DestinationChipPicker({ chips, onChange, lookupCities }) {
  const [query, setQuery] = useState('');

  const addChip = (suggestion) => {
    const city = suggestion.label?.trim();
    setQuery('');
    if (!city || chips.some((chip) => chip.label.toLowerCase() === city.toLowerCase())) return;
    onChange([...chips, { label: city, countryCode: suggestion.countryCode || null, kind: suggestion.kind || null }]);
  };

  const removeChip = (label) => {
    onChange(chips.filter((chip) => chip.label !== label));
  };

  return (
    <div className="sm:col-span-2">
      <CityInput
        value={query}
        onChange={setQuery}
        onCitySelect={addChip}
        lookupCities={lookupCities}
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
              <span aria-hidden="true">×</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
