// @vitest-environment jsdom
// Regression suite for the post-W5 blank-Plan-tab bug: a stop card unmounting
// inside Timeline (on move/remove) is a descendant unmount beneath the
// AnimatePresence-managed day panel, which corrupted framer-motion's presence
// tracking and made mode="wait" freeze the next day-tab switch on its exit
// animation. The day panel no longer participates in AnimatePresence — see
// PlanTab.jsx. Full-fidelity harness: real useTrip + useStops + PlanTab +
// Timeline/DayHeader/StopCard, mocked only at the API layer.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { useTrip } from '../hooks/useTrip.js';
import { useStops } from '../hooks/useStops.js';
import { useBookings } from '../hooks/useBookings.js';
import PlanTab from './PlanTab.jsx';

// --- jsdom polyfills framer-motion / Timeline need ---
if (!window.matchMedia) {
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  });
}
if (!window.ResizeObserver) {
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}
if (!window.IntersectionObserver) {
  window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
}

// --- mutable fake server state (SQLite-faithful: numeric ids) ---
let serverDays;

function resetServer() {
  serverDays = [
    {
      id: 1, tripId: 't1', date: '2026-08-01', dayIndex: 0,
      city: 'Shanghai', resolvedCity: 'Hangzhou', resolvedCountry: 'CN',
      cityOverride: null, theme: null, phase: null,
      stops: [
        { id: 11, dayId: 1, type: 'food', title: 'Stop One', note: '', sortOrder: 0 },
        { id: 12, dayId: 1, type: 'sight', title: 'Stop Two', note: '', sortOrder: 1 },
      ],
    },
    {
      id: 2, tripId: 't1', date: '2026-08-02', dayIndex: 1,
      city: 'Shanghai', resolvedCity: 'Suzhou', resolvedCountry: 'CN',
      cityOverride: null, theme: null, phase: null,
      stops: [],
    },
  ];
}

function detailSnapshot() {
  return JSON.parse(JSON.stringify({
    trip: { id: 't1', title: 'Repro Trip', destinations: ['Hangzhou'] },
    days: serverDays,
    bookings: [],
  }));
}

vi.mock('../services/tripsApi.js', () => ({
  tripsApi: {
    detail: vi.fn(() => Promise.resolve(detailSnapshot())),
    patchDayCityOverride: vi.fn(),
  },
}));

vi.mock('../services/stopsApi.js', () => ({
  stopsApi: {
    update: vi.fn((stopId, data) => {
      for (const day of serverDays) {
        const idx = day.stops.findIndex((s) => s.id === stopId);
        if (idx !== -1) {
          const [stop] = day.stops.splice(idx, 1);
          if (data.dayId != null) {
            stop.dayId = data.dayId;
            serverDays.find((d) => d.id === data.dayId).stops.push(stop);
          } else {
            Object.assign(stop, data);
            day.stops.splice(idx, 0, stop);
          }
          break;
        }
      }
      return Promise.resolve({});
    }),
    remove: vi.fn((stopId) => {
      for (const day of serverDays) {
        day.stops = day.stops.filter((s) => s.id !== stopId);
      }
      return Promise.resolve({});
    }),
    create: vi.fn(() => Promise.resolve({})),
    reorder: vi.fn(() => Promise.resolve({})),
  },
}));

vi.mock('../services/bookingsApi.js', () => ({
  bookingsApi: { lookupPlaces: vi.fn(), lookupHotelDetails: vi.fn() },
}));

// PlanTab pulls context from TripPage's outlet — replicate TripPage's wiring
// in the harness below and hand it through this mock.
let ctx;
vi.mock('./TripPage.jsx', () => ({ useTripContext: () => ctx }));

function Harness() {
  const tripState = useTrip('t1');
  const stopActions = useStops({ onChanged: tripState.refresh });
  const bookingActions = useBookings({ tripId: 't1', onChanged: tripState.refresh });
  ctx = { ...tripState, stopActions, bookingActions, discovery: {}, live: false, reportError: vi.fn() };
  if (tripState.loading) return <p>loading-screen</p>;
  return <PlanTab />;
}

const renderHarness = () => render(<MemoryRouter><Harness /></MemoryRouter>);

describe('Plan tab blank-panel regression (bug a)', () => {
  beforeEach(() => {
    resetServer();
    vi.clearAllMocks();
  });
  afterEach(cleanup);

  it('keeps day header + timeline rendered after moving a stop to another day', async () => {
    renderHarness();
    await screen.findByText(/Hangzhou · Day 1/i);
    expect(screen.getByText('Stop One')).toBeInTheDocument();

    // expand Stop One → Move to → pick Day 2 chip
    fireEvent.click(screen.getByText('Stop One'));
    fireEvent.click(await screen.findByText('Move to →'));
    const chip = await screen.findByText(/^Day 2/);
    fireEvent.click(chip);

    // wait until the refresh cycle has settled: Stop One left day 1
    await waitFor(() => {
      expect(screen.queryByText('Stop One')).not.toBeInTheDocument();
    }, { timeout: 3000 });

    // give the fade-in animation time to finish, then inspect
    await act(() => new Promise((r) => setTimeout(r, 600)));

    expect(screen.queryByText(/Hangzhou · Day 1/i)).toBeInTheDocument();
    expect(screen.queryByText('Stop Two')).toBeInTheDocument();
  });

  it('day-tab switch AFTER a move still renders the new day', async () => {
    renderHarness();
    await screen.findByText(/Hangzhou · Day 1/i);

    // move Stop One to day 2, let everything settle
    fireEvent.click(screen.getByText('Stop One'));
    fireEvent.click(await screen.findByText('Move to →'));
    fireEvent.click(await screen.findByText(/^Day 2/));
    await waitFor(() => {
      expect(screen.queryByText('Stop One')).not.toBeInTheDocument();
    }, { timeout: 3000 });
    await act(() => new Promise((r) => setTimeout(r, 600)));

    // now switch day tabs — DayTabs label is "<day> <weekday>" from the date;
    // the exact order is locale-dependent in jsdom, so match both.
    const tabs = screen.getAllByRole('button').filter((b) => /^(\d+ \w{3}|\w{3} \d+)$/.test(b.textContent.trim()));
    fireEvent.click(tabs[1]);

    // the day-2 header must appear
    await waitFor(() => {
      expect(screen.getByText(/Suzhou · Day 2/i)).toBeInTheDocument();
    }, { timeout: 3000 });
  });

  it('keeps day header + timeline rendered after removing a stop', async () => {
    renderHarness();
    await screen.findByText(/Hangzhou · Day 1/i);

    fireEvent.click(screen.getByText('Stop One'));
    fireEvent.click(await screen.findByText('Remove'));
    fireEvent.click(await screen.findByText('Remove?'));

    await waitFor(() => {
      expect(screen.queryByText('Stop One')).not.toBeInTheDocument();
    }, { timeout: 3000 });

    await act(() => new Promise((r) => setTimeout(r, 600)));

    expect(screen.queryByText(/Hangzhou · Day 1/i)).toBeInTheDocument();
    expect(screen.queryByText('Stop Two')).toBeInTheDocument();
  });

  it('day-tab switch AFTER a remove still renders the new day', async () => {
    renderHarness();
    await screen.findByText(/Hangzhou · Day 1/i);

    fireEvent.click(screen.getByText('Stop One'));
    fireEvent.click(await screen.findByText('Remove'));
    fireEvent.click(await screen.findByText('Remove?'));
    await waitFor(() => {
      expect(screen.queryByText('Stop One')).not.toBeInTheDocument();
    }, { timeout: 3000 });
    await act(() => new Promise((r) => setTimeout(r, 600)));

    const tabs = screen.getAllByRole('button').filter((b) => /^(\d+ \w{3}|\w{3} \d+)$/.test(b.textContent.trim()));
    fireEvent.click(tabs[1]);

    await waitFor(() => {
      expect(screen.getByText(/Suzhou · Day 2/i)).toBeInTheDocument();
    }, { timeout: 3000 });
  });
});
