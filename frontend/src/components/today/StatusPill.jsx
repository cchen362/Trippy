import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { bookingsApi } from '../../services/bookingsApi.js';

// Wires the flight-only extension point (D6) to the existing AeroDataBox
// lookup. Fetches once, silently, the first time the hero mounts — no
// polling, no storage beyond component state — so the traveler sees live
// status without an extra tap; a manual refresh covers the "check again
// right before boarding" case. Every live field is optional (coverage
// varies by airport/carrier), so the pill renders whichever of
// status/gate/terminal are present and degrades to a plain retry affordance
// (never blocks the card) when the provider has nothing.
export default function StatusPill({ booking }) {
  const [state, setState] = useState('idle'); // idle | loading | result | unavailable
  const [flight, setFlight] = useState(null);
  const [checkedAt, setCheckedAt] = useState(null);

  const detailsJson = booking?.detailsJson || {};
  const carrierCode = detailsJson.carrierCode;
  const flightNumber = detailsJson.flightNumber;
  const departureDate = booking?.startDatetime?.slice(0, 10);
  const bookingId = booking?.id;

  const handleCheck = async () => {
    setState('loading');
    try {
      const { flight: result } = await bookingsApi.lookupFlight({ carrierCode, flightNumber, departureDate });
      setCheckedAt(new Date());
      if (result?.lookupStatus === 'found') {
        setFlight(result);
        setState('result');
      } else {
        setState('unavailable');
      }
    } catch {
      setState('unavailable');
    }
  };

  useEffect(() => {
    if (carrierCode && flightNumber && departureDate) handleCheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookingId]);

  if (!carrierCode || !flightNumber || !departureDate) return null;

  const summary = flight
    ? [flight.status, flight.departureGate && `Gate ${flight.departureGate}`, flight.departureTerminal && `Terminal ${flight.departureTerminal}`]
      .filter(Boolean)
      .join(' · ')
    : null;

  const label = state === 'loading'
    ? 'Checking…'
    : state === 'result' && summary
      ? summary
      : state === 'unavailable'
        ? 'Status unavailable'
        : 'Status';

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={handleCheck}
        disabled={state === 'loading'}
        className="font-mono text-[11px] tracking-[0.2em] uppercase px-3 py-1 rounded-full border inline-flex items-center gap-1.5"
        style={{ borderColor: 'var(--ink-border)', color: 'var(--cream-mute)', opacity: state === 'loading' ? 0.5 : 1 }}
      >
        {label}
        {state !== 'loading' && state !== 'idle' && <RefreshCw size={10} />}
      </button>
      {checkedAt && state === 'result' && (
        <span className="font-mono text-[9px] tracking-[0.18em] uppercase" style={{ color: 'var(--cream-mute)', opacity: 0.6 }}>
          checked {checkedAt.getHours().toString().padStart(2, '0')}:{checkedAt.getMinutes().toString().padStart(2, '0')}
        </span>
      )}
    </div>
  );
}
