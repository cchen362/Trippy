import { useState, useEffect, useCallback, useRef } from 'react';
import { copilotApi } from '../services/copilotApi.js';

export function useCopilot(tripId) {
  const [messages, setMessages] = useState([]);
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [pendingMutation, setPendingMutation] = useState(null);
  const [error, setError] = useState(null);
  const abortRef = useRef(null);

  // Load history on mount
  useEffect(() => {
    if (!tripId) return;
    copilotApi.history(tripId)
      .then(data => setMessages(data.messages))
      .catch(err => console.error('[useCopilot] history load failed:', err));
  }, [tripId]);

  const send = useCallback(async (text) => {
    if (streaming) return;

    const userMsg = { role: 'user', content: text, createdAt: new Date().toISOString() };
    setMessages(prev => [...prev, userMsg]);
    setStreaming(true);
    setStreamingText('');
    setPendingMutation(null);
    setError(null);

    const controller = new AbortController();
    abortRef.current = controller;

    let fullText = '';
    try {
      await copilotApi.send(tripId, text, (chunk) => {
        if (chunk.type === 'text') {
          fullText += chunk.content;
          setStreamingText(fullText);
        } else if (chunk.type === 'mutation') {
          setPendingMutation(chunk.mutation);
        } else if (chunk.type === 'error') {
          setError(new Error(chunk.message));
        } else if (chunk.type === 'done') {
          setMessages(prev => [...prev, {
            role: 'assistant',
            content: fullText,
            createdAt: new Date().toISOString()
          }]);
          setStreamingText('');
          setStreaming(false);
        }
      }, controller.signal);
    } catch (err) {
      if (err.name !== 'AbortError') setError(err);
      setStreaming(false);
      setStreamingText('');
    } finally {
      abortRef.current = null;
    }
  }, [tripId, streaming]);

  const applyMutation = useCallback(async () => {
    if (!pendingMutation) return null;
    const result = await copilotApi.apply(tripId, pendingMutation);
    setPendingMutation(null);
    return result;
  }, [tripId, pendingMutation]);

  const rejectMutation = useCallback(() => {
    setPendingMutation(null);
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const clear = useCallback(async () => {
    abortRef.current?.abort();
    try {
      await copilotApi.clear(tripId);
    } catch (err) {
      setError(err);
      return;
    }
    setMessages([]);
    setStreamingText('');
    setPendingMutation(null);
    setError(null);
    setStreaming(false);
  }, [tripId]);

  return {
    messages, streaming, streamingText, pendingMutation, error,
    send, applyMutation, rejectMutation, cancel, clear,
  };
}
