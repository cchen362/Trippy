import { NavLink } from 'react-router-dom';

function NavItem({ to, label, disabled = false, end = false }) {
  if (disabled) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 py-3" style={{ color: 'var(--cream-mute)', opacity: 0.45 }}>
        <span className="font-mono text-[11px] tracking-[0.28em] uppercase">{label}</span>
        <span className="w-[3px] h-[3px] rounded-full" style={{ background: 'transparent' }} />
      </div>
    );
  }

  return (
    <NavLink to={to} end={end} className="flex-1 flex flex-col items-center justify-center gap-2 py-3">
      {({ isActive }) => (
        <>
          <span className="font-mono text-[11px] tracking-[0.28em] uppercase" style={{ color: isActive ? 'var(--cream)' : 'var(--cream-dim)' }}>
            {label}
          </span>
          <span
            className="w-[3px] h-[3px] rounded-full transition-opacity"
            style={{ background: 'var(--gold)', opacity: isActive ? 1 : 0 }}
          />
        </>
      )}
    </NavLink>
  );
}

export default function BottomNav({ tripId = null }) {
  const inTrip = Boolean(tripId);

  return (
    <nav
      className="sticky bottom-0 z-30 border-t backdrop-blur-md"
      style={{ background: 'rgba(13,11,9,0.92)', borderColor: 'var(--ink-border)' }}
    >
      <div className="max-w-6xl mx-auto px-3">
        <div className="flex items-center">
          <NavItem to="/trips" label="Trips" end />
          <NavItem to={inTrip ? `/trips/${tripId}/plan` : '#'} label="Plan" disabled={!inTrip} />
          <NavItem to={inTrip ? `/trips/${tripId}/logistics` : '#'} label="Logistics" disabled={!inTrip} />
          <NavItem to={inTrip ? `/trips/${tripId}/map` : '#'} label="Map" disabled={!inTrip} />
        </div>
      </div>
    </nav>
  );
}
