import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence, MotionConfig } from 'framer-motion';
import { Search, Sparkles, X } from 'lucide-react';
import SuggestionCard from './SuggestionCard.jsx';
import DayPicker from './DayPicker.jsx';
import { bookingsApi } from '../../services/bookingsApi.js';
import { discoveryApi } from '../../services/discoveryApi.js';
import { canonicalGeoKey } from '../../utils/geoIdentity.js';

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

function suggestionDetailKey(suggestion) {
  if (suggestion?.id != null) return `id:${suggestion.id}`;
  return `name:${canonicalGeoKey(suggestion?.name ?? '')}`;
}

// Shared card grid: wraps each SuggestionCard in a motion.div inside
// AnimatePresence so a successful report animates the card out (Wave 4
// §4.3) instead of it just vanishing on the next render.
function SuggestionGrid({
  items,
  days,
  destination,
  onAddToDay,
  onReport,
  onOpenCopilot,
  selectedDetailKey,
  onDetailSelection,
  showMore,
  scopeKey,
}) {
  return (
    <div className="discovery-register-grid">
      <AnimatePresence key={scopeKey}>
        {items.map((suggestion, idx) => (
          <motion.div
            key={suggestion.id ?? suggestion.name ?? idx}
            className="discovery-register-grid-item"
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
              onOpenCopilot={onOpenCopilot}
              detailsOpen={selectedDetailKey === suggestionDetailKey(suggestion)}
              onDetailsChange={(open) => onDetailSelection(open ? suggestionDetailKey(suggestion) : null)}
            />
          </motion.div>
        ))}
      </AnimatePresence>
      {showMore}
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

export default function DiscoveryPanel({ trip, days, activeDay, onAddStop, onClose, discovery, onOpenCopilot }) {
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
  const [destinationEditing, setDestinationEditing] = useState(!defaultDestination);
  const [inputFocused, setInputFocused] = useState(false);
  const [surprisePick, setSurprisePick] = useState(null);
  const [reportedIds, setReportedIds] = useState(() => new Set());
  const [selectedDetailKey, setSelectedDetailKey] = useState(null);

  // Search-inside-Discover state
  const [searchQuery, setSearchQuery] = useState('');
  const [mobileSearchExpanded, setMobileSearchExpanded] = useState(false);
  const [placePredictions, setPlacePredictions] = useState([]);
  const [placeSearching, setPlaceSearching] = useState(false);
  const destinationInputRef = useRef(null);
  const sessionTokenRef = useRef(null);
  const resultsScrollerRef = useRef(null);

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
    setSelectedDetailKey((selected) => selected === `id:${placeId}` ? null : selected);
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
    setDestinationEditing(false);
    discover(defaultDestination, defaultCountry);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultDestination, defaultCountry]);

  useEffect(() => {
    if (destinationEditing) destinationInputRef.current?.focus();
  }, [destinationEditing]);

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
      setDestinationEditing(false);
    }
  };

  const handleCategorySelect = (key) => {
    setSelectedDetailKey(null);
    setActiveCategory(key);
    const scroller = resultsScrollerRef.current;
    if (!scroller) return;
    if (typeof scroller.scrollTo === 'function') scroller.scrollTo({ top: 0 });
    else scroller.scrollTop = 0;
  };

  const clearSearch = () => {
    setSelectedDetailKey(null);
    setSearchQuery('');
    setPlacePredictions([]);
    setMobileSearchExpanded(false);
    sessionTokenRef.current = null;
  };

  const handleSearchQueryChange = (event) => {
    setSelectedDetailKey(null);
    setSearchQuery(event.target.value);
  };

  const handleAddToDay = async (dayId, suggestion) => {
    const isVerifiedWithCoordinates = suggestion.provenance === 'verified'
      && Number.isFinite(suggestion.lat) && Number.isFinite(suggestion.lng);

    // If the user searched a different destination than the active day's own
    // resolved scope, the searched destination's country is the correct one
    // to stamp — blindly using activeDay.resolvedCountry would mismatch the
    // city/country pair when adding a cross-city suggestion to this day.
    const activeDayCityKey = canonicalGeoKey(activeDay?.resolvedCity ?? activeDay?.city ?? '');
    const searchedDestinationKey = canonicalGeoKey(committedDestination);
    const resolvedLocationCountry = searchedDestinationKey && searchedDestinationKey !== activeDayCityKey
      ? committedCountry
      : (activeDay?.resolvedCountry ?? null);

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
        locationCountry: resolvedLocationCountry,
        localName: suggestion.localName,
        locationAliases: [suggestion.localName, ...(Array.isArray(suggestion.aliases) ? suggestion.aliases : [])].filter(Boolean),
        duration: suggestion.estimatedDuration,
        source: 'discovery',
        provenance: suggestion.provenance,
        photoQuery: suggestion.photoQuery,
        sceneType: suggestion.sceneType,
      });
      return;
    }

    await onAddStop(dayId, {
      title: suggestion.name,
      type: 'experience',
      note: suggestion.description,
      locationQuery: suggestion.name,
      locationCity: committedDestination.trim(),
      locationCountry: resolvedLocationCountry,
      localName: suggestion.localName,
      locationAliases: [suggestion.localName, ...(Array.isArray(suggestion.aliases) ? suggestion.aliases : [])].filter(Boolean),
      duration: suggestion.estimatedDuration,
      source: 'discovery',
      provenance: suggestion.provenance,
      photoQuery: suggestion.photoQuery,
      sceneType: suggestion.sceneType,
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
  const visibleSuggestions = isSearching ? searchMatches : activeItems;
  const visibleDetailKeys = [
    ...visibleSuggestions.map(suggestionDetailKey),
    ...(surprisePick ? [suggestionDetailKey(surprisePick)] : []),
  ];
  const visibleDetailKeySignature = visibleDetailKeys.join('|');
  const lastMoreCategory = [...moreCategories].reverse().find((cat) => (partialResults[cat]?.length ?? 0) > 0);

  useEffect(() => {
    if (selectedDetailKey && !visibleDetailKeys.includes(selectedDetailKey)) setSelectedDetailKey(null);
    // The signature intentionally tracks availability across category, search,
    // report, streaming, and Surprise without making the effect depend on a
    // freshly allocated array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDetailKey, visibleDetailKeySignature]);

  const showMoreTile = anyResults && !isSearching ? (
    <button
      type="button"
      onClick={handleShowMore}
      disabled={loading}
      className="discovery-register-show-more"
    >
      {loading ? (
        <>
          Finding more places
          <span className="discovery-register-loading-dots" aria-hidden="true">
            {[0, 1, 2].map((i) => <span key={i} style={{ animationDelay: `${i * 0.2}s` }} />)}
          </span>
        </>
      ) : 'Show more'}
    </button>
  ) : null;

  return (
    <MotionConfig reducedMotion="user">
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
      {/* Compact committed destination header */}
      <div className="discovery-register-header">
        <button
          onClick={onClose}
          aria-label="Close discovery panel"
          className="discovery-register-icon-button"
        >
          <X size={17} aria-hidden="true" />
        </button>

        {destinationEditing ? (
          <div className="discovery-destination-editor">
          <input
            ref={destinationInputRef}
            type="text"
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleDiscover()}
            onFocus={() => setInputFocused(true)}
            onBlur={() => setInputFocused(false)}
            placeholder="Destination"
            aria-label="Destination"
            style={{
              flex: 1,
              minWidth: 0,
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
        ) : (
          <div className="discovery-committed-destination">
            <span className="discovery-register-city">
              {committedDestination.trim() || defaultDestination}
            </span>
            {totalCount > 0 && (
              <span className="discovery-register-count">
                {totalCount} curated {totalCount === 1 ? 'place' : 'places'}
              </span>
            )}
            <button
              type="button"
              className="discovery-register-change"
              onClick={() => {
                setDestination(committedDestination);
                setDestinationEditing(true);
              }}
            >
              Change
            </button>
          </div>
        )}

        <button
          type="button"
          onClick={handleSurpriseMe}
          disabled={loading && !anyResults}
          aria-label="Surprise me"
          className="discovery-register-surprise"
        >
          <Sparkles size={15} aria-hidden="true" />
          <span className="discovery-register-surprise-label">Surprise me</span>
        </button>
      </div>

      {/* Category and search controls */}
      <div className="discovery-register-controls">
        <div className="discovery-register-tabs">
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
              onClick={() => handleCategorySelect(key)}
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

        {anyResults && !mobileSearchExpanded && (
          <button
            type="button"
            className="discovery-mobile-search-trigger"
            aria-label="Search"
            onClick={() => setMobileSearchExpanded(true)}
          >
            <Search size={17} aria-hidden="true" />
          </button>
        )}

        {anyResults && mobileSearchExpanded && (
          <div className="discovery-mobile-search-field">
          <input
            type="text"
            value={searchQuery}
            onChange={handleSearchQueryChange}
            placeholder="Find a place…"
            autoFocus
            style={{
              width: '100%',
              minWidth: 0,
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
            <button type="button" aria-label="Clear search" onClick={clearSearch}>
              <X size={15} aria-hidden="true" />
            </button>
          </div>
        )}

        {anyResults && (
          <div className="discovery-desktop-search-field">
            <input
              type="text"
              value={searchQuery}
              onChange={handleSearchQueryChange}
              aria-label="Search places"
            />
            {searchQuery && !mobileSearchExpanded && (
              <button type="button" aria-label="Clear desktop search" onClick={clearSearch}>
                <X size={15} aria-hidden="true" />
              </button>
            )}
          </div>
        )}
      </div>

      {/* Content area */}
      <div
        ref={resultsScrollerRef}
        role="region"
        aria-label="Discovery results"
        className="discovery-register-results"
      >
        {error && (
          <p style={{
            fontFamily: "'DM Mono', monospace",
            fontSize: 11, color: '#e05a5a',
            letterSpacing: '0.08em', textAlign: 'center', marginTop: 40,
          }}>
            Couldn’t load places right now. Please try again.
          </p>
        )}

        {!error && isSearching && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
            {searchMatches.length > 0 && (
              <SuggestionGrid
                items={searchMatches}
                days={days}
                destination={committedDestination}
                onAddToDay={handleAddToDay}
                onReport={handleReportPlace}
                onOpenCopilot={onOpenCopilot}
                selectedDetailKey={selectedDetailKey}
                onDetailSelection={setSelectedDetailKey}
                scopeKey={`search:${searchQuery.trim().toLowerCase()}`}
              />
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
            onOpenCopilot={onOpenCopilot}
            selectedDetailKey={selectedDetailKey}
            onDetailSelection={setSelectedDetailKey}
            showMore={showMoreTile}
            scopeKey={`category:${activeCategory}`}
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
                    onOpenCopilot={onOpenCopilot}
                    selectedDetailKey={selectedDetailKey}
                    onDetailSelection={setSelectedDetailKey}
                    showMore={cat === lastMoreCategory ? showMoreTile : null}
                    scopeKey={`more:${cat}`}
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
                  onOpenCopilot={onOpenCopilot}
                  detailsOpen={selectedDetailKey === suggestionDetailKey(surprisePick)}
                  onDetailsChange={(open) => setSelectedDetailKey(open ? suggestionDetailKey(surprisePick) : null)}
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

      </motion.div>
    </MotionConfig>
  );
}
