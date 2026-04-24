import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useDiscovery } from '../../hooks/useDiscovery.js';
import SuggestionCard from './SuggestionCard.jsx';

const CATEGORY_TABS = ['Culture', 'Food', 'Nature', 'Nightlife', 'Hidden Gems'];
const CATEGORY_KEYS = {
  Culture: 'culture',
  Food: 'food',
  Nature: 'nature',
  Nightlife: 'nightlife',
  'Hidden Gems': 'hidden_gems',
};

export default function DiscoveryPanel({ trip, days, stops, onAddStop, onClose }) {
  const defaultDestination = days[0]?.city || trip.destinations?.[0] || '';
  const [destination, setDestination] = useState(defaultDestination);
  const [activeCategory, setActiveCategory] = useState('culture');
  const { results, loading, error, source, cached, discover, refresh } = useDiscovery(trip.id);

  // Auto-discover when panel opens if we have a destination
  const discoveredRef = useRef(false);
  useEffect(() => {
    if (!discoveredRef.current && destination) {
      discoveredRef.current = true;
      discover(destination, trip.interest_tags ?? []);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleDiscover = () => {
    if (destination.trim()) {
      discover(destination.trim(), trip.interest_tags ?? []);
    }
  };

  const handleAddToDay = async (dayId, suggestion) => {
    await onAddStop(dayId, {
      title: suggestion.name,
      type: 'experience',
      note: suggestion.description,
      lat: suggestion.lat,
      lng: suggestion.lng,
      duration: suggestion.estimatedDuration,
    });
  };

  const activeSuggestions = results?.[activeCategory] ?? [];

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
          padding: '16px 20px 12px',
          borderBottom: '1px solid rgba(255,255,255,0.07)',
          flexShrink: 0,
        }}
      >
        <button
          onClick={onClose}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: 'rgba(240,234,216,0.60)',
            fontFamily: "'DM Mono', monospace",
            fontSize: '18px',
            padding: '0',
            lineHeight: '1',
          }}
          aria-label="Close discovery panel"
        >
          ✕
        </button>

        <span
          style={{
            fontFamily: "'DM Mono', monospace",
            fontSize: '11px',
            letterSpacing: '0.28em',
            textTransform: 'uppercase',
            color: 'var(--cream)',
          }}
        >
          DISCOVER
        </span>

        {/* Source badge + Refresh */}
        <div style={{ minWidth: '80px', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '8px' }}>
          {source && (
            <span
              style={{
                fontFamily: "'DM Mono', monospace",
                fontSize: '10px',
                letterSpacing: '0.08em',
                padding: '2px 8px',
                borderRadius: '999px',
                border: source === 'web'
                  ? '1px solid var(--gold)'
                  : '1px solid rgba(240,234,216,0.28)',
                color: source === 'web' ? 'var(--gold)' : 'rgba(240,234,216,0.50)',
              }}
            >
              {source === 'web' ? 'WEB RESULTS' : 'AI SUGGESTED'}
            </span>
          )}
          {results && (
            <button
              onClick={() => refresh(destination.trim(), trip.interest_tags ?? [])}
              disabled={loading}
              aria-label="Refresh discovery results"
              style={{
                background: 'none',
                border: 'none',
                cursor: loading ? 'default' : 'pointer',
                color: loading ? 'rgba(240,234,216,0.28)' : 'rgba(240,234,216,0.60)',
                fontFamily: "'DM Mono', monospace",
                fontSize: '14px',
                padding: '0',
                lineHeight: '1',
              }}
            >
              ↺
            </button>
          )}
        </div>
      </div>

      {/* Destination input + tags */}
      <div style={{ padding: '14px 20px 0', flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: '8px', marginBottom: '10px' }}>
          <input
            type="text"
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleDiscover()}
            placeholder="Enter destination..."
            style={{
              flex: 1,
              background: '#1c1a17',
              border: '1px solid rgba(255,255,255,0.10)',
              borderRadius: '8px',
              padding: '8px 12px',
              fontFamily: "'Cormorant Garamond', serif",
              fontSize: '15px',
              color: 'var(--cream)',
              outline: 'none',
            }}
          />
          <button
            onClick={handleDiscover}
            disabled={loading || !destination.trim()}
            style={{
              fontFamily: "'DM Mono', monospace",
              fontSize: '11px',
              letterSpacing: '0.14em',
              color: loading ? 'rgba(201,168,76,0.40)' : 'var(--gold)',
              border: '1px solid rgba(201,168,76,0.4)',
              borderRadius: '8px',
              padding: '8px 14px',
              background: 'transparent',
              cursor: loading ? 'default' : 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            DISCOVER
          </button>
        </div>

        {/* Interest tags */}
        {trip.interest_tags && trip.interest_tags.length > 0 && (
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '12px' }}>
            {trip.interest_tags.map((tag) => (
              <span
                key={tag}
                style={{
                  fontFamily: "'DM Mono', monospace",
                  fontSize: '10px',
                  letterSpacing: '0.08em',
                  color: 'rgba(240,234,216,0.50)',
                  border: '1px solid rgba(255,255,255,0.07)',
                  borderRadius: '999px',
                  padding: '2px 8px',
                }}
              >
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Category tabs */}
      <div
        style={{
          display: 'flex',
          gap: '0',
          overflowX: 'auto',
          padding: '0 20px',
          borderBottom: '1px solid rgba(255,255,255,0.07)',
          flexShrink: 0,
        }}
      >
        {CATEGORY_TABS.map((tab) => {
          const key = CATEGORY_KEYS[tab];
          const isActive = activeCategory === key;
          return (
            <button
              key={key}
              onClick={() => setActiveCategory(key)}
              style={{
                fontFamily: "'DM Mono', monospace",
                fontSize: '10px',
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                color: isActive ? 'var(--cream)' : 'rgba(240,234,216,0.28)',
                background: 'none',
                border: 'none',
                borderBottom: isActive ? '2px solid var(--gold)' : '2px solid transparent',
                padding: '10px 12px 8px',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                transition: 'color 0.15s, border-color 0.15s',
              }}
            >
              {tab}
            </button>
          );
        })}
      </div>

      {/* Content area */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 20px' }}>
        {loading && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                style={{
                  background: '#1c1a17',
                  borderRadius: '12px',
                  height: '100px',
                  border: '1px solid rgba(255,255,255,0.07)',
                  animation: 'pulse 1.6s ease-in-out infinite',
                  opacity: 1 - i * 0.15,
                }}
              />
            ))}
          </div>
        )}

        {!loading && error && (
          <p
            style={{
              fontFamily: "'DM Mono', monospace",
              fontSize: '11px',
              color: '#e05a5a',
              letterSpacing: '0.08em',
              textAlign: 'center',
              marginTop: '40px',
            }}
          >
            {error.message || 'Discovery failed. Please try again.'}
          </p>
        )}

        {!loading && !error && results && activeSuggestions.length === 0 && (
          <p
            style={{
              fontFamily: "'Cormorant Garamond', serif",
              fontSize: '14px',
              color: 'rgba(240,234,216,0.40)',
              textAlign: 'center',
              marginTop: '40px',
            }}
          >
            Nothing found for this category
          </p>
        )}

        {!loading && !error && activeSuggestions.length > 0 && (
          <div>
            {activeSuggestions.map((suggestion, idx) => (
              <SuggestionCard
                key={suggestion.name ?? idx}
                suggestion={suggestion}
                days={days}
                onAddToDay={handleAddToDay}
              />
            ))}
          </div>
        )}

        {!loading && !error && !results && (
          <p
            style={{
              fontFamily: "'Cormorant Garamond', serif",
              fontSize: '15px',
              color: 'rgba(240,234,216,0.35)',
              textAlign: 'center',
              marginTop: '60px',
              lineHeight: '1.6',
            }}
          >
            Enter a destination and tap Discover to find things to do.
          </p>
        )}
      </div>

      {/* Surprise Me button */}
      <div
        style={{
          padding: '14px 20px',
          borderTop: '1px solid rgba(255,255,255,0.07)',
          flexShrink: 0,
        }}
      >
        <button
          onClick={() => setActiveCategory('hidden_gems')}
          style={{
            width: '100%',
            fontFamily: "'DM Mono', monospace",
            fontSize: '12px',
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: 'var(--gold)',
            background: 'rgba(201,168,76,0.08)',
            border: '1px solid rgba(201,168,76,0.35)',
            borderRadius: '10px',
            padding: '12px',
            cursor: 'pointer',
          }}
        >
          SURPRISE ME
        </button>
      </div>
    </motion.div>
  );
}
