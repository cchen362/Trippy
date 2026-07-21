import { useState } from 'react';
import { formatMinor } from '../../utils/currency.js';
import { categoryMeta } from '../expenses/categoryMeta.js';
import { normalizeOwedName } from '../../utils/owedNames.js';

// Sums open (unsettled) owed rows per currency and formats them, joining
// distinct currencies with ' + '. Never sums across currencies (Cross-wave
// invariant #3) — mirrors the mixed-currency guard in RepaymentsList.
function formatOpenRepaymentsAggregate(expenses, selectedIds) {
  const byCurrency = new Map();
  for (const expense of expenses) {
    if (!selectedIds.has(expense.id)) continue;
    const openRows = (expense.owed || []).filter((row) => !row.settled);
    if (openRows.length === 0) continue;
    const sum = openRows.reduce((total, row) => total + row.amount, 0);
    byCurrency.set(expense.currency, (byCurrency.get(expense.currency) || 0) + sum);
  }
  if (byCurrency.size === 0) return null;
  return [...byCurrency.entries()].map(([currency, amount]) => formatMinor(amount, currency)).join(' + ');
}

function openRepaymentsConsequence(expense) {
  const openRows = (expense.owed || []).filter((row) => !row.settled);
  if (openRows.length === 0) return null;
  const sum = openRows.reduce((total, row) => total + row.amount, 0);
  // Spelling variants of one name are one person (decision e) — two rows for
  // "Sarah" and "sarah" must not read as two people in a destructive warning.
  const people = new Set(openRows.map((row) => normalizeOwedName(row.name))).size;
  if (people === 1) {
    return `includes ${openRows[0].name}'s ${formatMinor(sum, expense.currency)} open repayment`;
  }
  return `includes ${formatMinor(sum, expense.currency)} in open repayments across ${people} people`;
}

export default function BookingDeleteReview({ booking, expenses, saving, error, onCancel, onConfirm }) {
  const [selectedIds, setSelectedIds] = useState(() => new Set());

  const toggle = (expenseId) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(expenseId)) next.delete(expenseId);
      else next.add(expenseId);
      return next;
    });
  };

  const allSelected = expenses.length > 0
    && expenses.every((e) => selectedIds.has(e.id));
  const toggleAll = () => {
    setSelectedIds(allSelected ? new Set() : new Set(expenses.map((e) => e.id)));
  };

  // Intersect the selection with the live list rather than sending `selectedIds` raw:
  // a cost deleted on another device drops out of `expenses` when the list re-syncs,
  // and re-sending its dead id would fail the whole request on every retry.
  const liveSelectedIds = expenses.filter((e) => selectedIds.has(e.id)).map((e) => e.id);
  const selectedCount = liveSelectedIds.length;
  const aggregate = formatOpenRepaymentsAggregate(expenses, selectedIds);

  let confirmLabel;
  if (selectedCount === 0) {
    confirmLabel = 'Delete booking only';
  } else {
    confirmLabel = `Delete booking and ${selectedCount} cost${selectedCount === 1 ? '' : 's'}`;
    if (aggregate) confirmLabel += ` · ${aggregate} in open repayments`;
  }

  return (
    <div>
      <p className="font-body text-lg mb-1" style={{ color: 'var(--cream)' }}>
        Delete &ldquo;{booking.title}&rdquo;?
      </p>
      <p className="font-body text-base mb-4" style={{ color: 'var(--cream-dim)' }}>
        {expenses.length} cost{expenses.length === 1 ? '' : 's'} linked to this booking. Select any costs to delete too.
      </p>

      <button
        type="button"
        onClick={toggleAll}
        className="mb-2 font-mono text-[11px] tracking-[0.2em] uppercase"
        style={{ color: 'var(--cream-dim)' }}
      >
        {allSelected ? 'Clear all' : 'Select all'}
      </button>

      <ul className="space-y-3 max-h-[40vh] overflow-y-auto">
        {expenses.map((expense) => {
          const checked = selectedIds.has(expense.id);
          const consequence = checked ? openRepaymentsConsequence(expense) : null;
          return (
            <li key={expense.id}>
              <label className="flex items-center gap-3 min-h-[24px]">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(expense.id)}
                  className="shrink-0"
                  style={{ width: 24, height: 24, accentColor: 'var(--gold)' }}
                />
                <span className="min-w-0 flex-1 truncate font-mono text-sm" style={{ color: 'var(--cream)' }}>
                  {expense.title || categoryMeta(expense.category).label}
                </span>
                <span className="shrink-0 font-mono text-sm" style={{ color: 'var(--cream)' }}>
                  {formatMinor(expense.amount, expense.currency)}
                </span>
              </label>
              {consequence && (
                <p className="mt-1 ml-9 font-mono text-[10px]" style={{ color: 'var(--cream-mute)' }}>
                  {consequence}
                </p>
              )}
            </li>
          );
        })}
      </ul>

      <p className="mt-3 font-mono text-[10px]" style={{ color: 'var(--cream-mute)' }}>
        Unchecked costs stay in Expenses without a booking link.
      </p>

      {error && (
        <p className="mt-3 font-body text-sm" style={{ color: '#e05a5a' }}>{error}</p>
      )}

      <div className="mt-4 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={onCancel}
          className="font-mono text-xs tracking-[0.22em] uppercase"
          style={{ color: 'var(--cream-dim)' }}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => onConfirm(liveSelectedIds)}
          disabled={saving}
          className="px-4 py-3 rounded-xl border font-mono text-xs tracking-[0.22em] uppercase"
          style={{ color: '#e05a5a', borderColor: 'rgba(224,90,90,0.28)', opacity: saving ? 0.6 : 1 }}
        >
          {saving ? 'Deleting…' : confirmLabel}
        </button>
      </div>
    </div>
  );
}
