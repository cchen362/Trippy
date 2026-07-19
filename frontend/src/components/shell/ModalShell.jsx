import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { X } from 'lucide-react';

// --- Module-level open-shell stack ------------------------------------------------
// Tracks which ModalShell instances are currently open, in open order. The last id in
// the stack is "topmost": it owns the Escape key and the Tab focus trap. A tiny
// listener-set + version counter drives re-renders via useSyncExternalStore so every
// mounted shell recomputes its own stack index (and therefore z-index) whenever any
// shell opens or closes.
let openStack = [];
const stackListeners = new Set();

function notifyStack() {
  for (const listener of stackListeners) listener();
}

function subscribeStack(listener) {
  stackListeners.add(listener);
  return () => stackListeners.delete(listener);
}

function getStackSnapshot() {
  return openStack;
}

function pushStack(id) {
  // Replace the array (rather than mutate in place) so useSyncExternalStore's
  // Object.is snapshot comparison sees a change and re-renders every mounted shell.
  openStack = [...openStack, id];
  notifyStack();
}

function removeStack(id) {
  openStack = openStack.filter((existing) => existing !== id);
  notifyStack();
}

// --- Module-level scroll-lock refcount --------------------------------------------
// Body scroll is locked while at least one shell is open. Refcounted so two stacked
// shells don't fight over restoring `overflow` — only the last shell to close restores
// the value that was present before the first shell locked it.
let lockCount = 0;
let previousBodyOverflow = '';

function acquireScrollLock() {
  if (lockCount === 0) {
    previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  lockCount += 1;
}

function releaseScrollLock() {
  lockCount = Math.max(0, lockCount - 1);
  if (lockCount === 0) {
    document.body.style.overflow = previousBodyOverflow;
  }
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const MAX_WIDTH_CLASSES = {
  xl: 'sm:max-w-xl',
  '2xl': 'sm:max-w-2xl',
  '3xl': 'sm:max-w-3xl',
};

let shellIdCounter = 0;

export default function ModalShell({
  open,
  onRequestClose,
  eyebrow,
  headline,
  headerAccessory,
  maxWidth = '2xl',
  footer,
  initialFocusRef,
  children,
}) {
  const headlineId = useId();
  const panelRef = useRef(null);
  const shellIdRef = useRef(null);
  if (shellIdRef.current === null) {
    shellIdCounter += 1;
    shellIdRef.current = shellIdCounter;
  }
  const shellId = shellIdRef.current;
  const previousFocusRef = useRef(null);

  const [isOpenClass, setIsOpenClass] = useState(false);

  // CSS-only entrance motion: mount in the "closed" transform/opacity state, then flip
  // to `.is-open` on the next frame so the browser has a from-state to transition from.
  useEffect(() => {
    if (!open) {
      setIsOpenClass(false);
      return undefined;
    }
    const frame = requestAnimationFrame(() => setIsOpenClass(true));
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const stack = useSyncExternalStore(subscribeStack, getStackSnapshot, getStackSnapshot);
  const stackIndex = stack.indexOf(shellId);
  const isTopmost = stackIndex !== -1 && stackIndex === stack.length - 1;
  const zIndex = 40 + 10 * Math.max(stackIndex, 0);

  // Register/unregister this shell in the open stack and hold the scroll lock for as
  // long as it is mounted-and-open.
  useEffect(() => {
    if (!open) return undefined;
    pushStack(shellId);
    acquireScrollLock();
    return () => {
      removeStack(shellId);
      releaseScrollLock();
    };
  }, [open, shellId]);

  // Focus management: capture the previously-focused element on open, move focus into
  // the panel, and restore focus to the captured element on close/unmount.
  useLayoutEffect(() => {
    if (!open) return undefined;
    previousFocusRef.current = document.activeElement;

    const target = initialFocusRef?.current
      ?? panelRef.current?.querySelector(FOCUSABLE_SELECTOR)
      ?? null;
    target?.focus();

    return () => {
      previousFocusRef.current?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Escape + Tab trap: active only while this shell is topmost. Only Tab and Escape
  // keydown are intercepted — click/mousedown/focus pass through untouched so things
  // like Places autocomplete rows (onMouseDown preventDefault) keep working.
  useEffect(() => {
    if (!open || !isTopmost) return undefined;

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onRequestClose?.();
        return;
      }
      if (event.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = Array.from(panel.querySelectorAll(FOCUSABLE_SELECTOR));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, isTopmost, onRequestClose]);

  if (!open) return null;

  const maxWidthClass = MAX_WIDTH_CLASSES[maxWidth] ?? MAX_WIDTH_CLASSES['2xl'];

  return (
    <div
      className="fixed inset-0 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/60 backdrop-blur-sm"
      style={{ zIndex }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headlineId}
        className={`modal-shell-panel${isOpenClass ? ' is-open' : ''} w-full ${maxWidthClass} rounded-t-2xl sm:rounded-2xl border flex flex-col`}
        style={{
          background: 'var(--ink-surface)',
          borderColor: 'var(--ink-border)',
          maxHeight: '85dvh',
        }}
      >
        <div className="flex items-start justify-between gap-4 px-5 sm:px-7 pt-5 sm:pt-7 pb-5 sm:pb-6">
          <div className="min-w-0">
            {eyebrow && (
              <p className="font-mono text-[11px] tracking-[0.22em] uppercase mb-2" style={{ color: 'var(--gold)' }}>
                {eyebrow}
              </p>
            )}
            <h2 id={headlineId} className="font-display italic text-2xl" style={{ color: 'var(--cream)' }}>
              {headline}
            </h2>
          </div>
          {headerAccessory ?? (
            <button
              type="button"
              onClick={onRequestClose}
              className="w-11 h-11 shrink-0 inline-flex items-center justify-center rounded-full border"
              style={{ color: 'var(--cream-mute)', borderColor: 'var(--ink-border)' }}
              aria-label="Close"
            >
              <X size={18} />
            </button>
          )}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 sm:px-7">
          {children}
        </div>

        {footer && <div className="modal-shell-footer">{footer}</div>}
      </div>
    </div>
  );
}
