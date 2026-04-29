import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import SuggestionCard from './SuggestionCard.jsx';

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

function normalizeName(str) {
  return str
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\b(scenic area|& area|& park|national park|historic district|old town|city centre|city center)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

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
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', paddingTop: '8px' }}>
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          style={{
            background: '#1a1410',
            borderRadius: 4,
            height: 120,
            border: '1px solid rgba(201,160,80,0.08)',
            animation: 'pulse 1.6s ease-in-out infinite',
            opacity: 1 - i * 0.2,
          }}
        />
      ))}
    </div>
  );
}

function DestinationHero({ city, count }) {
  if (!city) return null;
  return (
    <div style={{
      position: 'relative',
      padding: '32px 20px 28px',
      borderBottom: '1px solid rgba(201,160,80,0.1)',
      overflow: 'hidden',
      flexShrink: 0,
    }}>
      {/* Celadon ambient tint */}
      <div style={{
        position: 'absolute', top: 0, right: 0, width: '55%', height: '100%',
        background: 'linear-gradient(135deg, transparent 40%, rgba(22,42,32,0.25) 100%)',
        pointerEvents: 'none',
      }} />
      {/* Ghost city name */}
      <div style={{
        position: 'absolute', top: '-15%', right: '-5%',
        fontFamily: "'Playfair Display', serif", fontStyle: 'italic', fontWeight: 500,
        fontSize: 'clamp(80px, 28vw, 180px)',
        color: '#f0ebe3', opacity: 0.025,
        lineHeight: 1, userSelect: 'none', pointerEvents: 'none',
        letterSpacing: '-0.03em', whiteSpace: 'nowrap',
      }}>
        {city}
      </div>
      <div style={{ position: 'relative', zIndex: 1 }}>
        <div style={{
          fontFamily: "'DM Mono', monospace", fontSize: 10,
          letterSpacing: '0.22em', textTransform: 'uppercase',
          color: '#504438', marginBottom: 12,
        }}>
          Destination
        </div>
        <div style={{
          fontFamily: "'Playfair Display', serif", fontStyle: 'italic', fontWeight: 500,
          fontSize: 'clamp(36px, 12vw, 64px)',
          color: '#f0ebe3', letterSpacing: '-0.025em',
          lineHeight: 1, marginBottom: 16,
        }}>
          {city}
        </div>
        {count > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 28, height: 1, background: 'rgba(201,160,80,0.4)', flexShrink: 0 }} />
            <span style={{
              fontFamily: "'DM Mono', monospace", fontSize: 10,
              letterSpacing: '0.16em', textTransform: 'uppercase', color: '#6e5e50',
            }}>
              {count} curated {count === 1 ? 'place' : 'places'}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

export default function DiscoveryPanel({ trip, days, activeDay, onAddStop, onClose, discovery }) {
  const defaultDestination = activeDay?.resolvedCity ?? activeDay?.city ?? days[0]?.resolvedCity ?? days[0]?.city ?? trip.destinations?.[0] ?? '';
  const [destination, setDestination] = useState(defaultDestination);
  const [inputFocused, setInputFocused] = useState(false);
  const tabs = buildTabs(trip.interestTags);
  const [activeCategory, setActiveCategory] = useState(tabs[0]);
  const [surprisePick, setSurprisePick] = useState(null);

  const { discover, refresh, getDestination } = discovery;
  const { partialResults, completedCategories, loading, error } = getDestination(destination);

  useEffect(() => {
    if (destination) discover(destination);
  }, []); // intentional mount-only

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
    }
  };

  const handleAddToDay = async (dayId, suggestion) => {
    await onAddStop(dayId, {
      title: suggestion.name,
      type: 'experience',
      note: suggestion.description,
      lat: suggestion.lat,
      lng: suggestion.lng,
      locationQuery: suggestion.name,
      locationCity: destination.trim(),
      localName: suggestion.localName,
      locationAliases: [suggestion.localName, ...(Array.isArray(suggestion.aliases) ? suggestion.aliases : [])].filter(Boolean),
      coordinateSystem: Number.isFinite(Number(suggestion.lat)) && Number.isFinite(Number(suggestion.lng)) ? 'wgs84' : undefined,
      coordinateSource: 'discovery',
      locationStatus: Number.isFinite(Number(suggestion.lat)) && Number.isFinite(Number(suggestion.lng)) ? 'estimated' : undefined,
      locationConfidence: Number.isFinite(Number(suggestion.lat)) && Number.isFinite(Number(suggestion.lng)) ? 0.68 : undefined,
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
  const categoryLoaded = completedCategories.has(activeCategory);
  const anyResults = Object.keys(partialResults).length > 0;
  const totalCount = Object.values(partialResults).flat().length;

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
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '16px 20px 12px',
        borderBottom: '1px solid rgba(240,235,227,0.07)',
        flexShrink: 0,
      }}>
        <button
          onClick={onClose}
          aria-label="Close discovery panel"
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'rgba(240,234,216,0.60)',
            fontFamily: "'DM Mono', monospace",
            fontSize: 18, padding: 0, lineHeight: 1,
          }}
        >
          ✕
        </button>

        <span style={{
          fontFamily: "'DM Mono', monospace",
          fontSize: 11, letterSpacing: '0.3em',
          textTransform: 'uppercase', color: '#f0ebe3',
        }}>
          Discover
        </span>

        <div style={{ minWidth: 56, display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>
          {anyResults && (
            <button
              onClick={() => refresh(destination.trim())}
              disabled={loading}
              aria-label="Refresh discovery results"
              style={{
                background: 'none', border: 'none',
                cursor: loading ? 'default' : 'pointer',
                color: loading ? 'rgba(240,234,216,0.28)' : 'rgba(240,234,216,0.60)',
                fontFamily: "'DM Mono', monospace",
                fontSize: 16, padding: 0, lineHeight: 1,
              }}
            >
              ↺
            </button>
          )}
        </div>
      </div>

      {/* Search input */}
      <div style={{ padding: '16px 20px 0', flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: 10 }}>
          <input
            type="text"
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleDiscover()}
            onFocus={() => setInputFocused(true)}
            onBlur={() => setInputFocused(false)}
            placeholder="Destination"
            style={{
              flex: 1,
              background: 'rgba(26,20,16,0.7)',
              border: `1px solid ${inputFocused ? 'rgba(201,160,80,0.45)' : 'rgba(201,160,80,0.12)'}`,
              borderRadius: 4,
              padding: '11px 18px',
              fontFamily: "'Cormorant Garamond', serif",
              fontSize: 20, fontWeight: 400,
              color: '#f0ebe3', letterSpacing: '0.01em',
              outline: 'none',
              transition: 'border-color 200ms',
              boxShadow: inputFocused ? '0 0 0 1px rgba(201,160,80,0.06)' : 'none',
            }}
          />
          <button
            onClick={handleDiscover}
            disabled={loading || !destination.trim()}
            style={{
              fontFamily: "'DM Mono', monospace",
              fontSize: 11, letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: (loading || !destination.trim()) ? 'rgba(201,168,76,0.35)' : 'var(--gold)',
              background: 'transparent',
              border: `1px solid ${(loading || !destination.trim()) ? 'rgba(201,168,76,0.2)' : 'rgba(201,168,76,0.5)'}`,
              borderRadius: 4,
              padding: '10px 22px',
              cursor: (loading || !destination.trim()) ? 'default' : 'pointer',
              whiteSpace: 'nowrap',
              transition: 'border-color 150ms, color 150ms',
            }}
          >
            {loading ? '...' : 'Go'}
          </button>
        </div>
      </div>

      {/* Destination hero */}
      {anyResults && (
        <DestinationHero city={destination.trim() || defaultDestination} count={totalCount} />
      )}

      {/* Category tabs */}
      <div style={{
        display: 'flex',
        overflowX: 'auto',
        padding: '0 20px',
        borderBottom: '1px solid rgba(240,235,227,0.07)',
        flexShrink: 0,
        gap: 0,
      }}>
        {tabs.map((key) => {
          const isActive = activeCategory === key;
          const isLoaded = completedCategories.has(key);
          const isLoading = loading && !isLoaded;
          const count = partialResults[key]?.length ?? 0;
          return (
            <button
              key={key}
              className="discovery-tab-btn"
              onClick={() => setActiveCategory(key)}
              style={{
                fontFamily: "'DM Mono', monospace",
                fontSize: 11, letterSpacing: '0.16em',
                textTransform: 'uppercase',
                color: isActive ? '#f0ebe3' : 'rgba(240,234,216,0.45)',
                background: 'none', border: 'none',
                borderBottom: isActive ? '2px solid #c9a050' : '2px solid transparent',
                padding: '16px 18px 14px',
                cursor: 'pointer', whiteSpace: 'nowrap',
                display: 'flex', alignItems: 'center', gap: 7,
              }}
            >
              {CATEGORY_LABELS[key] ?? key}
              {isLoading ? (
                <span style={{
                  width: 5, height: 5, borderRadius: '50%',
                  background: 'rgba(201,160,80,0.5)',
                  display: 'inline-block',
                  animation: 'trippyPulse 1.4s ease-in-out infinite',
                }} />
              ) : count > 0 ? (
                <span style={{
                  fontSize: 9,
                  color: isActive ? '#c9a050' : 'rgba(201,160,80,0.35)',
                  letterSpacing: '0.08em',
                }}>
                  {count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {/* Content area */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 20px 120px', position: 'relative' }}>
        {error && (
          <p style={{
            fontFamily: "'DM Mono', monospace",
            fontSize: 11, color: '#e05a5a',
            letterSpacing: '0.08em', textAlign: 'center', marginTop: 40,
          }}>
            {error.message || 'Discovery failed. Please try again.'}
          </p>
        )}

        {!error && !categoryLoaded && loading && <TabSkeleton />}

        {!error && categoryLoaded && activeItems.length === 0 && (
          <p style={{
            fontFamily: "'Cormorant Garamond', serif",
            fontSize: 20, color: '#504438',
            textAlign: 'center', marginTop: 80, lineHeight: 1.7,
          }}>
            Nothing curated for this category yet.
          </p>
        )}

        {!error && activeItems.length > 0 && (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 340px), 1fr))',
            gap: 16,
          }}>
            {activeItems.map((suggestion, idx) => (
              <SuggestionCard
                key={suggestion.name ?? idx}
                suggestion={suggestion}
                days={days}
                onAddToDay={handleAddToDay}
              />
            ))}
          </div>
        )}

        {!error && !loading && !anyResults && (
          <p style={{
            fontFamily: "'Cormorant Garamond', serif",
            fontSize: 20, color: 'rgba(240,234,216,0.35)',
            textAlign: 'center', marginTop: 80, lineHeight: 1.7,
          }}>
            Enter a destination and tap Go to find things to do.
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
                position: 'absolute', inset: 0,
                background: 'rgba(13,11,9,0.92)',
                backdropFilter: 'blur(8px)',
                display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center',
                padding: '24px 20px', zIndex: 10,
              }}
            >
              <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 480 }}>
                <p style={{
                  fontFamily: "'DM Mono', monospace",
                  fontSize: 10, letterSpacing: '0.22em',
                  color: '#c9a050', textAlign: 'center',
                  marginBottom: 20, textTransform: 'uppercase',
                }}>
                  ✦ &nbsp; Your surprise
                </p>

                <SuggestionCard
                  suggestion={surprisePick}
                  days={days}
                  onAddToDay={async (dayId, suggestion) => {
                    await handleAddToDay(dayId, suggestion);
                    setSurprisePick(null);
                  }}
                />

                <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
                  <button
                    onClick={() => setSurprisePick(pickSurprise(partialResults, days))}
                    style={{
                      flex: 1,
                      fontFamily: "'DM Mono', monospace",
                      fontSize: 11, letterSpacing: '0.14em', textTransform: 'uppercase',
                      color: '#8a7a6a',
                      border: '1px solid rgba(240,235,227,0.1)',
                      borderRadius: 3, padding: 12,
                      background: 'transparent', cursor: 'pointer',
                    }}
                  >
                    Another
                  </button>
                  <button
                    onClick={() => setSurprisePick(null)}
                    style={{
                      flex: 1,
                      fontFamily: "'DM Mono', monospace",
                      fontSize: 11, letterSpacing: '0.14em', textTransform: 'uppercase',
                      color: '#8a7a6a',
                      border: '1px solid rgba(240,235,227,0.1)',
                      borderRadius: 3, padding: 12,
                      background: 'transparent', cursor: 'pointer',
                    }}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Surprise Me footer */}
      <div style={{
        position: 'absolute', bottom: 0, left: 0, right: 0,
        padding: '20px 20px 24px',
        background: 'linear-gradient(transparent, rgba(13,11,9,0.98) 40%)',
        zIndex: 5,
        pointerEvents: 'none',
      }}>
        <button
          onClick={handleSurpriseMe}
          disabled={loading && !anyResults}
          style={{
            width: '100%',
            fontFamily: "'DM Mono', monospace",
            fontSize: 12, letterSpacing: '0.22em',
            textTransform: 'uppercase',
            color: (loading && !anyResults) ? 'rgba(201,160,80,0.40)' : '#c9a050',
            background: 'rgba(201,160,80,0.06)',
            border: '1px solid rgba(201,160,80,0.28)',
            borderRadius: 3, padding: '14px',
            cursor: (loading && !anyResults) ? 'default' : 'pointer',
            transition: 'all 200ms',
            pointerEvents: 'auto',
          }}
        >
          Surprise me
        </button>
      </div>
    </motion.div>
  );
}
