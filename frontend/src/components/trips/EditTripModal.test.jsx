// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import EditTripModal from './EditTripModal.jsx';
import { bookingsApi } from '../../services/bookingsApi.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const baseTrip = {
  id: 1,
  title: 'China Trip',
  startDate: '2026-08-01',
  endDate: '2026-08-10',
  travellers: 'couple',
  pace: 'moderate',
  interestTags: [],
  destinations: ['Shanghai'],
  destinationCountries: ['CN'],
};

const noop = () => {};
const lookupCities = async () => ({ suggestions: [] });

describe('EditTripModal — scopes-driven chips and honest removal', () => {
  it('derives initial chips from trip.scopes, not from destinations zip', () => {
    const trip = {
      ...baseTrip,
      scopes: [
        { label: 'Shanghai', countryCode: 'CN', kind: 'city', source: 'booking' },
        { label: 'Hangzhou', countryCode: 'CN', kind: 'city', source: 'booking' },
      ],
    };
    render(
      <EditTripModal
        trip={trip}
        days={[]}
        open
        onClose={noop}
        onSubmit={noop}
        saving={false}
        onDelete={noop}
        deleting={false}
        lookupCities={lookupCities}
      />
    );
    expect(screen.getByText('Shanghai')).toBeInTheDocument();
    expect(screen.getByText('Hangzhou')).toBeInTheDocument();
  });

  it('shows an inline note (without blocking removal) when a removed chip still matches resolved days', () => {
    const trip = {
      ...baseTrip,
      scopes: [
        { label: 'Shanghai', countryCode: 'CN', kind: 'city' },
        { label: 'Hangzhou', countryCode: 'CN', kind: 'city' },
      ],
    };
    const days = [
      { date: '2026-08-01', resolvedCity: 'Shanghai', resolvedCountry: 'CN' },
      { date: '2026-08-02', resolvedCity: 'Shanghai', resolvedCountry: 'CN' },
      { date: '2026-08-03', resolvedCity: 'Hangzhou', resolvedCountry: 'CN' },
    ];
    render(
      <EditTripModal
        trip={trip}
        days={days}
        open
        onClose={noop}
        onSubmit={noop}
        saving={false}
        onDelete={noop}
        deleting={false}
        lookupCities={lookupCities}
      />
    );

    const shanghaiChip = screen.getByText('Shanghai').closest('button');
    fireEvent.click(shanghaiChip);

    // Chip removal is not blocked ...
    expect(screen.queryByText('Shanghai')).not.toBeInTheDocument();
    // ... but an honest note explains the days keep their identity.
    expect(
      screen.getByText(/2 days still show Shanghai — days keep their identity/)
    ).toBeInTheDocument();
  });

  // Regression: a picker-added city chip fires an async bounds fetch that resolves after
  // the add and patches state via a functional update. The modal must hand the picker
  // React's setter directly so that late functional update applies to the LATEST chips —
  // an earlier build resolved functional updates against a stale snapshot taken before the
  // add, so the resolving bounds fetch silently reverted the just-added chip (found in
  // browser QA). This locks the fix: the added chip survives its own bounds fetch.
  it('keeps a just-added chip when its async bounds fetch resolves (no stale-snapshot clobber)', async () => {
    const trip = {
      ...baseTrip,
      scopes: [{ label: 'Shanghai', countryCode: 'CN', kind: 'city', source: 'picker' }],
    };
    const lookupSuzhou = async () => ({
      suggestions: [{ label: 'Suzhou', countryCode: 'CN', kind: 'city', placeId: 'place-suzhou' }],
    });
    vi.spyOn(bookingsApi, 'lookupDestinationBounds').mockResolvedValue({
      placeId: 'place-suzhou',
      bounds: { low: { lat: 1, lng: 2 }, high: { lat: 3, lng: 4 } },
    });

    render(
      <EditTripModal
        trip={trip}
        days={[]}
        open
        onClose={noop}
        onSubmit={noop}
        saving={false}
        onDelete={noop}
        deleting={false}
        lookupCities={lookupSuzhou}
      />
    );

    const input = screen.getByLabelText('Destinations');
    fireEvent.change(input, { target: { value: 'Suzhou' } });
    const suggestion = await waitFor(() => screen.getByText('Suzhou').closest('button'));
    fireEvent.click(suggestion);

    // Bounds fetch fired for the added chip...
    await waitFor(() => expect(bookingsApi.lookupDestinationBounds).toHaveBeenCalledWith('place-suzhou', expect.any(String)));
    // ...and after it resolves, BOTH the original scope chip and the new one remain.
    await waitFor(() => {
      const chips = screen.getAllByRole('button').filter((b) => /×$/.test(b.textContent));
      expect(chips.map((b) => b.textContent.replace('×', ''))).toEqual(['Shanghai', 'Suzhou']);
    });
  });
});
