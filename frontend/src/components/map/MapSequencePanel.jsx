import { useState } from 'react';

function statusLabel(stop) {
  if (!stop.canRenderMarker) return 'Unresolved';
  if (stop.locationStatus === 'user_confirmed') return 'Confirmed';
  if (stop.isEstimated || stop.locationStatus === 'estimated') return 'Estimated';
  return 'Resolved';
}

function statusColor(stop) {
  if (!stop.canRenderMarker) return '#e08a3a';
  if (stop.isEstimated || stop.locationStatus === 'estimated') return 'rgba(240,234,216,0.48)';
  if (stop.locationStatus === 'user_confirmed') return 'var(--gold)';
  return 'rgba(240,234,216,0.66)';
}

const placeButtonStyle = {
  marginTop: 6,
  border: '1px solid rgba(224,138,58,0.42)',
  borderRadius: 999,
  background: 'rgba(224,138,58,0.12)',
  color: '#e08a3a',
  fontFamily: "'DM Mono', monospace",
  fontSize: 9,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  padding: '5px 8px',
  cursor: 'pointer',
};

const checkButtonStyle = {
  ...placeButtonStyle,
  border: '1px solid rgba(201,168,76,0.42)',
  background: 'rgba(201,168,76,0.08)',
  color: 'var(--gold)',
};

export default function MapSequencePanel({ stops, focusedSegmentId = 'all', onPlaceStop }) {
  const [collapsed, setCollapsed] = useState(() => window.innerWidth < 480);

  if (!stops.length) return null;

  return (
    <div
      style={{
        position: 'absolute',
        right: 12,
        top: 62,
        zIndex: 900,
        width: 'min(320px, calc(100% - 24px))',
        ...(collapsed ? {} : {
          maxHeight: 'calc(100% - 74px)',
          overflow: 'auto',
        }),
        border: '1px solid rgba(255,255,255,0.10)',
        borderRadius: 8,
        background: 'rgba(13,11,9,0.88)',
        boxShadow: '0 18px 44px rgba(0,0,0,0.34)',
        backdropFilter: 'blur(10px)',
      }}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={() => setCollapsed((c) => !c)}
        onKeyDown={(e) => e.key === 'Enter' && setCollapsed((c) => !c)}
        style={{
          padding: '10px 14px',
          borderBottom: collapsed ? 'none' : '1px solid rgba(240,234,216,0.08)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          cursor: 'pointer',
          userSelect: 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <p
            style={{
              margin: 0,
              fontFamily: "'DM Mono', monospace",
              fontSize: 10,
              letterSpacing: '0.24em',
              textTransform: 'uppercase',
              color: 'var(--gold)',
            }}
          >
            Day Sequence
          </p>
          {collapsed && (
            <span
              style={{
                color: 'rgba(240,234,216,0.45)',
                fontFamily: "'DM Mono', monospace",
                fontSize: 9,
                letterSpacing: '0.12em',
              }}
            >
              · {stops.length} stop{stops.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>
        <span style={{ color: 'rgba(240,234,216,0.45)', fontSize: 10, lineHeight: 1 }}>
          {collapsed ? '▼' : '▲'}
        </span>
      </div>
      {!collapsed && (
        <ol style={{ listStyle: 'none', margin: 0, padding: '8px 0' }}>
          {stops.map((stop) => (
            <li
              key={stop.id}
              style={{
                display: 'grid',
                gridTemplateColumns: '30px minmax(0, 1fr) auto',
                alignItems: 'center',
                gap: 9,
                padding: '7px 12px',
                background: focusedSegmentId !== 'all' && stop.routeSegmentId === focusedSegmentId
                  ? 'rgba(201,168,76,0.08)'
                  : 'transparent',
              }}
            >
              <span
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: '50%',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontFamily: "'DM Mono', monospace",
                  fontSize: 11,
                  color: stop.canRenderMarker ? 'var(--ink-deep)' : 'rgba(240,234,216,0.42)',
                  background: stop.canRenderMarker ? 'var(--gold)' : 'rgba(240,234,216,0.06)',
                  border: stop.canRenderMarker ? '1px solid rgba(13,11,9,0.6)' : '1px dashed rgba(240,234,216,0.25)',
                }}
              >
                {stop.routeNumber}
              </span>
              <div style={{ minWidth: 0 }}>
                <p
                  style={{
                    margin: 0,
                    color: stop.canRenderMarker ? 'var(--cream)' : 'rgba(240,234,216,0.55)',
                    fontFamily: "'Playfair Display', serif",
                    fontSize: 15,
                    fontStyle: 'italic',
                    lineHeight: 1.2,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={stop.title}
                >
                  {stop.title}
                </p>
                <p
                  style={{
                    margin: '2px 0 0',
                    color: 'rgba(240,234,216,0.36)',
                    fontFamily: "'DM Mono', monospace",
                    fontSize: 9,
                    letterSpacing: '0.16em',
                    textTransform: 'uppercase',
                  }}
                >
                  {stop.time || 'Flexible'}
                </p>
                {!stop.canRenderMarker && onPlaceStop && (
                  <button
                    type="button"
                    onClick={() => onPlaceStop(stop)}
                    style={placeButtonStyle}
                  >
                    Place on map
                  </button>
                )}
                {stop.canRenderMarker && stop.isEstimated && onPlaceStop && (
                  <button
                    type="button"
                    onClick={() => onPlaceStop(stop)}
                    style={checkButtonStyle}
                  >
                    Check location
                  </button>
                )}
              </div>
              <span
                style={{
                  justifySelf: 'end',
                  color: statusColor(stop),
                  fontFamily: "'DM Mono', monospace",
                  fontSize: 9,
                  letterSpacing: '0.14em',
                  textTransform: 'uppercase',
                  whiteSpace: 'nowrap',
                }}
              >
                {statusLabel(stop)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
