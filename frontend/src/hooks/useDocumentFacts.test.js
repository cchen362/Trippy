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

  it('follows up once and does not re-arm', async () => {
    vi.useFakeTimers();
    factsApi.list.mockResolvedValue(payload('f1'));
    const { result } = renderHook(() => useDocumentFacts('trip-1'));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(factsApi.list).toHaveBeenCalledTimes(1);
    await act(async () => { result.current.refresh({ followUp: true }); });
    expect(factsApi.list).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(factsApi.list).toHaveBeenCalledTimes(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(factsApi.list).toHaveBeenCalledTimes(3);
  });

  it('cancels the pending follow-up on unmount', async () => {
    vi.useFakeTimers();
    factsApi.list.mockResolvedValue(payload('f1'));
    const { result, unmount } = renderHook(() => useDocumentFacts('trip-1'));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { result.current.refresh({ followUp: true }); });
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    expect(factsApi.list).toHaveBeenCalledTimes(2);
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
