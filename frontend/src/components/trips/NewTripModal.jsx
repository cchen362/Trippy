import { useMemo, useState } from 'react';
import InterestTagPicker from './InterestTagPicker';

const EMPTY_FORM = {
  title: '',
  destinations: '',
  destinationCountries: '',
  startDate: '',
  endDate: '',
  travellers: 'couple',
  interestTags: [],
  pace: 'moderate',
};

function parseList(value) {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

export default function NewTripModal({ open, onClose, onSubmit, saving }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState(null);

  const canSubmit = useMemo(() => (
    form.title && form.startDate && form.endDate && form.destinations
  ), [form]);

  if (!open) return null;

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError(null);
    try {
      await onSubmit({
        ...form,
        destinations: parseList(form.destinations),
        destinationCountries: parseList(form.destinationCountries),
      });
      setForm(EMPTY_FORM);
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-4">
      <div className="w-full max-w-2xl rounded-[22px] border" style={{ background: 'var(--ink-surface)', borderColor: 'var(--ink-border)' }}>
        <form onSubmit={handleSubmit} className="p-5 sm:p-7">
          <div className="flex items-start justify-between gap-4 mb-6">
            <div>
              <p className="font-mono text-[11px] tracking-[0.28em] uppercase mb-2" style={{ color: 'var(--gold)' }}>
                New Trip
              </p>
              <h2 className="font-display italic text-3xl" style={{ color: 'var(--cream)' }}>
                Sketch the journey.
              </h2>
            </div>
            <button type="button" onClick={onClose} className="font-mono text-xs tracking-[0.24em] uppercase" style={{ color: 'var(--cream-dim)' }}>
              Close
            </button>
          </div>

          <div className="grid sm:grid-cols-2 gap-4">
            {[
              ['title', 'Trip Title'],
              ['destinations', 'Destinations (comma separated)'],
              ['destinationCountries', 'Country Codes (comma separated)'],
              ['startDate', 'Start Date', 'date'],
              ['endDate', 'End Date', 'date'],
            ].map(([name, label, type = 'text']) => (
              <label key={name} className="block">
                <span className="font-mono text-[11px] tracking-[0.22em] uppercase mb-2 block" style={{ color: 'var(--cream-mute)' }}>
                  {label}
                </span>
                <input
                  type={type}
                  value={form[name]}
                  onChange={(event) => setForm((current) => ({ ...current, [name]: event.target.value }))}
                  className="w-full px-4 py-3 rounded-xl font-mono text-sm"
                  style={{ background: 'var(--ink-mid)', border: '1px solid var(--ink-border)', color: 'var(--cream)' }}
                />
              </label>
            ))}

            <InterestTagPicker
              selected={form.interestTags}
              onChange={(tags) => setForm((current) => ({ ...current, interestTags: tags }))}
            />

            <label className="block">
              <span className="font-mono text-[11px] tracking-[0.22em] uppercase mb-2 block" style={{ color: 'var(--cream-mute)' }}>
                Travellers
              </span>
              <select
                value={form.travellers}
                onChange={(event) => setForm((current) => ({ ...current, travellers: event.target.value }))}
                className="w-full px-4 py-3 rounded-xl font-mono text-sm"
                style={{ background: 'var(--ink-mid)', border: '1px solid var(--ink-border)', color: 'var(--cream)' }}
              >
                <option value="solo">Solo</option>
                <option value="couple">Couple</option>
                <option value="family">Family</option>
                <option value="friends">Friends</option>
              </select>
            </label>

            <label className="block">
              <span className="font-mono text-[11px] tracking-[0.22em] uppercase mb-2 block" style={{ color: 'var(--cream-mute)' }}>
                Pace
              </span>
              <select
                value={form.pace}
                onChange={(event) => setForm((current) => ({ ...current, pace: event.target.value }))}
                className="w-full px-4 py-3 rounded-xl font-mono text-sm"
                style={{ background: 'var(--ink-mid)', border: '1px solid var(--ink-border)', color: 'var(--cream)' }}
              >
                <option value="slow">Slow</option>
                <option value="moderate">Moderate</option>
                <option value="fast">Fast</option>
              </select>
            </label>
          </div>

          {error && <p className="mt-4 font-mono text-xs" style={{ color: '#e05a5a' }}>{error}</p>}

          <div className="mt-6 flex items-center justify-end gap-3">
            <button type="button" onClick={onClose} className="px-4 py-3 rounded-xl font-mono text-xs tracking-[0.22em] uppercase border" style={{ color: 'var(--cream-dim)', borderColor: 'var(--ink-border)' }}>
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit || saving}
              className="px-5 py-3 rounded-xl font-mono text-xs tracking-[0.22em] uppercase"
              style={{ background: 'var(--gold)', color: 'var(--ink-deep)', opacity: !canSubmit || saving ? 0.6 : 1 }}
            >
              {saving ? 'Creating...' : 'Create Trip'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
