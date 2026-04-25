import { useState } from 'react';
import { Trash2, UserPlus } from 'lucide-react';

function PersonRow({ person, label, canRemove, onRemove, saving }) {
  return (
    <div
      className="flex items-center justify-between gap-3 py-3 border-b last:border-b-0"
      style={{ borderColor: 'var(--ink-border)' }}
    >
      <div className="min-w-0">
        <p className="font-body text-lg truncate" style={{ color: 'var(--cream)' }}>
          {person.displayName || person.username}
        </p>
        <p className="font-mono text-[10px] tracking-[0.18em] uppercase truncate" style={{ color: 'var(--cream-mute)' }}>
          @{person.username} / {label}
        </p>
      </div>
      {canRemove && (
        <button
          type="button"
          onClick={() => onRemove(person.id)}
          disabled={saving}
          className="w-9 h-9 inline-flex items-center justify-center rounded-full border"
          style={{ borderColor: 'rgba(224,90,90,0.35)', color: '#e05a5a', opacity: saving ? 0.5 : 1 }}
          aria-label={`Remove ${person.username}`}
          title={`Remove ${person.username}`}
        >
          <Trash2 size={15} />
        </button>
      )}
    </div>
  );
}

export default function CollaboratorsPanel({
  owner,
  collaborators,
  canManage,
  saving,
  error,
  onInvite,
  onRemove,
}) {
  const [username, setUsername] = useState('');
  const [localError, setLocalError] = useState('');

  const handleSubmit = async (event) => {
    event.preventDefault();
    const nextUsername = username.trim();
    if (!nextUsername) return;
    setLocalError('');
    try {
      await onInvite(nextUsername);
      setUsername('');
    } catch (err) {
      setLocalError(err.message || 'Could not invite collaborator.');
    }
  };

  return (
    <section>
      <div className="flex items-center justify-between gap-3 mb-4">
        <div>
          <p className="font-mono text-[10px] tracking-[0.28em] uppercase" style={{ color: 'var(--gold)' }}>
            People
          </p>
          <h2 className="font-display italic text-2xl" style={{ color: 'var(--cream)' }}>
            Trip access
          </h2>
        </div>
      </div>

      {canManage && (
        <form onSubmit={handleSubmit} className="flex gap-2 mb-4">
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            className="modal-input"
            placeholder="Username"
            aria-label="Collaborator username"
            disabled={saving}
          />
          <button
            type="submit"
            disabled={saving || !username.trim()}
            className="w-12 h-12 inline-flex items-center justify-center rounded-full border"
            style={{
              borderColor: 'var(--gold-line)',
              color: 'var(--gold)',
              background: 'var(--gold-soft)',
              opacity: saving || !username.trim() ? 0.5 : 1,
            }}
            aria-label="Invite collaborator"
            title="Invite collaborator"
          >
            <UserPlus size={18} />
          </button>
        </form>
      )}

      {(localError || error) && (
        <p className="font-mono text-[11px] mb-3" style={{ color: '#e05a5a' }}>
          {localError || error.message}
        </p>
      )}

      <div className="rounded-xl border px-4" style={{ borderColor: 'var(--ink-border)', background: 'rgba(255,255,255,0.02)' }}>
        {owner && <PersonRow person={owner} label="owner" saving={saving} />}
        {collaborators.map((person) => (
          <PersonRow
            key={person.id}
            person={person}
            label={person.role}
            canRemove={canManage}
            onRemove={onRemove}
            saving={saving}
          />
        ))}
        {collaborators.length === 0 && (
          <p className="font-mono text-[11px] tracking-[0.18em] uppercase py-4" style={{ color: 'var(--cream-mute)' }}>
            No collaborators yet
          </p>
        )}
      </div>
    </section>
  );
}
