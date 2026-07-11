import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { dayDisplayLabel } from '../../utils/dayGeo.js';
import { unsplashService } from '../../services/unsplashService';

const monoStyle = {
  fontFamily: "'DM Mono', monospace",
  fontSize: '11px',
  letterSpacing: '0.18em',
  textTransform: 'uppercase',
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  padding: 0,
};

const noPinChipStyle = {
  marginTop: 4,
  display: 'inline-flex',
  alignItems: 'center',
  border: '1px solid rgba(224,138,58,0.42)',
  borderRadius: 999,
  background: 'rgba(224,138,58,0.12)',
  color: '#e08a3a',
  fontFamily: "'DM Mono', monospace",
  fontSize: 9,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  padding: '3px 8px',
  cursor: 'pointer',
};

// Plan 10 Wave 2 owner-approved per-scene no-image tints — each fades to
// --ink-deep (#0d0b09); gold stays accent-only and is never used as a fill.
const SCENE_TINTS = {
  temple_shrine: '#232227',
  museum_gallery: '#232227',
  landmark_architecture: '#232227',
  food_drink: '#2a1d12',
  market: '#2b1a13',
  street_neighborhood: '#2b1a13',
  nature_outdoors: '#14201a',
  viewpoint: '#14201a',
  beach_water: '#14201a',
  nightlife: '#241419',
  entertainment: '#241419',
  wellness: '#1a201d',
  hotel_stay: '#201d18',
  generic: '#241a12',
};

const TYPE_TINT_FALLBACK = {
  food: SCENE_TINTS.food_drink,
  hotel: SCENE_TINTS.hotel_stay,
};

function noImageTint(stop) {
  const top = SCENE_TINTS[stop.sceneType] || TYPE_TINT_FALLBACK[stop.type] || SCENE_TINTS.generic;
  return `linear-gradient(135deg, ${top}, #0d0b09)`;
}

export default function StopCard({ stop, expanded, onToggle, onDelete, onUpdate, days, onMove, dragHandleProps }) {
  const navigate = useNavigate();
  const [action, setAction] = useState(null); // null | 'delete' | 'move' | 'photo'
  const [noteValue, setNoteValue] = useState(stop.note || '');
  const [noteDirty, setNoteDirty] = useState(false);
  const [moving, setMoving] = useState(false);
  const [photoCandidates, setPhotoCandidates] = useState([]);
  const [photoLoading, setPhotoLoading] = useState(false);
  const [photoError, setPhotoError] = useState(false);
  const [applyingPhotoId, setApplyingPhotoId] = useState(null);
  const hasNoPin = stop.type !== 'transit' && (stop.locationStatus === 'unresolved' || stop.lat == null);

  const handleNoPinClick = (event) => {
    event.stopPropagation();
    navigate(`../map`, { relative: 'path' });
  };

  useEffect(() => {
    if (!expanded) setAction(null);
  }, [expanded]);

  useEffect(() => {
    if (!noteDirty) setNoteValue(stop.note || '');
  }, [stop.note]);

  useEffect(() => {
    if (action !== 'photo' || !expanded) {
      setPhotoCandidates([]);
      setPhotoError(false);
      setPhotoLoading(false);
      return;
    }
    let ignore = false;
    setPhotoLoading(true);
    setPhotoError(false);
    unsplashService.search(stop.photoQuery || stop.title)
      .then((data) => {
        if (ignore) return;
        const photos = (data?.photos || []).filter((p) => p.id !== stop.unsplashPhotoId).slice(0, 8);
        setPhotoCandidates(photos);
      })
      .catch(() => {
        if (ignore) return;
        setPhotoError(true);
      })
      .finally(() => {
        if (ignore) return;
        setPhotoLoading(false);
      });
    return () => { ignore = true; };
  }, [action, expanded, stop.photoQuery, stop.title, stop.unsplashPhotoId]);

  const handleNoteBlur = async () => {
    if (!noteDirty) return;
    try {
      await onUpdate(stop.id, { note: noteValue });
      setNoteDirty(false);
    } catch {
      // Failed save: keep noteDirty true so the value isn't silently discarded.
      // useStops.error is already surfaced by the shared TripPage banner.
    }
  };

  // Per-stop pending guard (Wave 4 §4.2) — disables this stop's move controls
  // for the duration of its own move request only; other stops' move/add
  // affordances are untouched, and out-of-order refreshes are already made
  // safe by the useTrip.refresh id guard (§4.1).
  const handleMoveClick = async (targetDayId) => {
    if (moving) return;
    setMoving(true);
    try {
      await onMove(stop.id, targetDayId);
    } catch (err) {
      // PlanTab's onMove already surfaces failures via the shared error
      // banner and never rethrows — this catch is only a defensive guard
      // against an unhandled rejection if a caller's contract ever changes.
      console.error('[stops] move failed:', err);
    } finally {
      setMoving(false);
    }
  };

  async function handleSelectPhoto(p) {
    if (applyingPhotoId !== null) return;
    setApplyingPhotoId(p.id);
    try {
      await onUpdate(stop.id, {
        unsplashPhotoUrl: p.url,
        unsplashPhotoId: p.id,
        photoAttribution: { photographer: p.photographer, photographerUrl: p.photographerUrl, unsplashUrl: p.unsplashUrl },
        photoQuery: stop.photoQuery || stop.title,
        photoDownloadLocation: p.downloadLocation,
      });
      setAction(null);
    } catch {
      setPhotoError(true);
    } finally {
      setApplyingPhotoId(null);
    }
  }

  const otherDays = days ? days.filter((d) => d.id !== stop.dayId) : [];
  const canMove = !stop.bookingId && otherDays.length > 0;

  return (
    <div className="relative pl-10">
      <span
        className="absolute left-[8px] top-8 w-[9px] h-[9px] rounded-full"
        style={{ background: 'var(--gold)' }}
      />
      <div
        className="timeline-card rounded-2xl overflow-hidden border"
        style={{
          borderColor: stop.isFeatured ? 'var(--gold-line)' : 'var(--ink-border)',
          minHeight: stop.isFeatured ? '180px' : '136px',
        }}
      >
        <div className="relative h-full">
          {stop.unsplashPhotoUrl ? (
            <img src={stop.unsplashPhotoUrl} alt="" className="absolute inset-0 w-full h-full object-cover" />
          ) : (
            <div className="absolute inset-0" style={{ background: noImageTint(stop) }} />
          )}
          <div className="absolute inset-0 trip-card-overlay" />
          {expanded && (
            <div
              className="absolute inset-x-0 bottom-0"
              style={{
                top: '35%',
                background: 'linear-gradient(to bottom, transparent 0%, rgba(13,11,9,0.82) 30%, rgba(13,11,9,0.88) 100%)',
                borderRadius: '0 0 16px 16px',
                pointerEvents: 'none',
              }}
            />
          )}
          <div className="relative z-10 p-4 sm:p-5 h-full flex flex-col justify-between gap-3">
            <div className="flex items-start justify-between gap-3">
              <button type="button" onClick={() => onToggle(stop.id)} className="text-left">
                <p className="font-mono text-[11px] tracking-[0.24em] uppercase mb-2" style={{ color: 'var(--gold)' }}>
                  {stop.type}
                </p>
                <h3 className="font-display italic text-2xl sm:text-[30px]" style={{ color: 'var(--cream)' }}>
                  {stop.title}
                </h3>
              </button>
              <span
                {...dragHandleProps}
                className="timeline-drag-handle cursor-grab active:cursor-grabbing"
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(2, 4px)',
                  placeContent: 'center',
                  gap: '3px',
                  minWidth: '44px',
                  minHeight: '44px',
                  margin: '-10px -10px 0 0',
                  padding: '10px',
                }}
              >
                {[...Array(6)].map((_, i) => (
                  <span key={i} style={{ width: 4, height: 4, borderRadius: '50%', background: 'rgba(240,234,216,0.3)' }} />
                ))}
              </span>
            </div>

            <div className="flex items-end justify-between gap-3">
              <div>
                <p className="font-mono text-xs tracking-[0.22em] uppercase" style={{ color: 'var(--cream-dim)' }}>
                  {stop.time || 'Flexible'}
                </p>
                {stop.duration && (
                  <p className="font-body text-base" style={{ color: 'var(--cream-dim)' }}>{stop.duration}</p>
                )}
                {hasNoPin && (
                  <button
                    type="button"
                    onClick={handleNoPinClick}
                    style={noPinChipStyle}
                  >
                    No map pin
                  </button>
                )}
              </div>
              {stop.estimatedCost && (
                <p className="font-mono text-[11px] tracking-[0.22em] uppercase" style={{ color: 'var(--cream-dim)' }}>
                  {stop.estimatedCost}
                </p>
              )}
            </div>

            {expanded && (
              <div className="pt-3 border-t" style={{ borderColor: 'rgba(240,234,216,0.14)' }}>
                <textarea
                  value={noteValue}
                  onChange={(e) => { setNoteValue(e.target.value); setNoteDirty(true); }}
                  onBlur={handleNoteBlur}
                  placeholder="Add notes, directions, tips..."
                  rows={3}
                  style={{
                    width: '100%',
                    background: 'transparent',
                    border: 'none',
                    borderBottom: '1px solid rgba(240,234,216,0.14)',
                    color: 'var(--cream-dim)',
                    fontFamily: "'Cormorant Garamond', serif",
                    fontSize: '18px',
                    lineHeight: 1.6,
                    resize: 'none',
                    outline: 'none',
                    paddingBottom: '8px',
                    marginBottom: '8px',
                  }}
                />
                <div className="mt-2 flex flex-wrap gap-2">
                  {stop.bestTime && <span className="pill">{stop.bestTime}</span>}
                  {stop.bookingRequired && <span className="pill">Booking Required</span>}
                </div>

                <div style={{ marginTop: '12px' }}>
                  {action === null && (
                    <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
                      <button type="button" onClick={() => setAction('delete')}
                        style={{ ...monoStyle, color: 'rgba(240,234,216,0.35)' }}>
                        Remove
                      </button>
                      {canMove && (
                        <button type="button" onClick={() => setAction('move')}
                          style={{ ...monoStyle, color: 'rgba(240,234,216,0.35)' }}>
                          Move to →
                        </button>
                      )}
                      {stop.type !== 'transit' && (
                        <button type="button" onClick={() => setAction('photo')}
                          style={{ ...monoStyle, color: 'rgba(240,234,216,0.35)' }}>
                          Photo →
                        </button>
                      )}
                    </div>
                  )}

                  {action === 'delete' && (
                    <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                      <button type="button" onClick={() => onDelete(stop.id)}
                        style={{ ...monoStyle, color: '#e05a5a' }}>
                        Remove?
                      </button>
                      <button type="button" onClick={() => setAction(null)}
                        style={{ ...monoStyle, color: 'rgba(240,234,216,0.35)' }}>
                        Cancel
                      </button>
                    </div>
                  )}

                  {action === 'move' && (
                    <div>
                      <p style={{
                        fontFamily: "'DM Mono', monospace",
                        fontSize: '10px',
                        letterSpacing: '0.2em',
                        textTransform: 'uppercase',
                        color: 'rgba(240,234,216,0.35)',
                        margin: '0 0 8px 0',
                      }}>
                        {moving ? 'Moving…' : 'Move to'}
                      </p>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '10px' }}>
                        {otherDays.map((day) => (
                          <button
                            key={day.id}
                            type="button"
                            onClick={() => handleMoveClick(day.id)}
                            disabled={moving}
                            style={{
                              fontFamily: "'DM Mono', monospace",
                              fontSize: '10px',
                              letterSpacing: '0.18em',
                              textTransform: 'uppercase',
                              color: 'var(--cream-dim)',
                              background: 'rgba(240,234,216,0.06)',
                              border: '1px solid rgba(240,234,216,0.15)',
                              borderRadius: '999px',
                              padding: '4px 12px',
                              cursor: moving ? 'not-allowed' : 'pointer',
                              opacity: moving ? 0.45 : 1,
                            }}
                          >
                            Day {days.indexOf(day) + 1}{dayDisplayLabel(day) ? ` · ${dayDisplayLabel(day)}` : ''}
                          </button>
                        ))}
                      </div>
                      <button type="button" onClick={() => setAction(null)} disabled={moving}
                        style={{ ...monoStyle, color: 'rgba(240,234,216,0.35)', opacity: moving ? 0.45 : 1, cursor: moving ? 'not-allowed' : 'pointer' }}>
                        Cancel
                      </button>
                    </div>
                  )}

                  {action === 'photo' && (
                    <div>
                      <p style={{
                        fontFamily: "'DM Mono', monospace",
                        fontSize: '10px',
                        letterSpacing: '0.2em',
                        textTransform: 'uppercase',
                        color: 'rgba(240,234,216,0.35)',
                        margin: '0 0 8px 0',
                      }}>
                        {photoLoading ? 'Loading…' : photoError ? 'No photos found' : 'Choose photo'}
                      </p>
                      <div style={{ display: 'flex', flexWrap: 'nowrap', overflowX: 'auto', gap: '8px', marginBottom: '10px', paddingBottom: '4px' }}>
                        {photoCandidates.map((p) => (
                          <button
                            key={p.id}
                            type="button"
                            disabled={applyingPhotoId !== null}
                            onClick={(e) => { e.stopPropagation(); handleSelectPhoto(p); }}
                            onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--gold)'; }}
                            onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'rgba(240,234,216,0.15)'; }}
                            style={{
                              flexShrink: 0,
                              width: '88px',
                              height: '64px',
                              padding: 0,
                              border: '1px solid rgba(240,234,216,0.15)',
                              borderRadius: '6px',
                              overflow: 'hidden',
                              background: 'none',
                              cursor: applyingPhotoId !== null ? 'wait' : 'pointer',
                              opacity: applyingPhotoId !== null && applyingPhotoId !== p.id ? 0.4 : 1,
                            }}
                          >
                            <img src={p.url} alt={p.alt || ''} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                          </button>
                        ))}
                      </div>
                      <button type="button" onClick={() => setAction(null)} disabled={applyingPhotoId !== null}
                        style={{ ...monoStyle, color: 'rgba(240,234,216,0.35)', opacity: applyingPhotoId !== null ? 0.45 : 1, cursor: applyingPhotoId !== null ? 'not-allowed' : 'pointer' }}>
                        Cancel
                      </button>
                    </div>
                  )}
                </div>

                {stop.unsplashPhotoUrl && stop.photoAttribution && (
                  <p
                    style={{
                      marginTop: '12px',
                      fontFamily: "'DM Mono', monospace",
                      fontSize: '9px',
                      letterSpacing: '0.2em',
                      textTransform: 'uppercase',
                      color: 'rgba(240,234,216,0.35)',
                    }}
                  >
                    PHOTO —{' '}
                    <a
                      href={stop.photoAttribution.photographerUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      style={{ color: 'inherit' }}
                    >
                      {stop.photoAttribution.photographer}
                    </a>
                    {' / '}
                    <a
                      href={stop.photoAttribution.unsplashUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      style={{ color: 'inherit' }}
                    >
                      Unsplash
                    </a>
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
