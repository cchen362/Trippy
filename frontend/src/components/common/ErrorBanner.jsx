import { AnimatePresence, motion } from 'framer-motion';

// Shared inline error surface — dismissible, styled to match the app's existing
// error text convention (#f8b4b4 on ink-surface, DM Mono label + Cormorant Garamond body).
// Feed it any message string; pass null/undefined to render nothing.
export default function ErrorBanner({ message, onDismiss, className = '' }) {
  return (
    <AnimatePresence>
      {message && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.16 }}
          role="alert"
          className={`rounded-2xl border px-4 py-3 flex items-start justify-between gap-4 ${className}`}
          style={{ background: 'rgba(248,180,180,0.08)', borderColor: 'rgba(248,180,180,0.28)' }}
        >
          <div>
            <p className="font-mono text-[10px] tracking-[0.24em] uppercase mb-1" style={{ color: '#f8b4b4' }}>
              Something went wrong
            </p>
            <p className="font-body text-base" style={{ color: '#f8b4b4' }}>
              {message}
            </p>
          </div>
          {onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              className="font-mono text-[11px] tracking-[0.2em] uppercase flex-shrink-0"
              style={{ color: '#f8b4b4', opacity: 0.75 }}
            >
              Dismiss
            </button>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
