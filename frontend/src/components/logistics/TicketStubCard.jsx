// Shared transit-card primitive used by FlightBookingCard and TrainBookingCard.
// Accepts display-ready values only; no booking data access here.
export default function TicketStubCard({
  cardClassName = '',
  eyebrow,
  leftCode,
  leftCodeSize = '',
  centerGlyph,
  rightCode,
  rightCodeSize = '',
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
      className={`logistics-card logistics-transit-card ${cardClassName} w-full text-left focus-visible:ring-2 focus-visible:ring-[var(--gold-line)]`}
    >
      <div className="logistics-card-top logistics-transit-top">
        <p className="logistics-eyebrow">{eyebrow}</p>

        <div className="logistics-route-grid">
          <span className={`logistics-route-code ${leftCodeSize}`}>
            {leftCode}
          </span>
          {centerGlyph && (
            <span className="logistics-route-center">
              {centerGlyph}
            </span>
          )}
          <span className={`logistics-route-code logistics-route-code-right ${rightCodeSize}`}>
            {rightCode}
          </span>
        </div>

        {connector && <span className="sr-only">Transit route connector</span>}
      </div>

      <div className="logistics-transit-body">
        {(leftTime || rightTime) && (
          <div className="logistics-time-grid">
            <div>
              <p className="logistics-time">{leftTime}</p>
              {leftLabel && <p className="logistics-time-label">{leftLabel}</p>}
              {leftDate && <p className="logistics-date">{leftDate}</p>}
            </div>
            <div className="text-right">
              <p className="logistics-time">{rightTime}</p>
              {rightLabel && <p className="logistics-time-label">{rightLabel}</p>}
              {rightDate && <p className="logistics-date">{rightDate}</p>}
            </div>
          </div>
        )}

        {(footerLeft || footerRight) && (
          <div className="logistics-transit-footer">
            <div className="logistics-footer-line" />
            <div className="logistics-footer-row">
              {footerLeft ? (
                <span className="logistics-footer-label">{footerLeft}</span>
              ) : <span />}
              {footerRight ? (
                <span className="logistics-footer-value">{footerRight}</span>
              ) : <span />}
            </div>
          </div>
        )}
      </div>
    </button>
  );
}
