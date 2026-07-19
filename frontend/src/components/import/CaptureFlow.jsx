import { useState, useEffect } from 'react';
import ModalShell from '../shell/ModalShell.jsx';
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

  // ModalShell keeps this component mounted while closed, so reset local
  // state whenever the modal transitions back open (mirrors NewTripModal).
  useEffect(() => {
    if (!open) return;
    setPhase('input');
    setInputs([]);
    setPastedText('');
    setInputError(null);
    setArtifact(null);
    setExtraction(null);
    setDraftBookings([]);
    setEditingLocalId(null);
    setConfirming(false);
    setSubmitError(null);
    setTripEndDate(tripDates.endDate);
    setTripStartDate(tripDates.startDate);
    setConfirmClose(false);
  }, [open]);

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

  const handleRequestClose = () => {
    if (confirmClose) {
      setConfirmClose(false);
      return;
    }
    if (hasUnsavedWork) {
      setConfirmClose(true);
      return;
    }
    onClose();
  };

  const handleDiscard = () => {
    setConfirmClose(false);
    onClose();
  };

  return (
    <>
      <ModalShell
        open={open}
        onRequestClose={handleRequestClose}
        eyebrow={isReview ? 'Review' : 'Import'}
        headline={isReview ? "Here's what we found." : 'Dump your travel chaos here.'}
        maxWidth="3xl"
      >
        <div className="pb-5 sm:pb-7">
          {confirmClose && (
            <div className="rounded-xl border p-4 mb-5 modal-danger-border">
              <p className="font-body text-base" style={{ color: 'var(--cream-dim)' }}>
                Discard this import? Anything extracted here will be lost.
              </p>
              <div className="flex gap-3 mt-3">
                <button
                  type="button"
                  onClick={() => setConfirmClose(false)}
                  className="px-4 py-3 rounded-xl font-mono text-xs tracking-[0.22em] uppercase border min-h-[44px]"
                  style={{ color: 'var(--cream-dim)', borderColor: 'var(--ink-border)' }}
                >
                  Keep Working
                </button>
                <button
                  type="button"
                  onClick={handleDiscard}
                  className="px-4 py-3 rounded-xl font-mono text-xs tracking-[0.22em] uppercase border min-h-[44px] modal-danger-text modal-danger-border"
                >
                  Discard &amp; Close
                </button>
              </div>
            </div>
          )}

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
      </ModalShell>

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
    </>
  );
}
