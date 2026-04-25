import { formatTime, formatShortDate } from './bookingCardUtils.js';
import TicketStubCard from './TicketStubCard.jsx';

// Abbreviates a station name to fit the ticket-stub hero slot.
// "Chengdu East" → "CHENGDU E." at text-4xl is ~120px on mobile.
function abbreviateStation(name) {
  if (!name) return '—';
  const words = name.trim().split(/\s+/);
  if (words.length === 1) return words[0].toUpperCase();
  // First word full + first letter of remainder words
  const first = words[0];
  const rest = words.slice(1).map((w) => w[0].toUpperCase()).join('');
  return `${first.toUpperCase()} ${rest}.`;
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
    ? `${originCity.toUpperCase()} → ${destCity.toUpperCase()}${trainNumber ? ` · ${trainNumber}` : ''}`
    : booking.title;

  return (
    <TicketStubCard
      eyebrow={eyebrow}
      leftCode={abbreviateStation(originStation)}
      leftCodeSize="text-2xl sm:text-3xl lg:text-4xl"
      centerGlyph={trainNumber}
      rightCode={abbreviateStation(destStation)}
      rightCodeSize="text-2xl sm:text-3xl lg:text-4xl"
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
