import { useMemo, useState } from 'react';
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

export default function AddPlaceModal({ open, day, saving, onClose, onSubmit }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState(null);
  const canSubmit = useMemo(() => form.title.trim().length > 0, [form.title]);

  if (!open) return null;

  const set = (key) => (event) => {
    setForm((current) => ({ ...current, [key]: event.target.value }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!canSubmit) return;
    setError(null);

    const title = form.title.trim();
    try {
      await onSubmit({
        title,
        locationQuery: title,
        type: form.type,
        time: form.time || null,
        note: form.note.trim() || null,
        duration: form.duration.trim() || null,
      });
      setForm(EMPTY_FORM);
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
            <label className="block">
              <span className="modal-label">Place Name</span>
              <input
                type="text"
                value={form.title}
                onChange={set('title')}
                placeholder="Raffles City Chongqing"
                required
                autoFocus
                className="modal-input"
              />
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
