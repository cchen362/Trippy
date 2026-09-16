import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { integrationsApi } from '../../services/integrationsApi.js';
import { friendlyError } from '../../utils/apiError.js';
import ModalShell from '../shell/ModalShell.jsx';

const SCOPES = [
  { value: 'trips:read', label: 'trips:read — read your trips' },
  { value: 'trips:write', label: 'trips:write — add bookings after a preview' },
  { value: 'documents:write', label: 'documents:write — attach original screenshots' },
];

const EXPIRY_OPTIONS = [
  { value: 30, label: '30 days' },
  { value: 90, label: '90 days' },
  { value: 365, label: '1 year' },
  { value: null, label: 'No expiry' },
];

const DEFAULT_SCOPES = ['trips:read'];
const DEFAULT_EXPIRY = 90;

function formatDate(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// Small local "time ago" — this is the only place Trippy needs one, so it
// lives here rather than as a shared util (grepped `frontend/src/utils` for
// an existing "ago"/relative-time helper; none exists).
function timeAgo(iso) {
  if (!iso) return null;
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function emptyForm() {
  return { name: '', scopes: [...DEFAULT_SCOPES], expiresInDays: DEFAULT_EXPIRY };
}

export default function IntegrationsPanel({ open, onRequestClose }) {
  const [view, setView] = useState('list'); // 'list' | 'create' | 'reveal'
  const [tokens, setTokens] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // Plan 28 W5.6: one confirmId does double duty for both Revoke (live rows)
  // and Delete (revoked rows) — a row only ever shows one of the two actions,
  // so the id alone disambiguates which confirm is pending.
  const [confirmId, setConfirmId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [revealToken, setRevealToken] = useState('');
  const [copied, setCopied] = useState(false);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const response = await integrationsApi.list();
      setTokens(response.tokens || []);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) load();
  }, [open]);

  useEffect(() => {
    if (!open) {
      setView('list');
      setConfirmId(null);
      setForm(emptyForm());
      setRevealToken('');
      setError('');
    }
  }, [open]);

  const toggleScope = (value) => {
    setForm((current) => ({
      ...current,
      scopes: current.scopes.includes(value)
        ? current.scopes.filter((s) => s !== value)
        : [...current.scopes, value],
    }));
  };

  const handleCreate = async () => {
    setSaving(true);
    setError('');
    try {
      const response = await integrationsApi.create({
        name: form.name.trim(),
        scopes: form.scopes,
        expiresInDays: form.expiresInDays,
      });
      setRevealToken(response.token);
      setView('reveal');
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setSaving(false);
    }
  };

  const handleRevoke = async (id) => {
    setSaving(true);
    setError('');
    try {
      await integrationsApi.revoke(id);
      setConfirmId(null);
      await load();
    } catch (err) {
      setError(friendlyError(err));
      setConfirmId(null);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    setSaving(true);
    setError('');
    try {
      await integrationsApi.remove(id);
      setConfirmId(null);
      await load();
    } catch (err) {
      setError(friendlyError(err));
      setConfirmId(null);
    } finally {
      setSaving(false);
    }
  };

  const handleCopy = async () => {
    if (!revealToken) return;
    await navigator.clipboard?.writeText(revealToken);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const handleDone = () => {
    setRevealToken('');
    setCopied(false);
    setView('list');
    load();
  };

  const openCreate = () => {
    setForm(emptyForm());
    setError('');
    setView('create');
  };

  return (
    <ModalShell
      open={open}
      onRequestClose={onRequestClose}
      zBase={240}
      eyebrow="Integrations"
      headline="Personal tokens"
      maxWidth="xl"
    >
      {view === 'list' && (
        <div className="space-y-5">
          <p className="font-body text-lg" style={{ color: 'var(--cream-dim)' }}>
            A token lets a tool you trust — Claude Code, Codex, your own script — read
            your trips and, with the right scope, add bookings. Each one is yours to
            revoke, and to delete once revoked.
          </p>

          {loading ? (
            <p className="font-mono text-[11px] tracking-[0.22em] uppercase" style={{ color: 'var(--cream-mute)' }}>
              Loading tokens...
            </p>
          ) : tokens.length === 0 ? (
            <p className="font-body text-lg" style={{ color: 'var(--cream-mute)' }}>
              Nothing connected yet. Create a token when you are ready to hand a tool
              the keys.
            </p>
          ) : (
            <div className="rounded-xl border px-4" style={{ borderColor: 'var(--ink-border)', background: 'rgba(255,255,255,0.02)' }}>
              {tokens.map((tok) => {
                const revoked = Boolean(tok.revokedAt);
                return (
                  <div
                    key={tok.id}
                    className="py-3 border-b last:border-b-0"
                    style={{ borderColor: 'var(--ink-border)' }}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1" style={{ opacity: revoked ? 0.5 : 1 }}>
                        <p className="font-body text-lg truncate" style={{ color: 'var(--cream)' }}>
                          {tok.name}
                        </p>
                        <p className="font-mono text-[11px] truncate" style={{ color: 'var(--cream-dim)' }}>
                          {tok.tokenPrefix}…
                        </p>
                        <div className="flex flex-wrap gap-2 mt-2">
                          {tok.scopes.map((scope) => (
                            <span key={scope} className="pill">{scope}</span>
                          ))}
                        </div>
                        <p className="font-mono text-[10px] tracking-[0.18em] uppercase mt-2" style={{ color: 'var(--cream-mute)' }}>
                          {revoked
                            ? `revoked ${formatDate(tok.revokedAt)}`
                            : `created ${formatDate(tok.createdAt)} · expires ${tok.expiresAt ? formatDate(tok.expiresAt) : 'never'} · last used ${tok.lastUsedAt ? timeAgo(tok.lastUsedAt) : 'never'}`}
                        </p>
                      </div>

                      {confirmId === tok.id ? (
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <button
                            type="button"
                            onClick={() => setConfirmId(null)}
                            className="font-mono text-[10px] tracking-[0.18em] uppercase"
                            style={{ color: 'var(--cream-dim)' }}
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            onClick={() => (revoked ? handleDelete(tok.id) : handleRevoke(tok.id))}
                            disabled={saving}
                            className="modal-danger-text modal-danger-border px-3 py-2 rounded-full border font-mono text-[10px] tracking-[0.18em] uppercase"
                            style={{ opacity: saving ? 0.45 : 1 }}
                          >
                            {saving ? (revoked ? 'Deleting…' : 'Revoking…') : 'Confirm?'}
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmId(tok.id)}
                          disabled={saving}
                          className="modal-danger-text modal-danger-border px-3 py-2 rounded-full border font-mono text-[10px] tracking-[0.18em] uppercase flex-shrink-0"
                          style={{ opacity: saving ? 0.45 : 1 }}
                        >
                          {revoked ? 'Delete' : 'Revoke'}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {error && <p className="modal-danger-text font-mono text-[11px]">{error}</p>}

          <button type="button" onClick={openCreate} className="modal-action w-full sm:w-auto">
            New token
          </button>
        </div>
      )}

      {view === 'create' && (
        <div className="space-y-5">
          <label className="block">
            <span className="modal-label">Name</span>
            <input
              className="modal-input"
              type="text"
              value={form.name}
              maxLength={64}
              placeholder="claude-code-laptop"
              onChange={(e) => setForm((current) => ({ ...current, name: e.target.value }))}
            />
          </label>

          <div>
            <span className="modal-label">Scopes</span>
            <div className="space-y-2">
              {SCOPES.map((scope) => (
                <label
                  key={scope.value}
                  className="flex items-center gap-3 rounded-xl border px-4 py-3"
                  style={{ borderColor: 'var(--ink-border)', color: 'var(--cream-dim)' }}
                >
                  <input
                    type="checkbox"
                    checked={form.scopes.includes(scope.value)}
                    onChange={() => toggleScope(scope.value)}
                    style={{ width: 18, height: 18, accentColor: 'var(--gold)' }}
                  />
                  <span className="font-mono text-[11px] tracking-[0.18em] uppercase">
                    {scope.label}
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div>
            <span className="modal-label">Expires</span>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {EXPIRY_OPTIONS.map((opt) => {
                const selected = form.expiresInDays === opt.value;
                return (
                  <button
                    key={String(opt.value)}
                    type="button"
                    onClick={() => setForm((current) => ({ ...current, expiresInDays: opt.value }))}
                    className="rounded-xl border px-3 py-2 font-mono text-[10px] tracking-[0.18em] uppercase"
                    style={{
                      borderColor: selected ? 'var(--gold-line)' : 'var(--ink-border)',
                      color: selected ? 'var(--gold)' : 'var(--cream-dim)',
                      background: selected ? 'var(--gold-soft)' : 'rgba(255,255,255,0.02)',
                    }}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          {error && <p className="modal-danger-text font-mono text-[11px]">{error}</p>}

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setView('list')}
              disabled={saving}
              className="font-mono text-[11px] tracking-[0.18em] uppercase w-full sm:w-auto"
              style={{ color: 'var(--cream-dim)' }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleCreate}
              disabled={saving || !form.name.trim() || form.scopes.length === 0}
              className="modal-action w-full sm:w-auto"
              style={{ opacity: saving || !form.name.trim() || form.scopes.length === 0 ? 0.5 : 1 }}
            >
              {saving ? 'Creating…' : 'Create'}
            </button>
          </div>
        </div>
      )}

      {view === 'reveal' && (
        <div className="space-y-5">
          <div>
            <p className="modal-label">Your new token</p>
            <div
              className="rounded-xl border px-4 py-3 font-mono text-sm break-all"
              style={{ borderColor: 'var(--gold-line)', color: 'var(--cream)', background: 'rgba(255,255,255,0.02)' }}
            >
              {revealToken}
            </div>
          </div>

          <p className="font-body text-lg" style={{ color: 'var(--cream-dim)' }}>
            Copy it now. Trippy keeps only a fingerprint of this token and cannot show
            it again.
          </p>

          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
            <button
              type="button"
              onClick={handleCopy}
              className="modal-action inline-flex items-center justify-center gap-2 w-full sm:w-auto"
            >
              {copied ? <Check size={15} /> : <Copy size={15} />}
              {copied ? 'Copied' : 'Copy token'}
            </button>
            <button
              type="button"
              onClick={handleDone}
              className="font-mono text-[11px] tracking-[0.18em] uppercase w-full sm:w-auto"
              style={{ color: 'var(--cream-dim)' }}
            >
              Done
            </button>
          </div>
        </div>
      )}
    </ModalShell>
  );
}
