import { iataFromOriginString, formatTime, formatShortDate } from './bookingCardUtils.js';
import TicketStubCard from './TicketStubCard.jsx';

export default function FlightBookingCard({ booking, onOpen }) {
  const dj = booking.detailsJson || {};

  const originIata =
    dj.providerPayload?.departure?.airport?.iata ||
    iataFromOriginString(booking.origin);
  const destIata =
    dj.providerPayload?.arrival?.airport?.iata ||
    iataFromOriginString(booking.destination);

  const carrierCode = dj.carrierCode || '';
  const flightNumber = dj.flightNumber || '';
  const airlineName = dj.airlineName || '';

  const eyebrow = airlineName
    ? `${airlineName.toUpperCase()} · ${carrierCode}${flightNumber}`
    : booking.title;

  const centerGlyph = carrierCode && flightNumber
    ? `${carrierCode} ${flightNumber}`
    : booking.title;

  const leftTime = formatTime(booking.startDatetime);
  const rightTime = formatTime(booking.endDatetime);
  const leftDate = formatShortDate(booking.startDatetime);
  const rightDate = formatShortDate(booking.endDatetime);

  // Depart label includes the IATA for clarity (matches boarding-pass convention).
  const leftLabel = originIata ? `DEPART · ${originIata}` : 'DEPART';
  const rightLabel = destIata ? `ARRIVE · ${destIata}` : 'ARRIVE';

  // Graceful degradation: no times from lookup → show departure date instead.
  const hasTimes = leftTime || rightTime;

  return (
    <TicketStubCard
      eyebrow={eyebrow}
      leftCode={originIata || '—'}
      rightCode={destIata || '—'}
      centerGlyph={centerGlyph}
      leftTime={hasTimes ? leftTime : (dj.departureDate || '')}
      rightTime={hasTimes ? rightTime : ''}
      leftLabel={hasTimes ? leftLabel : 'DEPARTURE DATE'}
      rightLabel={hasTimes ? rightLabel : ''}
      leftDate={hasTimes ? leftDate : ''}
      rightDate={hasTimes ? rightDate : ''}
      footerLeft={booking.confirmationRef ? 'BOOKING REF' : undefined}
      footerRight={booking.confirmationRef || undefined}
      connector
      onClick={() => onOpen(booking)}
    />
  );
}
