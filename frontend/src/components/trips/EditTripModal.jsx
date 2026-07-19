import { useEffect, useRef, useState } from 'react';
import InterestTagPicker from './InterestTagPicker';
import DestinationChipPicker from './DestinationChipPicker';
import ModalShell from '../shell/ModalShell';
import { dayDisplayLabel } from '../../utils/dayGeo.js';
import { canonicalGeoKey } from '../../utils/geoIdentity.js';

// Pre-fill source for the destination chips: prefer trip.scopes — the durable,
// position-ordered scope list Plan 9 introduced — since it's the source of truth for
// "what destinations does this trip cover" independent of day-level resolution. Falls
// back to the older per-day resolved pairs / destinations-zip logic only for cached
// payloads that predate scopes (bounds/placeId are not carried in scopes, so those
// fields are null — the picker re-derives them lazily if the chip is re-added).
function deriveInitialChips(trip, days) {
  if (Array.isArray(trip.scopes) && trip.scopes.length > 0) {
    return trip.scopes.map((scope) => ({
      label: scope.label,
      countryCode: scope.countryCode ?? null,
      kind: scope.kind ?? null,
      placeId: null,
      bounds: null,
    }));
  }

  if (Array.isArray(days) && days.length > 0) {
    const chips = [];
    const seen = new Set();
    for (const day of days) {
      const city = dayDisplayLabel(day);
      if (!city || seen.has(city)) continue;
      seen.add(city);
      chips.push({ label: city, countryCode: day.resolvedCountry ?? null, kind: null, placeId: null, bounds: null });
    }
    if (chips.length > 0) return chips;
  }

  const destinations = trip.destinations ?? [];
  const destinationCountries = trip.destinationCountries ?? [];
  return destinations.map((city, i) => ({
    label: city,
    countryCode: destinationCountries[i] ?? null,
    kind: null,
    placeId: null,
    bounds: null,
  }));
}

// Count how many of the trip's currently-resolved days still show this label, for the
// honest "removing this chip doesn't rename days" note.
function countResolvedDaysMatching(days, label) {
  if (!Array.isArray(days) || !label) return 0;
  const key = canonicalGeoKey(label);
  return days.filter((day) => canonicalGeoKey(dayDisplayLabel(day)) === key).length;
}

export default function EditTripModal({ trip, days, open, onClose, onSubmit, saving, onDelete, deleting, lookupCities }) {
  const [form, setForm] = useState({
    title: trip.title ?? '',
    endDate: trip.endDate ?? '',
    travellers: trip.travellers ?? 'couple',
    pace: trip.pace ?? 'moderate',
    interestTags: trip.interestTags ?? [],
  });
  const [destinationChips, setDestinationChips] = useState(() => deriveInitialChips(trip, days));
  const [removalNote, setRemovalNote] = useState(null);
  const [error, setError] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // ModalShell keeps the parent mounted while closed (unlike the old early-return-null
  // panel, which unmounted and therefore always remounted with fresh state). Re-seed the
  // form from `trip` whenever the modal transitions to open so a stale edit from a
  // previous open (or a different trip) never leaks into the next one.
  useEffect(() => {
    if (!open) return;
    setForm({
      title: trip.title ?? '',
      endDate: trip.endDate ?? '',
      travellers: trip.travellers ?? 'couple',
      pace: trip.pace ?? 'moderate',
      interestTags: trip.interestTags ?? [],
    });
    setDestinationChips(deriveInitialChips(trip, days));
    setRemovalNote(null);
    setError(null);
    setConfirmDelete(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, trip]);

  // The picker owns chip-list integrity (it uses functional onChange updates so async
  // bounds fetches can't clobber a just-added chip), so we hand it setDestinationChips
  // directly. The removal note is a pure function of chip transitions, computed here by
  // diffing the current chips against the previous render's value — never by resolving
  // the picker's update against a stale snapshot, which would defeat the functional update.
  const prevChipsRef = useRef(destinationChips);
  useEffect(() => {
    const prev = prevChipsRef.current;
    if (destinationChips.length < prev.length) {
      const removed = prev.find(
        (chip) => !destinationChips.some((next) => next.label === chip.label)
      );
      const matchCount = removed ? countResolvedDaysMatching(days, removed.label) : 0;
      setRemovalNote(
        matchCount > 0
          ? `${matchCount} day${matchCount === 1 ? '' : 's'} still show ${removed.label} — days keep their identity; edit day headers or bookings to change them`
          : null
      );
    } else if (destinationChips.length > prev.length) {
      setRemovalNote(null);
    }
    prevChipsRef.current = destinationChips;
  }, [destinationChips, days]);

  const handleClose = () => {
    setConfirmDelete(false);
    onClose();
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError(null);
    const payload = {
      ...form,
      destinations: destinationChips.map((chip) => ({
        city: chip.label,
        countryCode: chip.countryCode || null,
        kind: chip.kind || null,
        placeId: chip.placeId || null,
        bounds: chip.bounds || null,
      })),
    };
    try {
      await onSubmit(payload);
      onClose();
    } catch (err) {
      setError(err.message);
    }
  };

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const formId = 'edit-trip-form';

  return (
    <ModalShell
      open={open}
      onRequestClose={handleClose}
      eyebrow="Edit Trip"
      headline="Refine the plan."
      maxWidth="2xl"
      footer={
        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={handleClose}
            className="px-4 py-3 rounded-xl font-mono text-xs tracking-[0.22em] uppercase border"
            style={{ color: 'var(--cream-dim)', borderColor: 'var(--ink-border)' }}
          >
            Cancel
          </button>
          <button
            type="submit"
            form={formId}
            disabled={!form.title.trim() || saving}
            className="px-5 py-3 rounded-xl font-mono text-xs tracking-[0.22em] uppercase"
            style={{ background: 'var(--gold)', color: 'var(--ink-deep)', opacity: !form.title.trim() || saving ? 0.6 : 1 }}
          >
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      }
    >
      <form id={formId} onSubmit={handleSubmit} className="pb-6">
        <div className="grid sm:grid-cols-2 gap-4">
          <label className="block sm:col-span-2">
            <span className="modal-label">Trip Title</span>
            <input
              type="text"
              value={form.title}
              onChange={set('title')}
              required
              className="modal-input"
            />
          </label>

          <DestinationChipPicker
            chips={destinationChips}
            onChange={setDestinationChips}
            lookupCities={lookupCities}
          />
          {removalNote && (
            <p className="sm:col-span-2 -mt-2 font-mono text-[11px] tracking-[0.08em]" style={{ color: 'var(--cream-dim)' }}>
              {removalNote}
            </p>
          )}

          <label className="block">
            <span className="modal-label">Start Date</span>
            <input
              type="date"
              value={trip.startDate}
              disabled
              className="modal-input opacity-40 cursor-not-allowed"
            />
            <span className="font-mono text-[10px] tracking-[0.14em] mt-1 block" style={{ color: 'rgba(240,234,216,0.35)' }}>
              Start date cannot be changed
            </span>
          </label>

          <label className="block">
            <span className="modal-label">End Date</span>
            <input
              type="date"
              value={form.endDate}
              min={trip.startDate}
              onChange={set('endDate')}
              className="modal-input"
            />
            {form.endDate < trip.endDate && (
              <span className="font-mono text-[10px] tracking-[0.14em] mt-1 block" style={{ color: '#e08a3a' }}>
                Shortening will remove later days (blocked if they have stops)
              </span>
            )}
          </label>

          <label className="block">
            <span className="modal-label">Travellers</span>
            <select
              value={form.travellers}
              onChange={set('travellers')}
              className="modal-input"
            >
              <option value="solo">Solo</option>
              <option value="couple">Couple</option>
              <option value="family">Family</option>
              <option value="friends">Friends</option>
            </select>
          </label>

          <label className="block">
            <span className="modal-label">Pace</span>
            <select
              value={form.pace}
              onChange={set('pace')}
              className="modal-input"
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

        <div className="mt-8 pt-6" style={{ borderTop: '1px solid var(--ink-border)' }}>
          {confirmDelete ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="px-3 py-2 rounded-xl font-mono text-xs tracking-[0.22em] uppercase border min-h-[44px]"
                style={{ color: 'var(--cream-dim)', borderColor: 'var(--ink-border)' }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onDelete}
                disabled={deleting}
                className="modal-danger-fill px-4 py-2 rounded-xl font-mono text-xs tracking-[0.22em] uppercase min-h-[44px]"
                style={{ opacity: deleting ? 0.6 : 1 }}
              >
                {deleting ? 'Deleting…' : 'Confirm delete'}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="modal-danger-text modal-danger-border px-3 py-2 rounded-xl font-mono text-xs tracking-[0.22em] uppercase border min-h-[44px]"
            >
              Delete trip
            </button>
          )}
        </div>
      </form>
    </ModalShell>
  );
}
