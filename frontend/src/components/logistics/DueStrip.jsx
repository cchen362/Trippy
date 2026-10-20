import { useState } from 'react';
import { dueLines } from './dueLines.js';
import { formatAtAsWritten } from './factFormat.js';
import { formatDeadlineCountdown, localIso } from '../../utils/date.js';

const VISIBLE = 3;

export default function DueStrip({ bookings, factsByBooking, today, now }) {
  const [expanded, setExpanded] = useState(false);
  const clock = now || new Date();
  // D-37-6 (Plan 37): only deadlines still ahead; the next one alone carries the gold dot; absent when none.
  const entries = dueLines(bookings, factsByBooking, today || localIso(clock));
  if (entries.length === 0) return null;

  const shown = expanded ? entries : entries.slice(0, VISIBLE);
  const hidden = entries.length - VISIBLE;

  return (
    // Capped at the lone card's 560px so a line's countdown stays within reach of its label on desktop.
    <section aria-label="Due" className="max-w-[560px]">
      <h3 className="font-mono text-[11px] tracking-[0.28em] uppercase mb-3" style={{ color: 'var(--cream-mute)' }}>Due</h3>
      <ul className="space-y-3">
        {shown.map((entry, index) => {
          const color = index === 0 ? 'var(--cream)' : 'var(--cream-dim)';
          const moment = formatAtAsWritten(entry.at);
          return (
            <li key={entry.key} style={{ color }}>
              <div className="flex items-center gap-2">
                {index === 0
                  ? <span className="trip-live-dot" style={{ background: 'var(--gold)' }} aria-hidden="true" />
                  : <span className="inline-block w-[6px] shrink-0" aria-hidden="true" />}
                <span className="min-w-0 font-mono text-[10px] tracking-[0.24em] uppercase">{entry.label}</span>
                <span className="ml-auto shrink-0 font-mono text-[10px] tracking-[0.24em] uppercase">
                  {formatDeadlineCountdown(entry.at.slice(0, 10), clock)}
                </span>
              </div>
              <div className="pl-[14px] flex flex-wrap items-baseline gap-x-3">
                <span className="font-body text-base">{entry.titles.join(' · ')}</span>
                {moment && (
                  <span className="font-mono text-[11px]">{[moment.date, moment.time].filter(Boolean).join(' ')}</span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {hidden > 0 && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
          className="font-mono text-[10px] tracking-[0.24em] uppercase mt-2 min-h-[44px] pl-[14px]"
          style={{ color: 'var(--cream-mute)' }}
        >
          {expanded ? 'Fewer' : `${hidden} more`}
        </button>
      )}
    </section>
  );
}
