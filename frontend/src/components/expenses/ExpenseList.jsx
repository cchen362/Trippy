import { Link2 } from 'lucide-react';
import { categoryMeta } from './categoryMeta.js';
import { formatMinor } from '../../utils/currency.js';

function payerInitial(name) {
  return (name || '?').trim().charAt(0).toUpperCase();
}

export default function ExpenseList({ expenses, onOpen }) {
  if (expenses.length === 0) {
    return (
      <p className="font-body text-base py-6 text-center" style={{ color: 'var(--cream-dim)' }}>
        Nothing logged yet — tap Add expense to start the diary for this trip.
      </p>
    );
  }

  return (
    <ul className="divide-y" style={{ borderColor: 'var(--ink-border)' }}>
      {expenses.map((expense) => {
        const { Icon, label } = categoryMeta(expense.category);
        return (
          <li key={expense.id}>
            <button
              type="button"
              onClick={() => onOpen(expense)}
              className="w-full flex items-center gap-3 py-3 text-left"
            >
              <span
                className="w-9 h-9 shrink-0 rounded-full border flex items-center justify-center"
                style={{ borderColor: 'var(--ink-border)', color: 'var(--cream-dim)' }}
              >
                <Icon size={16} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-body text-base truncate" style={{ color: 'var(--cream)' }}>
                  {expense.title || label}
                </span>
                <span className="block font-mono text-[10px] tracking-[0.14em] uppercase" style={{ color: 'var(--cream-mute)' }}>
                  {expense.expenseDate}
                  {expense.bookingId && <Link2 size={11} className="inline ml-1.5 align-text-top" aria-label="Linked to a booking" />}
                </span>
              </span>
              <span className="shrink-0 text-right">
                <span className="block font-mono text-sm" style={{ color: 'var(--cream)' }}>
                  {formatMinor(expense.amount, expense.currency)}
                </span>
                <span className="block font-mono text-[10px] tracking-[0.1em]" style={{ color: 'var(--cream-mute)' }}>
                  {expense.summaryAmount !== null
                    ? `${formatMinor(expense.summaryAmount, expense.summaryCurrency)} est.`
                    : 'unestimated'}
                </span>
              </span>
              <span
                className="w-6 h-6 shrink-0 rounded-full flex items-center justify-center font-mono text-[10px]"
                style={{ background: 'var(--ink-mid)', color: 'var(--cream-dim)' }}
                title={expense.payerName}
              >
                {payerInitial(expense.payerName)}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
