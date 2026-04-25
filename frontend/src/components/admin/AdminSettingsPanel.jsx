import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { RefreshCcw, Settings, Trash2, X } from 'lucide-react';
import { adminApi } from '../../services/api.js';
import { useAuth } from '../../context/AuthContext.jsx';

export default function AdminSettingsPanel() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [inviteCode, setInviteCode] = useState('');
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    if (!user?.is_admin) return;
    setLoading(true);
    setError('');
    try {
      const [codeResponse, usersResponse] = await Promise.all([
        adminApi.getInviteCode(),
        adminApi.listUsers(),
      ]);
      setInviteCode(codeResponse.inviteCode || '');
      setUsers(usersResponse.users || []);
    } catch (err) {
      setError(err.message || 'Could not load admin settings.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) load();
  }, [open]);

  if (!user?.is_admin) return null;

  const regenerate = async () => {
    setSaving(true);
    setError('');
    try {
      const response = await adminApi.regenerateInviteCode();
      setInviteCode(response.inviteCode || '');
    } catch (err) {
      setError(err.message || 'Could not regenerate invite code.');
    } finally {
      setSaving(false);
    }
  };

  const removeUser = async (userId) => {
    setSaving(true);
    setError('');
    try {
      await adminApi.deleteUser(userId);
      await load();
    } catch (err) {
      setError(err.message || 'Could not remove user.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-10 h-10 inline-flex items-center justify-center rounded-full border"
        style={{ borderColor: 'var(--ink-border)', color: 'var(--cream-dim)', background: 'rgba(255,255,255,0.02)' }}
        aria-label="Open admin settings"
        title="Admin settings"
      >
        <Settings size={18} />
      </button>

      {open && createPortal(
        <motion.div
          className="fixed inset-0 z-[230] flex items-end sm:items-center justify-center px-0 sm:px-4"
          style={{ background: 'rgba(0,0,0,0.68)' }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <motion.div
            className="w-full sm:max-w-xl max-h-[88vh] overflow-y-auto border rounded-t-2xl sm:rounded-2xl p-5 sm:p-6"
            style={{ background: 'var(--ink-mid)', borderColor: 'var(--ink-border)' }}
            initial={{ y: 40, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 40, opacity: 0 }}
            transition={{ type: 'spring', damping: 28, stiffness: 260 }}
          >
            <div className="flex items-center justify-between gap-3 mb-6">
              <div>
                <p className="font-mono text-[10px] tracking-[0.3em] uppercase" style={{ color: 'var(--gold)' }}>
                  Admin
                </p>
                <h1 className="font-display italic text-3xl" style={{ color: 'var(--cream)' }}>
                  App settings
                </h1>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="w-10 h-10 inline-flex items-center justify-center rounded-full border"
                style={{ borderColor: 'var(--ink-border)', color: 'var(--cream-dim)' }}
                aria-label="Close admin settings"
                title="Close"
              >
                <X size={18} />
              </button>
            </div>

            {loading ? (
              <p className="font-mono text-[11px] tracking-[0.22em] uppercase" style={{ color: 'var(--cream-mute)' }}>
                Loading settings...
              </p>
            ) : (
              <div className="space-y-7">
                <section>
                  <p className="modal-label">Invite code</p>
                  <div className="flex gap-2">
                    <div
                      className="flex-1 rounded-xl border px-4 py-3 font-mono text-lg tracking-[0.18em]"
                      style={{ borderColor: 'var(--ink-border)', color: 'var(--cream)', background: 'rgba(255,255,255,0.02)' }}
                    >
                      {inviteCode || '--------'}
                    </div>
                    <button
                      type="button"
                      onClick={regenerate}
                      disabled={saving}
                      className="w-12 h-12 inline-flex items-center justify-center rounded-full border"
                      style={{ borderColor: 'var(--gold-line)', color: 'var(--gold)', background: 'var(--gold-soft)', opacity: saving ? 0.5 : 1 }}
                      aria-label="Regenerate invite code"
                      title="Regenerate invite code"
                    >
                      <RefreshCcw size={17} />
                    </button>
                  </div>
                </section>

                <section>
                  <p className="modal-label">Users</p>
                  <div className="rounded-xl border px-4" style={{ borderColor: 'var(--ink-border)', background: 'rgba(255,255,255,0.02)' }}>
                    {users.map((item) => {
                      const isSelf = item.id === user.id;
                      return (
                        <div
                          key={item.id}
                          className="flex items-center justify-between gap-3 py-3 border-b last:border-b-0"
                          style={{ borderColor: 'var(--ink-border)' }}
                        >
                          <div className="min-w-0">
                            <p className="font-body text-lg truncate" style={{ color: 'var(--cream)' }}>
                              {item.display_name || item.username}
                            </p>
                            <p className="font-mono text-[10px] tracking-[0.18em] uppercase truncate" style={{ color: 'var(--cream-mute)' }}>
                              @{item.username}{item.is_admin ? ' / admin' : ''}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => removeUser(item.id)}
                            disabled={saving || isSelf}
                            className="w-9 h-9 inline-flex items-center justify-center rounded-full border"
                            style={{
                              borderColor: isSelf ? 'var(--ink-border)' : 'rgba(224,90,90,0.35)',
                              color: isSelf ? 'var(--cream-mute)' : '#e05a5a',
                              opacity: saving || isSelf ? 0.45 : 1,
                            }}
                            aria-label={isSelf ? 'Cannot remove yourself' : `Remove ${item.username}`}
                            title={isSelf ? 'Cannot remove yourself' : `Remove ${item.username}`}
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </section>

                {error && (
                  <p className="font-mono text-[11px]" style={{ color: '#e05a5a' }}>
                    {error}
                  </p>
                )}
              </div>
            )}
          </motion.div>
        </motion.div>,
        document.body,
      )}
    </>
  );
}
