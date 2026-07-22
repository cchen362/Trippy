// First-run / all-empty state for Trips Home. Rather than a generic centered
// block, the empty space is drawn in Trippy's own cartographic language: a faint
// atlas graticule ground with the trip's life rendered as an itinerary-route —
// bookings → itinerary → navigate — that terminates in the single New Trip CTA
// as its destination. It teaches what Trippy does while reading as a designed
// state, not a void. Left-aligned to stay coherent with the page header hero.

const STEPS = [
  { label: 'Bookings', copy: 'Flights, hotels, and trains — captured and lined up.' },
  { label: 'Itinerary', copy: 'Shape each day, place by place.' },
  { label: 'On the ground', copy: 'Live guidance the moment you land.' },
];

// Rail geometry mirrors the Plan-tab itinerary timeline exactly (Timeline.jsx /
// StopCard.jsx): a single gradient-faded gold line at left-[20px] over a
// `relative pl-2` container, and each row is `relative pl-10` with one solid
// gold dot at left-[8px] — so the dot centre (8 + 8 + 4.5 = 20.5) lands on the
// line. Solid dots, no concentric ring, so nothing can look disconnected.
const RAIL_LINE = 'linear-gradient(to bottom, rgba(201,168,76,0) 0%, rgba(201,168,76,0.35) 20%, rgba(201,168,76,0.35) 80%, rgba(201,168,76,0) 100%)';

function Graticule() {
  const meridians = [];
  for (let i = 0; i < 6; i++) {
    const bx = 60 + i * 150;
    meridians.push(`M ${bx} -20 Q ${bx + 46} 220 ${bx} 460`);
  }
  const parallels = [];
  for (let j = 0; j < 4; j++) {
    const by = 70 + j * 110;
    parallels.push(`M -20 ${by} Q 440 ${by - 34} 900 ${by}`);
  }
  return (
    <svg
      className="absolute inset-0 w-full h-full"
      viewBox="0 0 880 440"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <g stroke="rgba(240,234,216,0.05)" strokeWidth="1" fill="none">
        {[...meridians, ...parallels].map((d, i) => (
          <path key={i} d={d} />
        ))}
      </g>
    </svg>
  );
}

export default function EmptyTripsState({ onNewTrip }) {
  return (
    <section
      className="relative overflow-hidden mb-6"
      style={{
        borderRadius: 'var(--radius-l)',
        border: '1px solid var(--ink-border-strong)',
        background: 'var(--ink-satin)',
        boxShadow: 'var(--shadow-deep)',
      }}
    >
      <Graticule />
      <div
        className="absolute inset-0"
        style={{
          background: 'linear-gradient(96deg, rgba(13,11,9,0.92) 0%, rgba(13,11,9,0.55) 55%, rgba(13,11,9,0.15) 100%)',
        }}
      />

      <div className="relative px-7 py-12 sm:px-12 sm:py-16 max-w-xl">
        <p className="font-mono text-[10px] tracking-[0.32em] uppercase mb-4" style={{ color: 'var(--gold)' }}>
          No route yet
        </p>
        <h2 className="font-display italic text-4xl sm:text-5xl mb-3" style={{ color: 'var(--cream)' }}>
          Your first line on the map.
        </h2>
        <p className="font-body text-xl mb-10" style={{ color: 'var(--cream-dim)' }}>
          Trippy draws every journey as a route. Here is how yours takes shape.
        </p>

        {/* The trip's life as an itinerary-route: gold nodes on a single rail,
            ending in the New Trip CTA as the journey's first destination. */}
        {/* Itinerary rail — same construction as the Plan-tab timeline. */}
        <div className="relative pl-2">
          <div
            className="absolute left-[20px] top-0 bottom-0 w-px"
            style={{ background: RAIL_LINE }}
          />
          <ol className="space-y-7">
            {STEPS.map((step) => (
              <li key={step.label} className="relative pl-10">
                <span
                  className="absolute left-[8px] top-[4px] w-[9px] h-[9px] rounded-full"
                  style={{ background: 'var(--gold)' }}
                />
                <p className="font-mono text-[11px] tracking-[0.26em] uppercase mb-1.5" style={{ color: 'var(--cream)' }}>
                  {step.label}
                </p>
                <p className="font-body text-lg leading-snug" style={{ color: 'var(--cream-dim)' }}>
                  {step.copy}
                </p>
              </li>
            ))}
            {/* Terminal node — the CTA is the journey's first real destination. */}
            <li className="relative pl-10">
              <span
                className="absolute left-[8px] top-1/2 -translate-y-1/2 w-[9px] h-[9px] rounded-full"
                style={{ background: 'var(--gold)' }}
              />
              <button
                type="button"
                onClick={onNewTrip}
                className="px-6 py-4 rounded-2xl border font-mono text-xs tracking-[0.28em] uppercase"
                style={{ borderColor: 'var(--gold-line)', color: 'var(--gold)', background: 'var(--gold-soft)' }}
              >
                + New Trip
              </button>
            </li>
          </ol>
        </div>
      </div>
    </section>
  );
}
