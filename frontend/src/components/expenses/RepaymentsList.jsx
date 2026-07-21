import { formatMinor } from '../../utils/currency.js';
import { categoryMeta } from './categoryMeta.js';

// Rows here are owed amounts on expenses the current user paid — the people
// who owe money back. Displayed grouped by a normalized name key so different
// spellings/casing of the same person collapse into one group, in the
// ORIGINAL expense currency (the totals block is the only place that
// converts — D1/D6).
function normalizeName(name) {
  return (name || '').toLowerCase().replace(/\s+/g, '');
}

function groupByName(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = normalizeName(row.name);
    if (!groups.has(key)) groups.set(key, { key, label: row.name, rows: [] });
    groups.get(key).rows.push(row);
  }
  return [...groups.values()];
}

export default function RepaymentsList({ expenses, currentUserId, onToggleSettled, onOpenExpense }) {
  const rows = expenses
    .filter((expense) => expense.payerUserId === currentUserId)
    .flatMap((expense) =>
      (expense.owed || []).map((owed) => ({
        ...owed,
        expenseId: expense.id,
        currency: expense.currency,
        expenseTitle: expense.title,
        category: expense.category,
      }))
    );

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
      {grouped.map(({ key, label, rows: personRows }) => {
        const openRows = personRows.filter((r) => !r.settled);
        const openCurrencies = new Set(openRows.map((r) => r.currency));
        const showOutstanding = openRows.length > 0 && openCurrencies.size === 1;
        const outstandingSum = showOutstanding ? openRows.reduce((sum, r) => sum + r.amount, 0) : 0;

        return (
          <div key={key}>
            <p className="font-mono text-[11px] tracking-[0.2em] uppercase mb-2" style={{ color: 'var(--cream-mute)' }}>
              {showOutstanding
                ? `${label} · ${formatMinor(outstandingSum, openRows[0].currency)} outstanding`
                : label}
            </p>
            <ul className="space-y-2">
              {personRows.map((row) => (
                <li key={row.id} className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => onOpenExpense(row.expenseId)}
                    className="min-w-0 flex-1 truncate text-left font-body text-base"
                    style={{ color: row.settled ? 'var(--cream-mute)' : 'var(--cream)', textDecoration: row.settled ? 'line-through' : 'none' }}
                  >
                    {row.expenseTitle || categoryMeta(row.category).label}
                  </button>
                  <span
                    className="font-mono text-sm shrink-0"
                    style={{ color: row.settled ? 'var(--cream-mute)' : 'var(--cream)', textDecoration: row.settled ? 'line-through' : 'none' }}
                  >
                    {formatMinor(row.amount, row.currency)}
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
        );
      })}
    </div>
  );
}
