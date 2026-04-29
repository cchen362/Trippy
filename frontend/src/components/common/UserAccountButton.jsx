import { useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { LogOut, X } from 'lucide-react';
import { useAuth } from '../../context/AuthContext.jsx';

function getInitials(displayName) {
  if (!displayName) return '?';
  return displayName
    .trim()
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

export default function UserAccountButton() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  if (!user) return null;

  const handleSignOut = async () => {
    setSigningOut(true);
    await logout();
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-10 h-10 inline-flex items-center justify-center rounded-full border"
        style={{ borderColor: 'var(--ink-border)', color: 'var(--cream-dim)', background: 'rgba(255,255,255,0.02)' }}
        aria-label="Open account menu"
        title="Account"
      >
        <span className="font-mono text-[13px] leading-none tracking-[0.05em]">
          {getInitials(user.display_name)}
        </span>
      </button>

      {open && createPortal(
        <motion.div
          className="fixed inset-0 z-[230] flex items-end sm:items-center justify-center px-0 sm:px-4"
          style={{ background: 'rgba(0,0,0,0.68)' }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
        >
          <motion.div
            className="w-full sm:max-w-sm border rounded-t-2xl sm:rounded-2xl p-5 sm:p-6"
            style={{ background: 'var(--ink-mid)', borderColor: 'var(--ink-border)' }}
            initial={{ y: 40, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 40, opacity: 0 }}
            transition={{ type: 'spring', damping: 28, stiffness: 260 }}
          >
            <div className="flex items-center justify-between gap-3 mb-5">
              <div>
                <p className="font-mono text-[10px] tracking-[0.3em] uppercase" style={{ color: 'var(--gold)' }}>
                  Account
                </p>
                <h2 className="font-display italic text-3xl" style={{ color: 'var(--cream)' }}>
                  {user.display_name}
                </h2>
                <p className="font-mono text-[10px] tracking-[0.18em] uppercase mt-0.5" style={{ color: 'var(--cream-mute)' }}>
                  @{user.username}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="w-10 h-10 inline-flex items-center justify-center rounded-full border flex-shrink-0"
                style={{ borderColor: 'var(--ink-border)', color: 'var(--cream-dim)' }}
                aria-label="Close account menu"
              >
                <X size={18} />
              </button>
            </div>

            <div className="border-t mb-5" style={{ borderColor: 'var(--ink-border)' }} />

            <button
              type="button"
              onClick={handleSignOut}
              disabled={signingOut}
              className="w-full flex items-center gap-3 px-4 py-3 rounded-xl border font-mono text-xs tracking-[0.22em] uppercase"
              style={{
                borderColor: 'var(--ink-border)',
                color: signingOut ? 'var(--cream-mute)' : 'var(--cream-dim)',
                background: 'rgba(255,255,255,0.02)',
                opacity: signingOut ? 0.6 : 1,
              }}
            >
              <LogOut size={15} />
              {signingOut ? 'Signing out…' : 'Sign out'}
            </button>
          </motion.div>
        </motion.div>,
        document.body,
      )}
    </>
  );
}
