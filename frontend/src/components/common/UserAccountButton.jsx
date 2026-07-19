import { useState } from 'react';
import { LogOut } from 'lucide-react';
import { useAuth } from '../../context/AuthContext.jsx';
import ModalShell from '../shell/ModalShell.jsx';

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

      <ModalShell open={open} onRequestClose={() => setOpen(false)} zBase={230} eyebrow="Account" headline={user.display_name} maxWidth="xl">
            <p className="font-mono text-[10px] tracking-[0.18em] uppercase mb-5" style={{ color: 'var(--cream-mute)' }}>
              @{user.username}
            </p>
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
      </ModalShell>
    </>
  );
}
