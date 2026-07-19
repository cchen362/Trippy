import { useCallback, useEffect, useRef, useState } from 'react';
import { expensesApi } from '../services/expensesApi.js';

// Mirrors useBookings' load/run shape, plus an optimistic settled-toggle
// (the one mutation frequent enough — post-trip settlement checklist — to
// warrant instant feedback instead of waiting on the round trip).
export function useExpenses(tripId) {
  const [expenses, setExpenses] = useState([]);
  const [totals, setTotals] = useState(null);
  const [summaryCurrency, setSummaryCurrency] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const hasLoadedRef = useRef(false);
  const requestIdRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!tripId) return;
    const requestId = (requestIdRef.current += 1);
    if (!hasLoadedRef.current) setLoading(true);
    setError(null);
    try {
      const result = await expensesApi.list(tripId);
      if (requestId !== requestIdRef.current) return; // superseded — drop
      setExpenses(result.expenses || []);
      setTotals(result.totals || null);
      setSummaryCurrency(result.summaryCurrency ?? null);
      hasLoadedRef.current = true;
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setError(err);
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [tripId]);

  useEffect(() => {
    hasLoadedRef.current = false;
    refresh();
  }, [refresh]);

  const run = useCallback(async (action) => {
    setSaving(true);
    setError(null);
    try {
      const result = await action();
      if (result?.totals) setTotals(result.totals);
      return result;
    } catch (err) {
      setError(err);
      throw err;
    } finally {
      setSaving(false);
    }
  }, []);

  const createExpense = useCallback((data) => run(async () => {
    const result = await expensesApi.create(tripId, data);
    setExpenses((prev) => [result.expense, ...prev]);
    return result;
  }), [run, tripId]);

  const updateExpense = useCallback((expenseId, data) => run(async () => {
    const result = await expensesApi.update(tripId, expenseId, data);
    setExpenses((prev) => prev.map((exp) => (exp.id === expenseId ? result.expense : exp)));
    return result;
  }), [run, tripId]);

  const deleteExpense = useCallback((expenseId) => run(async () => {
    const result = await expensesApi.remove(tripId, expenseId);
    setExpenses((prev) => prev.filter((exp) => exp.id !== expenseId));
    return result;
  }), [run, tripId]);

  // Optimistic: flip the owed row's `settled` flag immediately, then reconcile
  // with the server response. On failure, restore the pre-toggle snapshot so
  // the UI never shows a settled state the server rejected.
  const toggleOwedSettled = useCallback(async (expenseId, owedId, settled) => {
    setError(null);
    const previous = expenses;
    setExpenses((prev) => prev.map((exp) => (
      exp.id !== expenseId
        ? exp
        : { ...exp, owed: exp.owed.map((row) => (row.id === owedId ? { ...row, settled } : row)) }
    )));
    try {
      const result = await expensesApi.setOwedSettled(tripId, expenseId, owedId, settled);
      setExpenses((prev) => prev.map((exp) => (exp.id === expenseId ? result.expense : exp)));
      if (result.totals) setTotals(result.totals);
      return result;
    } catch (err) {
      setExpenses(previous);
      setError(err);
      throw err;
    }
  }, [expenses, tripId]);

  return {
    expenses,
    totals,
    summaryCurrency,
    loading,
    saving,
    error,
    clearError: () => setError(null),
    refresh,
    createExpense,
    updateExpense,
    deleteExpense,
    toggleOwedSettled,
  };
}
