import { formatMinor } from '../../utils/currency.js';

// Spent-primary headline (D1): everything the current user paid, including
// fronted purchases, never silently excluded. Secondary lines break out what's
// still owed back and the user's true net share.
export default function ExpenseSummary({ totals }) {
  if (!totals) return null;

  const unestimatedEntries = Object.entries(totals.unestimatedByCurrency || {});

  return (
    <div className="space-y-3">
      <div>
        <p className="font-mono text-[11px] tracking-[0.28em] uppercase mb-1" style={{ color: 'var(--cream-mute)' }}>
          Spent
        </p>
        <p className="font-mono text-4xl" style={{ color: 'var(--gold)' }}>
          {formatMinor(totals.spent, totals.summaryCurrency)}
        </p>
      </div>

      <div className="font-mono text-sm space-y-1" style={{ color: 'var(--cream-dim)' }}>
        <p>Awaiting repayment: {formatMinor(totals.awaitingRepayment, totals.summaryCurrency)}</p>
        <p>Your share (est.): {formatMinor(totals.netShare, totals.summaryCurrency)}</p>
      </div>

      {unestimatedEntries.length > 0 && (
        <p className="font-mono text-xs" style={{ color: 'var(--cream-mute)' }}>
          {unestimatedEntries.map(([currency, amount]) => `+ ${formatMinor(amount, currency)} unestimated`).join(', ')}
        </p>
      )}

      <p className="font-body text-sm pt-1" style={{ color: 'rgba(240,234,216,0.45)' }}>
        Estimates use daily mid-market reference rates, not your card's exchange rate.
      </p>
    </div>
  );
}
