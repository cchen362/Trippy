import { useMemo, useState } from 'react';
import AddBookingModal from '../components/logistics/AddBookingModal.jsx';
import FlightBookingCard from '../components/logistics/FlightBookingCard.jsx';
import TrainBookingCard from '../components/logistics/TrainBookingCard.jsx';
import HotelBookingCard from '../components/logistics/HotelBookingCard.jsx';
import OtherBookingCard from '../components/logistics/OtherBookingCard.jsx';
import { useTripContext } from './TripPage.jsx';

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

export default function LogisticsTab() {
  const {
    bookings,
    createBooking,
    updateBooking,
    deleteBooking,
    saving,
    lookupHotels,
    lookupHotelDetails,
    lookupFlight,
    lookupCities,
  } = useTripContext();

  const [addOpen, setAddOpen] = useState(false);
  const [selectedBooking, setSelectedBooking] = useState(null);
  const [editing, setEditing] = useState(null);

  const grouped = useMemo(() => groupBookings(bookings), [bookings]);

  return (
    <div className="space-y-8">
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
            {bookings.length} bookings across {new Set(bookings.map((b) => b.bookingSource).filter(Boolean)).size || 1} sources.
          </p>
        </div>

        <button
          type="button"
          onClick={() => setAddOpen(true)}
          className="px-5 py-4 rounded-2xl font-mono text-xs tracking-[0.28em] uppercase"
          style={{ background: 'var(--gold)', color: 'var(--ink-deep)' }}
        >
          + Add Booking
        </button>
      </section>

      {/* Per-type sections */}
      {['flight', 'train', 'hotel', 'other'].map((section) => (
        grouped[section].length > 0 && (
          <section key={section}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-mono text-[11px] tracking-[0.28em] uppercase" style={{ color: 'var(--cream-mute)' }}>
                {section === 'other' ? 'Other' : `${section}s`}
              </h3>
              <span className="font-mono text-[11px] tracking-[0.22em] uppercase" style={{ color: 'var(--cream-mute)' }}>
                {grouped[section].length}
              </span>
            </div>
            {/* Ticket cards (flight/train) span full width; hotel pairs 2-up on lg+ */}
            <div className={section === 'hotel' ? 'grid lg:grid-cols-2 gap-4' : 'grid grid-cols-1 gap-4'}>
              {grouped[section].map((booking) => {
                const Card = CARD_BY_TYPE[booking.type] || OtherBookingCard;
                return <Card key={booking.id} booking={booking} onOpen={setSelectedBooking} />;
              })}
            </div>
          </section>
        )
      ))}

      {/* Detail sheet */}
      {selectedBooking && (
        <div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-4">
          <div className="w-full max-w-xl rounded-[22px] border p-6" style={{ background: 'var(--ink-surface)', borderColor: 'var(--ink-border)' }}>
            <div className="flex items-start justify-between gap-4 mb-5">
              <div>
                <p className="font-mono text-[11px] tracking-[0.28em] uppercase mb-2" style={{ color: 'var(--gold)' }}>
                  {selectedBooking.type}
                </p>
                <h3 className="font-display italic text-3xl" style={{ color: 'var(--cream)' }}>
                  {selectedBooking.title}
                </h3>
              </div>
              <button type="button" onClick={() => setSelectedBooking(null)} className="font-mono text-xs tracking-[0.22em] uppercase" style={{ color: 'var(--cream-dim)' }}>
                Close
              </button>
            </div>

            <div className="space-y-3 font-body text-lg" style={{ color: 'var(--cream-dim)' }}>
              {selectedBooking.startDatetime && <p><span className="font-mono text-xs tracking-[0.22em] uppercase" style={{ color: 'var(--cream-mute)' }}>Start</span><br />{selectedBooking.startDatetime.replace('T', ' ')}</p>}
              {selectedBooking.endDatetime && <p><span className="font-mono text-xs tracking-[0.22em] uppercase" style={{ color: 'var(--cream-mute)' }}>End</span><br />{selectedBooking.endDatetime.replace('T', ' ')}</p>}
              {selectedBooking.origin && <p><span className="font-mono text-xs tracking-[0.22em] uppercase" style={{ color: 'var(--cream-mute)' }}>Origin</span><br />{selectedBooking.origin}</p>}
              {selectedBooking.destination && <p><span className="font-mono text-xs tracking-[0.22em] uppercase" style={{ color: 'var(--cream-mute)' }}>Destination</span><br />{selectedBooking.destination}</p>}
              {selectedBooking.confirmationRef && <p><span className="font-mono text-xs tracking-[0.22em] uppercase" style={{ color: 'var(--cream-mute)' }}>Reference</span><br />{selectedBooking.confirmationRef}</p>}
            </div>

            <div className="mt-6 flex justify-between gap-3">
              <button
                type="button"
                onClick={() => {
                  setEditing(selectedBooking);
                  setSelectedBooking(null);
                }}
                className="modal-action"
              >
                Edit Booking
              </button>
              <button
                type="button"
                onClick={async () => {
                  await deleteBooking(selectedBooking.id);
                  setSelectedBooking(null);
                }}
                className="px-4 py-3 rounded-xl border font-mono text-xs tracking-[0.22em] uppercase"
                style={{ color: '#f8b4b4', borderColor: 'rgba(248,180,180,0.22)' }}
              >
                Delete Booking
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create modal */}
      <AddBookingModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onSubmit={createBooking}
        saving={saving}
        lookupHotels={lookupHotels}
        lookupHotelDetails={lookupHotelDetails}
        lookupFlight={lookupFlight}
        lookupCities={lookupCities}
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
    </div>
  );
}
