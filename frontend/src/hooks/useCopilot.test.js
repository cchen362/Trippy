// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCopilot } from './useCopilot.js';
import { copilotApi } from '../services/copilotApi.js';

vi.mock('../services/copilotApi.js', () => ({
  copilotApi: {
    history: vi.fn(),
    send: vi.fn(),
    apply: vi.fn(),
    reject: vi.fn(),
    clear: vi.fn(),
  },
}));

vi.mock('../context/AuthContext.jsx', () => ({
  useAuth: () => ({ user: { display_name: 'Test User' } }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  copilotApi.history.mockResolvedValue({
    messages: [{ id: 'history-1', role: 'user', content: 'Earlier', createdAt: '2026-01-01', context: null }],
    proposals: [],
  });
  copilotApi.send.mockImplementation(async (_tripId, _text, _context, onChunk) => {
    onChunk({ type: 'done' });
  });
});

describe('useCopilot context channel', () => {
  it('normalizes history and attaches the same context field to a live user turn', async () => {
    const { result } = renderHook(() => useCopilot('trip-1'));
    await waitFor(() => expect(result.current.messages).toHaveLength(1));

    const context = { tab: 'plan', dayId: 'day-3' };
    await act(async () => {
      await result.current.send('How is this day looking?', context);
    });

    expect(result.current.messages[0].context).toBeNull();
    expect(result.current.messages[1]).toMatchObject({
      role: 'user',
      content: 'How is this day looking?',
      context,
    });
    expect(copilotApi.send).toHaveBeenCalledWith(
      'trip-1',
      'How is this day looking?',
      context,
      expect.any(Function),
      expect.any(AbortSignal),
    );
  });
});

describe('useCopilot truncation notice (Plan 15 Wave 1)', () => {
  it('attaches notice: "truncated" to the assistant message when a notice event arrives', async () => {
    copilotApi.send.mockImplementation(async (_tripId, _text, _context, onChunk) => {
      onChunk({ type: 'text', content: 'Cut off mid' });
      onChunk({ type: 'notice', notice: 'truncated' });
      onChunk({ type: 'done' });
    });

    const { result } = renderHook(() => useCopilot('trip-1'));
    await waitFor(() => expect(result.current.messages).toHaveLength(1));

    await act(async () => {
      await result.current.send('tell me more');
    });

    const assistantMsg = result.current.messages.find((m) => m.role === 'assistant');
    expect(assistantMsg).toMatchObject({ content: 'Cut off mid', notice: 'truncated' });
  });

  it('ignores unknown SSE event types without throwing or affecting the final message', async () => {
    copilotApi.send.mockImplementation(async (_tripId, _text, _context, onChunk) => {
      onChunk({ type: 'text', content: 'Hello' });
      onChunk({ type: 'future_event_type', foo: 'bar' });
      onChunk({ type: 'done' });
    });

    const { result } = renderHook(() => useCopilot('trip-1'));
    await waitFor(() => expect(result.current.messages).toHaveLength(1));

    await act(async () => {
      await result.current.send('anything');
    });

    const assistantMsg = result.current.messages.find((m) => m.role === 'assistant');
    expect(assistantMsg).toMatchObject({ content: 'Hello', notice: null });
  });
});
