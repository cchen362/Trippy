import { useState } from 'react';
import ModalShell from '../shell/ModalShell.jsx';
import ErrorBanner from '../common/ErrorBanner.jsx';
import { COMMON_CURRENCIES } from '../../utils/currency.js';

// First-open prompt when trip.summaryCurrency is null — one select, saves via
// the trip edit endpoint's `summaryCurrency` field (D7).
export default function SummaryCurrencyPrompt({ open, onSave, saving }) {
  const [currency, setCurrency] = useState('SGD');
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      await onSave(currency);
    } catch (err) {
      setError(err.message || 'Could not save your summary currency.');
    }
  };

  const formId = 'summary-currency-form';

  return (
    <ModalShell
      open={open}
      onRequestClose={() => {}}
      headerAccessory={<span />}
      zBase={220}
      eyebrow="Trip expenses"
      headline="What currency should totals show in?"
      maxWidth="xl"
      footer={
        <div className="flex justify-end">
          <button
            type="submit"
            form={formId}
            disabled={saving}
            className="px-5 py-3 rounded-xl font-mono text-xs tracking-[0.22em] uppercase"
            style={{ background: 'var(--gold)', color: 'var(--ink-deep)', opacity: saving ? 0.6 : 1 }}
          >
            {saving ? 'Saving...' : 'Start tracking'}
          </button>
        </div>
      }
    >
      <form id={formId} onSubmit={handleSubmit} className="pb-6 space-y-4">
        <p className="font-body text-base" style={{ color: 'var(--cream-dim)' }}>
          Expenses logged in other currencies will be converted here for the totals. You can change this later in trip settings.
        </p>
        <ErrorBanner message={error} onDismiss={() => setError(null)} />
        <label className="block">
          <span className="modal-label">Summary currency</span>
          <select value={currency} onChange={(e) => setCurrency(e.target.value)} className="modal-input">
            {COMMON_CURRENCIES.map((code) => <option key={code} value={code}>{code}</option>)}
          </select>
        </label>
      </form>
    </ModalShell>
  );
}
