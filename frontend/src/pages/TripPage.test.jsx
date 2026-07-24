// @vitest-environment jsdom
//
// Shell-preservation test: proves the outlet-only Suspense altitude keeps TopBar
// and BottomNav mounted while a nested tab route's lazy chunk is still resolving.
// Approach: mount the REAL TripPage with its hook stack mocked (useTrip loaded,
// useStops/useBookings/useCopilot/useDiscovery stubbed) — this exercises the actual
// production JSX (main > ChunkErrorBoundary > Suspense > Outlet), not a re-typed
// stand-in, per the plan's "attempt the real TripPage version first" instruction.
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { lazy } from 'react';

afterEach(cleanup);

vi.mock('../context/AuthContext.jsx', () => ({
  useAuth: () => ({ user: { id: 'u1', is_admin: false }, needsSetup: false, loading: false }),
}));

vi.mock('../hooks/useTrip.js', () => ({
  useTrip: () => ({
    detail: { trip: {}, days: [], bookings: [] },
    trip: {
      id: 'trip-1',
      title: 'Shanghai Loop',
      startDate: '2020-01-01',
      endDate: '2020-01-05',
      ownerId: 'u1',
    },
    days: [],
    bookings: [],
    activeDayId: null,
    setActiveDayId: vi.fn(),
    activeDay: null,
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

vi.mock('../hooks/useStops.js', () => ({
  useStops: () => ({ saving: false, createStop: vi.fn(), updateStop: vi.fn(), deleteStop: vi.fn(), reorderStops: vi.fn() }),
}));

vi.mock('../hooks/useBookings.js', () => ({
  useBookings: () => ({
    saving: false,
    createBooking: vi.fn(),
    updateBooking: vi.fn(),
    deleteBooking: vi.fn(),
    lookupHotels: vi.fn(),
    lookupHotelDetails: vi.fn(),
    lookupFlight: vi.fn(),
    lookupCities: vi.fn(),
  }),
}));

vi.mock('../hooks/useCopilot.js', () => ({
  useCopilot: () => ({
    messages: [], streaming: false, streamingText: '', activeTool: null, proposals: [], error: null,
    send: vi.fn(), applyProposal: vi.fn(), rejectProposal: vi.fn(), cancel: vi.fn(), clear: vi.fn(),
  }),
}));

vi.mock('../hooks/useDiscovery.js', () => ({
  useDiscovery: () => ({
    discover: vi.fn(), showMore: vi.fn(), getDestination: vi.fn(() => ({})), isAnyLoading: false, reset: vi.fn(),
  }),
}));

vi.mock('../services/tripsApi.js', () => ({
  tripsApi: { remove: vi.fn(), update: vi.fn(), detail: vi.fn() },
}));

vi.mock('../services/bookingsApi.js', () => ({
  bookingsApi: { lookupCities: vi.fn() },
}));

const TripPage = (await import('./TripPage.jsx')).default;

// A lazy child that never resolves within the test's lifetime — simulates a
// chunk still in flight, so the Suspense fallback stays showing indefinitely.
function makeForeverSuspendingLazy() {
  return lazy(() => new Promise(() => {}));
}

describe('TripPage — nested outlet Suspense preserves the trip shell', () => {
  it('keeps TopBar and BottomNav mounted while the outlet content is still suspended', async () => {
    const NeverResolves = makeForeverSuspendingLazy();

    render(
      <MemoryRouter initialEntries={['/trips/trip-1/plan']}>
        <Routes>
          <Route path="/trips/:tripId" element={<TripPage />}>
            <Route path="plan" element={<NeverResolves />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    // TopBar renders the trip title.
    expect(await screen.findByText('Shanghai Loop')).toBeInTheDocument();
    // BottomNav's tab labels stay present around the suspended outlet.
    expect(screen.getByText('Plan')).toBeInTheDocument();
    expect(screen.getByText('Logistics')).toBeInTheDocument();
    expect(screen.getByText('Map')).toBeInTheDocument();
    // TripPage's own Suspense (wrapping the whole <Outlet/>) is what catches the
    // suspension — its fallback (TabLoadingFallback, "Loading") is what shows.
    expect(screen.getByText('Loading')).toBeInTheDocument();
  });
});
