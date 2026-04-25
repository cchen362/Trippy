import { useState, useRef, useEffect } from 'react';
import { motion } from 'framer-motion';
import CopilotMessage from './CopilotMessage.jsx';
import MutationPreview from './MutationPreview.jsx';

export default function CopilotPanel({ copilot, days, onClose, onMutationApplied }) {
  const {
    messages,
    streaming,
    streamingText,
    pendingMutation,
    error,
    send,
    applyMutation,
    rejectMutation,
    cancel,
    clear,
  } = copilot;

  const [inputText, setInputText] = useState('');
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState(null);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);

  // Auto-focus input when panel opens
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Auto-scroll to bottom when messages or streaming text change
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, streamingText]);

  const handleSend = () => {
    const text = inputText.trim();
    if (!text || streaming) return;
    setInputText('');
    send(text);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleApply = async () => {
    setApplying(true);
    setApplyError(null);
    try {
      const result = await applyMutation();
      if (result) onMutationApplied(result);
    } catch (err) {
      setApplyError(err.message || 'Failed to apply changes. Please try again.');
    } finally {
      setApplying(false);
    }
  };

  const isEmpty = messages.length === 0 && !streamingText && !streaming;

  return (
    <motion.div
      initial={{ y: '100%' }}
      animate={{ y: 0 }}
      exit={{ y: '100%' }}
      transition={{ type: 'spring', damping: 30, stiffness: 300 }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 200,
        background: '#0d0b09',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '16px 20px',
          borderBottom: '1px solid rgba(255,255,255,0.07)',
          flexShrink: 0,
        }}
      >
        <button
          onClick={onClose}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'rgba(240,234,216,0.60)',
            cursor: 'pointer',
            padding: '4px 8px 4px 0',
            fontFamily: "'DM Mono', monospace",
            fontSize: 18,
            lineHeight: 1,
          }}
          aria-label="Close co-pilot"
        >
          ←
        </button>

        <span
          style={{
            fontFamily: "'DM Mono', monospace",
            fontSize: 11,
            letterSpacing: '0.28em',
            textTransform: 'uppercase',
            color: 'rgba(240,234,216,0.60)',
          }}
        >
          Co-Pilot
        </span>

        <div style={{ width: 40, display: 'flex', justifyContent: 'flex-end' }}>
          {streaming ? (
            <button
              onClick={cancel}
              style={{
                background: 'transparent',
                border: '1px solid rgba(255,255,255,0.15)',
                color: 'rgba(240,234,216,0.5)',
                cursor: 'pointer',
                fontFamily: "'DM Mono', monospace",
                fontSize: 10,
                letterSpacing: '0.16em',
                textTransform: 'uppercase',
                padding: '4px 8px',
                borderRadius: 6,
              }}
            >
              Stop
            </button>
          ) : messages.length > 0 ? (
            <button
              onClick={async () => {
                if (!window.confirm('Clear this conversation? This cannot be undone.')) return;
                try { await clear(); } catch {}
              }}
              aria-label="Clear conversation"
              title="Clear conversation"
              style={{
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                color: 'rgba(240,234,216,0.60)',
                padding: 8,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                <path d="M10 11v6" />
                <path d="M14 11v6" />
                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
              </svg>
            </button>
          ) : null}
        </div>
      </div>

      {/* Message list */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '20px 16px',
        }}
      >
        {isEmpty && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              fontFamily: "'DM Mono', monospace",
              fontSize: 13,
              color: 'rgba(240,234,216,0.28)',
              fontStyle: 'italic',
              textAlign: 'center',
              padding: '0 32px',
            }}
          >
            Ask me anything about your trip...
          </div>
        )}

        {messages.map((msg, i) => (
          <CopilotMessage
            key={`${msg.role}-${msg.createdAt || i}`}
            role={msg.role}
            content={msg.content}
            isStreaming={false}
          />
        ))}

        {streamingText && (
          <CopilotMessage
            role="assistant"
            content={streamingText}
            isStreaming={true}
          />
        )}

        {pendingMutation && !streaming && (
          <>
            <MutationPreview
              mutation={pendingMutation}
              days={days}
              onApply={handleApply}
              onReject={rejectMutation}
              applying={applying}
            />
            {applyError && (
              <div
                style={{
                  fontFamily: "'DM Mono', monospace",
                  fontSize: 11,
                  color: '#e05a5a',
                  padding: '6px 0 0',
                  textAlign: 'center',
                }}
              >
                {applyError}
              </div>
            )}
          </>
        )}

        {error && (
          <div
            style={{
              fontFamily: "'DM Mono', monospace",
              fontSize: 12,
              color: '#e05a5a',
              padding: '8px 0',
              textAlign: 'center',
            }}
          >
            {error.message || 'Something went wrong. Try again.'}
          </div>
        )}
      </div>

      {/* Input area */}
      <div
        style={{
          background: '#1c1a17',
          borderTop: '1px solid rgba(255,255,255,0.07)',
          padding: '12px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexShrink: 0,
        }}
      >
        <input
          ref={inputRef}
          type="text"
          className="copilot-input"
          value={inputText}
          onChange={e => setInputText(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={streaming}
          placeholder="Message your co-pilot..."
          style={{
            flex: 1,
            background: 'transparent',
            border: 'none',
            fontFamily: "'Cormorant Garamond', serif",
            fontSize: 16,
            color: '#f0ead8',
            padding: '4px 0',
            opacity: streaming ? 0.5 : 1,
          }}
        />
        <button
          onClick={handleSend}
          disabled={streaming || !inputText.trim()}
          style={{
            background: streaming || !inputText.trim()
              ? 'transparent'
              : 'rgba(201,168,76,0.12)',
            border: '1px solid rgba(201,168,76,0.4)',
            borderRadius: '50%',
            width: 36,
            height: 36,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: streaming || !inputText.trim() ? 'not-allowed' : 'pointer',
            color: streaming || !inputText.trim() ? 'rgba(201,168,76,0.3)' : '#c9a84c',
            fontSize: 18,
            flexShrink: 0,
            transition: 'background 0.15s, color 0.15s',
          }}
          aria-label="Send message"
        >
          ↑
        </button>
      </div>
    </motion.div>
  );
}
