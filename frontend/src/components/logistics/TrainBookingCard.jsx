import { formatTime, formatShortDate } from './bookingCardUtils.js';
import TicketStubCard from './TicketStubCard.jsx';

function formatStationName(name) {
  if (!name) return '\u2014';
  return name.trim().toUpperCase();
}

export default function TrainBookingCard({ booking, onOpen }) {
  const dj = booking.detailsJson || {};

  const originStation = dj.originStation || booking.origin || '';
  const destStation = dj.destinationStation || booking.destination || '';
  const trainNumber = dj.trainNumber || '';
  const originCity = dj.originCity || booking.origin || '';
  const destCity = dj.destinationCity || booking.destination || '';
  const seatClass = dj.seatClass || '';

  const eyebrow = originCity && destCity
    ? `${originCity.toUpperCase()} \u2192 ${destCity.toUpperCase()}${trainNumber ? ` \u00b7 ${trainNumber}` : ''}`
    : booking.title;

  return (
    <TicketStubCard
      cardClassName="logistics-transit-card-wide"
      eyebrow={eyebrow}
      leftCode={formatStationName(originStation)}
      leftCodeSize="logistics-route-code-station"
      centerGlyph={trainNumber}
      rightCode={formatStationName(destStation)}
      rightCodeSize="logistics-route-code-station"
      leftTime={formatTime(booking.startDatetime)}
      rightTime={formatTime(booking.endDatetime)}
      leftLabel="DEPART"
      rightLabel="ARRIVE"
      leftDate={formatShortDate(booking.startDatetime)}
      rightDate={formatShortDate(booking.endDatetime)}
      footerLeft={seatClass ? seatClass.toUpperCase() : (booking.confirmationRef ? 'BOOKING REF' : undefined)}
      footerRight={booking.confirmationRef || undefined}
      connector
      onClick={() => onOpen(booking)}
    />
  );
}
