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

describe('EditTripModal — ModalShell migration', () => {
  it('renders as a labelled dialog with the expected headline', () => {
    render(
      <EditTripModal
        trip={baseTrip}
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
    const dialog = screen.getByRole('dialog');
    const headline = screen.getByRole('heading', { name: 'Refine the plan.' });
    expect(dialog).toHaveAttribute('aria-labelledby', headline.id);
  });

  it('renders nothing when closed', () => {
    render(
      <EditTripModal
        trip={baseTrip}
        days={[]}
        open={false}
        onClose={noop}
        onSubmit={noop}
        saving={false}
        onDelete={noop}
        deleting={false}
        lookupCities={lookupCities}
      />
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('arms the danger confirm on "Delete trip", disarms on Cancel, and confirms via onDelete', () => {
    const onDelete = vi.fn();
    render(
      <EditTripModal
        trip={baseTrip}
        days={[]}
        open
        onClose={noop}
        onSubmit={noop}
        saving={false}
        onDelete={onDelete}
        deleting={false}
        lookupCities={lookupCities}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Delete trip' }));
    const confirmButton = screen.getByRole('button', { name: 'Confirm delete' });
    expect(confirmButton).toBeInTheDocument();

    const cancelButtons = screen.getAllByRole('button', { name: 'Cancel' });
    fireEvent.click(cancelButtons[0]);
    expect(screen.queryByRole('button', { name: 'Confirm delete' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete trip' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Delete trip' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('submits the form when the footer Save Changes button is clicked (form attribute wiring)', () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <EditTripModal
        trip={baseTrip}
        days={[]}
        open
        onClose={noop}
        onSubmit={onSubmit}
        saving={false}
        onDelete={noop}
        deleting={false}
        lookupCities={lookupCities}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('shows the honest-constraint strings under their conditions', () => {
    const trip = { ...baseTrip, endDate: '2026-08-10' };
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

    expect(screen.getByText('Start date cannot be changed')).toBeInTheDocument();
    expect(
      screen.queryByText('Shortening will remove later days (blocked if they have stops)')
    ).not.toBeInTheDocument();

    const endDateInput = screen.getByDisplayValue('2026-08-10');
    fireEvent.change(endDateInput, { target: { value: '2026-08-05' } });
    expect(
      screen.getByText('Shortening will remove later days (blocked if they have stops)')
    ).toBeInTheDocument();
  });

  it('shows the removed-chip identity note verbatim', () => {
    const trip = {
      ...baseTrip,
      scopes: [
        { label: 'Shanghai', countryCode: 'CN', kind: 'city' },
        { label: 'Hangzhou', countryCode: 'CN', kind: 'city' },
      ],
    };
    const days = [{ date: '2026-08-01', resolvedCity: 'Shanghai', resolvedCountry: 'CN' }];
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

    expect(
      screen.getByText('1 day still show Shanghai — days keep their identity; edit day headers or bookings to change them')
    ).toBeInTheDocument();
  });
});
