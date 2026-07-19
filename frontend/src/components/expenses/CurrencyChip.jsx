import { useMemo, useState } from 'react';
import ModalShell from '../shell/ModalShell.jsx';
import { COMMON_CURRENCIES } from '../../utils/currency.js';

// Inline chip next to the amount field. Tapping opens a small ModalShell
// sheet with a searchable list of currency codes (D3: one tap to change).
export default function CurrencyChip({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const options = useMemo(() => {
    const q = query.trim().toUpperCase();
    const codes = COMMON_CURRENCIES.includes(value) ? COMMON_CURRENCIES : [value, ...COMMON_CURRENCIES];
    return q ? codes.filter((code) => code.includes(q)) : codes;
  }, [query, value]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="pill shrink-0"
        style={{ color: 'var(--gold)', borderColor: 'var(--gold-line, var(--ink-border))' }}
        aria-label={`Currency: ${value}. Tap to change.`}
      >
        {value}
      </button>
      <ModalShell
        open={open}
        onRequestClose={() => setOpen(false)}
        zBase={260}
        eyebrow="Currency"
        headline="Choose a currency"
        maxWidth="xl"
      >
        <div className="space-y-4 pb-4">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search currency code..."
            className="modal-input"
            autoFocus
          />
          <div className="grid grid-cols-3 gap-2">
            {options.map((code) => (
              <button
                key={code}
                type="button"
                onClick={() => { onChange(code); setOpen(false); setQuery(''); }}
                className="rounded-xl border px-3 py-3 font-mono text-xs tracking-[0.14em] uppercase"
                style={{
                  borderColor: code === value ? 'var(--gold)' : 'var(--ink-border)',
                  color: code === value ? 'var(--gold)' : 'var(--cream-dim)',
                  background: code === value ? 'rgba(201,168,76,0.08)' : 'transparent',
                }}
              >
                {code}
              </button>
            ))}
            {options.length === 0 && (
              <p className="col-span-3 font-body text-base" style={{ color: 'var(--cream-dim)' }}>
                No currency matches "{query}".
              </p>
            )}
          </div>
        </div>
      </ModalShell>
    </>
  );
}
