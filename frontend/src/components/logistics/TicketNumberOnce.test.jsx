// @vitest-environment jsdom
import { describe, expect, it, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import FlightBookingCard from './FlightBookingCard.jsx';
import TrainBookingCard from './TrainBookingCard.jsx';

afterEach(cleanup);

const noop = () => {};
const base = { startDatetime: '2099-03-01T08:00', endDatetime: '2099-03-01T16:00', documents: [] };

// The number sits between the codes, as on a boarding pass; the eyebrow never repeats it.
describe('a ticket card prints its flight or train number once', () => {
  it('flight: eyebrow names the airline, the centre carries the number', () => {
    const { container } = render(<FlightBookingCard onOpen={noop} booking={{
      ...base, id: 'f', type: 'flight', title: 'SQ 832', origin: 'SIN', destination: 'PVG',
      detailsJson: { carrierCode: 'SQ', flightNumber: '832', airlineName: 'Singapore Airlines' },
    }} />);
    expect(container.querySelector('.logistics-eyebrow').textContent).toBe('SINGAPORE AIRLINES');
    expect(container.querySelector('.logistics-route-center').textContent).toBe('SQ 832');
  });

  it('flight without an airline name: eyebrow says Flight, not the number again', () => {
    const { container } = render(<FlightBookingCard onOpen={noop} booking={{
      ...base, id: 'f', type: 'flight', title: 'SQ 832', origin: 'SIN', destination: 'PVG',
      detailsJson: { carrierCode: 'SQ', flightNumber: '832' },
    }} />);
    expect(container.querySelector('.logistics-eyebrow').textContent).toBe('Flight');
    expect(container.querySelector('.logistics-route-center').textContent).toBe('SQ 832');
  });

  it('train: eyebrow names the route, the centre carries the number', () => {
    const { container } = render(<TrainBookingCard onOpen={noop} booking={{
      ...base, id: 't', type: 'train', title: 'G8501',
      detailsJson: { originCity: 'Chengdu', destinationCity: 'Chongqing', trainNumber: 'G8501' },
    }} />);
    expect(container.querySelector('.logistics-eyebrow').textContent).toBe('CHENGDU → CHONGQING');
    expect(container.querySelector('.logistics-route-center').textContent).toBe('G8501');
  });
});
