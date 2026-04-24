export default function StopCard({ stop, expanded, onToggle }) {
  return (
    <div className="relative pl-10">
      <span
        className="absolute left-[8px] top-8 w-[9px] h-[9px] rounded-full"
        style={{ background: 'var(--gold)' }}
      />
      <div
        className="rounded-2xl overflow-hidden border"
        style={{
          borderColor: stop.isFeatured ? 'var(--gold-line)' : 'var(--ink-border)',
          minHeight: stop.isFeatured ? '180px' : '136px',
        }}
      >
        <div className="relative h-full">
          {stop.unsplashPhotoUrl ? (
            <img src={stop.unsplashPhotoUrl} alt="" className="absolute inset-0 w-full h-full object-cover" />
          ) : (
            <div className="absolute inset-0" style={{ background: 'linear-gradient(135deg, #3d3021, #101010)' }} />
          )}
          <div className="absolute inset-0 trip-card-overlay" />
          <div className="relative z-10 p-4 sm:p-5 h-full flex flex-col justify-between gap-3">
            <div className="flex items-start justify-between gap-3">
              <button type="button" onClick={() => onToggle(stop.id)} className="text-left">
                <p className="font-mono text-[11px] tracking-[0.24em] uppercase mb-2" style={{ color: 'var(--gold)' }}>
                  {stop.type}
                </p>
                <h3 className="font-display italic text-2xl sm:text-[30px]" style={{ color: 'var(--cream)' }}>
                  {stop.title}
                </h3>
              </button>
              <span className="rounded-full border px-3 py-2 font-mono text-[10px] tracking-[0.22em] uppercase" style={{ color: 'var(--cream-dim)', borderColor: 'rgba(240,234,216,0.18)', background: 'rgba(13,11,9,0.22)' }}>
                Drag
              </span>
            </div>

            <div className="flex items-end justify-between gap-3">
              <div>
                <p className="font-mono text-xs tracking-[0.22em] uppercase" style={{ color: 'var(--cream-dim)' }}>
                  {stop.time || 'Flexible'}
                </p>
                {stop.duration && (
                  <p className="font-body text-base" style={{ color: 'var(--cream-dim)' }}>{stop.duration}</p>
                )}
              </div>
              {stop.estimatedCost && (
                <p className="font-mono text-[11px] tracking-[0.22em] uppercase" style={{ color: 'var(--cream-dim)' }}>
                  {stop.estimatedCost}
                </p>
              )}
            </div>

            {expanded && (
              <div className="pt-3 border-t" style={{ borderColor: 'rgba(240,234,216,0.14)' }}>
                {stop.note && <p className="font-body text-lg leading-relaxed" style={{ color: 'var(--cream-dim)' }}>{stop.note}</p>}
                <div className="mt-3 flex flex-wrap gap-2">
                  {stop.bestTime && <span className="pill">{stop.bestTime}</span>}
                  {stop.bookingRequired && <span className="pill">Booking Required</span>}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
