// @vitest-environment jsdom
import { describe, expect, it, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '@testing-library/jest-dom/vitest';
import TripCard from './TripCard.jsx';

afterEach(() => {
  cleanup();
});

const baseTrip = {
  id: 'trip-1',
  title: 'Taiwan Loop',
  destinations: ['Taipei', 'Kaohsiung'],
  destinationsGeo: [],
  startDate: '2026-08-01',
  endDate: '2026-08-10',
};

function renderCard(trip) {
  return render(
    <MemoryRouter>
      <TripCard trip={trip} />
    </MemoryRouter>
  );
}

describe('TripCard', () => {
  it('renders "Active now" and a live dot for an active trip', () => {
    const { container, getByText } = renderCard({ ...baseTrip, status: 'active' });
    expect(getByText('Active now')).toBeInTheDocument();
    expect(container.querySelector('.trip-live-dot')).toBeTruthy();
  });

  it('renders a countdown string for an upcoming trip', () => {
    const future = new Date();
    future.setDate(future.getDate() + 5);
    const startDate = future.toISOString().slice(0, 10);
    const { getByText } = renderCard({ ...baseTrip, status: 'upcoming', startDate });
    expect(getByText(/In \d+ (days|weeks|months)|Tomorrow/)).toBeInTheDocument();
  });

  it('renders neither "Active now" nor a countdown for a past trip, and dims the card', () => {
    const { container, queryByText } = renderCard({ ...baseTrip, status: 'past' });
    expect(queryByText('Active now')).toBeNull();
    expect(queryByText(/In \d+ (days|weeks|months)|Tomorrow/)).toBeNull();
    const link = container.querySelector('a');
    expect(link.style.opacity).toBe('0.72');
  });
});
