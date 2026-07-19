import { formatMinor } from '../../utils/currency.js';

// Rows here are owed amounts on expenses the current user paid — the people
// who owe money back. Displayed grouped by name, in the ORIGINAL expense
// currency (the totals block is the only place that converts — D1/D6).
function groupByName(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.name)) groups.set(row.name, []);
    groups.get(row.name).push(row);
  }
  return [...groups.entries()];
}

export default function RepaymentsList({ expenses, currentUserId, onToggleSettled }) {
  const rows = expenses
    .filter((expense) => expense.payerUserId === currentUserId)
    .flatMap((expense) => (expense.owed || []).map((owed) => ({ ...owed, expenseId: expense.id, currency: expense.currency, expenseTitle: expense.title })));

  if (rows.length === 0) {
    return (
      <p className="font-body text-base py-4" style={{ color: 'var(--cream-dim)' }}>
        No one owes you anything on this trip right now.
      </p>
    );
  }

  const grouped = groupByName(rows);

  return (
    <div className="space-y-5">
      {grouped.map(([name, personRows]) => (
        <div key={name}>
          <p className="font-mono text-[11px] tracking-[0.2em] uppercase mb-2" style={{ color: 'var(--cream-mute)' }}>
            {name}
          </p>
          <ul className="space-y-2">
            {personRows.map((row) => (
              <li key={row.id} className="flex items-center justify-between gap-3">
                <span className="font-body text-base" style={{ color: row.settled ? 'var(--cream-mute)' : 'var(--cream)', textDecoration: row.settled ? 'line-through' : 'none' }}>
                  {name} owes you {formatMinor(row.amount, row.currency)}
                </span>
                <button
                  type="button"
                  onClick={() => onToggleSettled(row.expenseId, row.id, !row.settled)}
                  className="font-mono text-[10px] tracking-[0.2em] uppercase px-3 py-2 rounded-full border shrink-0"
                  style={{
                    borderColor: row.settled ? 'var(--ink-border)' : 'var(--gold)',
                    color: row.settled ? 'var(--cream-mute)' : 'var(--gold)',
                  }}
                >
                  {row.settled ? 'Settled' : 'Mark settled'}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
