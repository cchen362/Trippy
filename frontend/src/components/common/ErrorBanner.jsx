import { AnimatePresence, motion } from 'framer-motion';

// Shared inline error surface — dismissible, styled to match the app's existing
// error text convention (#e05a5a on ink-surface, DM Mono label + Cormorant Garamond body).
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
          className={`rounded-xl border px-4 py-3 flex items-start justify-between gap-4 ${className}`}
          style={{ background: 'rgba(224,90,90,0.08)', borderColor: 'rgba(224,90,90,0.28)' }}
        >
          <div>
            <p className="font-mono text-[10px] tracking-[0.24em] uppercase mb-1" style={{ color: '#e05a5a' }}>
              Something went wrong
            </p>
            <p className="font-body text-base" style={{ color: '#e05a5a' }}>
              {message}
            </p>
          </div>
          {onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              className="font-mono text-[11px] tracking-[0.2em] uppercase flex-shrink-0"
              style={{ color: '#e05a5a', opacity: 0.75 }}
            >
              Dismiss
            </button>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
