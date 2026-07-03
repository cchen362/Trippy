import { useState } from 'react';
import CityInput from '../logistics/CityInput.jsx';

export default function DestinationChipPicker({ chips, onChange, lookupCities }) {
  const [query, setQuery] = useState('');

  const addChip = (suggestion) => {
    const city = suggestion.city?.trim();
    setQuery('');
    if (!city || chips.some((chip) => chip.city.toLowerCase() === city.toLowerCase())) return;
    onChange([...chips, { city, country: suggestion.country || null }]);
  };

  const removeChip = (city) => {
    onChange(chips.filter((chip) => chip.city !== city));
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
              key={chip.city}
              type="button"
              onClick={() => removeChip(chip.city)}
              className="px-3 py-1.5 rounded-full font-mono text-[11px] tracking-[0.22em] uppercase transition-colors flex items-center gap-2"
              style={{ background: 'var(--ink-mid)', border: '1px solid var(--gold)', color: 'var(--gold)' }}
            >
              {chip.city}
              <span aria-hidden="true">×</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
