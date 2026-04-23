import { useState } from 'react';

function formatDayLabel(days, dayId) {
  if (!dayId || !days) return 'unknown day';
  const day = days.find(d => d.id === dayId);
  if (!day) return `day ${dayId}`;
  const date = new Date(day.date + 'T00:00:00');
  return date.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric' });
}

function OperationRow({ op, days }) {
  if (op.type === 'add_stop') {
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
        }}
      >
        <span style={{ color: 'rgba(100,200,100,0.9)' }}>＋</span>{' '}
        Add: <strong>{op.stop?.title || 'new stop'}</strong>{' '}
        <span style={{ color: 'rgba(240,234,216,0.5)', fontSize: 13 }}>
          to {formatDayLabel(days, op.dayId)}
        </span>
      </div>
    );
  }

  if (op.type === 'remove_stop') {
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
        }}
      >
        <span style={{ color: 'rgba(200,80,80,0.9)' }}>×</span>{' '}
        Remove: <strong>{op.stopId}</strong>
      </div>
    );
  }

  if (op.type === 'move_stop') {
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
        }}
      >
        <span style={{ color: '#c9a84c' }}>→</span>{' '}
        Move stop to{' '}
        <strong>{formatDayLabel(days, op.toDayId || op.dayId)}</strong>
      </div>
    );
  }

  if (op.type === 'update_stop') {
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
        }}
      >
        <span style={{ color: '#c9a84c' }}>✎</span>{' '}
        Update: <strong>{op.stopId}</strong>
      </div>
    );
  }

  return null;
}

export default function MutationPreview({ mutation, days, onApply, onReject, applying }) {
  const operations = mutation?.operations || [];

  return (
    <div
      style={{
        background: '#1c1a17',
        border: '1px solid rgba(201,168,76,0.2)',
        borderRadius: 12,
        padding: '14px 16px',
        marginTop: 8,
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
          <OperationRow key={i} op={op} days={days} />
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
            color: 'rgba(240,234,216,0.28)',
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
