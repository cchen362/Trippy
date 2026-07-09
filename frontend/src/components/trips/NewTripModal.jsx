import { useMemo, useState } from 'react';
import InterestTagPicker from './InterestTagPicker';
import DestinationChipPicker from './DestinationChipPicker';
import CaptureInput from '../import/CaptureInput.jsx';
import { importApi, fileToInput, textToInput, MAX_INPUTS } from '../../services/importApi.js';
import { toBookingConfirmPayload } from '../../services/bookingPayload.js';

const EMPTY_FORM = {
  title: '',
  startDate: '',
  endDate: '',
  travellers: 'couple',
  interestTags: [],
  pace: 'moderate',
};

const TRANSIT_TYPES = ['flight', 'train', 'bus'];

// Chips = unique {city, country} pairs in chronological booking order; dates = the
// span across every extracted booking; title = "{firstCity} {Month YYYY}".
// destinations/destinationCountries are independent arrays on the trip record, not a
// 1:1 pairing — chips just happen to carry both fields together here.
function deriveTripPrefill(extraction) {
  const bookings = extraction.bookings || [];
  const sorted = [...bookings].sort((a, b) => (a.startDatetime || '').localeCompare(b.startDatetime || ''));

  const chips = [];
  const seen = new Set();
  for (const booking of sorted) {
    const details = booking.detailsJson || {};
    const candidates = TRANSIT_TYPES.includes(booking.type)
      ? [
          { city: details.originCity, country: details.originCountryCode },
          { city: details.destinationCity, country: details.destinationCountryCode },
        ]
      : [{ city: details.city, country: details.countryCode || null }];
    for (const { city, country } of candidates) {
      if (!city || seen.has(city)) continue;
      seen.add(city);
      chips.push({ city, country: country || null });
    }
  }

  const allDates = bookings.flatMap((b) => [b.startDatetime, b.endDatetime]).filter(Boolean);
  const startDate = allDates.length ? allDates.reduce((min, d) => (d < min ? d : min)).slice(0, 10) : '';
  const endDate = allDates.length ? allDates.reduce((max, d) => (d > max ? d : max)).slice(0, 10) : '';

  let suggestedTitle = '';
  if (chips[0]?.city && startDate) {
    const monthYear = new Date(`${startDate}T00:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    suggestedTitle = `${chips[0].city} ${monthYear}`;
  }

  return { chips, startDate, endDate, suggestedTitle };
}

export default function NewTripModal({ open, onClose, onSubmit, saving, lookupCities }) {
  const [phase, setPhase] = useState('capture'); // 'capture' | 'details'
  const [form, setForm] = useState(EMPTY_FORM);
  const [destinationChips, setDestinationChips] = useState([]);
  const [error, setError] = useState(null);

  const [inputs, setInputs] = useState([]);
  const [pastedText, setPastedText] = useState('');
  const [inputError, setInputError] = useState(null);
  const [extracting, setExtracting] = useState(false);
  const [emptySummary, setEmptySummary] = useState(null);
  const [captureResult, setCaptureResult] = useState(null); // { artifactId, bookings }

  const canSubmit = useMemo(() => (
    form.title && form.startDate && form.endDate && destinationChips.length > 0
  ), [form, destinationChips]);

  if (!open) return null;

  const resetAll = () => {
    setPhase('capture');
    setForm(EMPTY_FORM);
    setDestinationChips([]);
    setError(null);
    setInputs([]);
    setPastedText('');
    setInputError(null);
    setExtracting(false);
    setEmptySummary(null);
    setCaptureResult(null);
  };

  const handleClose = () => {
    resetAll();
    onClose();
  };

  const totalInputCount = inputs.length + (pastedText.trim() ? 1 : 0);

  const handleAddFiles = async (fileList) => {
    setInputError(null);
    const files = Array.from(fileList);
    if (totalInputCount + files.length > MAX_INPUTS) {
      setInputError(`Only ${MAX_INPUTS} inputs allowed — remove some first.`);
      return;
    }
    for (const file of files) {
      try {
        const input = await fileToInput(file);
        setInputs((current) => [...current, { ...input, localId: crypto.randomUUID() }]);
      } catch (err) {
        setInputError(err.message);
      }
    }
  };

  const handleRemoveInput = (localId) => {
    setInputs((current) => current.filter((input) => input.localId !== localId));
  };

  const handleExtract = async () => {
    setInputError(null);
    setEmptySummary(null);

    let textInput = null;
    try {
      textInput = textToInput(pastedText);
    } catch (err) {
      setInputError(err.message);
      return;
    }
    const allInputs = [
      ...inputs.map(({ kind, mediaType, filename, content }) => ({ kind, mediaType, filename, content })),
      ...(textInput ? [textInput] : []),
    ];
    if (allInputs.length === 0) {
      setInputError('Add at least one screenshot, PDF, or pasted text.');
      return;
    }

    setExtracting(true);
    try {
      const { artifact, extraction } = await importApi.createArtifact({ tripId: null, inputs: allInputs });
      if (!extraction.isTravelRelated || extraction.bookings.length === 0) {
        setEmptySummary(extraction.summary || "We couldn't find any bookings in that.");
        return;
      }
      const prefill = deriveTripPrefill(extraction);
      setForm((current) => ({
        ...current,
        title: prefill.suggestedTitle || current.title,
        startDate: prefill.startDate || current.startDate,
        endDate: prefill.endDate || current.endDate,
      }));
      setDestinationChips(prefill.chips.map(({ city, country }) => ({ city, country })));
      setCaptureResult({ artifactId: artifact.id, bookings: extraction.bookings });
      setPhase('details');
    } catch (err) {
      setInputError(err.message);
    } finally {
      setExtracting(false);
    }
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError(null);
    const payload = {
      ...form,
      destinations: destinationChips.map((chip) => ({ city: chip.label, countryCode: chip.countryCode || null })),
    };
    if (captureResult) {
      payload.captureArtifactId = captureResult.artifactId;
      payload.captureBookings = captureResult.bookings.map(toBookingConfirmPayload);
    }
    try {
      await onSubmit(payload);
      resetAll();
    } catch (err) {
      setError(err.message);
    }
  };

  const isDetails = phase === 'details';

  return (
    <div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-4">
      <div className="w-full max-w-2xl rounded-[22px] border" style={{ background: 'var(--ink-surface)', borderColor: 'var(--ink-border)' }}>
        <div className="p-5 sm:p-7 max-h-[85vh] overflow-y-auto">
          <div className="flex items-start justify-between gap-4 mb-6">
            <div>
              <p className="font-mono text-[11px] tracking-[0.28em] uppercase mb-2" style={{ color: 'var(--gold)' }}>
                New Trip
              </p>
              <h2 className="font-display italic text-3xl" style={{ color: 'var(--cream)' }}>
                {isDetails ? 'Sketch the journey.' : 'Dump your travel chaos here.'}
              </h2>
            </div>
            <button type="button" onClick={handleClose} className="font-mono text-xs tracking-[0.24em] uppercase" style={{ color: 'var(--cream-dim)' }}>
              Close
            </button>
          </div>

          {!isDetails && (
            <>
              <CaptureInput
                inputs={inputs}
                pastedText={pastedText}
                onPastedTextChange={setPastedText}
                onAddFiles={handleAddFiles}
                onRemoveInput={handleRemoveInput}
                onExtract={handleExtract}
                extracting={extracting}
                error={inputError}
              />

              {emptySummary && (
                <p className="mt-3 font-body text-base" style={{ color: 'var(--cream-dim)' }}>
                  {emptySummary}
                </p>
              )}

              <button
                type="button"
                onClick={() => setPhase('details')}
                className="mt-4 font-mono text-xs tracking-[0.24em] uppercase underline underline-offset-4"
                style={{ color: 'var(--cream-dim)' }}
              >
                Skip — start from scratch
              </button>
            </>
          )}

          {isDetails && (
            <form onSubmit={handleSubmit}>
              <div className="grid sm:grid-cols-2 gap-4">
                <label className="block sm:col-span-2">
                  <span className="modal-label">Trip Title</span>
                  <input
                    value={form.title}
                    onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
                    className="modal-input"
                  />
                </label>

                <DestinationChipPicker
                  chips={destinationChips}
                  onChange={setDestinationChips}
                  lookupCities={lookupCities}
                />

                <label className="block">
                  <span className="modal-label">Start Date</span>
                  <input
                    type="date"
                    value={form.startDate}
                    onChange={(event) => setForm((current) => ({ ...current, startDate: event.target.value }))}
                    className="modal-input"
                  />
                </label>

                <label className="block">
                  <span className="modal-label">End Date</span>
                  <input
                    type="date"
                    value={form.endDate}
                    onChange={(event) => setForm((current) => ({ ...current, endDate: event.target.value }))}
                    className="modal-input"
                  />
                </label>

                <InterestTagPicker
                  selected={form.interestTags}
                  onChange={(tags) => setForm((current) => ({ ...current, interestTags: tags }))}
                />

                <label className="block">
                  <span className="modal-label">Travellers</span>
                  <select
                    value={form.travellers}
                    onChange={(event) => setForm((current) => ({ ...current, travellers: event.target.value }))}
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
                    onChange={(event) => setForm((current) => ({ ...current, pace: event.target.value }))}
                    className="modal-input"
                  >
                    <option value="slow">Slow</option>
                    <option value="moderate">Moderate</option>
                    <option value="fast">Fast</option>
                  </select>
                </label>
              </div>

              {error && <p className="mt-4 font-mono text-xs" style={{ color: '#e05a5a' }}>{error}</p>}

              <div className="mt-6 flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={() => setPhase('capture')}
                  className="font-mono text-xs tracking-[0.22em] uppercase"
                  style={{ color: 'var(--cream-dim)' }}
                >
                  ‹ Back
                </button>
                <div className="flex items-center gap-3">
                  <button type="button" onClick={handleClose} className="px-4 py-3 rounded-xl font-mono text-xs tracking-[0.22em] uppercase border" style={{ color: 'var(--cream-dim)', borderColor: 'var(--ink-border)' }}>
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
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
