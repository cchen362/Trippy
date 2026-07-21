import { useState } from 'react';
import { Plus } from 'lucide-react';
import ErrorBanner from '../components/common/ErrorBanner.jsx';
import ExpenseSummary from '../components/expenses/ExpenseSummary.jsx';
import ExpenseList from '../components/expenses/ExpenseList.jsx';
import RepaymentsList from '../components/expenses/RepaymentsList.jsx';
import ExpenseSheet from '../components/expenses/ExpenseSheet.jsx';
import SummaryCurrencyPrompt from '../components/expenses/SummaryCurrencyPrompt.jsx';
import { useExpenses } from '../hooks/useExpenses.js';
import { useCollaboration } from '../hooks/useCollaboration.js';
import { useAuth } from '../context/AuthContext.jsx';
import { tripsApi } from '../services/tripsApi.js';
import { currencyForCountry } from '../utils/currency.js';
import { useTripContext } from './TripPage.jsx';

export default function ExpensesTab() {
  const { trip, activeDay, bookings, refresh: refreshTrip } = useTripContext();
  const { user } = useAuth();
  const expensesState = useExpenses(trip.id);
  const collaboration = useCollaboration(trip.id);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editingExpense, setEditingExpense] = useState(null);
  const [savingSummaryCurrency, setSavingSummaryCurrency] = useState(false);

  const { expenses, totals, summaryCurrency, loading, saving, error, clearError } = expensesState;

  const defaultCurrency = currencyForCountry(activeDay?.resolvedCountry) || summaryCurrency || 'SGD';
  const collaboratorOptions = collaboration.owner
    ? [collaboration.owner, ...collaboration.collaborators]
    : collaboration.collaborators;

  const openAdd = () => { setEditingExpense(null); setSheetOpen(true); };
  const openEdit = (expense) => { setEditingExpense(expense); setSheetOpen(true); };
  const closeSheet = () => { setSheetOpen(false); setEditingExpense(null); };

  const handleSave = async (payload) => {
    if (editingExpense) {
      await expensesState.updateExpense(editingExpense.id, payload);
    } else {
      await expensesState.createExpense(payload);
    }
  };

  const handleDelete = async (expenseId) => {
    await expensesState.deleteExpense(expenseId);
    closeSheet();
  };

  const handleSaveSummaryCurrency = async (currency) => {
    setSavingSummaryCurrency(true);
    try {
      await tripsApi.update(trip.id, { summaryCurrency: currency });
      await Promise.all([refreshTrip(), expensesState.refresh()]);
    } finally {
      setSavingSummaryCurrency(false);
    }
  };

  if (loading) {
    return (
      <p className="font-mono text-xs tracking-[0.22em] uppercase" style={{ color: 'var(--cream-mute)' }}>
        Loading expenses...
      </p>
    );
  }

  const hasOpenRepayments = expenses.some(
    (e) => e.payerUserId === user?.id && (e.owed || []).length > 0
  );

  const repaymentsSection = (
    <section key="repayments">
      <h2 className="font-mono text-[11px] tracking-[0.28em] uppercase mb-2" style={{ color: 'var(--cream-mute)' }}>
        To collect
      </h2>
      <RepaymentsList
        expenses={expenses}
        currentUserId={user?.id}
        onToggleSettled={expensesState.toggleOwedSettled}
        onOpenExpense={(expenseId) => openEdit(expenses.find((e) => e.id === expenseId))}
      />
    </section>
  );

  const recentEntriesSection = (
    <section key="recent">
      <h2 className="font-mono text-[11px] tracking-[0.28em] uppercase mb-2" style={{ color: 'var(--cream-mute)' }}>
        Recent entries
      </h2>
      <ExpenseList expenses={expenses} onOpen={openEdit} currentUserId={user?.id} bookings={bookings} />
    </section>
  );

  return (
    <div className="max-w-2xl mx-auto space-y-8 pb-28">
      <SummaryCurrencyPrompt
        open={!loading && !summaryCurrency}
        onSave={handleSaveSummaryCurrency}
        saving={savingSummaryCurrency}
      />

      <ErrorBanner message={error?.message} onDismiss={clearError} />

      <div className="flex items-start justify-between gap-4">
        <h1 className="font-display italic text-3xl" style={{ color: 'var(--cream)' }}>Expenses</h1>
        <button
          type="button"
          onClick={openAdd}
          className="flex items-center gap-2 px-4 py-3 rounded-xl font-mono text-xs tracking-[0.22em] uppercase shrink-0"
          style={{ background: 'var(--gold)', color: 'var(--ink-deep)' }}
        >
          <Plus size={14} /> Add expense
        </button>
      </div>

      <ExpenseSummary totals={totals} />

      {hasOpenRepayments ? (
        <>
          {repaymentsSection}
          {recentEntriesSection}
        </>
      ) : (
        <>
          {recentEntriesSection}
          {repaymentsSection}
        </>
      )}

      <ExpenseSheet
        open={sheetOpen}
        onClose={closeSheet}
        expense={editingExpense}
        defaultCurrency={defaultCurrency}
        currentUserId={user?.id}
        collaborators={collaboratorOptions}
        bookings={bookings}
        allExpenses={expenses}
        saving={saving}
        onSave={handleSave}
        onDelete={handleDelete}
      />
    </div>
  );
}
