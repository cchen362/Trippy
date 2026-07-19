import { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, Plus, X } from 'lucide-react';
import ModalShell from '../shell/ModalShell.jsx';
import ErrorBanner from '../common/ErrorBanner.jsx';
import CurrencyChip from './CurrencyChip.jsx';
import { EXPENSE_CATEGORIES } from './categoryMeta.js';
import { minorUnitsFor } from '../../utils/currency.js';
import { localIso } from '../../utils/date.js';

function toMinor(amountStr, currency) {
  const decimals = minorUnitsFor(currency);
  const value = parseFloat(amountStr);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 10 ** decimals);
}

function toMajorString(minor, currency) {
  if (minor === null || minor === undefined) return '';
  const decimals = minorUnitsFor(currency);
  return (minor / 10 ** decimals).toString();
}

function emptyForm(defaultCurrency, currentUserId) {
  return {
    amount: '',
    currency: defaultCurrency,
    category: 'other',
    expenseDate: localIso(),
    title: '',
    note: '',
    bookingId: null,
    payerUserId: currentUserId,
    manualRate: '',
    owed: [],
  };
}

function fromExpense(expense) {
  return {
    amount: toMajorString(expense.amount, expense.currency),
    currency: expense.currency,
    category: expense.category,
    expenseDate: expense.expenseDate,
    title: expense.title ?? '',
    note: expense.note ?? '',
    bookingId: expense.bookingId ?? null,
    payerUserId: expense.payerUserId,
    manualRate: expense.fxSource === 'manual' && expense.fxRate ? String(expense.fxRate) : '',
    owed: (expense.owed || []).map((row) => ({
      name: row.name,
      amount: toMajorString(row.amount, expense.currency),
      settled: row.settled,
    })),
  };
}

// Add/edit sheet on ModalShell. Amount + currency + category are always
// visible and gate Save; date is visible-but-defaulted (D2); payer/note/
// booking-link/manual-rate/owed-rows live in a collapsed "More" section.
export default function ExpenseSheet({
  open,
  onClose,
  expense = null,
  defaultCurrency,
  currentUserId,
  collaborators = [],
  bookings = [],
  saving,
  onSave,
  onDelete,
}) {
  const [form, setForm] = useState(() => (expense ? fromExpense(expense) : emptyForm(defaultCurrency, currentUserId)));
  const [moreOpen, setMoreOpen] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return;
    setForm(expense ? fromExpense(expense) : emptyForm(defaultCurrency, currentUserId));
    setMoreOpen(false);
    setError(null);
  }, [open, expense, defaultCurrency, currentUserId]);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const amountMinor = toMinor(form.amount, form.currency);
  const amountValid = amountMinor !== null && amountMinor > 0;

  const owedSumMinor = form.owed.reduce((sum, row) => {
    const rowMinor = toMinor(row.amount, form.currency);
    return sum + (Number.isFinite(rowMinor) ? rowMinor : 0);
  }, 0);
  const owedExceedsAmount = amountValid && owedSumMinor > amountMinor;
  const owedRowsIncomplete = form.owed.some((row) => !row.name.trim() || toMinor(row.amount, form.currency) === null);

  const canSave = amountValid && !owedExceedsAmount && !owedRowsIncomplete;

  const updateOwedRow = (index, patch) => setForm((f) => ({
    ...f,
    owed: f.owed.map((row, i) => (i === index ? { ...row, ...patch } : row)),
  }));

  const addOwedRow = () => setForm((f) => ({ ...f, owed: [...f.owed, { name: '', amount: '', settled: false }] }));
  const removeOwedRow = (index) => setForm((f) => ({ ...f, owed: f.owed.filter((_, i) => i !== index) }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!canSave) return;
    setError(null);
    const payload = {
      amount: amountMinor,
      currency: form.currency,
      category: form.category,
      expenseDate: form.expenseDate,
      title: form.title.trim() || null,
      note: form.note.trim() || null,
      bookingId: form.bookingId || null,
      payerUserId: form.payerUserId,
      manualRate: form.manualRate.trim() ? parseFloat(form.manualRate) : (expense ? null : undefined),
      owed: form.owed.map((row) => ({
        name: row.name.trim(),
        amount: toMinor(row.amount, form.currency),
        settled: Boolean(row.settled),
      })),
    };
    try {
      await onSave(payload);
      onClose();
    } catch (err) {
      // Loud inline error, form state preserved — no offline queueing (D2/D5e).
      setError(err.message || 'Could not save this expense.');
    }
  };

  const formId = 'expense-form';

  return (
    <ModalShell
      open={open}
      onRequestClose={onClose}
      zBase={220}
      eyebrow={expense ? 'Edit expense' : 'New expense'}
      headline={expense ? 'Update this entry.' : 'Log what you spent.'}
      maxWidth="2xl"
      footer={
        <div className="flex items-center justify-between gap-3">
          {expense && onDelete ? (
            <button
              type="button"
              onClick={() => onDelete(expense.id)}
              className="modal-danger-text px-3 py-3 font-mono text-xs tracking-[0.22em] uppercase"
            >
              Delete
            </button>
          ) : <span />}
          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-3 rounded-xl font-mono text-xs tracking-[0.22em] uppercase border"
              style={{ color: 'var(--cream-dim)', borderColor: 'var(--ink-border)' }}
            >
              Cancel
            </button>
            <button
              type="submit"
              form={formId}
              disabled={!canSave || saving}
              className="px-5 py-3 rounded-xl font-mono text-xs tracking-[0.22em] uppercase"
              style={{ background: 'var(--gold)', color: 'var(--ink-deep)', opacity: !canSave || saving ? 0.6 : 1 }}
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      }
    >
      <form id={formId} onSubmit={handleSubmit} className="pb-6 space-y-5">
        <ErrorBanner message={error} onDismiss={() => setError(null)} />

        <div className="flex items-end gap-3">
          <label className="block flex-1">
            <span className="modal-label">Amount</span>
            <input
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              value={form.amount}
              onChange={set('amount')}
              placeholder="0.00"
              className="modal-input"
              autoFocus
            />
          </label>
          <CurrencyChip value={form.currency} onChange={(currency) => setForm((f) => ({ ...f, currency }))} />
        </div>

        <div>
          <span className="modal-label">Category</span>
          <div className="grid grid-cols-3 gap-2">
            {EXPENSE_CATEGORIES.map(({ value, label, Icon }) => (
              <button
                key={value}
                type="button"
                onClick={() => setForm((f) => ({ ...f, category: value }))}
                className="rounded-xl border px-3 py-3 flex flex-col items-center gap-1.5"
                style={{
                  borderColor: form.category === value ? 'var(--gold)' : 'var(--ink-border)',
                  color: form.category === value ? 'var(--gold)' : 'var(--cream-dim)',
                  background: form.category === value ? 'rgba(201,168,76,0.08)' : 'transparent',
                }}
              >
                <Icon size={18} />
                <span className="font-mono text-[10px] tracking-[0.14em] uppercase">{label}</span>
              </button>
            ))}
          </div>
        </div>

        <label className="block">
          <span className="modal-label">Date</span>
          <input type="date" value={form.expenseDate} onChange={set('expenseDate')} className="modal-input" />
        </label>

        <label className="block">
          <span className="modal-label">Title (optional)</span>
          <input type="text" value={form.title} onChange={set('title')} className="modal-input" placeholder="e.g. Taxi to hotel" />
        </label>

        {owedExceedsAmount && (
          <p className="font-mono text-[11px]" style={{ color: '#e05a5a' }}>
            Owed amounts exceed the expense amount.
          </p>
        )}

        <button
          type="button"
          onClick={() => setMoreOpen((v) => !v)}
          className="flex items-center gap-2 font-mono text-[11px] tracking-[0.22em] uppercase"
          style={{ color: 'var(--cream-mute)' }}
        >
          {moreOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          More
        </button>

        {moreOpen && (
          <div className="space-y-5 pt-1">
            <label className="block">
              <span className="modal-label">Paid by</span>
              <select value={form.payerUserId} onChange={(e) => setForm((f) => ({ ...f, payerUserId: e.target.value }))} className="modal-input">
                {collaborators.map((person) => (
                  <option key={person.id} value={person.id}>{person.displayName || person.username}</option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="modal-label">Note</span>
              <textarea value={form.note} onChange={set('note')} className="modal-input" rows={2} />
            </label>

            {bookings.length > 0 && (
              <label className="block">
                <span className="modal-label">Linked booking</span>
                <select
                  value={form.bookingId ?? ''}
                  onChange={(e) => setForm((f) => ({ ...f, bookingId: e.target.value || null }))}
                  className="modal-input"
                >
                  <option value="">Not linked</option>
                  {bookings.map((booking) => (
                    <option key={booking.id} value={booking.id}>{booking.title}</option>
                  ))}
                </select>
              </label>
            )}

            <label className="block">
              <span className="modal-label">Manual FX rate (optional)</span>
              <input
                type="number"
                inputMode="decimal"
                step="any"
                min="0"
                value={form.manualRate}
                onChange={set('manualRate')}
                className="modal-input"
                placeholder="Leave blank to use the daily reference rate"
              />
            </label>

            <div>
              <span className="modal-label">Someone owes me</span>
              <div className="space-y-2">
                {form.owed.map((row, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input
                      type="text"
                      value={row.name}
                      onChange={(e) => updateOwedRow(i, { name: e.target.value })}
                      placeholder="Name"
                      className="modal-input flex-1"
                    />
                    <input
                      type="number"
                      inputMode="decimal"
                      step="0.01"
                      min="0"
                      value={row.amount}
                      onChange={(e) => updateOwedRow(i, { amount: e.target.value })}
                      placeholder="0.00"
                      className="modal-input"
                      style={{ width: '7rem', flexShrink: 0 }}
                    />
                    <button type="button" onClick={() => removeOwedRow(i)} aria-label="Remove" className="p-2" style={{ color: 'var(--cream-mute)' }}>
                      <X size={16} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={addOwedRow}
                  className="flex items-center gap-2 font-mono text-[11px] tracking-[0.2em] uppercase mt-1"
                  style={{ color: 'var(--gold)' }}
                >
                  <Plus size={14} /> Add person
                </button>
              </div>
            </div>
          </div>
        )}
      </form>
    </ModalShell>
  );
}
