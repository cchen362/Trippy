import { useState } from 'react';
import NavigateIcon from './NavigateIcon.jsx';
import StatusPill from './StatusPill.jsx';
import DocumentViewer from '../documents/DocumentViewer.jsx';

function TicketButton({ documents }) {
  const [open, setOpen] = useState(false);
  if (!documents?.length) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="font-mono text-[11px] tracking-[0.2em] uppercase px-3 py-1 rounded-full border"
        style={{ borderColor: 'var(--gold-line)', color: 'var(--gold)' }}
      >
        Ticket
      </button>
      {open && <DocumentViewer document={documents[0]} onClose={() => setOpen(false)} />}
    </>
  );
}

export default function HeroCard({ item, deepLinkProvider }) {
  if (!item) return null;

  const isHotel = item.kind === 'hotel';
  const booking = item.booking;
  const stop = item.stop;

  const eyebrow = isHotel ? 'Tonight' : (booking?.type || stop?.type || 'Next');
  const title = booking?.title || stop?.title || 'Untitled';
  const timeLabel = isHotel ? null : item.time;
  // Status is a flight-only extension point (D6) — trains/others deep-link out instead.
  const showStatus = booking?.type === 'flight';

  const lat = stop?.lat ?? null;
  const lng = stop?.lng ?? null;
  const navLabel = title;

  return (
    <div
      className="rounded-2xl border p-5"
      style={{
        borderColor: 'var(--gold-line)',
        background: 'linear-gradient(135deg, rgba(36,31,20,0.98), rgba(15,13,10,0.99) 44%, rgba(9,8,6,0.99))',
        boxShadow: '0 22px 50px rgba(0,0,0,0.34), inset 0 1px 0 rgba(255,255,255,0.04)',
      }}
    >
      <p className="font-mono text-[10px] tracking-[0.32em] uppercase mb-2" style={{ color: 'var(--gold)' }}>
        {eyebrow}
      </p>
      {timeLabel && (
        <p className="font-mono text-[28px] font-bold leading-none mb-1" style={{ color: 'var(--cream)', textShadow: '1px 1px 0 rgba(201,168,76,0.28)' }}>
          {timeLabel}
        </p>
      )}
      <p className="font-display italic text-2xl mb-4" style={{ color: 'var(--cream)', textShadow: '1px 1px 0 rgba(201,168,76,0.45)' }}>
        {title}
      </p>
      {booking?.confirmationRef && (
        <p className="font-mono text-xs mb-4" style={{ color: 'var(--gold)' }}>
          {booking.confirmationRef}
        </p>
      )}
      <div className="flex items-center gap-2 flex-wrap">
        <NavigateIcon lat={lat} lng={lng} label={navLabel} deepLinkProvider={deepLinkProvider} />
        <TicketButton documents={booking?.documents} />
        {showStatus && <StatusPill />}
      </div>
    </div>
  );
}
