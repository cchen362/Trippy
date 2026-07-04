import { X } from 'lucide-react';

export default function DocumentViewer({ document, onClose }) {
  if (!document) return null;
  const isPdf = document.mediaType === 'application/pdf';

  return (
    <div className="fixed inset-0 z-[210] flex flex-col" style={{ background: 'var(--ink-deep)' }}>
      <div className="flex items-center justify-between px-5 py-4 flex-shrink-0">
        <p className="font-mono text-[11px] tracking-[0.28em] uppercase truncate pr-4" style={{ color: 'var(--cream-dim)' }}>
          {document.filename || (isPdf ? 'Document' : 'Photo')}
        </p>
        <button type="button" onClick={onClose} aria-label="Close" style={{ color: 'var(--cream)' }}>
          <X size={22} />
        </button>
      </div>

      {/* Near-white content pane (not the full-screen chrome) so an imported QR/barcode
          screenshot stays scannable against a light background. */}
      <div className="flex-1 flex items-center justify-center overflow-auto p-4" style={{ background: '#f5f3ee' }}>
        {isPdf ? (
          <embed src={document.url} type="application/pdf" className="w-full h-full rounded-md" />
        ) : (
          <img src={document.url} alt={document.filename || 'Attached document'} className="max-w-full max-h-full object-contain rounded-md" />
        )}
      </div>
    </div>
  );
}
