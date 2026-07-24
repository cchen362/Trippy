// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

vi.mock('../services/tripsApi.js', () => ({
  tripsApi: { list: vi.fn(), create: vi.fn() },
}));
vi.mock('../services/bookingsApi.js', () => ({
  bookingsApi: { lookupCities: vi.fn() },
}));
vi.mock('../services/importApi.js', () => ({
  importApi: { confirm: vi.fn() },
}));
vi.mock('../components/trips/TripCard.jsx', () => ({
  default: ({ trip }) => <div data-testid="trip-card">{trip.id}</div>,
}));
vi.mock('../components/trips/EmptyTripsState.jsx', () => ({
  default: () => <div data-testid="empty-trips-state" />,
}));
vi.mock('../components/trips/NewTripModal.jsx', () => ({
  default: () => null,
}));
vi.mock('../components/nav/BottomNav.jsx', () => ({
  default: () => null,
}));
vi.mock('../components/admin/AdminSettingsPanel.jsx', () => ({
  default: () => null,
}));
vi.mock('../components/common/UserAccountButton.jsx', () => ({
  default: () => null,
}));
vi.mock('../components/common/LoadingScreen.jsx', () => ({
  default: ({ label }) => <div data-testid="loading-screen">{label}</div>,
}));

const { tripsApi } = await import('../services/tripsApi.js');
const TripsHomePage = (await import('./TripsHomePage.jsx')).default;

function renderPage() {
  return render(
    <MemoryRouter>
      <TripsHomePage />
    </MemoryRouter>
  );
}

describe('TripsHomePage error/empty/loaded states', () => {
  it('shows offline copy and a Try again control when trips fail to load, and hides the empty state', async () => {
    tripsApi.list.mockRejectedValueOnce(Object.assign(new Error('Failed to fetch'), { code: 'NETWORK_ERROR' }));
    renderPage();

    await waitFor(() =>
      expect(
        screen.getByText("We can't load your trips right now. Check your connection and try again.")
      ).toBeInTheDocument()
    );
    expect(screen.getByText('Try again')).toBeInTheDocument();
    expect(screen.queryByTestId('empty-trips-state')).not.toBeInTheDocument();
  });

  it('renders the empty state with no error copy when the load succeeds with zero trips', async () => {
    tripsApi.list.mockResolvedValueOnce({ trips: [] });
    renderPage();

    await waitFor(() => expect(screen.getByTestId('empty-trips-state')).toBeInTheDocument());
    expect(screen.queryByText(/check your connection/i)).not.toBeInTheDocument();
  });

  it('Try again re-invokes loadTrips and clears the error on success', async () => {
    tripsApi.list
      .mockRejectedValueOnce(Object.assign(new Error('Failed to fetch'), { code: 'NETWORK_ERROR' }))
      .mockResolvedValueOnce({ trips: [] });
    renderPage();

    await waitFor(() => expect(screen.getByText('Try again')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Try again'));

    await waitFor(() => expect(tripsApi.list).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('empty-trips-state')).toBeInTheDocument());
    expect(screen.queryByText(/check your connection/i)).not.toBeInTheDocument();
  });
});
