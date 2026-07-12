import { useState, useEffect, useCallback, useRef } from 'react';
import { copilotApi } from '../services/copilotApi.js';
import { useAuth } from '../context/AuthContext.jsx';

function normalizeProposal(p) {
  return {
    id: p.id,
    messageId: p.messageId,
    operations: p.operations,
    warnings: p.warnings || [],
    status: p.status,
    statusReason: p.statusReason ?? null,
  };
}

export function useCopilot(tripId) {
  const { user } = useAuth();
  const [messages, setMessages] = useState([]);
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [activeTool, setActiveTool] = useState(null);
  const [proposals, setProposals] = useState([]);
  const [error, setError] = useState(null);
  const abortRef = useRef(null);

  // Load history on mount
  useEffect(() => {
    if (!tripId) return;
    copilotApi.history(tripId)
      .then(data => {
        setMessages(data.messages);
        setProposals((data.proposals || []).map(normalizeProposal));
      })
      .catch(err => console.error('[useCopilot] history load failed:', err));
  }, [tripId]);

  const setProposalStatus = useCallback((id, status, statusReason = null) => {
    setProposals(prev => prev.map(p => (p.id === id ? { ...p, status, statusReason } : p)));
  }, []);

  const send = useCallback(async (text) => {
    if (streaming) return;

    const userMsg = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      createdAt: new Date().toISOString(),
      authorName: user?.display_name ?? null,
    };
    setMessages(prev => [...prev, userMsg]);
    setStreaming(true);
    setStreamingText('');
    setActiveTool(null);
    setError(null);

    const controller = new AbortController();
    abortRef.current = controller;

    let fullText = '';
    let terminated = false;
    let proposalPayload = null;
    try {
      await copilotApi.send(tripId, text, (chunk) => {
        if (chunk.type === 'text') {
          fullText += chunk.content;
          setStreamingText(fullText);
        } else if (chunk.type === 'proposal') {
          proposalPayload = chunk;
        } else if (chunk.type === 'tool') {
          setActiveTool(chunk.state === 'started' ? chunk.tool : null);
        } else if (chunk.type === 'error') {
          terminated = true;
          setError(new Error(chunk.message));
          if (fullText) {
            setMessages(prev => [...prev, {
              id: crypto.randomUUID(),
              role: 'assistant',
              content: fullText,
              createdAt: new Date().toISOString(),
            }]);
          }
        } else if (chunk.type === 'done' && !terminated) {
          terminated = true;
          if (fullText || proposalPayload) {
            const assistantId = crypto.randomUUID();
            setMessages(prev => [...prev, {
              id: assistantId,
              role: 'assistant',
              content: fullText,
              createdAt: new Date().toISOString(),
            }]);
            if (proposalPayload) {
              setProposals(prev => [...prev, normalizeProposal({
                id: proposalPayload.proposalId,
                messageId: assistantId,
                operations: proposalPayload.operations,
                warnings: proposalPayload.warnings,
                status: proposalPayload.status || 'pending',
                statusReason: proposalPayload.statusReason ?? null,
              })]);
            }
          }
        }
      }, controller.signal);
    } catch (err) {
      if (err.name !== 'AbortError') {
        setError(err);
      } else if (!terminated && fullText) {
        // Client-initiated Stop: the server still persists whatever text it had
        // accumulated, so keep the same partial text locally to match history on reload.
        setMessages(prev => [...prev, {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: fullText,
          createdAt: new Date().toISOString(),
        }]);
      }
    } finally {
      setStreaming(false);
      setStreamingText('');
      setActiveTool(null);
      abortRef.current = null;
    }
  }, [tripId, streaming, user]);

  const applyProposal = useCallback(async (proposalId) => {
    try {
      const result = await copilotApi.apply(tripId, proposalId);
      setProposalStatus(proposalId, 'applied');
      return result;
    } catch (err) {
      // Mirror the status the server persists so the live card matches what a refresh would
      // show: 409 → stale (fingerprint drift), 422 → invalid (a targeted stop was removed or
      // booking-linked since creation). The raw reason string is kept only for the audit
      // record — MutationPreview renders product-voice copy off `status`, never this text
      // (D12 / Wave 3 §4). 404 means the proposal itself is gone (e.g. conversation cleared).
      if (err.status === 409) {
        setProposalStatus(proposalId, 'stale', err.message);
      } else if (err.status === 422 || err.status === 404) {
        setProposalStatus(proposalId, 'invalid', err.message);
      }
      throw err;
    }
  }, [tripId, setProposalStatus]);

  const rejectProposal = useCallback(async (proposalId) => {
    try {
      await copilotApi.reject(tripId, proposalId);
      setProposalStatus(proposalId, 'rejected');
    } catch (err) {
      throw err;
    }
  }, [tripId, setProposalStatus]);

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
    setProposals([]);
    setError(null);
    setStreaming(false);
  }, [tripId]);

  return {
    messages, streaming, streamingText, activeTool, proposals, error,
    send, applyProposal, rejectProposal, cancel, clear,
  };
}
