import { formatTime, formatShortDate, tzAbbr, costLineText } from './bookingCardUtils.js';
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

  const originTz = booking.originTz || null;
  const destTz   = booking.destinationTz || null;

  const routeLabel = originStation && destStation
    ? `${formatStationName(originStation)} to ${formatStationName(destStation)}`
    : booking.title;

  return (
    <TicketStubCard
      cardClassName="logistics-transit-card-wide"
      ariaLabel={`Train booking: ${routeLabel}. Opens details.`}
      eyebrow={eyebrow}
      leftCode={formatStationName(originStation)}
      leftCodeClassName="logistics-route-code-station"
      centerGlyph={trainNumber}
      rightCode={formatStationName(destStation)}
      rightCodeClassName="logistics-route-code-station"
      leftTime={formatTime(booking.startDatetime, originTz)}
      rightTime={formatTime(booking.endDatetime, destTz)}
      leftLabel="DEPART"
      rightLabel="ARRIVE"
      leftDate={formatShortDate(booking.startDatetime, originTz)}
      rightDate={formatShortDate(booking.endDatetime, destTz)}
      leftTzBadge={tzAbbr(originTz, booking.startDatetime)}
      rightTzBadge={tzAbbr(destTz, booking.endDatetime)}
      footerLeft={seatClass ? seatClass.toUpperCase() : (booking.confirmationRef ? 'BOOKING REF' : undefined)}
      footerRight={booking.confirmationRef || undefined}
      costLine={costLineText(booking.expenseSummary)}
      connector
      hasDocuments={booking.documents?.length > 0}
      onClick={() => onOpen(booking)}
    />
  );
}
