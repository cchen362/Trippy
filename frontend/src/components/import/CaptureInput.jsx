import { X } from 'lucide-react';
import { MAX_INPUTS } from '../../services/importApi.js';

const KIND_LABEL = { text: 'TEXT', image: 'IMAGE', pdf: 'PDF' };

export default function CaptureInput({
  inputs,
  pastedText,
  onPastedTextChange,
  onAddFiles,
  onRemoveInput,
  onExtract,
  extracting,
  error,
  showExtractAction = true,
}) {
  const totalCount = inputs.length + (pastedText.trim() ? 1 : 0);
  const canExtract = totalCount > 0 && !extracting;

  const handleFileInputChange = (event) => {
    if (event.target.files?.length) onAddFiles(event.target.files);
    event.target.value = '';
  };

  const handleDrop = (event) => {
    event.preventDefault();
    if (event.dataTransfer.files?.length) onAddFiles(event.dataTransfer.files);
  };

  return (
    <>
      <p className="font-body text-lg mb-6" style={{ color: 'var(--cream-dim)' }}>
        Paste a confirmation email, or drop a screenshot / PDF.
      </p>

      <label className="block mb-4">
        <span className="modal-label">Paste text</span>
        <textarea
          value={pastedText}
          onChange={(e) => onPastedTextChange(e.target.value)}
          className="modal-input resize-none"
          rows={5}
          placeholder="Paste a booking confirmation email, itinerary, or note..."
        />
      </label>

      <label
        onDrop={handleDrop}
        onDragOver={(e) => e.preventDefault()}
        className="flex flex-col items-center justify-center gap-1 rounded-xl border border-dashed cursor-pointer"
        style={{ borderColor: 'var(--ink-border)', minHeight: '96px', color: 'var(--cream-mute)' }}
      >
        <input
          type="file"
          multiple
          accept="image/*,application/pdf"
          onChange={handleFileInputChange}
          className="sr-only"
        />
        <span className="font-mono text-[11px] tracking-[0.22em] uppercase">Tap to choose files</span>
        <span className="font-mono text-[11px] tracking-[0.22em] uppercase">or drag &amp; drop</span>
      </label>

      {inputs.length > 0 && (
        <div className="mt-4 space-y-2">
          {inputs.map((input) => (
            <div
              key={input.localId}
              className="flex items-center justify-between gap-3 rounded-xl border px-4 py-2"
              style={{ borderColor: 'var(--ink-border)' }}
            >
              <div className="flex items-center gap-3 min-w-0">
                <span
                  className="font-mono text-[10px] tracking-[0.18em] uppercase px-2 py-1 rounded-full border shrink-0"
                  style={{ color: 'var(--cream-mute)', borderColor: 'var(--ink-border)' }}
                >
                  {KIND_LABEL[input.kind]}
                </span>
                <span className="font-mono text-xs truncate" style={{ color: 'var(--cream-dim)' }}>
                  {input.filename}
                </span>
              </div>
              <button
                type="button"
                onClick={() => onRemoveInput(input.localId)}
                aria-label={`Remove ${input.filename}`}
                className="shrink-0 inline-flex items-center justify-center rounded-full"
                style={{ width: 44, height: 44, color: 'var(--cream-dim)' }}
              >
                <X size={16} />
              </button>
            </div>
          ))}
        </div>
      )}

      <p className="mt-3 font-mono text-[11px] tracking-[0.22em] uppercase" style={{ color: 'var(--cream-mute)' }}>
        {totalCount} / {MAX_INPUTS} inputs
      </p>

      {error && (
        <p className="mt-3 font-mono text-xs" style={{ color: '#e05a5a' }}>
          {error}
        </p>
      )}

      {showExtractAction && (
        <div className="sticky bottom-0 pt-4 mt-6 border-t" style={{ borderColor: 'var(--ink-border)', background: 'var(--ink-surface)' }}>
          <button
            type="button"
            onClick={onExtract}
            disabled={!canExtract}
            className="w-full sm:w-auto px-5 py-4 rounded-xl font-mono text-xs tracking-[0.28em] uppercase inline-flex items-center justify-center gap-2"
            style={{ background: 'var(--gold)', color: 'var(--ink-deep)', opacity: canExtract ? 1 : 0.5 }}
          >
            {extracting && <span className="modal-loading-dots"><span /><span /><span /></span>}
            {extracting ? 'Reading...' : 'Extract'}
          </button>
        </div>
      )}
    </>
  );
}
