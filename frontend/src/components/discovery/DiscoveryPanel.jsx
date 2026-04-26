import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import SuggestionCard from './SuggestionCard.jsx';

// Maps user interest tags → discovery category keys
const TAG_TO_CATEGORY = {
  'food & drink': 'food',
  'nature': 'nature',
  'culture': 'culture',
  'nightlife': 'nightlife',
  'architecture': 'architecture',
  'wellness': 'wellness',
  'history': 'culture',
  'art': 'culture',
  'markets': 'hidden_gems',
  'shopping': 'hidden_gems',
  'adventure': 'nature',
  'off the beaten path': 'hidden_gems',
};

const CATEGORY_LABELS = {
  essentials: 'Essentials',
  culture: 'Culture',
  food: 'Food',
  nature: 'Nature',
  nightlife: 'Nightlife',
  hidden_gems: 'Hidden Gems',
  architecture: 'Architecture',
  wellness: 'Wellness',
};

const PAGE_SIZE = 5;

function normalizeName(str) {
  return str
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\b(scenic area|& area|& park|national park|historic district|old town|city centre|city center)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Derives which category tabs to show based on user interest tags.
// Always includes 'essentials'. Deduplicates mapped categories.
function buildTabs(interestTags) {
  const categories = ['essentials'];
  const seen = new Set(['essentials']);
  for (const tag of (interestTags ?? [])) {
    const cat = TAG_TO_CATEGORY[tag.toLowerCase()];
    if (cat && !seen.has(cat)) {
      categories.push(cat);
      seen.add(cat);
    }
  }
  // If no tags, show all 8 categories so the panel is still useful
  if (categories.length === 1) {
    for (const cat of Object.keys(CATEGORY_LABELS)) {
      if (!seen.has(cat)) {
        categories.push(cat);
        seen.add(cat);
      }
    }
  }
  return categories;
}

function pickSurprise(partialResults, days) {
  const addedNames = new Set(
    (days ?? []).flatMap((d) => (d.stops ?? []).map((s) => normalizeName(s.title ?? ''))),
  );
  const pool = Object.values(partialResults).flat().filter(
    (s) => s?.name && !addedNames.has(normalizeName(s.name)),
  );
  if (pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

function TabSkeleton() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', paddingTop: '4px' }}>
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          style={{
            background: '#1c1a17',
            borderRadius: '12px',
            height: '100px',
            border: '1px solid rgba(255,255,255,0.07)',
            animation: 'pulse 1.6s ease-in-out infinite',
            opacity: 1 - i * 0.2,
          }}
        />
      ))}
    </div>
  );
}

export default function DiscoveryPanel({ trip, days, activeDay, onAddStop, onClose, discovery }) {
  const defaultDestination = activeDay?.resolvedCity ?? activeDay?.city ?? days[0]?.resolvedCity ?? days[0]?.city ?? trip.destinations?.[0] ?? '';
  const [destination, setDestination] = useState(defaultDestination);
  const tabs = buildTabs(trip.interestTags);
  const [activeCategory, setActiveCategory] = useState(tabs[0]);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [surprisePick, setSurprisePick] = useState(null);

  const { discover, refresh, getDestination } = discovery;
  // Per-destination state — updates independently from other cities in the cache
  const { partialResults, completedCategories, loading, error } = getDestination(destination);

  // Reset visible count when switching tabs
  useEffect(() => setVisibleCount(PAGE_SIZE), [activeCategory]);

  // On mount: trigger discovery for this destination if not already fetched/loading.
  // discover() internally guards against duplicate calls.
  useEffect(() => {
    if (destination) discover(destination);
  }, []); // intentional mount-only

  // When results arrive after a pending Surprise Me, surface the pick
  const surprisePendingRef = useRef(false);
  useEffect(() => {
    if (surprisePendingRef.current && Object.keys(partialResults).length > 0 && !loading) {
      surprisePendingRef.current = false;
      setSurprisePick(pickSurprise(partialResults, days));
    }
  }, [partialResults, loading]);

  const handleDiscover = () => {
    if (destination.trim()) {
      discover(destination.trim());
      setActiveCategory(tabs[0]);
      setVisibleCount(PAGE_SIZE);
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

  const handleSurpriseMe = () => {
    const hasResults = Object.keys(partialResults).length > 0;
    if (!hasResults && destination.trim()) {
      surprisePendingRef.current = true;
      discover(destination.trim());
      return;
    }
    setSurprisePick(pickSurprise(partialResults, days));
  };

  const activeItems = partialResults[activeCategory] ?? [];
  const visibleItems = activeItems.slice(0, visibleCount);
  const hasMore = activeItems.length > visibleCount;
  const categoryLoaded = completedCategories.has(activeCategory);
  const anyResults = Object.keys(partialResults).length > 0;

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

        <div style={{ minWidth: '80px', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '8px' }}>
          {anyResults && (
            <button
              onClick={() => refresh(destination.trim())}
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

      {/* Destination input */}
      <div style={{ padding: '14px 20px 0', flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
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
            GO
          </button>
        </div>
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
        {tabs.map((key) => {
          const isActive = activeCategory === key;
          const isLoaded = completedCategories.has(key);
          const isLoading = loading && !isLoaded;
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
                display: 'flex',
                alignItems: 'center',
                gap: '5px',
              }}
            >
              {CATEGORY_LABELS[key] ?? key}
              {isLoading && (
                <span
                  style={{
                    width: '5px',
                    height: '5px',
                    borderRadius: '50%',
                    background: 'rgba(201,168,76,0.5)',
                    display: 'inline-block',
                    animation: 'trippyPulse 1.4s ease-in-out infinite',
                  }}
                />
              )}
            </button>
          );
        })}
      </div>

      {/* Content area */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 20px', position: 'relative' }}>
        {error && (
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

        {!error && !categoryLoaded && loading && <TabSkeleton />}

        {!error && categoryLoaded && activeItems.length === 0 && (
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

        {!error && visibleItems.length > 0 && (
          <div>
            {visibleItems.map((suggestion, idx) => (
              <SuggestionCard
                key={suggestion.name ?? idx}
                suggestion={suggestion}
                days={days}
                onAddToDay={handleAddToDay}
              />
            ))}

            {hasMore && (
              <button
                onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
                style={{
                  display: 'block',
                  width: '100%',
                  marginTop: '12px',
                  fontFamily: "'DM Mono', monospace",
                  fontSize: '11px',
                  letterSpacing: '0.18em',
                  textTransform: 'uppercase',
                  color: 'rgba(240,234,216,0.50)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: '8px',
                  padding: '10px',
                  background: 'transparent',
                  cursor: 'pointer',
                }}
              >
                Show more ({activeItems.length - visibleCount} remaining)
              </button>
            )}
          </div>
        )}

        {!error && !loading && !anyResults && (
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
            Enter a destination and tap GO to find things to do.
          </p>
        )}

        {/* Surprise Me spotlight overlay */}
        <AnimatePresence>
          {surprisePick && (
            <motion.div
              key="surprise-overlay"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              onClick={() => setSurprisePick(null)}
              style={{
                position: 'absolute',
                inset: 0,
                background: 'rgba(13,11,9,0.88)',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '24px 20px',
                zIndex: 10,
              }}
            >
              <div
                onClick={(e) => e.stopPropagation()}
                style={{ width: '100%', maxWidth: '420px' }}
              >
                <p
                  style={{
                    fontFamily: "'DM Mono', monospace",
                    fontSize: '10px',
                    letterSpacing: '0.22em',
                    color: 'var(--gold)',
                    textAlign: 'center',
                    marginBottom: '14px',
                    textTransform: 'uppercase',
                  }}
                >
                  ✦ Your Surprise
                </p>

                <SuggestionCard
                  suggestion={surprisePick}
                  days={days}
                  onAddToDay={async (dayId, suggestion) => {
                    await handleAddToDay(dayId, suggestion);
                    setSurprisePick(null);
                  }}
                />

                <div style={{ display: 'flex', gap: '10px', marginTop: '12px' }}>
                  <button
                    onClick={() => setSurprisePick(pickSurprise(partialResults, days))}
                    style={{
                      flex: 1,
                      fontFamily: "'DM Mono', monospace",
                      fontSize: '11px',
                      letterSpacing: '0.14em',
                      color: 'rgba(240,234,216,0.60)',
                      border: '1px solid rgba(255,255,255,0.10)',
                      borderRadius: '8px',
                      padding: '10px',
                      background: 'transparent',
                      cursor: 'pointer',
                    }}
                  >
                    ANOTHER
                  </button>
                  <button
                    onClick={() => setSurprisePick(null)}
                    style={{
                      flex: 1,
                      fontFamily: "'DM Mono', monospace",
                      fontSize: '11px',
                      letterSpacing: '0.14em',
                      color: 'rgba(240,234,216,0.60)',
                      border: '1px solid rgba(255,255,255,0.10)',
                      borderRadius: '8px',
                      padding: '10px',
                      background: 'transparent',
                      cursor: 'pointer',
                    }}
                  >
                    DISMISS
                  </button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
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
          onClick={handleSurpriseMe}
          disabled={loading && !anyResults}
          style={{
            width: '100%',
            fontFamily: "'DM Mono', monospace",
            fontSize: '12px',
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: (loading && !anyResults) ? 'rgba(201,168,76,0.40)' : 'var(--gold)',
            background: 'rgba(201,168,76,0.08)',
            border: '1px solid rgba(201,168,76,0.35)',
            borderRadius: '10px',
            padding: '12px',
            cursor: (loading && !anyResults) ? 'default' : 'pointer',
          }}
        >
          SURPRISE ME
        </button>
      </div>
    </motion.div>
  );
}
