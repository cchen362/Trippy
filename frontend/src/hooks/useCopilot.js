import { useState, useEffect, useCallback, useRef } from 'react';
import { copilotApi } from '../services/copilotApi.js';
import { useAuth } from '../context/AuthContext.jsx';

// The notices the server sends over SSE (D-30-4). Anything else is ignored,
// exactly as unknown event types are. 'stopped' and 'interrupted' (D-30-8) are
// deliberately absent: the server never writes them to the stream — Stop kills the
// socket and an error ends the turn with {type:'error'} — so the client stamps them
// itself, at the two places below, and an SSE event claiming either is not trusted.
const COPILOT_NOTICES = new Set(['truncated', 'refused', 'empty']);

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

function normalizeMessage(message) {
  return {
    ...message,
    context: message.context ?? null,
    notice: message.notice ?? null,
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
        setMessages((data.messages || []).map(normalizeMessage));
        setProposals((data.proposals || []).map(normalizeProposal));
      })
      .catch(err => console.error('[useCopilot] history load failed:', err));
  }, [tripId]);

  const setProposalStatus = useCallback((id, status, statusReason = null) => {
    setProposals(prev => prev.map(p => (p.id === id ? { ...p, status, statusReason } : p)));
  }, []);

  const send = useCallback(async (text, context = null) => {
    if (streaming) return;

    const userMsg = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      createdAt: new Date().toISOString(),
      authorName: user?.display_name ?? null,
      context,
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
    let noticeFlag = null;

    const appendAssistantRow = ({ content, notice }) => {
      const id = crypto.randomUUID();
      setMessages(prev => [...prev, {
        id,
        role: 'assistant',
        content,
        createdAt: new Date().toISOString(),
        notice,
      }]);
      return id;
    };

    // The turn finished server-side: its text, notice and (if any) proposal become one row.
    const commitTurn = (notice) => {
      const assistantId = appendAssistantRow({ content: fullText, notice });
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
    };

    try {
      await copilotApi.send(tripId, text, context, (chunk) => {
        if (chunk.type === 'text') {
          fullText += chunk.content;
          setStreamingText(fullText);
        } else if (chunk.type === 'proposal') {
          proposalPayload = chunk;
        } else if (chunk.type === 'notice' && COPILOT_NOTICES.has(chunk.notice)) {
          noticeFlag = chunk.notice;
        } else if (chunk.type === 'tool') {
          setActiveTool(chunk.state === 'started' ? chunk.tool : null);
        } else if (chunk.type === 'error') {
          terminated = true;
          setError(new Error(chunk.message));
          // D-30-8 (Plan 30): a provider error mid-turn keeps its partial text, labelled
          // 'interrupted' — even with no text yet, as the server saves the row either way.
          appendAssistantRow({ content: fullText, notice: 'interrupted' });
        } else if (chunk.type === 'done' && !terminated) {
          terminated = true;
          // D-30-4: a turn is never silent — a notice alone earns an assistant row.
          if (fullText || proposalPayload || noticeFlag) commitTurn(noticeFlag);
        }
      }, controller.signal);
    } catch (err) {
      if (err.name !== 'AbortError') {
        setError(err);
      } else if (!terminated) {
        terminated = true;
        if (proposalPayload) {
          // The server finished and saved the turn normally in the sliver between its
          // proposal event and `done`; Stop arrived too late to change that, so it is
          // not labelled 'stopped'.
          commitTurn(noticeFlag);
        } else {
          // D-30-8 (Plan 30): the server saves exactly one assistant row for a stopped
          // turn — the partial text, even if empty — labelled 'stopped'. Mirror it here
          // so the live thread matches what a reload will show.
          appendAssistantRow({ content: fullText, notice: 'stopped' });
        }
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
