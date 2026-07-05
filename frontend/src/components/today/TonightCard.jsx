import NavigateIcon from './NavigateIcon.jsx';

export default function TonightCard({ booking, stop, deepLinkProvider, mapConfig }) {
  if (!booking) return null;

  return (
    <div
      className="rounded-2xl border p-4 mb-3"
      style={{ borderColor: 'var(--ink-border)', background: 'var(--ink-mid)' }}
    >
      <p className="font-mono text-[10px] tracking-[0.32em] uppercase mb-2" style={{ color: 'var(--gold)' }}>
        Tonight
      </p>
      <p className="font-display italic text-lg mb-1" style={{ color: 'var(--cream)' }}>
        {booking.title}
      </p>
      <div className="flex items-center justify-between gap-2">
        {booking.confirmationRef && (
          <p className="font-mono text-xs" style={{ color: 'var(--cream-dim)' }}>
            {booking.confirmationRef}
          </p>
        )}
        <NavigateIcon stop={stop} label={booking.title} deepLinkProvider={deepLinkProvider} mapConfig={mapConfig} />
      </div>
    </div>
  );
}
