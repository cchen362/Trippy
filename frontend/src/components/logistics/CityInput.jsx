import { useEffect, useState } from 'react';

export default function CityInput({ value, onChange, onCitySelect, onFreeTextCommit, lookupCities, placeholder, label }) {
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
    setSelectedText(suggestion.label);
    setSuggestions([]);
    onCitySelect(suggestion);
  };

  const handleKeyDown = (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const text = value?.trim();
    if (!text) return;
    setSelectedText(text);
    setSuggestions([]);
    if (onFreeTextCommit) {
      onFreeTextCommit(text);
    } else {
      onCitySelect({ label: text, countryCode: null, kind: 'freetext', placeId: null });
    }
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
        onKeyDown={handleKeyDown}
        className={`modal-input${searching ? ' opacity-70' : ''}`}
        placeholder={placeholder}
      />
      {suggestions.length > 0 && (
        <div className="mt-2 rounded-xl border overflow-hidden" style={{ borderColor: 'var(--ink-border)' }}>
          {suggestions.slice(0, 5).map((s) => (
            <button
              key={`${s.label}-${s.countryCode}`}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => handleSelect(s)}
              className="block w-full text-left px-4 py-3 border-b last:border-b-0"
              style={{ borderColor: 'var(--ink-border)', color: 'var(--cream-dim)' }}
            >
              <span className="font-mono text-xs block" style={{ color: 'var(--cream)' }}>
                {s.label}
                {s.kind === 'region' && (
                  <span
                    className="font-mono uppercase text-[11px] tracking-[0.22em] ml-2"
                    style={{ color: 'var(--cream-dim)' }}
                  >
                    REGION
                  </span>
                )}
              </span>
              {s.countryCode && (
                <span className="font-body text-base">{s.countryCode}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </label>
  );
}
