import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Paperclip, FileText, X } from 'lucide-react';
import AddBookingModal from '../components/logistics/AddBookingModal.jsx';
import FlightBookingCard from '../components/logistics/FlightBookingCard.jsx';
import TrainBookingCard from '../components/logistics/TrainBookingCard.jsx';
import HotelBookingCard from '../components/logistics/HotelBookingCard.jsx';
import OtherBookingCard from '../components/logistics/OtherBookingCard.jsx';
import CaptureFlow from '../components/import/CaptureFlow.jsx';
import DocumentViewer from '../components/documents/DocumentViewer.jsx';
import ErrorBanner from '../components/common/ErrorBanner.jsx';
import ExpenseSheet from '../components/expenses/ExpenseSheet.jsx';
import { categoryMeta } from '../components/expenses/categoryMeta.js';
import { bookingCostDefaults } from '../components/expenses/bookingCostDefaults.js';
import { bookingsApi } from '../services/bookingsApi.js';
import { fileToInput } from '../services/importApi.js';
import { formatMinor, currencyForCountry } from '../utils/currency.js';
import { useExpenses } from '../hooks/useExpenses.js';
import { useCollaboration } from '../hooks/useCollaboration.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useTripContext } from './TripPage.jsx';

function payerInitial(name) {
  return (name || '?').trim().charAt(0).toUpperCase();
}

const CARD_BY_TYPE = {
  flight: FlightBookingCard,
  train: TrainBookingCard,
  hotel: HotelBookingCard,
};

function groupBookings(bookings) {
  return {
    flight: bookings.filter((b) => b.type === 'flight'),
    train: bookings.filter((b) => b.type === 'train'),
    hotel: bookings.filter((b) => b.type === 'hotel'),
    other: bookings.filter((b) => !['flight', 'train', 'hotel'].includes(b.type)),
  };
}

function sectionGridClass(section) {
  if (section === 'train') return 'logistics-card-grid logistics-card-grid-wide';
  return 'logistics-card-grid logistics-card-grid-standard';
}

export default function LogisticsTab() {
  const {
    trip,
    bookings,
    activeDay,
    refresh,
    createBooking,
    updateBooking,
    deleteBooking,
    saving,
    lookupHotels,
    lookupHotelDetails,
    lookupFlight,
    lookupCities,
  } = useTripContext();

  const { user } = useAuth();
  const expensesState = useExpenses(trip.id);
  const collaboration = useCollaboration(trip.id);

  const [addOpen, setAddOpen] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [selectedBooking, setSelectedBooking] = useState(null);
  const [editing, setEditing] = useState(null);
  const [viewerDoc, setViewerDoc] = useState(null);
  const [attaching, setAttaching] = useState(false);
  const [attachError, setAttachError] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState(null);
  const [confirmDocUrl, setConfirmDocUrl] = useState(null);
  const [removingDoc, setRemovingDoc] = useState(false);
  const [expenseSheetOpen, setExpenseSheetOpen] = useState(false);
  const [editingExpense, setEditingExpense] = useState(null);
  const [addCostBookingId, setAddCostBookingId] = useState(null);
  const fileInputRef = useRef(null);
  const location = useLocation();
  const navigate = useNavigate();
  const [importBanner, setImportBanner] = useState(location.state?.bannerMessage || null);

  const defaultCurrency = currencyForCountry(activeDay?.resolvedCountry) || expensesState.summaryCurrency || 'SGD';
  const collaboratorOptions = collaboration.owner
    ? [collaboration.owner, ...collaboration.collaborators]
    : collaboration.collaborators;

  // Memoised on the booking's primitive fields, not the booking object — `bookings`
  // gets a fresh identity on every trip refresh, and ExpenseSheet resets its form when
  // `defaults` changes identity, which would wipe an in-progress edit.
  const addCostBooking = addCostBookingId ? bookings.find((x) => x.id === addCostBookingId) : null;
  const addCostDefaults = useMemo(
    () => (addCostBooking ? bookingCostDefaults(addCostBooking, user?.id) : null),
    [addCostBooking?.id, addCostBooking?.type, addCostBooking?.title, user?.id], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Clear the navigation-state flag once read so a page refresh or revisit doesn't
  // resurface the same one-time import-failure message.
  useEffect(() => {
    if (location.state?.bannerMessage) {
      navigate(location.pathname, { replace: true, state: null });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const grouped = useMemo(() => groupBookings(bookings), [bookings]);
  const sourceCount = new Set(bookings.map((b) => b.bookingSource).filter(Boolean)).size;

  // selectedBooking is a snapshot from the moment its card was tapped; re-derive from the
  // live `bookings` list so a newly attached/removed document appears without closing the sheet.
  const liveSelected = selectedBooking
    ? bookings.find((b) => b.id === selectedBooking.id) || selectedBooking
    : null;

  const closeSheet = () => {
    setSelectedBooking(null);
    setConfirmDelete(false);
    setDeleteError(null);
    setConfirmDocUrl(null);
  };

  const linkedExpenses = liveSelected
    ? expensesState.expenses.filter((e) => e.bookingId === liveSelected.id)
    : [];

  const openAddCost = () => {
    setEditingExpense(null);
    setAddCostBookingId(liveSelected.id);
    setExpenseSheetOpen(true);
  };
  const openEditExpense = (expense) => {
    setEditingExpense(expense);
    setAddCostBookingId(null);
    setExpenseSheetOpen(true);
  };
  const closeExpenseSheet = () => {
    setExpenseSheetOpen(false);
    setEditingExpense(null);
    setAddCostBookingId(null);
  };

  const handleSaveExpense = async (payload) => {
    if (editingExpense) {
      await expensesState.updateExpense(editingExpense.id, payload);
    } else {
      await expensesState.createExpense(payload);
    }
    // Booking-card badges read expenseSummary off the trip-detail payload — refresh
    // it so "Add cost" flips to "Cost · …" without a full page reload.
    await refresh();
  };

  const handleDeleteExpense = async (expenseId) => {
    await expensesState.deleteExpense(expenseId);
    await refresh();
    closeExpenseSheet();
  };

  const handleCreateBooking = async (data) => {
    const result = await createBooking(data);
    // A composite create wrote an expense the local store hasn't seen — the trip
    // refresh inside createBooking only carries the booking-card badge.
    if (data.cost) await expensesState.refresh();
    return result;
  };

  const handleDeleteBooking = async () => {
    setDeleteError(null);
    try {
      await deleteBooking(liveSelected.id);
      closeSheet();
    } catch (err) {
      setDeleteError(err.message || 'Could not delete this booking.');
      setConfirmDelete(false);
    }
  };

  async function handleAttach(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !liveSelected) return;

    setAttachError(null);
    setAttaching(true);
    try {
      const input = await fileToInput(file);
      await bookingsApi.addAttachment(liveSelected.id, input);
      await refresh();
    } catch (err) {
      setAttachError(err.message);
    } finally {
      setAttaching(false);
    }
  }

  async function handleRemoveAttachment(doc) {
    setDeleteError(null);
    setRemovingDoc(true);
    try {
      const attachmentId = doc.url.split('/').pop();
      await bookingsApi.removeAttachment(liveSelected.id, attachmentId);
      setConfirmDocUrl(null);
      await refresh();
    } catch (err) {
      setDeleteError(err.message || 'Could not remove this document.');
      setConfirmDocUrl(null);
    } finally {
      setRemovingDoc(false);
    }
  }

  return (
    <div className="space-y-8">
      <ErrorBanner message={importBanner} onDismiss={() => setImportBanner(null)} />

      {/* Header */}
      <section className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
        <div>
          <p className="font-mono text-[11px] tracking-[0.3em] uppercase mb-2" style={{ color: 'var(--gold)' }}>
            Logistics
          </p>
          <h2 className="font-display italic text-5xl mb-2" style={{ color: 'var(--cream)' }}>
            Your bookings
          </h2>
          <p className="font-body text-xl" style={{ color: 'var(--cream-dim)' }}>
            {bookings.length === 0
              ? 'No bookings yet — add one to get started.'
              : sourceCount === 0
                ? `${bookings.length} booking${bookings.length === 1 ? '' : 's'}.`
                : `${bookings.length} booking${bookings.length === 1 ? '' : 's'} across ${sourceCount} source${sourceCount === 1 ? '' : 's'}.`}
          </p>
        </div>

        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
          <button
            type="button"
            onClick={() => setCaptureOpen(true)}
            className="px-5 py-4 rounded-2xl font-mono text-xs tracking-[0.28em] uppercase"
            style={{ background: 'transparent', color: 'var(--gold)', border: '1px solid rgba(201,168,76,0.45)' }}
          >
            Import confirmations
          </button>
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="px-5 py-4 rounded-2xl font-mono text-xs tracking-[0.28em] uppercase"
            style={{ background: 'transparent', color: 'var(--cream-dim)', border: '1px solid rgba(240,234,216,0.14)' }}
          >
            Enter manually
          </button>
        </div>
      </section>

      {/* Per-type sections */}
      {['flight', 'hotel', 'other', 'train'].map((section) => (
        grouped[section].length > 0 && (
          <section key={section}>
            <div className="mb-4">
              <h3 className="font-mono text-[11px] tracking-[0.28em] uppercase" style={{ color: 'var(--cream-mute)' }}>
                {section === 'other' ? 'Other' : `${section}s`}
                <span style={{ color: 'var(--cream-dim)' }}> &middot; {grouped[section].length}</span>
              </h3>
            </div>
            <div className={sectionGridClass(section)}>
              {grouped[section].map((booking) => {
                const Card = CARD_BY_TYPE[booking.type] || OtherBookingCard;
                return <Card key={booking.id} booking={booking} onOpen={setSelectedBooking} />;
              })}
            </div>
          </section>
        )
      ))}

      {/* Detail sheet */}
      {liveSelected && (
        <div className="fixed inset-0 z-[110] bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-4">
          <div className="w-full max-w-xl rounded-[22px] border p-6 max-h-[85vh] overflow-y-auto" style={{ background: 'var(--ink-surface)', borderColor: 'var(--ink-border)' }}>
            <div className="flex items-start justify-between gap-4 mb-5">
              <div>
                <p className="font-mono text-[11px] tracking-[0.28em] uppercase mb-2" style={{ color: 'var(--gold)' }}>
                  {liveSelected.type}
                </p>
                <h3 className="font-display italic text-3xl" style={{ color: 'var(--cream)' }}>
                  {liveSelected.title}
                </h3>
              </div>
              <button type="button" onClick={closeSheet} className="font-mono text-xs tracking-[0.22em] uppercase" style={{ color: 'var(--cream-dim)' }}>
                Close
              </button>
            </div>

            <div className="space-y-3 font-body text-lg" style={{ color: 'var(--cream-dim)' }}>
              {liveSelected.startDatetime && <p><span className="font-mono text-xs tracking-[0.22em] uppercase" style={{ color: 'var(--cream-mute)' }}>Start</span><br />{liveSelected.startDatetime.replace('T', ' ')}</p>}
              {liveSelected.endDatetime && <p><span className="font-mono text-xs tracking-[0.22em] uppercase" style={{ color: 'var(--cream-mute)' }}>End</span><br />{liveSelected.endDatetime.replace('T', ' ')}</p>}
              {liveSelected.origin && <p><span className="font-mono text-xs tracking-[0.22em] uppercase" style={{ color: 'var(--cream-mute)' }}>Origin</span><br />{liveSelected.origin}</p>}
              {liveSelected.destination && <p><span className="font-mono text-xs tracking-[0.22em] uppercase" style={{ color: 'var(--cream-mute)' }}>Destination</span><br />{liveSelected.destination}</p>}
              {liveSelected.confirmationRef && <p><span className="font-mono text-xs tracking-[0.22em] uppercase" style={{ color: 'var(--cream-mute)' }}>Reference</span><br />{liveSelected.confirmationRef}</p>}
            </div>

            {liveSelected.documents?.length > 0 && (
              <div className="mt-4">
                <p className="font-mono text-xs tracking-[0.22em] uppercase mb-2" style={{ color: 'var(--cream-mute)' }}>Documents</p>
                <div className="flex flex-wrap gap-2">
                  {liveSelected.documents.map((doc, i) => (
                    <div key={doc.url} className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setViewerDoc(doc)}
                        className="px-3 py-2 rounded-lg border font-mono text-[11px] tracking-[0.18em] uppercase flex items-center gap-2"
                        style={{ borderColor: 'var(--ink-border)', color: 'var(--cream-dim)' }}
                      >
                        <FileText size={14} />
                        {doc.filename || (doc.mediaType === 'application/pdf' ? `Document ${i + 1}` : `Photo ${i + 1}`)}
                      </button>
                      {doc.source === 'attachment' && (
                        confirmDocUrl === doc.url ? (
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => setConfirmDocUrl(null)}
                              className="font-mono text-[11px] tracking-[0.18em] uppercase"
                              style={{ color: 'var(--cream-dim)' }}
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              onClick={() => handleRemoveAttachment(doc)}
                              disabled={removingDoc}
                              className="px-2 py-2 rounded-lg border font-mono text-[11px] tracking-[0.18em] uppercase"
                              style={{ color: '#e05a5a', borderColor: 'rgba(224,90,90,0.28)', opacity: removingDoc ? 0.6 : 1 }}
                            >
                              {removingDoc ? 'Removing…' : 'Confirm?'}
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            aria-label={`Remove ${doc.filename || `Document ${i + 1}`}`}
                            onClick={() => { setDeleteError(null); setConfirmDocUrl(doc.url); }}
                            className="px-2 py-2 rounded-lg border font-mono text-[11px]"
                            style={{ color: '#e05a5a', borderColor: 'rgba(224,90,90,0.28)' }}
                          >
                            <X size={12} />
                          </button>
                        )
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-4">
              <p className="font-mono text-xs tracking-[0.22em] uppercase mb-2" style={{ color: 'var(--cream-mute)' }}>Costs</p>
              {linkedExpenses.length > 0 && (
                <ul className="space-y-2 mb-3">
                  {linkedExpenses.map((expense) => (
                    <li key={expense.id}>
                      <button
                        type="button"
                        onClick={() => openEditExpense(expense)}
                        className="w-full flex items-center gap-3 text-left"
                      >
                        <span className="min-w-0 flex-1 font-body text-base truncate" style={{ color: 'var(--cream)' }}>
                          {expense.title || categoryMeta(expense.category).label}
                        </span>
                        <span className="shrink-0 font-mono text-sm" style={{ color: 'var(--cream)' }}>
                          {formatMinor(expense.amount, expense.currency)}
                        </span>
                        <span
                          className="w-6 h-6 shrink-0 rounded-full flex items-center justify-center font-mono text-[10px]"
                          style={{ background: 'var(--ink-mid)', color: 'var(--cream-dim)' }}
                          title={expense.payerName}
                        >
                          {payerInitial(expense.payerName)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <button
                type="button"
                onClick={openAddCost}
                className="px-3 py-2 rounded-lg border font-mono text-[11px] tracking-[0.18em] uppercase"
                style={{ borderColor: 'var(--ink-border)', color: 'var(--cream-dim)' }}
              >
                {linkedExpenses.length > 0 ? 'Add another cost' : 'Add cost'}
              </button>
            </div>

            {attachError && (
              <p className="mt-3 font-body text-sm" style={{ color: '#e05a5a' }}>{attachError}</p>
            )}

            {deleteError && (
              <p className="mt-3 font-body text-sm" style={{ color: '#e05a5a' }}>{deleteError}</p>
            )}

            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,application/pdf"
              onChange={handleAttach}
              className="sr-only"
            />

            <div className="mt-6 flex flex-wrap justify-between gap-3">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={attaching}
                className="px-4 py-3 rounded-xl border font-mono text-xs tracking-[0.22em] uppercase flex items-center gap-2"
                style={{ color: 'var(--cream-dim)', borderColor: 'var(--ink-border)' }}
              >
                <Paperclip size={14} />
                {attaching ? 'Attaching…' : 'Attach'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditing(liveSelected);
                  setSelectedBooking(null);
                }}
                className="modal-action"
              >
                Edit Booking
              </button>
              {confirmDelete ? (
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(false)}
                    className="font-mono text-xs tracking-[0.22em] uppercase"
                    style={{ color: 'var(--cream-dim)' }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleDeleteBooking}
                    disabled={saving}
                    className="px-4 py-3 rounded-xl border font-mono text-xs tracking-[0.22em] uppercase"
                    style={{ color: '#e05a5a', borderColor: 'rgba(224,90,90,0.28)', opacity: saving ? 0.6 : 1 }}
                  >
                    {saving ? 'Deleting…' : 'Confirm?'}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => { setDeleteError(null); setConfirmDelete(true); }}
                  className="px-4 py-3 rounded-xl border font-mono text-xs tracking-[0.22em] uppercase"
                  style={{ color: '#e05a5a', borderColor: 'rgba(224,90,90,0.28)' }}
                >
                  Delete Booking
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <DocumentViewer document={viewerDoc} onClose={() => setViewerDoc(null)} />

      <ExpenseSheet
        open={expenseSheetOpen}
        onClose={closeExpenseSheet}
        expense={editingExpense}
        defaultCurrency={defaultCurrency}
        currentUserId={user?.id}
        collaborators={collaboratorOptions}
        bookings={bookings}
        allExpenses={expensesState.expenses}
        fixedBookingId={addCostBookingId}
        defaults={addCostDefaults}
        saving={expensesState.saving}
        onSave={handleSaveExpense}
        onDelete={handleDeleteExpense}
      />

      {/* Create modal */}
      <AddBookingModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onSubmit={handleCreateBooking}
        saving={saving}
        lookupHotels={lookupHotels}
        lookupHotelDetails={lookupHotelDetails}
        lookupFlight={lookupFlight}
        lookupCities={lookupCities}
        defaultCostCurrency={defaultCurrency}
      />

      {/* Edit modal — keyed on booking.id so React remounts (and resets form) when target changes */}
      {editing && (
        <AddBookingModal
          key={editing.id}
          open
          onClose={() => setEditing(null)}
          onSubmit={(data) => updateBooking(editing.id, data)}
          saving={saving}
          lookupHotels={lookupHotels}
          lookupHotelDetails={lookupHotelDetails}
          lookupFlight={lookupFlight}
          lookupCities={lookupCities}
          booking={editing}
        />
      )}

      {/* Capture flow — conditional mount so state resets cleanly every time it reopens */}
      {captureOpen && (
        <CaptureFlow
          open={captureOpen}
          onClose={() => setCaptureOpen(false)}
          tripId={trip.id}
          tripDates={{ startDate: trip.startDate, endDate: trip.endDate }}
          onConfirmed={async () => {
            await refresh();
            setCaptureOpen(false);
          }}
          lookupHotels={lookupHotels}
          lookupHotelDetails={lookupHotelDetails}
          lookupFlight={lookupFlight}
          lookupCities={lookupCities}
        />
      )}
    </div>
  );
}
