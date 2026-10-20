// @vitest-environment jsdom
import { describe, expect, it, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import FlightBookingCard from './FlightBookingCard.jsx';
import TrainBookingCard from './TrainBookingCard.jsx';
import HotelBookingCard from './HotelBookingCard.jsx';
import OtherBookingCard from './OtherBookingCard.jsx';
import TicketStubCard from './TicketStubCard.jsx';

afterEach(cleanup);

const noop = () => {};

const flight = {
  id: 'f1', type: 'flight', title: 'SQ 12', confirmationRef: 'ABC123',
  origin: 'SIN', destination: 'NRT',
  startDatetime: '2099-03-01T08:00', endDatetime: '2099-03-01T16:00',
  originTz: 'Asia/Singapore', destinationTz: 'Asia/Tokyo',
  detailsJson: { carrierCode: 'SQ', flightNumber: '12', airlineName: 'Singapore Airlines' },
  documents: [],
};
const train = {
  id: 't1', type: 'train', title: 'Shinkansen', confirmationRef: 'TR789',
  origin: 'Tokyo', destination: 'Kyoto',
  startDatetime: '2099-03-02T09:00', endDatetime: '2099-03-02T11:15',
  originTz: 'Asia/Tokyo', destinationTz: 'Asia/Tokyo',
  detailsJson: { originStation: 'Tokyo', destinationStation: 'Kyoto', trainNumber: 'N700', seatClass: 'Green' },
  documents: [],
};
const hotel = {
  id: 'h1', type: 'hotel', title: 'Park Hyatt', confirmationRef: 'HT1',
  startDatetime: '2099-03-01T15:00', endDatetime: '2099-03-04T11:00', originTz: 'Asia/Tokyo',
  documents: [],
};
const other = {
  id: 'o1', type: 'activity', title: 'Teamlab Tickets', confirmationRef: 'OT1',
  startDatetime: '2099-03-03T10:00', destination: 'Toyosu', originTz: 'Asia/Tokyo',
  documents: [],
};

const fact = (id, kind, at, label, value) => ({ id, kind, at, label, value });
const facts = [
  fact('w1', 'window', '2099-03-01T15:00', 'Check-in time', 'Check-in from 3:00 PM'),
  fact('d2', 'deadline', '2099-02-20T23:59', 'Cancel free until', 'Free cancellation until 20 Feb'),
  fact('d1', 'deadline', '2099-02-10', 'Pay balance by', 'Balance due 10 Feb'),
  fact('d0', 'deadline', '2000-01-01', 'Old deadline', 'Already passed'),
  fact('i1', 'instruction', null, 'Late arrival', 'Call ahead if after 10 PM'),
  fact('c1', 'contact', null, 'Front desk', '+81 3 0000 0000'),
];
const otherKindsOnly = facts.filter((f) => f.kind !== 'deadline' && f.kind !== 'window');

const cases = [
  ['flight', (p) => <FlightBookingCard booking={flight} onOpen={noop} {...p} />, 'Flight booking: SIN to NRT.'],
  ['train', (p) => <TrainBookingCard booking={train} onOpen={noop} {...p} />, 'Train booking: TOKYO to KYOTO.'],
  ['hotel', (p) => <HotelBookingCard booking={hotel} onOpen={noop} {...p} />, 'Hotel booking: Park Hyatt.'],
  ['other', (p) => <OtherBookingCard booking={other} onOpen={noop} {...p} />, 'ACTIVITY booking: Teamlab Tickets.'],
];

describe.each(cases)('%s card conditions', (_name, renderCard, base) => {
  it('shows the next deadline, then the first window, and nothing else', () => {
    const { container } = render(renderCard({ facts }));
    const zone = container.querySelector('.logistics-conditions');
    expect(zone).toBeInTheDocument();
    const labels = [...zone.querySelectorAll('.logistics-conditions-label')].map((n) => n.textContent);
    const values = [...zone.querySelectorAll('.logistics-conditions-value')].map((n) => n.textContent);
    expect(labels).toEqual(['Pay balance by', 'Check-in time']);
    expect(values).toEqual(['10 Feb', 'Check-in from 3:00 PM']);
    expect(zone.textContent).not.toContain('Late arrival');
    expect(zone.textContent).not.toContain('Already passed');
  });

  it('adds the lines to the aria-label', () => {
    render(renderCard({ facts }));
    expect(screen.getByRole('button')).toHaveAttribute(
      'aria-label',
      `${base} Pay balance by: 10 Feb. Check-in time: Check-in from 3:00 PM. Opens details.`,
    );
  });

  it('renders no zone and the original aria-label without facts', () => {
    for (const props of [{}, { facts: [] }, { facts: otherKindsOnly }]) {
      const { container, unmount } = render(renderCard(props));
      expect(container.querySelector('.logistics-conditions')).toBeNull();
      expect(screen.getByRole('button')).toHaveAttribute('aria-label', `${base} Opens details.`);
      unmount();
    }
  });

  it('keeps the card button as the sole root element', () => {
    const { container } = render(renderCard({ facts }));
    expect(container.children).toHaveLength(1);
    expect(container.firstElementChild.tagName).toBe('BUTTON');
  });
});

describe('ticket card layout', () => {
  it.each([
    ['flight', <FlightBookingCard key="f" booking={flight} facts={facts} onOpen={noop} />],
    ['train', <TrainBookingCard key="t" booking={train} facts={facts} onOpen={noop} />],
  ])('%s: zone sits between the time grid and the footer', (_n, ui) => {
    const { container } = render(ui);
    const body = container.querySelector('.logistics-transit-body');
    const zone = body.querySelector('.logistics-conditions-transit');
    const footer = body.querySelector('.logistics-transit-footer');
    expect(zone.parentElement).toBe(body);
    expect(footer.parentElement).toBe(body);
    expect(body.querySelector('.logistics-time-grid').nextElementSibling).toBe(zone);
    expect(zone.nextElementSibling).toBe(footer);
    expect(footer.firstElementChild).toHaveClass('logistics-footer-line');
  });

  it('a ticket with no footer ends on the zone', () => {
    const { container } = render(
      <TicketStubCard
        eyebrow="EYEBROW" leftCode="AAA" rightCode="BBB" leftTime="08:00" rightTime="09:00"
        conditions={[{ key: 'c', label: 'Check-in closes', value: '60 minutes before departure' }]}
        onClick={noop}
      />,
    );
    const body = container.querySelector('.logistics-transit-body');
    expect(body.querySelector('.logistics-transit-footer')).toBeNull();
    expect(body.lastElementChild).toHaveClass('logistics-conditions');
  });
});

describe('dossier card layout', () => {
  it.each([
    ['hotel', <HotelBookingCard key="h" booking={hotel} facts={facts} onOpen={noop} />],
    ['other', <OtherBookingCard key="o" booking={other} facts={facts} onOpen={noop} />],
  ])('%s: zone is the last element, right after the rows', (_n, ui) => {
    const { container } = render(ui);
    const button = container.querySelector('button');
    const zone = button.querySelector('.logistics-conditions-dossier');
    expect(button.lastElementChild).toBe(zone);
    expect(zone.previousElementSibling).toHaveClass('logistics-card-rows');
    expect(zone.querySelector('.logistics-data-row')).toBeNull();
  });
});
