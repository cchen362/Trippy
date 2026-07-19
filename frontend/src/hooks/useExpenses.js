import { useCallback, useEffect, useRef, useState } from 'react';
import { expensesApi } from '../services/expensesApi.js';

// Mirrors useBookings' load/run shape, plus an optimistic settled-toggle
// (the one mutation frequent enough — post-trip settlement checklist — to
// warrant instant feedback instead of waiting on the round trip).
//
// Silent refetch (W3.5 item d): if a list response still has an unestimated
// row (summaryAmount null while a summary currency is set and the row's own
// currency differs from it), the backend's bounded stamping pass may just
// have missed the budget — schedule ONE quiet retry ~3s later. A retry that
// itself still comes back unestimated (e.g. FX negative-cached) does not
// re-arm, so this can never loop.
const SILENT_REFETCH_DELAY_MS = 3000;

function hasUnestimatedRow(expenses, summaryCurrency) {
  if (!summaryCurrency) return false;
  return (expenses || []).some((exp) => exp.summaryAmount == null && exp.currency !== summaryCurrency);
}

export function useExpenses(tripId) {
  const [expenses, setExpenses] = useState([]);
  const [totals, setTotals] = useState(null);
  const [summaryCurrency, setSummaryCurrency] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const hasLoadedRef = useRef(false);
  const requestIdRef = useRef(0);
  const silentRetryTimerRef = useRef(null);

  const clearSilentRetryTimer = useCallback(() => {
    if (silentRetryTimerRef.current) {
      clearTimeout(silentRetryTimerRef.current);
      silentRetryTimerRef.current = null;
    }
  }, []);

  const refresh = useCallback(async (options = {}) => {
    if (!tripId) return;
    const isSilentRetry = Boolean(options.silentRetry);
    const requestId = (requestIdRef.current += 1);
    if (!hasLoadedRef.current) setLoading(true);
    setError(null);
    try {
      const result = await expensesApi.list(tripId);
      if (requestId !== requestIdRef.current) return; // superseded — drop
      const nextExpenses = result.expenses || [];
      const nextSummaryCurrency = result.summaryCurrency ?? null;
      setExpenses(nextExpenses);
      setTotals(result.totals || null);
      setSummaryCurrency(nextSummaryCurrency);
      hasLoadedRef.current = true;

      // Fire at most one silent retry per completed refresh, and never chain a
      // retry off of a retry — a still-unestimated row after the retry is left
      // as-is (likely negative-cached upstream) rather than polled forever.
      if (!isSilentRetry && hasUnestimatedRow(nextExpenses, nextSummaryCurrency)) {
        clearSilentRetryTimer();
        silentRetryTimerRef.current = setTimeout(() => {
          silentRetryTimerRef.current = null;
          refresh({ silentRetry: true });
        }, SILENT_REFETCH_DELAY_MS);
      }
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setError(err);
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [tripId, clearSilentRetryTimer]);

  useEffect(() => {
    hasLoadedRef.current = false;
    clearSilentRetryTimer();
    refresh();
    return clearSilentRetryTimer;
  }, [refresh, clearSilentRetryTimer]);

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
