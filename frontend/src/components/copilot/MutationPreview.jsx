function formatDayLabel(days, dayId) {
  if (!dayId || !days) return 'unknown day';
  const day = days.find(d => d.id === dayId);
  if (!day) return `day ${dayId}`;
  const date = new Date(day.date + 'T00:00:00');
  return date.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric' });
}

function resolveStopLabel(days, stopId) {
  for (const day of (days || [])) {
    const stop = day.stops?.find(s => s.id === stopId);
    if (stop) return stop.title;
  }
  return stopId;
}

function resolveStop(days, stopId) {
  for (const day of (days || [])) {
    const stop = day.stops?.find(s => s.id === stopId);
    if (stop) return stop;
  }
  return null;
}

const FIELD_LABELS = {
  title: 'TITLE',
  type: 'TYPE',
  time: 'TIME',
  note: 'NOTE',
  duration: 'DURATION',
  estimatedCost: 'COST',
  bestTime: 'BEST TIME',
};

function formatFieldValue(key, value) {
  if (key === 'time') {
    return value ? (
      <span style={{ fontFamily: "'DM Mono', monospace" }}>{value}</span>
    ) : (
      <span style={{ color: 'rgba(240,234,216,0.45)', fontStyle: 'italic' }}>flexible</span>
    );
  }
  if (value === null || value === undefined || value === '') {
    return <span style={{ color: 'rgba(240,234,216,0.35)' }}>—</span>;
  }
  return String(value);
}

function OperationRow({ op, days, muted }) {
  const opacity = muted ? 0.6 : 1;

  if (op.action === 'add_stop') {
    const time = op.stop?.time;
    return (
      <div
        style={{
          background: 'rgba(100,200,100,0.15)',
          borderLeft: '2px solid rgba(100,200,100,0.5)',
          borderRadius: 6,
          padding: '8px 10px',
          marginBottom: 6,
          fontFamily: "'Cormorant Garamond', serif",
          fontSize: 14,
          color: '#f0ead8',
          opacity,
        }}
      >
        <div>
          <span style={{ color: 'rgba(100,200,100,0.9)' }}>＋</span>{' '}
          Add: <strong>{op.stop?.title || 'new stop'}</strong>{' '}
          <span style={{ color: 'rgba(240,234,216,0.5)', fontSize: 13 }}>
            to {formatDayLabel(days, op.dayId)}
          </span>
        </div>
        <div style={{ marginTop: 4, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {time ? (
            <span
              style={{
                fontFamily: "'DM Mono', monospace",
                fontSize: 10,
                letterSpacing: '0.08em',
                color: 'rgba(240,234,216,0.7)',
                border: '1px solid rgba(201,168,76,0.35)',
                borderRadius: 4,
                padding: '2px 6px',
              }}
            >
              {time}
            </span>
          ) : (
            <span
              style={{
                fontFamily: "'DM Mono', monospace",
                fontSize: 10,
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                color: 'rgba(201,168,76,0.75)',
                border: '1px solid rgba(201,168,76,0.35)',
                borderRadius: 4,
                padding: '2px 6px',
              }}
            >
              No time · Flexible
            </span>
          )}
          {op.placeVerified === true && (
            <span
              style={{
                fontFamily: "'DM Mono', monospace",
                fontSize: 10,
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                color: 'rgba(201,168,76,0.75)',
                border: '1px solid rgba(201,168,76,0.35)',
                borderRadius: 4,
                padding: '2px 6px',
              }}
            >
              Verified Place
            </span>
          )}
        </div>
      </div>
    );
  }

  if (op.action === 'remove_stop') {
    return (
      <div
        style={{
          background: 'rgba(200,80,80,0.15)',
          borderLeft: '2px solid rgba(200,80,80,0.5)',
          borderRadius: 6,
          padding: '8px 10px',
          marginBottom: 6,
          fontFamily: "'Cormorant Garamond', serif",
          fontSize: 14,
          color: '#f0ead8',
          opacity,
        }}
      >
        <span style={{ color: 'rgba(200,80,80,0.9)' }}>×</span>{' '}
        Remove: <strong>{resolveStopLabel(days, op.stopId)}</strong>
      </div>
    );
  }

  if (op.action === 'move_stop') {
    return (
      <div
        style={{
          background: 'rgba(201,168,76,0.10)',
          borderLeft: '2px solid rgba(201,168,76,0.5)',
          borderRadius: 6,
          padding: '8px 10px',
          marginBottom: 6,
          fontFamily: "'Cormorant Garamond', serif",
          fontSize: 14,
          color: '#f0ead8',
          opacity,
        }}
      >
        <span style={{ color: '#c9a84c' }}>→</span>{' '}
        Move <strong>{resolveStopLabel(days, op.stopId)}</strong> to{' '}
        <strong>{formatDayLabel(days, op.toDayId || op.dayId)}</strong>
      </div>
    );
  }

  if (op.action === 'update_stop') {
    const stop = resolveStop(days, op.stopId);
    const fields = op.fields || {};
    return (
      <div
        style={{
          background: 'rgba(201,168,76,0.10)',
          borderLeft: '2px solid rgba(201,168,76,0.5)',
          borderRadius: 6,
          padding: '8px 10px',
          marginBottom: 6,
          fontFamily: "'Cormorant Garamond', serif",
          fontSize: 14,
          color: '#f0ead8',
          opacity,
        }}
      >
        <div style={{ marginBottom: 4 }}>
          <span style={{ color: '#c9a84c' }}>✎</span>{' '}
          Update: <strong>{resolveStopLabel(days, op.stopId)}</strong>
        </div>
        {Object.keys(fields).map((key) => (
          <div
            key={key}
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 6,
              fontSize: 13,
              marginTop: 2,
            }}
          >
            <span
              style={{
                fontFamily: "'DM Mono', monospace",
                fontSize: 10,
                letterSpacing: '0.1em',
                color: 'rgba(240,234,216,0.45)',
                minWidth: 62,
              }}
            >
              {FIELD_LABELS[key] || key.toUpperCase()}
            </span>
            <span>
              {formatFieldValue(key, stop ? stop[key] : undefined)}
              {' → '}
              {formatFieldValue(key, fields[key])}
            </span>
          </div>
        ))}
      </div>
    );
  }

  return null;
}

function WarningBlock({ warnings }) {
  if (!warnings?.length) return null;
  return (
    <div
      style={{
        background: 'rgba(200,80,80,0.15)',
        border: '1px solid rgba(200,80,80,0.3)',
        borderRadius: 8,
        padding: '10px 12px',
        marginBottom: 12,
      }}
    >
      <div
        style={{
          fontFamily: "'DM Mono', monospace",
          fontSize: 10,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: '#e05a5a',
          marginBottom: 6,
        }}
      >
        Heads Up
      </div>
      {warnings.map((w, i) => {
        const hasNote = w.losses?.includes('note');
        const hasPhoto = w.losses?.includes('photo');
        let copy;
        if (hasNote && hasPhoto) {
          copy = <>has your notes and a photo you pinned — they'll be lost.</>;
        } else if (hasNote) {
          copy = <>has your notes — they'll be deleted.</>;
        } else if (hasPhoto) {
          copy = <>has a photo you pinned — it'll be lost.</>;
        } else {
          copy = <>will be affected by this change.</>;
        }
        return (
          <p
            key={`${w.stopId}-${i}`}
            style={{
              fontFamily: "'Cormorant Garamond', serif",
              fontSize: 14,
              color: '#f0ead8',
              margin: '2px 0',
            }}
          >
            <strong>{w.stopTitle}</strong> {copy}
          </p>
        );
      })}
    </div>
  );
}

const STATUS_META = {
  applied: { label: 'Applied', color: 'rgba(240,234,216,0.5)', icon: '✓' },
  rejected: { label: 'Dismissed', color: 'rgba(240,234,216,0.5)', icon: null },
  stale: { label: 'Outdated', color: 'rgba(240,234,216,0.5)', icon: null },
  invalid: { label: "Can't Apply", color: 'rgba(240,234,216,0.5)', icon: null },
};

// Product-voice copy shown for unappliable proposals — derived from status, never the raw
// server validation reason (which stays in the audit record). Both cases resolve the same
// way for the user: ask the co-pilot again (D12 / Wave 3 §4).
const RESOLVED_COPY = {
  stale: 'The trip changed since this suggestion was made. Ask again to get a fresh one.',
  invalid: 'This suggestion no longer matches your current trip. Ask the co-pilot again for an up-to-date version.',
};

export default function MutationPreview({ proposal, days, onApply, onReject, applying }) {
  const operations = proposal?.operations || [];
  const warnings = proposal?.warnings || [];
  const status = proposal?.status || 'pending';

  if (status !== 'pending') {
    const meta = STATUS_META[status] || STATUS_META.rejected;
    return (
      <div
        style={{
          background: '#1c1a17',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 12,
          padding: '12px 16px',
          marginTop: 8,
          marginBottom: 12,
        }}
      >
        <div
          style={{
            fontFamily: "'DM Mono', monospace",
            fontSize: 10,
            letterSpacing: '0.22em',
            textTransform: 'uppercase',
            color: meta.color,
            marginBottom: 8,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          {meta.icon && <span style={{ color: '#f0ead8' }}>{meta.icon}</span>}
          {meta.label}
        </div>

        {RESOLVED_COPY[status] && (
          <p
            style={{
              fontFamily: "'Cormorant Garamond', serif",
              fontSize: 14,
              color: 'rgba(240,234,216,0.65)',
              margin: '0 0 10px',
            }}
          >
            {RESOLVED_COPY[status]}
          </p>
        )}

        <div style={{ opacity: 0.6 }}>
          {operations.map((op, i) => (
            <OperationRow key={`${op.action}-${op.stopId || op.dayId || i}`} op={op} days={days} muted />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        background: '#1c1a17',
        border: '1px solid rgba(201,168,76,0.2)',
        borderRadius: 12,
        padding: '14px 16px',
        marginTop: 8,
        marginBottom: 12,
      }}
    >
      <div
        style={{
          fontFamily: "'DM Mono', monospace",
          fontSize: 10,
          letterSpacing: '0.22em',
          textTransform: 'uppercase',
          color: '#c9a84c',
          marginBottom: 10,
          paddingBottom: 10,
          borderBottom: '1px solid rgba(201,168,76,0.2)',
        }}
      >
        Proposed Changes
      </div>

      <div style={{ marginBottom: 12 }}>
        {operations.map((op, i) => (
          <OperationRow key={`${op.action}-${op.stopId || op.dayId || i}`} op={op} days={days} />
        ))}
        {operations.length === 0 && (
          <p
            style={{
              fontFamily: "'Cormorant Garamond', serif",
              fontSize: 14,
              color: 'rgba(240,234,216,0.4)',
              margin: 0,
            }}
          >
            No operations specified.
          </p>
        )}
      </div>

      <WarningBlock warnings={warnings} />

      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={onApply}
          disabled={applying}
          style={{
            flex: 1,
            background: 'rgba(201,168,76,0.12)',
            border: '1px solid rgba(201,168,76,0.5)',
            color: '#c9a84c',
            fontFamily: "'DM Mono', monospace",
            fontSize: 11,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            padding: '10px 12px',
            borderRadius: 8,
            cursor: applying ? 'not-allowed' : 'pointer',
            opacity: applying ? 0.6 : 1,
          }}
        >
          {applying ? 'Applying…' : 'Apply Changes'}
        </button>
        <button
          onClick={onReject}
          disabled={applying}
          style={{
            flex: 1,
            background: 'transparent',
            border: '1px solid rgba(255,255,255,0.10)',
            color: 'var(--cream-mute)',
            fontFamily: "'DM Mono', monospace",
            fontSize: 11,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            padding: '10px 12px',
            borderRadius: 8,
            cursor: applying ? 'not-allowed' : 'pointer',
          }}
        >
          Reject
        </button>
      </div>
    </div>
  );
}
