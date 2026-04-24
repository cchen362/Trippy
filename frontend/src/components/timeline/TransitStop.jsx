export default function TransitStop({ stop, index, onExpand, expanded }) {
  return (
    <div className="relative pl-10 py-3">
      <span
        className="absolute left-[9px] top-6 w-[7px] h-[7px] rounded-full border"
        style={{ borderColor: 'rgba(240,234,216,0.25)' }}
      />
      <div className="font-body italic" style={{ color: 'var(--cream-dim)' }}>
        <button type="button" onClick={() => onExpand(stop.id)} className="text-left">
          <span className="font-mono text-[11px] tracking-[0.22em] uppercase mr-3" style={{ color: 'var(--cream-mute)' }}>
            {stop.time || `${index + 1}`}
          </span>
          {stop.title}
        </button>
        {expanded && stop.note && (
          <p className="mt-2 pl-16 text-base" style={{ color: 'var(--cream-mute)' }}>{stop.note}</p>
        )}
      </div>
    </div>
  );
}
