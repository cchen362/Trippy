// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useDocumentFacts } from './useDocumentFacts.js';
import { factsApi } from '../services/factsApi.js';

vi.mock('../services/factsApi.js', () => ({ factsApi: { list: vi.fn() } }));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const payload = (id) => ({
  bookings: [{ bookingId: 'b1', facts: [{ id }] }, { bookingId: 'b2', facts: [] }],
  readsPending: 0,
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useDocumentFacts', () => {
  it('groups facts by booking and omits bookings with none', async () => {
    factsApi.list.mockResolvedValue(payload('f1'));
    const { result } = renderHook(() => useDocumentFacts('trip-1'));
    await act(async () => {});
    expect(result.current.factsByBooking).toEqual({ b1: [{ id: 'f1' }] });
    expect(result.current.loaded).toBe(true);
  });

  it('drops a superseded response', async () => {
    const slow = deferred();
    const fast = deferred();
    factsApi.list.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise);
    const { result } = renderHook(() => useDocumentFacts('trip-1'));
    act(() => { result.current.refresh(); });
    await act(async () => { fast.resolve(payload('newer')); });
    await act(async () => { slow.resolve(payload('older')); });
    expect(result.current.factsByBooking).toEqual({ b1: [{ id: 'newer' }] });
  });

  it('refresh makes one plain request and never schedules another', async () => {
    vi.useFakeTimers();
    factsApi.list.mockResolvedValue(payload('f1'));
    const { result } = renderHook(() => useDocumentFacts('trip-1'));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { result.current.refresh(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(factsApi.list).toHaveBeenCalledTimes(2);
    expect(factsApi.list).toHaveBeenLastCalledWith('trip-1');
  });

  it('keeps the last good data when a later load fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    factsApi.list.mockResolvedValueOnce(payload('f1')).mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHook(() => useDocumentFacts('trip-1'));
    await act(async () => {});
    await act(async () => { await result.current.refresh(); });
    expect(result.current.factsByBooking).toEqual({ b1: [{ id: 'f1' }] });
    expect(consoleError).toHaveBeenCalledWith('[facts] load failed:', 'offline');
    consoleError.mockRestore();
  });

  it('resets when the trip changes', async () => {
    factsApi.list.mockResolvedValueOnce(payload('f1')).mockResolvedValueOnce({ bookings: [], readsPending: 0 });
    const { result, rerender } = renderHook(({ id }) => useDocumentFacts(id), { initialProps: { id: 'trip-1' } });
    await act(async () => {});
    expect(result.current.factsByBooking.b1).toBeDefined();
    rerender({ id: 'trip-2' });
    await act(async () => {});
    expect(result.current.factsByBooking).toEqual({});
    expect(factsApi.list).toHaveBeenLastCalledWith('trip-2');
  });
});

describe('useDocumentFacts — awaitReads (D-37-15)', () => {
  const empty = (readsPending = 0) => ({ bookings: [], readsPending });
  const withFacts = (readsPending = 0, ids = ['b9']) => ({
    bookings: ids.map((bookingId) => ({ bookingId, facts: [{ id: `f-${bookingId}` }] })),
    readsPending,
  });

  async function mountLoaded() {
    factsApi.list.mockResolvedValueOnce(empty());
    const hook = renderHook(() => useDocumentFacts('trip-1'));
    await act(async () => {});
    return hook;
  }

  it('marks the booking reading, makes one held request, and clears when the facts arrive', async () => {
    const { result } = await mountLoaded();
    const held = deferred();
    factsApi.list.mockReturnValueOnce(held.promise);
    let done;
    act(() => { done = result.current.awaitReads(['b9']); });
    expect(result.current.readingStatus).toEqual({ b9: 'reading' });
    expect(factsApi.list).toHaveBeenLastCalledWith('trip-1', { wait: true });
    await act(async () => { held.resolve(withFacts(0)); await done; });
    expect(result.current.readingStatus).toEqual({});
    expect(result.current.factsByBooking).toEqual({ b9: [{ id: 'f-b9' }] });
    expect(factsApi.list).toHaveBeenCalledTimes(2);
  });

  it('names the booking in arrivedIds, and the next refresh clears it', async () => {
    const { result } = await mountLoaded();
    factsApi.list.mockResolvedValueOnce(withFacts(0));
    await act(async () => { await result.current.awaitReads(['b9']); });
    expect(result.current.arrivedIds).toEqual(['b9']);
    factsApi.list.mockResolvedValueOnce(withFacts(0));
    await act(async () => { await result.current.refresh(); });
    expect(result.current.arrivedIds).toEqual([]);
  });

  it('clears the mark with nothing arrived when the read found no conditions', async () => {
    const { result } = await mountLoaded();
    factsApi.list.mockResolvedValueOnce(empty(0));
    await act(async () => { await result.current.awaitReads(['b9']); });
    expect(result.current.readingStatus).toEqual({});
    expect(result.current.arrivedIds).toEqual([]);
    expect(factsApi.list).toHaveBeenCalledTimes(2);
  });

  it('makes a second held request only while reads are still pending', async () => {
    const { result } = await mountLoaded();
    factsApi.list.mockResolvedValueOnce(empty(1)).mockResolvedValueOnce(withFacts(0));
    await act(async () => { await result.current.awaitReads(['b9']); });
    expect(factsApi.list).toHaveBeenCalledTimes(3);
    expect(factsApi.list).toHaveBeenLastCalledWith('trip-1', { wait: true });
    expect(result.current.readingStatus).toEqual({});
    expect(result.current.arrivedIds).toEqual(['b9']);
  });

  it('does not make the second request once the booking has its facts', async () => {
    const { result } = await mountLoaded();
    factsApi.list.mockResolvedValueOnce(withFacts(1));
    await act(async () => { await result.current.awaitReads(['b9']); });
    expect(factsApi.list).toHaveBeenCalledTimes(2);
    expect(result.current.readingStatus).toEqual({});
  });

  it('marks the booking slow after two held requests and never asks a third time', async () => {
    vi.useFakeTimers();
    factsApi.list.mockResolvedValue(empty(1));
    const { result } = renderHook(() => useDocumentFacts('trip-1'));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await result.current.awaitReads(['b9']); });
    expect(factsApi.list).toHaveBeenCalledTimes(3);
    expect(result.current.readingStatus).toEqual({ b9: 'slow' });
    await act(async () => { await vi.advanceTimersByTimeAsync(120000); });
    expect(factsApi.list).toHaveBeenCalledTimes(3);
  });

  it('clears the marks quietly when a held request fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result } = await mountLoaded();
    factsApi.list.mockRejectedValueOnce(new Error('offline'));
    await act(async () => { await result.current.awaitReads(['b9']); });
    expect(result.current.readingStatus).toEqual({});
    expect(consoleError).toHaveBeenCalledWith('[facts] wait failed:', 'offline');
    consoleError.mockRestore();
  });

  it('a newer call takes over the bookings an older one was waiting on', async () => {
    const { result } = await mountLoaded();
    const first = deferred();
    factsApi.list.mockReturnValueOnce(first.promise);
    let firstDone;
    act(() => { firstDone = result.current.awaitReads(['b9']); });
    factsApi.list.mockResolvedValueOnce(withFacts(0, ['b9', 'b8']));
    await act(async () => { await result.current.awaitReads(['b8']); });
    await act(async () => { first.resolve(empty(0)); await firstDone; });
    expect(result.current.readingStatus).toEqual({});
    expect(result.current.factsByBooking).toEqual({ b9: [{ id: 'f-b9' }], b8: [{ id: 'f-b8' }] });
  });

  it('clears the marks on a trip change and drops the held reply that lands afterwards', async () => {
    const { result, rerender, unmount } = await (async () => {
      factsApi.list.mockResolvedValueOnce(empty());
      const hook = renderHook(({ id }) => useDocumentFacts(id), { initialProps: { id: 'trip-1' } });
      await act(async () => {});
      return hook;
    })();
    const held = deferred();
    factsApi.list.mockReturnValueOnce(held.promise);
    let done;
    act(() => { done = result.current.awaitReads(['b9']); });
    factsApi.list.mockResolvedValueOnce(empty());
    rerender({ id: 'trip-2' });
    await act(async () => {});
    expect(result.current.readingStatus).toEqual({});
    await act(async () => { held.resolve(withFacts(0)); await done; });
    expect(result.current.factsByBooking).toEqual({});
    unmount();
  });
});
