import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { bookingsApi } from '../../services/bookingsApi.js';

// L1: AeroDataBox lookups are a paid call. StatusPill previously re-fetched
// on every mount (i.e. every Today-tab visit/tab switch), re-billing for data
// that hadn't changed. Cache the result in sessionStorage — survives tab
// switches and remounts within the tab's lifetime, cleared when the tab
// closes — keyed by flight + date, with a minimum interval before a fresh
// fetch is allowed on mount. A manual refresh always bypasses the interval
// (the "check again right before boarding" case still hits the API on
// demand).
const CACHE_PREFIX = 'trippy:flightStatus:';
const MIN_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

function cacheKey({ carrierCode, flightNumber, departureDate }) {
  return `${CACHE_PREFIX}${carrierCode}:${flightNumber}:${departureDate}`;
}

function readCache(key) {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeCache(key, entry) {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(entry));
  } catch {
    // sessionStorage unavailable/full — degrade to no caching, not a crash
  }
}

export default function StatusPill({ booking }) {
  const [state, setState] = useState('idle'); // idle | loading | result | unavailable | error
  const [flight, setFlight] = useState(null);
  const [checkedAt, setCheckedAt] = useState(null);

  const detailsJson = booking?.detailsJson || {};
  const carrierCode = detailsJson.carrierCode;
  const flightNumber = detailsJson.flightNumber;
  const departureDate = booking?.startDatetime?.slice(0, 10);
  const bookingId = booking?.id;

  const runCheck = async (key) => {
    setState('loading');
    try {
      const { flight: result } = await bookingsApi.lookupFlight({ carrierCode, flightNumber, departureDate });
      const now = Date.now();
      setCheckedAt(new Date(now));
      if (result?.lookupStatus === 'found') {
        setFlight(result);
        setState('result');
        writeCache(key, { checkedAt: now, outcome: 'result', flight: result });
      } else {
        // Provider reached successfully but has no data for this flight —
        // distinct from a network/HTTP failure below.
        setFlight(null);
        setState('unavailable');
        writeCache(key, { checkedAt: now, outcome: 'unavailable', flight: null });
      }
    } catch {
      // Network/HTTP failure — do not cache (worth retrying sooner), and
      // keep the copy distinct from "provider has no data".
      setCheckedAt(new Date());
      setFlight(null);
      setState('error');
    }
  };

  const handleCheck = () => {
    if (!carrierCode || !flightNumber || !departureDate) return;
    runCheck(cacheKey({ carrierCode, flightNumber, departureDate }));
  };

  useEffect(() => {
    if (!carrierCode || !flightNumber || !departureDate) return;
    const key = cacheKey({ carrierCode, flightNumber, departureDate });
    const cached = readCache(key);
    if (cached && Date.now() - cached.checkedAt < MIN_INTERVAL_MS) {
      setCheckedAt(new Date(cached.checkedAt));
      setFlight(cached.flight);
      setState(cached.outcome);
      return;
    }
    runCheck(key);
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
        ? 'No status yet'
        : state === 'error'
          ? 'Status check failed'
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
      {checkedAt && state !== 'loading' && state !== 'idle' && (
        <span className="font-mono text-[9px] tracking-[0.18em] uppercase" style={{ color: 'var(--cream-mute)', opacity: 0.6 }}>
          checked {checkedAt.getHours().toString().padStart(2, '0')}:{checkedAt.getMinutes().toString().padStart(2, '0')}
        </span>
      )}
    </div>
  );
}
