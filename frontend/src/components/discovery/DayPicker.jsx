import { useState, useEffect, useRef } from 'react';

// Parses a 'YYYY-MM-DD' calendar date string as local (device) midnight rather
// than UTC midnight. `new Date('YYYY-MM-DD')` parses as UTC, which renders as
// the previous day in negative-UTC-offset timezones — this avoids that bug.
function parseLocalDateParts(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(year, month - 1, day);
}

export default function DayPicker({ addedDayIds, days, suggestion, onAddToDay, onClose, anchorRef }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ top: 0, left: 0, width: 220 });

  useEffect(() => {
    function updatePosition() {
      if (!anchorRef.current) return;
      const rect = anchorRef.current.getBoundingClientRect();
      const popoverHeight = Math.min(days.length * 44 + 52, 320);
      const spaceAbove = rect.top;
      const openUpward = spaceAbove > popoverHeight + 8;
      setPos({
        top: openUpward ? rect.top - popoverHeight - 8 : rect.bottom + 8,
        left: rect.left,
        width: Math.max(rect.width, 220),
      });
    }

    updatePosition();

    // The popover is `position: fixed`, anchored to the trigger button's
    // viewport coordinates. The panel content scrolls (DiscoveryPanel's
    // content area, or the page itself), which moves the anchor without
    // firing resize — so we must also reposition on scroll. Capture phase
    // catches scroll events from any nested scrollable ancestor, not just window.
    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('resize', updatePosition);

    function onOutsideInteraction(e) {
      if (
        ref.current && !ref.current.contains(e.target) &&
        anchorRef.current && !anchorRef.current.contains(e.target)
      ) {
        onClose();
      }
    }
    function onKeyDown(e) {
      if (e.key === 'Escape') {
        onClose();
        anchorRef.current?.focus();
      }
    }
    document.addEventListener('mousedown', onOutsideInteraction);
    document.addEventListener('touchstart', onOutsideInteraction);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
      document.removeEventListener('mousedown', onOutsideInteraction);
      document.removeEventListener('touchstart', onOutsideInteraction);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  return (
    <div
      ref={ref}
      style={{
        position: 'fixed',
        top: pos.top,
        left: pos.left,
        width: pos.width,
        background: '#1a1410',
        border: '1px solid rgba(201,160,80,0.22)',
        borderRadius: 4,
        boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
        zIndex: 9999,
        overflow: 'hidden',
        animation: 'fadeUp 0.18s ease both',
      }}
    >
      <div style={{
        padding: '12px 16px 8px',
        borderBottom: '1px solid rgba(240,235,227,0.06)',
      }}>
        <span style={{
          fontFamily: "'DM Mono', monospace",
          fontSize: 9,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: '#504438',
        }}>Add to day</span>
      </div>
      {days.map(day => {
        const added = addedDayIds.has(day.id);
        const label = day.date
          ? parseLocalDateParts(day.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
          : `Day ${(day.dayIndex ?? 0) + 1}`;
        return (
          <button
            key={day.id}
            className="discovery-day-btn"
            onClick={() => { onAddToDay(day.id, suggestion); onClose(); }}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              width: '100%',
              padding: '10px 16px',
              background: added ? 'rgba(201,160,80,0.08)' : 'transparent',
              border: 'none',
              borderBottom: '1px solid rgba(240,235,227,0.04)',
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            <span style={{
              fontFamily: "'Cormorant Garamond', serif",
              fontSize: 16,
              color: added ? '#c9a050' : '#f0ebe3',
              letterSpacing: '0.01em',
            }}>
              {`Day ${(day.dayIndex ?? 0) + 1}`}
            </span>
            <span style={{
              fontFamily: "'DM Mono', monospace",
              fontSize: 10,
              color: added ? '#c9a050' : '#504438',
              letterSpacing: '0.08em',
            }}>
              {added ? '✓ added' : label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
