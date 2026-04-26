import { useEffect, useState } from 'react';

export default function CityInput({ value, onChange, onCitySelect, lookupCities, placeholder, label }) {
  const [suggestions, setSuggestions] = useState([]);
  const [searching, setSearching] = useState(false);
  // Track the last selected city text to suppress re-triggering autocomplete on it
  const [selectedText, setSelectedText] = useState('');

  useEffect(() => {
    const query = value?.trim() ?? '';
    if (query.length < 2 || (selectedText && value === selectedText)) {
      setSuggestions([]);
      return;
    }
    const timer = setTimeout(async () => {
      if (!lookupCities) return;
      setSearching(true);
      try {
        const response = await lookupCities(query);
        setSuggestions(response.suggestions || []);
      } catch {
        setSuggestions([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [value, lookupCities, selectedText]);

  const handleSelect = (suggestion) => {
    setSelectedText(suggestion.city);
    setSuggestions([]);
    onCitySelect(suggestion.city);
  };

  return (
    <label className="block">
      <span className="modal-label">{label}</span>
      <input
        value={value}
        onChange={(e) => {
          setSelectedText('');
          onChange(e.target.value);
        }}
        className={`modal-input${searching ? ' opacity-70' : ''}`}
        placeholder={placeholder}
      />
      {suggestions.length > 0 && (
        <div className="mt-2 rounded-xl border overflow-hidden" style={{ borderColor: 'var(--ink-border)' }}>
          {suggestions.slice(0, 5).map((s) => (
            <button
              key={`${s.city}-${s.country}`}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => handleSelect(s)}
              className="block w-full text-left px-4 py-3 border-b last:border-b-0"
              style={{ borderColor: 'var(--ink-border)', color: 'var(--cream-dim)' }}
            >
              <span className="font-mono text-xs block" style={{ color: 'var(--cream)' }}>
                {s.city}
              </span>
              {s.country && (
                <span className="font-body text-base">{s.country}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </label>
  );
}
