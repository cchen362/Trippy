// Shared ticket-stub primitive used by FlightBookingCard and TrainBookingCard.
// Accepts display-ready values only — no booking data access here.
export default function TicketStubCard({
  eyebrow,
  leftCode,
  leftCodeSize = 'text-4xl sm:text-5xl lg:text-6xl',
  centerGlyph,
  rightCode,
  rightCodeSize = 'text-4xl sm:text-5xl lg:text-6xl',
  leftTime,
  rightTime,
  leftLabel,
  rightLabel,
  leftDate,
  rightDate,
  footerLeft,
  footerRight,
  connector = false,
  onClick,
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left rounded-xl overflow-hidden border focus-visible:ring-2 focus-visible:ring-[var(--gold-line)]"
      style={{ borderColor: 'var(--ink-border)' }}
    >
      {/* HERO ZONE — eyebrow, fold, codes, connector */}
      <div className="px-5 sm:px-8 pt-5 pb-5" style={{ background: 'var(--ink-surface)' }}>

        <p className="font-mono text-[11px] tracking-[0.26em] uppercase mb-3" style={{ color: 'var(--gold)' }}>
          {eyebrow}
        </p>

        <div className="ticket-fold mb-4" />

        {/* Hero row: left code | center glyph | right code */}
        <div className="flex items-center justify-between gap-2">
          <span
            className={`font-mono font-bold leading-none ${leftCodeSize}`}
            style={{ color: 'var(--cream)', letterSpacing: '0.04em' }}
          >
            {leftCode}
          </span>
          {centerGlyph && (
            <span
              className="font-mono text-[11px] tracking-[0.18em] uppercase text-center flex-shrink-0"
              style={{ color: 'var(--cream-mute)' }}
            >
              {/* Diamonds hidden below sm so codes don't overflow 375px */}
              <span className="hidden sm:inline">◆ </span>
              {centerGlyph}
              <span className="hidden sm:inline"> ◆</span>
            </span>
          )}
          <span
            className={`font-mono font-bold leading-none text-right ${rightCodeSize}`}
            style={{ color: 'var(--cream)', letterSpacing: '0.04em' }}
          >
            {rightCode}
          </span>
        </div>

        {connector && <div className="flight-line mt-3" />}
      </div>

      {/* DATA ZONE — times, labels, dates, footer */}
      <div className="px-5 sm:px-8 pt-5 pb-5" style={{ background: 'var(--ink-deep)' }}>

        {(leftTime || rightTime) && (
          <div className="flex items-start justify-between gap-4">
            <div>
              <p
                className={`font-mono font-bold leading-none ${leftTime ? 'text-2xl sm:text-3xl' : ''}`}
                style={{ color: 'var(--cream)' }}
              >
                {leftTime}
              </p>
              {leftLabel && (
                <p className="font-mono text-[11px] tracking-[0.2em] uppercase mt-2" style={{ color: 'var(--cream-mute)' }}>
                  {leftLabel}
                </p>
              )}
              {leftDate && (
                <p className="font-body italic text-sm mt-0.5" style={{ color: 'var(--cream-dim)' }}>
                  {leftDate}
                </p>
              )}
            </div>
            <div className="text-right">
              <p
                className={`font-mono font-bold leading-none ${rightTime ? 'text-2xl sm:text-3xl' : ''}`}
                style={{ color: 'var(--cream)' }}
              >
                {rightTime}
              </p>
              {rightLabel && (
                <p className="font-mono text-[11px] tracking-[0.2em] uppercase mt-2" style={{ color: 'var(--cream-mute)' }}>
                  {rightLabel}
                </p>
              )}
              {rightDate && (
                <p className="font-body italic text-sm mt-0.5" style={{ color: 'var(--cream-dim)' }}>
                  {rightDate}
                </p>
              )}
            </div>
          </div>
        )}

        {(footerLeft || footerRight) && (
          <div className="ticket-fold flex items-center justify-between pt-3 mt-4 gap-2">
            {footerLeft ? (
              <span className="font-mono text-[11px] tracking-[0.22em] uppercase" style={{ color: 'var(--cream-mute)' }}>
                {footerLeft}
              </span>
            ) : <span />}
            <span className="font-mono text-[10px]" style={{ color: 'var(--cream-mute)' }}>◆</span>
            {footerRight ? (
              <span className="font-mono text-[11px] tracking-[0.22em] uppercase" style={{ color: 'var(--gold)' }}>
                {footerRight}
              </span>
            ) : <span />}
          </div>
        )}
      </div>
    </button>
  );
}
