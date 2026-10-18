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
    removeExchange: vi.fn(),
  },
}));

vi.mock('../context/AuthContext.jsx', () => ({
  useAuth: () => ({ user: { id: 'user-1', display_name: 'Test User' } }),
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

describe('useCopilot history normalisation (D-30-8)', () => {
  it('carries the server notice on history rows and defaults a missing one to null', async () => {
    copilotApi.history.mockResolvedValue({
      messages: [
        { id: 'h1', role: 'assistant', content: 'Partial', createdAt: '2026-01-01', notice: 'stopped' },
        { id: 'h2', role: 'assistant', content: 'Whole', createdAt: '2026-01-01' },
      ],
      proposals: [],
    });
    const { result } = renderHook(() => useCopilot('trip-1'));
    await waitFor(() => expect(result.current.messages).toHaveLength(2));

    expect(result.current.messages[0].notice).toBe('stopped');
    expect(result.current.messages[1].notice).toBeNull();
  });
});

// Plan 32: removing a stopped exchange. The `turn` event is the first event of every stream
// and names the saved question row (D-32-2).
describe('useCopilot remove a stopped exchange (Plan 32)', () => {
  function abortError() {
    const err = new Error('The operation was aborted.');
    err.name = 'AbortError';
    return err;
  }

  async function sendThenStopWithTurn(result, messageId = 'srv-q1') {
    copilotApi.send.mockImplementation((_tripId, _text, _context, onChunk, signal) => new Promise((_resolve, reject) => {
      onChunk({ type: 'turn', messageId });
      onChunk({ type: 'text', content: 'Half an ans' });
      signal.addEventListener('abort', () => reject(abortError()));
    }));
    let pending;
    act(() => {
      pending = result.current.send('Move Day 3 to Osaka');
    });
    await waitFor(() => expect(copilotApi.send).toHaveBeenCalled());
    act(() => {
      result.current.cancel();
    });
    await act(async () => {
      await pending;
    });
  }

  it('gives history rows serverId === id and keeps the asker userId', async () => {
    copilotApi.history.mockResolvedValue({
      messages: [
        { id: 'h1', role: 'user', content: 'Q', createdAt: '2026-01-01', userId: 'user-9' },
        { id: 'h2', role: 'assistant', content: 'A', createdAt: '2026-01-01', userId: null },
      ],
      proposals: [],
    });
    const { result } = renderHook(() => useCopilot('trip-1'));
    await waitFor(() => expect(result.current.messages).toHaveLength(2));

    expect(result.current.messages[0]).toMatchObject({ serverId: 'h1', userId: 'user-9' });
    expect(result.current.messages[1]).toMatchObject({ serverId: 'h2', userId: null });
  });

  it('stamps serverId from the turn event on the live user row, which carries the session user id', async () => {
    const { result } = renderHook(() => useCopilot('trip-1'));
    await waitFor(() => expect(result.current.messages).toHaveLength(1));

    copilotApi.send.mockImplementation(async (_tripId, _text, _context, onChunk) => {
      onChunk({ type: 'turn', messageId: 'srv-q1' });
      onChunk({ type: 'done' });
    });
    await act(async () => {
      await result.current.send('hello');
    });

    expect(result.current.messages[1]).toMatchObject({ role: 'user', serverId: 'srv-q1', userId: 'user-1' });
  });

  it('leaves serverId null for a turn event without a string messageId', async () => {
    const { result } = renderHook(() => useCopilot('trip-1'));
    await waitFor(() => expect(result.current.messages).toHaveLength(1));

    copilotApi.send.mockImplementation(async (_tripId, _text, _context, onChunk) => {
      onChunk({ type: 'turn' });
      onChunk({ type: 'turn', messageId: 42 });
      onChunk({ type: 'done' });
    });
    await act(async () => {
      await result.current.send('hello');
    });

    expect(result.current.messages[1].serverId).toBeNull();
  });

  it('removes the question and its stopped reply after Stop with no reload', async () => {
    copilotApi.removeExchange.mockResolvedValue({ removed: 2 });
    const { result } = renderHook(() => useCopilot('trip-1'));
    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    await sendThenStopWithTurn(result);
    expect(result.current.messages.map((m) => m.role)).toEqual(['user', 'user', 'assistant']);

    await act(async () => {
      await result.current.removeExchange('srv-q1');
    });

    expect(copilotApi.removeExchange).toHaveBeenCalledWith('trip-1', 'srv-q1');
    expect(result.current.messages.map((m) => m.id)).toEqual(['history-1']);
  });

  it('restores both rows at their original position and rethrows when the remove fails', async () => {
    const failure = Object.assign(new Error('This conversation changed — reload and try again.'), { status: 409 });
    copilotApi.removeExchange.mockRejectedValue(failure);
    const { result } = renderHook(() => useCopilot('trip-1'));
    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    await sendThenStopWithTurn(result);

    // A later exchange sits after the stopped one, so position matters.
    copilotApi.send.mockImplementation(async (_tripId, _text, _context, onChunk) => {
      onChunk({ type: 'turn', messageId: 'srv-q2' });
      onChunk({ type: 'text', content: 'Fine' });
      onChunk({ type: 'done' });
    });
    await act(async () => {
      await result.current.send('second');
    });
    const before = result.current.messages.map((m) => m.id);
    expect(before).toHaveLength(5);

    let caught;
    await act(async () => {
      try {
        await result.current.removeExchange('srv-q1');
      } catch (err) {
        caught = err;
      }
    });

    expect(caught).toBe(failure);
    expect(result.current.messages.map((m) => m.id)).toEqual(before);
  });

  it('still calls the API and rethrows when no local row matches', async () => {
    const failure = Object.assign(new Error('nope'), { status: 404 });
    copilotApi.removeExchange.mockRejectedValue(failure);
    const { result } = renderHook(() => useCopilot('trip-1'));
    await waitFor(() => expect(result.current.messages).toHaveLength(1));

    await expect(result.current.removeExchange('unknown')).rejects.toBe(failure);
    expect(copilotApi.removeExchange).toHaveBeenCalledWith('trip-1', 'unknown');
    expect(result.current.messages).toHaveLength(1);
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

  it('attaches notice: "refused" to the text that streamed before the refusal', async () => {
    copilotApi.send.mockImplementation(async (_tripId, _text, _context, onChunk) => {
      onChunk({ type: 'text', content: 'I started to answer' });
      onChunk({ type: 'notice', notice: 'refused' });
      onChunk({ type: 'done' });
    });

    const { result } = renderHook(() => useCopilot('trip-1'));
    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    await act(async () => {
      await result.current.send('something');
    });

    const assistantMsg = result.current.messages.find((m) => m.role === 'assistant');
    expect(assistantMsg).toMatchObject({ content: 'I started to answer', notice: 'refused' });
  });

  it('appends one empty-content assistant row for an "empty" notice with no text or proposal', async () => {
    copilotApi.send.mockImplementation(async (_tripId, _text, _context, onChunk) => {
      onChunk({ type: 'notice', notice: 'empty' });
      onChunk({ type: 'done' });
    });

    const { result } = renderHook(() => useCopilot('trip-1'));
    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    await act(async () => {
      await result.current.send('anything');
    });

    const assistantMsgs = result.current.messages.filter((m) => m.role === 'assistant');
    expect(assistantMsgs).toHaveLength(1);
    expect(assistantMsgs[0]).toMatchObject({ content: '', notice: 'empty' });
  });

  it('treats keep-alive ping events as harmless', async () => {
    copilotApi.send.mockImplementation(async (_tripId, _text, _context, onChunk) => {
      onChunk({ type: 'ping' });
      onChunk({ type: 'text', content: 'Hello' });
      onChunk({ type: 'ping' });
      onChunk({ type: 'done' });
    });

    const { result } = renderHook(() => useCopilot('trip-1'));
    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    await act(async () => {
      await result.current.send('anything');
    });

    const assistantMsgs = result.current.messages.filter((m) => m.role === 'assistant');
    expect(assistantMsgs).toHaveLength(1);
    expect(assistantMsgs[0]).toMatchObject({ content: 'Hello', notice: null });
  });

  it('ignores an unknown notice string: no row when nothing else arrived', async () => {
    copilotApi.send.mockImplementation(async (_tripId, _text, _context, onChunk) => {
      onChunk({ type: 'notice', notice: 'something_new' });
      onChunk({ type: 'done' });
    });

    const { result } = renderHook(() => useCopilot('trip-1'));
    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    await act(async () => {
      await result.current.send('anything');
    });

    expect(result.current.messages.filter((m) => m.role === 'assistant')).toHaveLength(0);
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

// Stop is simulated the way the real client sees it: copilotApi.send rejects with an
// AbortError once the signal fires. cancel() is what the Stop button calls.
describe('useCopilot Stop and mid-turn error (D-30-8)', () => {
  function abortError() {
    const err = new Error('The operation was aborted.');
    err.name = 'AbortError';
    return err;
  }

  // Streams the given chunks, then stays pending until the hook aborts, then rejects.
  function sendThatWaitsForStop(chunks) {
    copilotApi.send.mockImplementation((_tripId, _text, _context, onChunk, signal) => new Promise((_resolve, reject) => {
      chunks.forEach(onChunk);
      signal.addEventListener('abort', () => reject(abortError()));
    }));
  }

  async function sendThenStop(result, chunks) {
    sendThatWaitsForStop(chunks);
    let pending;
    act(() => {
      pending = result.current.send('hello');
    });
    await waitFor(() => expect(copilotApi.send).toHaveBeenCalled());
    act(() => {
      result.current.cancel();
    });
    await act(async () => {
      await pending;
    });
  }

  it('keeps the partial text as one row labelled "stopped"', async () => {
    const { result } = renderHook(() => useCopilot('trip-1'));
    await waitFor(() => expect(result.current.messages).toHaveLength(1));

    await sendThenStop(result, [{ type: 'text', content: 'Half an ans' }]);

    const assistantMsgs = result.current.messages.filter((m) => m.role === 'assistant');
    expect(assistantMsgs).toHaveLength(1);
    expect(assistantMsgs[0]).toMatchObject({ content: 'Half an ans', notice: 'stopped' });
    expect(result.current.streaming).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('appends a notice-only "stopped" row when Stop lands before any text', async () => {
    const { result } = renderHook(() => useCopilot('trip-1'));
    await waitFor(() => expect(result.current.messages).toHaveLength(1));

    await sendThenStop(result, []);

    const assistantMsgs = result.current.messages.filter((m) => m.role === 'assistant');
    expect(assistantMsgs).toHaveLength(1);
    expect(assistantMsgs[0]).toMatchObject({ content: '', notice: 'stopped' });
  });

  it('saves the turn normally, not as "stopped", when Stop lands after the proposal event', async () => {
    const { result } = renderHook(() => useCopilot('trip-1'));
    await waitFor(() => expect(result.current.messages).toHaveLength(1));

    await sendThenStop(result, [
      { type: 'text', content: 'Here is a change' },
      { type: 'proposal', proposalId: 'p1', operations: [{ op: 'move' }], warnings: [], status: 'pending' },
    ]);

    const assistantMsgs = result.current.messages.filter((m) => m.role === 'assistant');
    expect(assistantMsgs).toHaveLength(1);
    expect(assistantMsgs[0]).toMatchObject({ content: 'Here is a change', notice: null });
    expect(result.current.proposals).toHaveLength(1);
    expect(result.current.proposals[0]).toMatchObject({ id: 'p1', messageId: assistantMsgs[0].id });
  });

  it('leaves no stray row when Stop is followed by clear', async () => {
    copilotApi.clear.mockResolvedValue({});
    const { result } = renderHook(() => useCopilot('trip-1'));
    await waitFor(() => expect(result.current.messages).toHaveLength(1));

    sendThatWaitsForStop([{ type: 'text', content: 'Half' }]);
    let pending;
    act(() => {
      pending = result.current.send('hello');
    });
    await waitFor(() => expect(copilotApi.send).toHaveBeenCalled());
    await act(async () => {
      await result.current.clear();
      await pending;
    });

    expect(result.current.messages).toEqual([]);
  });

  it('keeps partial text as one row labelled "interrupted" when the stream errors', async () => {
    copilotApi.send.mockImplementation(async (_tripId, _text, _context, onChunk) => {
      onChunk({ type: 'text', content: 'Partway' });
      onChunk({ type: 'error', message: 'Provider fell over' });
      onChunk({ type: 'done' });
    });
    const { result } = renderHook(() => useCopilot('trip-1'));
    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    await act(async () => {
      await result.current.send('hello');
    });

    const assistantMsgs = result.current.messages.filter((m) => m.role === 'assistant');
    expect(assistantMsgs).toHaveLength(1);
    expect(assistantMsgs[0]).toMatchObject({ content: 'Partway', notice: 'interrupted' });
    expect(result.current.error).toBeInstanceOf(Error);
  });

  it('appends a notice-only "interrupted" row when the stream errors before any text', async () => {
    copilotApi.send.mockImplementation(async (_tripId, _text, _context, onChunk) => {
      onChunk({ type: 'error', message: 'Provider fell over' });
      onChunk({ type: 'done' });
    });
    const { result } = renderHook(() => useCopilot('trip-1'));
    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    await act(async () => {
      await result.current.send('hello');
    });

    const assistantMsgs = result.current.messages.filter((m) => m.role === 'assistant');
    expect(assistantMsgs).toHaveLength(1);
    expect(assistantMsgs[0]).toMatchObject({ content: '', notice: 'interrupted' });
  });

  it('does not trust an SSE notice event claiming "stopped"', async () => {
    copilotApi.send.mockImplementation(async (_tripId, _text, _context, onChunk) => {
      onChunk({ type: 'text', content: 'Fine' });
      onChunk({ type: 'notice', notice: 'stopped' });
      onChunk({ type: 'done' });
    });
    const { result } = renderHook(() => useCopilot('trip-1'));
    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    await act(async () => {
      await result.current.send('hello');
    });

    expect(result.current.messages.find((m) => m.role === 'assistant')).toMatchObject({ content: 'Fine', notice: null });
  });
});

describe('useCopilot proposal activity (D-30-9)', () => {
  it('shows the propose tool as active until the explanation starts', async () => {
    let releaseExplanation;
    copilotApi.send.mockImplementation(async (_tripId, _text, _context, onChunk) => {
      onChunk({ type: 'tool', tool: 'propose_itinerary_changes', state: 'started' });
      await new Promise((resolve) => { releaseExplanation = resolve; });
      onChunk({ type: 'tool', tool: 'propose_itinerary_changes', state: 'done' });
      onChunk({ type: 'text', content: 'Moved it to day 2.' });
      onChunk({ type: 'done' });
    });

    const { result } = renderHook(() => useCopilot('trip-1'));
    await waitFor(() => expect(result.current.messages).toHaveLength(1));

    let pending;
    act(() => {
      pending = result.current.send('move the museum to day 2');
    });
    await waitFor(() => expect(result.current.activeTool).toBe('propose_itinerary_changes'));
    expect(result.current.streamingText).toBe('');

    await act(async () => {
      releaseExplanation();
      await pending;
    });

    expect(result.current.activeTool).toBeNull();
    expect(result.current.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'Moved it to day 2.' });
  });
});
