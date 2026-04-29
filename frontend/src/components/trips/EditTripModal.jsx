import { useState } from 'react';
import InterestTagPicker from './InterestTagPicker';

export default function EditTripModal({ trip, open, onClose, onSubmit, saving, onDelete, deleting }) {
  const [form, setForm] = useState({
    title: trip.title ?? '',
    endDate: trip.endDate ?? '',
    travellers: trip.travellers ?? 'couple',
    pace: trip.pace ?? 'moderate',
    interestTags: trip.interestTags ?? [],
  });
  const [error, setError] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (!open) return null;

  const handleClose = () => {
    setConfirmDelete(false);
    onClose();
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError(null);
    try {
      await onSubmit(form);
      onClose();
    } catch (err) {
      setError(err.message);
    }
  };

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  return (
    <div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-4">
      <div className="w-full max-w-2xl rounded-[22px] border" style={{ background: 'var(--ink-surface)', borderColor: 'var(--ink-border)' }}>
        <form onSubmit={handleSubmit} className="p-5 sm:p-7">
          <div className="flex items-start justify-between gap-4 mb-6">
            <div>
              <p className="font-mono text-[11px] tracking-[0.28em] uppercase mb-2" style={{ color: 'var(--gold)' }}>
                Edit Trip
              </p>
              <h2 className="font-display italic text-3xl" style={{ color: 'var(--cream)' }}>
                Refine the plan.
              </h2>
            </div>
            <button type="button" onClick={handleClose} className="font-mono text-xs tracking-[0.24em] uppercase" style={{ color: 'var(--cream-dim)' }}>
              Close
            </button>
          </div>

          <div className="grid sm:grid-cols-2 gap-4">
            <label className="block sm:col-span-2">
              <span className="font-mono text-[11px] tracking-[0.22em] uppercase mb-2 block" style={{ color: 'var(--cream-mute)' }}>
                Trip Title
              </span>
              <input
                type="text"
                value={form.title}
                onChange={set('title')}
                required
                className="w-full px-4 py-3 rounded-xl font-mono text-sm"
                style={{ background: 'var(--ink-mid)', border: '1px solid var(--ink-border)', color: 'var(--cream)' }}
              />
            </label>

            <label className="block">
              <span className="font-mono text-[11px] tracking-[0.22em] uppercase mb-2 block" style={{ color: 'var(--cream-mute)' }}>
                Start Date
              </span>
              <input
                type="date"
                value={trip.startDate}
                disabled
                className="w-full px-4 py-3 rounded-xl font-mono text-sm opacity-40 cursor-not-allowed"
                style={{ background: 'var(--ink-mid)', border: '1px solid var(--ink-border)', color: 'var(--cream)' }}
              />
              <span className="font-mono text-[10px] tracking-[0.14em] mt-1 block" style={{ color: 'rgba(240,234,216,0.35)' }}>
                Start date cannot be changed
              </span>
            </label>

            <label className="block">
              <span className="font-mono text-[11px] tracking-[0.22em] uppercase mb-2 block" style={{ color: 'var(--cream-mute)' }}>
                End Date
              </span>
              <input
                type="date"
                value={form.endDate}
                min={trip.startDate}
                onChange={set('endDate')}
                className="w-full px-4 py-3 rounded-xl font-mono text-sm"
                style={{ background: 'var(--ink-mid)', border: '1px solid var(--ink-border)', color: 'var(--cream)' }}
              />
              {form.endDate < trip.endDate && (
                <span className="font-mono text-[10px] tracking-[0.14em] mt-1 block" style={{ color: '#e08a3a' }}>
                  Shortening will remove later days (blocked if they have stops)
                </span>
              )}
            </label>

            <label className="block">
              <span className="font-mono text-[11px] tracking-[0.22em] uppercase mb-2 block" style={{ color: 'var(--cream-mute)' }}>
                Travellers
              </span>
              <select
                value={form.travellers}
                onChange={set('travellers')}
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
                onChange={set('pace')}
                className="w-full px-4 py-3 rounded-xl font-mono text-sm"
                style={{ background: 'var(--ink-mid)', border: '1px solid var(--ink-border)', color: 'var(--cream)' }}
              >
                <option value="slow">Slow</option>
                <option value="moderate">Moderate</option>
                <option value="fast">Fast</option>
              </select>
            </label>

            <InterestTagPicker
              selected={form.interestTags}
              onChange={(tags) => setForm((f) => ({ ...f, interestTags: tags }))}
            />
          </div>

          {error && <p className="mt-4 font-mono text-xs" style={{ color: '#e05a5a' }}>{error}</p>}

          <div className="mt-6 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              {confirmDelete ? (
                <>
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(false)}
                    className="px-3 py-2 rounded-xl font-mono text-xs tracking-[0.22em] uppercase border"
                    style={{ color: 'var(--cream-dim)', borderColor: 'var(--ink-border)' }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={onDelete}
                    disabled={deleting}
                    className="px-4 py-2 rounded-xl font-mono text-xs tracking-[0.22em] uppercase"
                    style={{ background: '#c0392b', color: '#fff', opacity: deleting ? 0.6 : 1 }}
                  >
                    {deleting ? 'Deleting…' : 'Confirm delete'}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  className="px-3 py-2 rounded-xl font-mono text-xs tracking-[0.22em] uppercase border"
                  style={{ color: '#c0392b', borderColor: 'rgba(192,57,43,0.3)' }}
                >
                  Delete trip
                </button>
              )}
            </div>
            <div className="flex items-center gap-3">
              <button type="button" onClick={handleClose} className="px-4 py-3 rounded-xl font-mono text-xs tracking-[0.22em] uppercase border" style={{ color: 'var(--cream-dim)', borderColor: 'var(--ink-border)' }}>
                Cancel
              </button>
              <button
                type="submit"
                disabled={!form.title.trim() || saving}
                className="px-5 py-3 rounded-xl font-mono text-xs tracking-[0.22em] uppercase"
                style={{ background: 'var(--gold)', color: 'var(--ink-deep)', opacity: !form.title.trim() || saving ? 0.6 : 1 }}
              >
                {saving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
