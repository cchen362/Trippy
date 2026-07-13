import { useState, useRef, useEffect, useMemo } from 'react';
import { motion, useDragControls, useReducedMotion } from 'framer-motion';
import CopilotMessage from './CopilotMessage.jsx';
import MutationPreview from './MutationPreview.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import useMediaQuery from '../../hooks/useMediaQuery.js';
import { deriveCopilotSeeds } from '../../utils/copilotSeeds.js';

const TOOL_ACTIVITY_LABELS = {
  search_discovery_catalogue: 'Searching your Discovery picks…',
  check_trip_health: 'Checking your trip…',
};

// Height as a fraction of the layout viewport. Resolved to pixels at render so
// framer animates a numeric height reliably (vh strings animate unpredictably),
// and so the on-screen keyboard — which shrinks only the *visual* viewport, not
// window.innerHeight — never changes the sheet's height (R3).
const HEIGHT_RATIOS = {
  mobile: { partial: 0.58, expanded: 1.0 },
  desktop: { partial: 0.56, expanded: 0.92 },
};

export default function CopilotPanel({ copilot, context, trip, days, bookings, activeDayId, onClose, onMutationApplied, ownerId }) {
  const {
    messages,
    streaming,
    streamingText,
    activeTool,
    proposals,
    error,
    send,
    applyProposal,
    rejectProposal,
    cancel,
    clear,
  } = copilot;

  const { user } = useAuth();
  const isOwner = user?.id === ownerId;

  const [inputText, setInputText] = useState('');
  const [applyingId, setApplyingId] = useState(null);
  const [applyError, setApplyError] = useState(null);
  const [sheetState, setSheetState] = useState('partial');
  const [kbInset, setKbInset] = useState(0);
  const [viewportH, setViewportH] = useState(() =>
    typeof window === 'undefined' ? 812 : window.innerHeight,
  );
  const scrollRef = useRef(null);
  const inputRef = useRef(null);

  const isDesktop = useMediaQuery('(min-width: 640px)');
  const reduceMotion = useReducedMotion();
  const dragControls = useDragControls();

  const showAuthors = useMemo(() => {
    const authors = new Set(
      messages.filter((m) => m.role === 'user' && m.authorName).map((m) => m.authorName),
    );
    return authors.size >= 2;
  }, [messages]);

  const proposalsByMessageId = useMemo(() => {
    const map = new Map();
    for (const p of proposals) {
      if (!p.messageId) continue;
      if (!map.has(p.messageId)) map.set(p.messageId, []);
      map.get(p.messageId).push(p);
    }
    return map;
  }, [proposals]);

  // Auto-focus input when panel opens
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Auto-scroll to bottom when messages or streaming text change
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, streamingText]);

  // Track the layout-viewport height so the pixel-resolved sheet height follows
  // rotation / window resize but NOT the keyboard (which changes only visualViewport).
  useEffect(() => {
    const onResize = () => setViewportH(window.innerHeight);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Keyboard inset (R3): keep the sheet's top edge fixed when the on-screen keyboard opens
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => {
      const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      setKbInset(inset);
    };
    vv.addEventListener('resize', onResize);
    vv.addEventListener('scroll', onResize);
    onResize();
    return () => {
      vv.removeEventListener('resize', onResize);
      vv.removeEventListener('scroll', onResize);
    };
  }, []);

  // Escape closes
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const handleSend = () => {
    const text = inputText.trim();
    if (!text || streaming) return;
    setInputText('');
    send(text, context);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleApply = async (proposalId) => {
    setApplyingId(proposalId);
    setApplyError(null);
    try {
      const result = await applyProposal(proposalId);
      if (result) onMutationApplied(result);
    } catch (err) {
      // Stale/invalid outcomes are already reflected on the card via its status;
      // only surface a transient banner for other failure modes.
      if (err.status !== 409 && err.status !== 422 && err.status !== 404) {
        setApplyError(err.message || 'Failed to apply changes. Please try again.');
      }
    } finally {
      setApplyingId(null);
    }
  };

  const handleReject = async (proposalId) => {
    try {
      await rejectProposal(proposalId);
    } catch (err) {
      setApplyError(err.message || 'Failed to reject changes. Please try again.');
    }
  };

  const handleDragEnd = (_e, info) => {
    const dy = info.offset.y;
    const vy = info.velocity.y;

    if (dy < -60 || vy < -500) {
      if (sheetState === 'partial') setSheetState('expanded');
      return;
    }

    if (dy > 60 || vy > 500) {
      if (sheetState === 'expanded') setSheetState('partial');
      else onClose();
    }
  };

  const isEmpty = messages.length === 0 && !streamingText && !streaming;
  const seedPrompts = useMemo(
    () => deriveCopilotSeeds({ trip, days, bookings, activeDayId }),
    [trip, days, bookings, activeDayId],
  );

  const formFactor = isDesktop ? 'desktop' : 'mobile';
  const currentHeight = Math.round(viewportH * HEIGHT_RATIOS[formFactor][sheetState]);
  const topRadius = !isDesktop && sheetState === 'expanded' ? 0 : 16;

  // framer animates the y-slide AND the height morph together on the OUTER div
  // (no drag on it). Two rules learned the hard way here: (1) never put `drag="y"`
  // and `animate.y` on the same element — drag swallows the whole `animate`; and
  // (2) never put a CSS `transition` string in a framer element's `style` — it
  // fights framer over the inline transform and freezes the slide. So: framer owns
  // outer motion (px height, reliable), inner owns only the drag gesture.
  const transition = reduceMotion
    ? { duration: 0 }
    : { type: 'spring', damping: 30, stiffness: 300 };

  const showScrim = isDesktop && sheetState === 'expanded';

  const showExpandControl = isDesktop || sheetState === 'expanded';
  const isExpanded = sheetState === 'expanded';

  return (
    <>
      {showScrim && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={() => setSheetState('partial')}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 199,
            background: 'rgba(13,11,9,0.55)',
          }}
        />
      )}

      {/* Outer: presence slide + height morph via framer. No drag, no CSS transition. */}
      <motion.div
        initial={{ y: '100%', height: currentHeight }}
        animate={{ y: 0, height: currentHeight }}
        exit={{ y: '100%' }}
        transition={transition}
        style={{
          position: 'fixed',
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 200,
          width: isDesktop ? 'min(640px, calc(100% - 48px))' : '100%',
          marginInline: isDesktop ? 'auto' : undefined,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Inner: the visible sheet + drag gesture (mobile). No animate.y → no conflict. */}
        <motion.div
          drag={isDesktop ? false : 'y'}
          dragControls={dragControls}
          dragListener={false}
          dragConstraints={{ top: 0, bottom: 0 }}
          dragElastic={0.35}
          onDragEnd={handleDragEnd}
          style={{
            flex: 1,
            width: '100%',
            minHeight: 0,
            background: '#0d0b09',
            display: 'flex',
            flexDirection: 'column',
            borderTop: '1px solid rgba(255,255,255,0.09)',
            borderTopLeftRadius: topRadius,
            borderTopRightRadius: topRadius,
            boxShadow: '0 -16px 48px rgba(0,0,0,0.55)',
            paddingBottom: kbInset,
            overflow: 'hidden',
          }}
        >
        {/* Drag handle (mobile only) */}
        {!isDesktop && (
          <div
            onPointerDown={(e) => dragControls.start(e)}
            style={{
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              padding: '8px 0 2px',
              minHeight: 28,
              touchAction: 'none',
              cursor: 'grab',
              flexShrink: 0,
            }}
          >
            <div
              style={{
                width: 36,
                height: 4,
                borderRadius: 2,
                background: 'rgba(240,234,216,0.18)',
              }}
            />
          </div>
        )}

        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '6px 16px 10px',
            borderBottom: '1px solid rgba(255,255,255,0.07)',
            flexShrink: 0,
          }}
        >
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

          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
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
            ) : isOwner && messages.length > 0 ? (
              <button
                onClick={async () => {
                  if (!window.confirm('Clear this conversation? This cannot be undone.')) return;
                  try {
                    await clear();
                  } catch (err) {
                    if (err.status === 403) {
                      setApplyError('Only the trip owner can clear the conversation.');
                    }
                  }
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

            {showExpandControl && (
              <button
                className="ctl"
                onClick={() => setSheetState(isExpanded ? 'partial' : 'expanded')}
                aria-label={isExpanded ? 'Collapse co-pilot' : 'Expand co-pilot'}
                style={{
                  width: 32,
                  height: 32,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontFamily: "'DM Mono', monospace",
                  fontSize: 15,
                  color: 'rgba(240,234,216,0.60)',
                  borderRadius: 6,
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                {isExpanded ? '⌄' : '⌃'}
              </button>
            )}

            <button
              className="ctl"
              onClick={onClose}
              aria-label="Close co-pilot"
              style={{
                width: 32,
                height: 32,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontFamily: "'DM Mono', monospace",
                fontSize: 15,
                color: 'rgba(240,234,216,0.60)',
                borderRadius: 6,
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              ×
            </button>
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
                padding: '10px 0 0',
              }}
            >
              <p style={{
                margin: '0 0 4px',
                fontFamily: "'DM Mono', monospace",
                fontSize: 10,
                letterSpacing: '0.24em',
                textTransform: 'uppercase',
                color: 'var(--gold)',
              }}>
                Start from your trip
              </p>
              {seedPrompts.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => send(prompt, context)}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 14,
                    padding: '13px 0',
                    border: 'none',
                    borderBottom: '1px solid var(--ink-border)',
                    background: 'transparent',
                    color: 'rgba(240,234,216,0.85)',
                    cursor: 'pointer',
                    textAlign: 'left',
                    fontFamily: "'Cormorant Garamond', serif",
                    fontSize: 16.5,
                    lineHeight: 1.45,
                  }}
                >
                  <span>{prompt}</span>
                  <span aria-hidden="true" style={{
                    flexShrink: 0,
                    fontFamily: "'DM Mono', monospace",
                    color: 'var(--cream-mute)',
                  }}>
                    →
                  </span>
                </button>
              ))}
              <p style={{
                margin: '14px 0 0',
                fontFamily: "'Cormorant Garamond', serif",
                fontSize: 15,
                fontStyle: 'italic',
                color: 'var(--cream-mute)',
              }}>
                …or ask anything. The co-pilot reads the whole trip.
              </p>
            </div>
          )}

          {messages.map((msg, i) => (
            <div key={msg.id || `${msg.role}-${msg.createdAt || i}`}>
              <CopilotMessage
                role={msg.role}
                content={msg.content}
                isStreaming={false}
                authorLabel={showAuthors ? msg.authorName : null}
                context={msg.context}
                days={days}
              />
              {(proposalsByMessageId.get(msg.id) || []).map((p) => (
                <MutationPreview
                  key={p.id}
                  proposal={p}
                  days={days}
                  onApply={() => handleApply(p.id)}
                  onReject={() => handleReject(p.id)}
                  applying={applyingId === p.id}
                />
              ))}
            </div>
          ))}

          {activeTool && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                fontFamily: "'DM Mono', monospace",
                fontSize: 11,
                letterSpacing: '0.06em',
                color: 'rgba(240,234,216,0.45)',
                padding: '2px 0 8px',
              }}
            >
              <span style={{ animation: 'copilot-blink 1s step-end infinite', color: '#c9a84c' }}>●</span>
              {TOOL_ACTIVITY_LABELS[activeTool] || 'Working…'}
            </div>
          )}

          {streamingText && (
            <CopilotMessage
              role="assistant"
              content={streamingText}
              isStreaming={true}
            />
          )}

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
      </motion.div>
    </>
  );
}
