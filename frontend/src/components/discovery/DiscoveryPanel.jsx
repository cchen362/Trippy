import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import SuggestionCard from './SuggestionCard.jsx';
import DayPicker from './DayPicker.jsx';
import { bookingsApi } from '../../services/bookingsApi.js';
import { discoveryApi } from '../../services/discoveryApi.js';

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
  _more: 'More',
};

const MORE_TAB_KEY = '_more';

function normalizeName(str) {
  return (str ?? '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\b(scenic area|& area|& park|national park|historic district|old town|city centre|city center)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Builds the reachable tab list plus, separately, the set of categories that
// only surface under the terminal "More" tab (Wave 4 §4.2/Q3-04). Every
// category actually present in partialResults ends up reachable through
// exactly one of: a named tab, or "More" — so a hero count derived by
// summing across `tabs` (with moreCategories folded in for the "_more" key)
// is correct by construction rather than by coincidence.
function buildTabs(interestTags, partialResults) {
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
      if (cat !== MORE_TAB_KEY && !seen.has(cat)) {
        categories.push(cat);
        seen.add(cat);
      }
    }
  }

  const moreCategories = Object.keys(partialResults ?? {}).filter((cat) => !seen.has(cat));
  if (moreCategories.length > 0) {
    categories.push(MORE_TAB_KEY);
  }

  return { tabs: categories, moreCategories };
}

// Returns the list of underlying result categories a tab key actually
// covers — a single category for a normal tab, or every "More"-only
// category for the terminal tab. Used to derive counts/loaded-state/items
// for both kinds of tab from one code path.
function categoriesForTabKey(key, moreCategories) {
  return key === MORE_TAB_KEY ? moreCategories : [key];
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

// Matches a loaded suggestion against a search query across name, localName,
// aliases, and description — case-insensitive substring match.
function suggestionMatchesQuery(suggestion, query) {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  const haystacks = [
    suggestion?.name,
    suggestion?.localName,
    ...(Array.isArray(suggestion?.aliases) ? suggestion.aliases : []),
    suggestion?.description,
  ];
  return haystacks.some((h) => typeof h === 'string' && h.toLowerCase().includes(q));
}

// Shared card grid: wraps each SuggestionCard in a motion.div inside
// AnimatePresence so a successful report animates the card out (Wave 4
// §4.3) instead of it just vanishing on the next render.
function SuggestionGrid({ items, days, destination, onAddToDay, onReport }) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 340px), 1fr))',
      gap: 16,
    }}>
      <AnimatePresence>
        {items.map((suggestion, idx) => (
          <motion.div
            key={suggestion.id ?? suggestion.name ?? idx}
            layout
            exit={{ opacity: 0, scale: 0.92 }}
            transition={{ duration: 0.2 }}
            // The grid stretches this wrapper to the row height, but the card
            // inside would otherwise size to its own content — flex makes the
            // card fill the wrapper so all cards in a row share one height.
            style={{ display: 'flex' }}
          >
            <SuggestionCard
              suggestion={suggestion}
              days={days}
              destination={destination}
              onAddToDay={onAddToDay}
              onReport={onReport}
            />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
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

// Compact row for a Google Places prediction under "On the map". Tapping "Add"
// opens a DayPicker; picking a day resolves place details then adds the stop.
function PlaceResultRow({ prediction, days, onAdd }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [resolving, setResolving] = useState(false);
  const btnRef = useRef(null);

  const handlePick = async (dayId) => {
    setResolving(true);
    try {
      await onAdd(dayId, prediction);
    } finally {
      setResolving(false);
    }
  };

  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 12, padding: '12px 14px',
        background: '#1a1410',
        border: '1px solid rgba(201,160,80,0.1)',
        borderRadius: 4,
      }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{
          fontFamily: "'Cormorant Garamond', serif",
          fontSize: 17, color: '#f0ebe3',
          letterSpacing: '0.01em',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {prediction.mainText || prediction.text}
        </div>
        {prediction.secondaryText && (
          <div style={{
            fontFamily: "'DM Mono', monospace",
            fontSize: 10, letterSpacing: '0.04em',
            color: '#6e5e50',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            marginTop: 3,
          }}>
            {prediction.secondaryText}
          </div>
        )}
      </div>
      <div style={{ position: 'relative', flexShrink: 0 }}>
        <button
          ref={btnRef}
          onClick={() => setPickerOpen((v) => !v)}
          disabled={resolving}
          style={{
            fontFamily: "'DM Mono', monospace",
            fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase',
            color: resolving ? 'rgba(201,160,80,0.35)' : '#c9a050',
            background: 'rgba(201,160,80,0.06)',
            border: '1px solid rgba(201,160,80,0.28)',
            borderRadius: 3, padding: '8px 14px',
            cursor: resolving ? 'default' : 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          {resolving ? '...' : 'Add'}
        </button>
        {pickerOpen && (
          <DayPicker
            addedDayIds={new Set()}
            days={days}
            suggestion={prediction}
            onAddToDay={(dayId) => handlePick(dayId)}
            onClose={() => setPickerOpen(false)}
            anchorRef={btnRef}
          />
        )}
      </div>
    </div>
  );
}

export default function DiscoveryPanel({ trip, days, activeDay, onAddStop, onClose, discovery }) {
  const defaultDestination = activeDay?.resolvedCity ?? activeDay?.city ?? days[0]?.resolvedCity ?? days[0]?.city ?? trip.destinations?.[0] ?? '';
  const defaultCountry = activeDay?.resolvedCountry ?? days[0]?.resolvedCountry ?? trip.destinationCountries?.[0] ?? null;

  // `destination` is the live input draft (updates every keystroke).
  // `committedDestination` is the lookup/search key — it only changes when the
  // user explicitly commits (submit, or the default recomputes on open/day change).
  // Keeping these separate means typing never blanks the results view mid-keystroke,
  // since `getDestination(partialText)` would otherwise look up an empty cache entry.
  // `committedCountry` follows the same rule and pairs with it (Wave 4 §4.1) — the
  // manual "Go" search box has no country field, so a manually committed search
  // always clears it (free-text search shouldn't force a country match).
  const [destination, setDestination] = useState(defaultDestination);
  const [committedDestination, setCommittedDestination] = useState(defaultDestination);
  const [committedCountry, setCommittedCountry] = useState(defaultCountry);
  const [inputFocused, setInputFocused] = useState(false);
  const [surprisePick, setSurprisePick] = useState(null);
  const [reportedIds, setReportedIds] = useState(() => new Set());

  // Search-inside-Discover state
  const [searchQuery, setSearchQuery] = useState('');
  const [placePredictions, setPlacePredictions] = useState([]);
  const [placeSearching, setPlaceSearching] = useState(false);
  const sessionTokenRef = useRef(null);

  const { discover, showMore, getDestination } = discovery;
  const { partialResults: rawPartialResults, completedCategories, loading, error } = getDestination(committedDestination, committedCountry);

  // Reported places are filtered out at render time rather than mutated into
  // the shared useDiscovery cache — the cache is keyed per-destination and
  // shared across every consumer of that hook instance, while "reported" is
  // this panel session's local view of what to keep showing.
  const partialResults = reportedIds.size === 0
    ? rawPartialResults
    : Object.fromEntries(
        Object.entries(rawPartialResults).map(([cat, items]) => [cat, items.filter((it) => !reportedIds.has(it.id))]),
      );

  const { tabs, moreCategories } = buildTabs(trip.interestTags, partialResults);
  const [activeCategory, setActiveCategory] = useState(tabs[0]);

  const handleReportPlace = async (placeId) => {
    await discoveryApi.reportPlace(placeId, trip.id);
    setReportedIds((prev) => new Set(prev).add(placeId));
  };

  // Recompute the default destination whenever the active day changes (the
  // panel itself is only ever mounted while open, so mounting already covers
  // "the panel opens") so a stale default from a previous day never lingers,
  // and kick off discovery for it.
  useEffect(() => {
    if (!defaultDestination) return;
    setDestination(defaultDestination);
    setCommittedDestination(defaultDestination);
    setCommittedCountry(defaultCountry);
    discover(defaultDestination, defaultCountry);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultDestination, defaultCountry]);

  const surprisePendingRef = useRef(false);
  useEffect(() => {
    if (surprisePendingRef.current && Object.keys(partialResults).length > 0 && !loading) {
      surprisePendingRef.current = false;
      setSurprisePick(pickSurprise(partialResults, days));
    }
  }, [partialResults, loading]);

  // Debounced Google Places lookup while searching, so "I heard about this place
  // but it's not in Discover" always has a real-world escape hatch.
  useEffect(() => {
    if (searchQuery.trim().length < 3) {
      setPlacePredictions([]);
      return;
    }
    if (!sessionTokenRef.current) sessionTokenRef.current = crypto.randomUUID();
    const timer = setTimeout(async () => {
      setPlaceSearching(true);
      try {
        const response = await bookingsApi.lookupPlaces(searchQuery.trim(), sessionTokenRef.current, committedDestination.trim());
        setPlacePredictions(response?.suggestions ?? []);
      } catch {
        setPlacePredictions([]);
      } finally {
        setPlaceSearching(false);
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [searchQuery, committedDestination]);

  // Manual "Go" search is free-text: it has no country field, so it always
  // clears the committed country rather than reusing whatever the active
  // day happened to have — forcing a country match onto a typed destination
  // the user may be deliberately searching outside the trip's own geography
  // would be dishonest (Wave 4 §4.1).
  const handleDiscover = () => {
    if (destination.trim()) {
      setCommittedDestination(destination.trim());
      setCommittedCountry(null);
      discover(destination.trim(), null);
      setActiveCategory(tabs[0]);
    }
  };

  const handleAddToDay = async (dayId, suggestion) => {
    const isVerifiedWithCoordinates = suggestion.provenance === 'verified'
      && Number.isFinite(suggestion.lat) && Number.isFinite(suggestion.lng);

    if (isVerifiedWithCoordinates) {
      // Trusted fast path (Wave 4 §4.4) — same shape handleAddPlaceResult
      // uses for a resolved Google Places pick, skipping a redundant
      // server-side geocode for a place the verification pipeline already
      // confirmed real coordinates for.
      await onAddStop(dayId, {
        title: suggestion.name,
        type: 'experience',
        note: suggestion.description,
        lat: suggestion.lat,
        lng: suggestion.lng,
        coordinateSystem: 'wgs84',
        coordinateSource: 'places',
        locationStatus: 'resolved',
        providerId: suggestion.placeRef,
        locationQuery: suggestion.name,
        locationCity: committedDestination.trim(),
        locationCountry: activeDay?.resolvedCountry ?? null,
        localName: suggestion.localName,
        locationAliases: [suggestion.localName, ...(Array.isArray(suggestion.aliases) ? suggestion.aliases : [])].filter(Boolean),
        duration: suggestion.estimatedDuration,
        source: 'discovery',
        provenance: suggestion.provenance,
      });
      return;
    }

    await onAddStop(dayId, {
      title: suggestion.name,
      type: 'experience',
      note: suggestion.description,
      locationQuery: suggestion.name,
      locationCity: committedDestination.trim(),
      locationCountry: activeDay?.resolvedCountry ?? null,
      localName: suggestion.localName,
      locationAliases: [suggestion.localName, ...(Array.isArray(suggestion.aliases) ? suggestion.aliases : [])].filter(Boolean),
      duration: suggestion.estimatedDuration,
      source: 'discovery',
      provenance: suggestion.provenance,
    });
  };

  // Adds a place picked from the "On the map" Google Places results. Resolves
  // exact details first — if coordinates come back, use the trusted-coordinates
  // fast path; otherwise fall back to free-text resolution server-side.
  const handleAddPlaceResult = async (dayId, prediction) => {
    const sessionToken = sessionTokenRef.current;
    sessionTokenRef.current = null; // session ends with the details call
    let place = null;
    try {
      const response = await bookingsApi.lookupHotelDetails(prediction.placeId, sessionToken);
      place = response?.place;
    } catch {
      place = null;
    }

    const name = place?.name || prediction.mainText || prediction.text;

    if (place && Number.isFinite(place.lat) && Number.isFinite(place.lng)) {
      await onAddStop(dayId, {
        title: name,
        type: 'experience',
        note: place.address || '',
        lat: place.lat,
        lng: place.lng,
        coordinateSystem: 'wgs84',
        coordinateSource: 'places',
        locationStatus: 'resolved',
        locationConfidence: 0.95,
        providerId: `google:${place.placeId || prediction.placeId}`,
        resolvedName: name,
        resolvedAddress: place.address,
        locationQuery: name,
      });
    } else {
      await onAddStop(dayId, {
        title: name,
        locationQuery: name,
        type: 'experience',
        note: place?.address || prediction.secondaryText || '',
      });
    }
  };

  const handleSurpriseMe = () => {
    const hasResults = Object.keys(partialResults).length > 0;
    if (!hasResults && committedDestination.trim()) {
      surprisePendingRef.current = true;
      discover(committedDestination.trim(), committedCountry);
      return;
    }
    setSurprisePick(pickSurprise(partialResults, days));
  };

  const handleShowMore = () => {
    if (committedDestination.trim()) showMore(committedDestination.trim(), committedCountry);
  };

  const activeTabCategories = categoriesForTabKey(activeCategory, moreCategories);
  const activeItems = activeTabCategories.flatMap((cat) => partialResults[cat] ?? []);
  const categoryLoaded = activeTabCategories.length > 0 && activeTabCategories.every((cat) => completedCategories.has(cat));
  const anyResults = Object.keys(partialResults).length > 0;
  // Sum of item counts across every reachable tab (Wave 4 §4.2/Q3-04) — with
  // "More" folded in, every category streamed for this destination is
  // reachable through exactly one tab, so this is structurally the full
  // count, not an independently-maintained figure that could drift from it.
  const totalCount = tabs.reduce(
    (sum, key) => sum + categoriesForTabKey(key, moreCategories).reduce((s, cat) => s + (partialResults[cat]?.length ?? 0), 0),
    0,
  );

  const isSearching = searchQuery.trim().length >= 2;
  const searchMatches = isSearching
    ? Object.values(partialResults).flat().filter((s) => suggestionMatchesQuery(s, searchQuery))
    : [];
  const showPlaceResults = searchQuery.trim().length >= 3;
  const noSearchResults = isSearching && searchMatches.length === 0 && (!showPlaceResults || (!placeSearching && placePredictions.length === 0));

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

        <div style={{ minWidth: 56 }} />
      </div>

      {/* Destination input */}
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
        <DestinationHero city={committedDestination.trim() || defaultDestination} count={totalCount} />
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
          const tabCategories = categoriesForTabKey(key, moreCategories);
          const isActive = activeCategory === key;
          const isLoaded = tabCategories.length > 0 && tabCategories.every((cat) => completedCategories.has(cat));
          const isLoading = loading && !isLoaded;
          const count = tabCategories.reduce((sum, cat) => sum + (partialResults[cat]?.length ?? 0), 0);
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

      {/* Search inside Discover */}
      {anyResults && (
        <div style={{ padding: '14px 20px 0', flexShrink: 0 }}>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Find a place…"
            style={{
              width: '100%',
              background: 'rgba(26,20,16,0.5)',
              border: '1px solid rgba(240,235,227,0.1)',
              borderRadius: 4,
              padding: '10px 16px',
              fontFamily: "'Cormorant Garamond', serif",
              fontSize: 17, fontWeight: 400,
              color: '#f0ebe3', letterSpacing: '0.01em',
              outline: 'none',
            }}
          />
        </div>
      )}

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

        {!error && isSearching && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
            {searchMatches.length > 0 && (
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 340px), 1fr))',
                gap: 16,
              }}>
                {searchMatches.map((suggestion, idx) => (
                  <SuggestionCard
                    key={suggestion.id ?? suggestion.name ?? idx}
                    suggestion={suggestion}
                    days={days}
                    destination={committedDestination}
                    onAddToDay={handleAddToDay}
                    onReport={handleReportPlace}
                  />
                ))}
              </div>
            )}

            {showPlaceResults && (
              <div>
                <div style={{
                  fontFamily: "'DM Mono', monospace",
                  fontSize: 10, letterSpacing: '0.22em', textTransform: 'uppercase',
                  color: '#504438', marginBottom: 10,
                }}>
                  On the map
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {placeSearching && placePredictions.length === 0 && (
                    <p style={{
                      fontFamily: "'DM Mono', monospace",
                      fontSize: 11, letterSpacing: '0.1em',
                      color: 'rgba(240,234,216,0.35)',
                    }}>
                      Searching…
                    </p>
                  )}
                  {placePredictions.map((prediction) => (
                    <PlaceResultRow
                      key={prediction.placeId}
                      prediction={prediction}
                      days={days}
                      onAdd={handleAddPlaceResult}
                    />
                  ))}
                </div>
              </div>
            )}

            {noSearchResults && (
              <p style={{
                fontFamily: "'Cormorant Garamond', serif",
                fontSize: 20, color: 'rgba(240,234,216,0.35)',
                textAlign: 'center', marginTop: 40, lineHeight: 1.7,
              }}>
                Nothing found. Keep typing to search the map.
              </p>
            )}
          </div>
        )}

        {!error && !isSearching && !categoryLoaded && loading && <TabSkeleton />}

        {!error && !isSearching && categoryLoaded && activeItems.length === 0 && (
          <p style={{
            fontFamily: "'Cormorant Garamond', serif",
            fontSize: 20, color: '#504438',
            textAlign: 'center', marginTop: 80, lineHeight: 1.7,
          }}>
            Nothing curated for this category yet.
          </p>
        )}

        {!error && !isSearching && activeItems.length > 0 && activeCategory !== MORE_TAB_KEY && (
          <SuggestionGrid
            items={activeItems}
            days={days}
            destination={committedDestination}
            onAddToDay={handleAddToDay}
            onReport={handleReportPlace}
          />
        )}

        {/* "More" tab (Wave 4 §4.2): every returned category not already
            tabbed, grouped into labeled sub-sections rather than one
            undifferentiated grid. */}
        {!error && !isSearching && activeCategory === MORE_TAB_KEY && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
            {moreCategories.map((cat) => {
              const items = partialResults[cat] ?? [];
              if (items.length === 0) return null;
              return (
                <div key={cat}>
                  <div style={{
                    fontFamily: "'DM Mono', monospace",
                    fontSize: 10, letterSpacing: '0.22em', textTransform: 'uppercase',
                    color: '#504438', marginBottom: 12,
                  }}>
                    {CATEGORY_LABELS[cat] ?? cat}
                  </div>
                  <SuggestionGrid
                    items={items}
                    days={days}
                    destination={committedDestination}
                    onAddToDay={handleAddToDay}
                    onReport={handleReportPlace}
                  />
                </div>
              );
            })}
          </div>
        )}

        {!error && !isSearching && !loading && !anyResults && (
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
                  destination={committedDestination}
                  onAddToDay={async (dayId, suggestion) => {
                    await handleAddToDay(dayId, suggestion);
                    setSurprisePick(null);
                  }}
                  onReport={async (placeId) => {
                    await handleReportPlace(placeId);
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

      {/* Footer: Show more + Surprise me */}
      <div style={{
        position: 'absolute', bottom: 0, left: 0, right: 0,
        padding: '20px 20px 24px',
        background: 'linear-gradient(transparent, rgba(13,11,9,0.98) 40%)',
        zIndex: 5,
        pointerEvents: 'none',
        display: 'flex',
        gap: 12,
      }}>
        {anyResults && (
          <button
            onClick={handleShowMore}
            disabled={loading}
            style={{
              flex: 1,
              fontFamily: "'DM Mono', monospace",
              fontSize: 12, letterSpacing: '0.22em',
              textTransform: 'uppercase',
              color: loading ? 'rgba(240,234,216,0.28)' : 'rgba(240,234,216,0.75)',
              background: 'transparent',
              border: '1px solid rgba(240,235,227,0.18)',
              borderRadius: 3, padding: '14px',
              cursor: loading ? 'default' : 'pointer',
              transition: 'all 200ms',
              pointerEvents: 'auto',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            }}
          >
            {/* Wave 4 §4.3: while a show-more is in flight (loading with results
                already on screen — the initial load never reaches this button,
                since it only renders once anyResults is true), swap to a
                "still working" label. Un-dims the instant `done` lands and
                loading flips back to false. */}
            {loading ? (
              <>
                Finding more places
                <span style={{ display: 'inline-flex', gap: 3 }}>
                  {[0, 1, 2].map((i) => (
                    <span
                      key={i}
                      style={{
                        width: 3, height: 3, borderRadius: '50%',
                        background: 'currentColor', display: 'inline-block',
                        animation: 'pulse 1.2s ease-in-out infinite',
                        animationDelay: `${i * 0.2}s`,
                      }}
                    />
                  ))}
                </span>
              </>
            ) : 'Show more'}
          </button>
        )}
        <button
          onClick={handleSurpriseMe}
          disabled={loading && !anyResults}
          style={{
            flex: 1,
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
