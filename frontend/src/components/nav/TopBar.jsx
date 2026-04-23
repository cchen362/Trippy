import { Link } from 'react-router-dom';

export default function TopBar({ title }) {
  return (
    <header
      className="sticky top-0 z-20 border-b backdrop-blur-md"
      style={{ background: 'rgba(13,11,9,0.86)', borderColor: 'var(--ink-border)' }}
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between gap-4">
        <Link
          to="/trips"
          className="font-mono text-[11px] tracking-[0.28em] uppercase"
          style={{ color: 'var(--gold)' }}
        >
          ← Trips
        </Link>
        <div className="min-w-0 text-right">
          <p className="font-mono text-[10px] tracking-[0.28em] uppercase" style={{ color: 'var(--cream-mute)' }}>
            Current Trip
          </p>
          <h1 className="font-display italic text-2xl truncate" style={{ color: 'var(--cream)' }}>
            {title}
          </h1>
        </div>
      </div>
    </header>
  );
}
