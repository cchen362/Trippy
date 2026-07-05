import { useState } from 'react';
import AddBookingModal from '../logistics/AddBookingModal.jsx';
import CaptureInput from './CaptureInput.jsx';
import ExtractionReview from './ExtractionReview.jsx';
import { importApi, fileToInput, textToInput, MAX_INPUTS } from '../../services/importApi.js';
import { tripsApi } from '../../services/tripsApi.js';
import { toBookingConfirmPayload } from '../../services/bookingPayload.js';

function buildDraftBookings(bookings, warnings) {
  return bookings.map((data, index) => ({
    localId: `b${index}`,
    included: !warnings.some((w) => w.type === 'duplicate' && w.bookingIndex === index),
    data,
    warnings: warnings.filter((w) => w.bookingIndex === index),
  }));
}

export default function CaptureFlow({
  open,
  onClose,
  tripId,
  tripDates,
  onConfirmed,
  lookupHotels,
  lookupHotelDetails,
  lookupFlight,
  lookupCities,
}) {
  const [phase, setPhase] = useState('input'); // 'input' | 'extracting' | 'review'
  const [inputs, setInputs] = useState([]);
  const [pastedText, setPastedText] = useState('');
  const [inputError, setInputError] = useState(null);
  const [artifact, setArtifact] = useState(null);
  const [extraction, setExtraction] = useState(null);
  const [draftBookings, setDraftBookings] = useState([]);
  const [editingLocalId, setEditingLocalId] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [tripEndDate, setTripEndDate] = useState(tripDates.endDate);
  const [tripStartDate, setTripStartDate] = useState(tripDates.startDate);
  const [confirmClose, setConfirmClose] = useState(false);

  if (!open) return null;

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

  const runExtract = async (force = false) => {
    setInputError(null);
    setPhase('extracting');
    try {
      let textInput = null;
      try {
        textInput = textToInput(pastedText);
      } catch (err) {
        setInputError(err.message);
        setPhase('input');
        return;
      }
      const allInputs = [
        ...inputs.map(({ kind, mediaType, filename, content }) => ({ kind, mediaType, filename, content })),
        ...(textInput ? [textInput] : []),
      ];
      if (allInputs.length === 0) {
        setInputError('Add at least one screenshot, PDF, or pasted text.');
        setPhase('input');
        return;
      }

      const result = artifact && force
        ? await importApi.reextract(artifact.id)
        : await importApi.createArtifact({ tripId, inputs: allInputs, force });

      setArtifact(result.artifact);
      setExtraction(result.extraction);
      setDraftBookings(buildDraftBookings(result.extraction.bookings, result.warnings));
      setPhase('review');
    } catch (err) {
      setInputError(err.message);
      setPhase('input');
    }
  };

  const handleToggleIncluded = (localId) => {
    setDraftBookings((current) => current.map((d) =>
      d.localId === localId ? { ...d, included: !d.included } : d));
  };

  const handleExtendTrip = async (suggestedEndDate) => {
    await tripsApi.update(tripId, { endDate: suggestedEndDate });
    setTripEndDate(suggestedEndDate);
    setDraftBookings((current) => current.map((d) => ({
      ...d,
      warnings: d.warnings.filter((w) => w.type !== 'afterTripEnd'),
    })));
  };

  const handleExtendTripStart = async (suggestedStartDate) => {
    await tripsApi.update(tripId, { startDate: suggestedStartDate });
    setTripStartDate(suggestedStartDate);
    setDraftBookings((current) => current.map((d) => ({
      ...d,
      warnings: d.warnings.filter((w) => w.type !== 'beforeTripStart'),
    })));
  };

  const handleDraftSubmit = (localId, formData) => {
    setDraftBookings((current) => current.map((d) =>
      d.localId === localId ? { ...d, data: { ...d.data, ...formData } } : d));
    setEditingLocalId(null);
    return Promise.resolve();
  };

  const handleConfirm = async () => {
    const included = draftBookings.filter((d) => d.included);
    if (included.length === 0) return;
    setConfirming(true);
    setSubmitError(null);
    try {
      const payloadBookings = included.map(({ data }) => toBookingConfirmPayload(data));
      const result = await importApi.confirm(artifact.id, { tripId, bookings: payloadBookings });
      await onConfirmed?.(result.bookings);
    } catch (err) {
      setSubmitError(err.message);
    } finally {
      setConfirming(false);
    }
  };

  const editingDraft = draftBookings.find((d) => d.localId === editingLocalId) || null;
  const isReview = phase === 'review';
  const hasUnsavedWork = phase === 'extracting' || (isReview && draftBookings.some((d) => d.included));

  const handleCloseClick = () => {
    if (hasUnsavedWork && !confirmClose) {
      setConfirmClose(true);
      return;
    }
    setConfirmClose(false);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-4">
      <div className="w-full max-w-3xl rounded-[22px] border" style={{ background: 'var(--ink-surface)', borderColor: 'var(--ink-border)' }}>
        <div className="p-5 sm:p-7 max-h-[85vh] overflow-y-auto">
          <div className="flex items-start justify-between gap-4 mb-6">
            <div>
              <p className="font-mono text-[11px] tracking-[0.28em] uppercase mb-2" style={{ color: 'var(--gold)' }}>
                {isReview ? 'Review' : 'Import'}
              </p>
              <h2 className="font-display italic text-3xl" style={{ color: 'var(--cream)' }}>
                {isReview ? "Here's what we found." : 'Dump your travel chaos here.'}
              </h2>
            </div>
            {confirmClose ? (
              <div className="flex items-center gap-3 flex-shrink-0">
                <button
                  type="button"
                  onClick={() => setConfirmClose(false)}
                  className="font-mono text-xs tracking-[0.24em] uppercase"
                  style={{ color: 'var(--cream-dim)' }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleCloseClick}
                  className="font-mono text-xs tracking-[0.24em] uppercase"
                  style={{ color: '#f8b4b4' }}
                >
                  Discard &amp; Close?
                </button>
              </div>
            ) : (
              <button type="button" onClick={handleCloseClick} className="font-mono text-xs tracking-[0.24em] uppercase flex-shrink-0" style={{ color: 'var(--cream-dim)' }}>
                Close
              </button>
            )}
          </div>

          {(phase === 'input' || phase === 'extracting') && (
            <CaptureInput
              inputs={inputs}
              pastedText={pastedText}
              onPastedTextChange={setPastedText}
              onAddFiles={handleAddFiles}
              onRemoveInput={handleRemoveInput}
              onExtract={() => runExtract(false)}
              extracting={phase === 'extracting'}
              error={inputError}
            />
          )}
          {phase === 'review' && extraction && (
            <ExtractionReview
              extraction={extraction}
              draftBookings={draftBookings}
              onToggleIncluded={handleToggleIncluded}
              onEditCard={setEditingLocalId}
              onExtendTrip={handleExtendTrip}
              onExtendTripStart={handleExtendTripStart}
              onRetry={() => setPhase('input')}
              onConfirm={handleConfirm}
              confirming={confirming}
              submitError={submitError}
              tripEndDate={tripEndDate}
              tripStartDate={tripStartDate}
            />
          )}
        </div>
      </div>

      {editingDraft && (
        <AddBookingModal
          key={editingDraft.localId}
          open
          onClose={() => setEditingLocalId(null)}
          onSubmit={(formData) => handleDraftSubmit(editingDraft.localId, formData)}
          saving={false}
          lookupHotels={lookupHotels}
          lookupHotelDetails={lookupHotelDetails}
          lookupFlight={lookupFlight}
          lookupCities={lookupCities}
          booking={editingDraft.data}
          mode="draft"
        />
      )}
    </div>
  );
}
