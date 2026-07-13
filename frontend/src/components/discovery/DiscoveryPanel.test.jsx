// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import DiscoveryPanel from './DiscoveryPanel.jsx';
import { discoveryApi } from '../../services/discoveryApi.js';

// Vitest doesn't register a global `afterEach` unless `test.globals` is set
// (this project's vitest.config.js doesn't), so @testing-library/react's
// automatic post-test cleanup never fires — without this, each render() in
// this file would pile up in the same jsdom document as the last.
afterEach(cleanup);

vi.mock('../../services/discoveryApi.js', () => ({
  discoveryApi: {
    discover: vi.fn(),
    reportPlace: vi.fn(),
  },
}));

vi.mock('../../services/bookingsApi.js', () => ({
  bookingsApi: {
    lookupPlaces: vi.fn(),
    lookupHotelDetails: vi.fn(),
  },
}));

const TRIP = {
  id: 'trip-1',
  interestTags: ['food & drink'],
  destinations: ['Testville'],
  destinationCountries: ['TV'],
};

const DAYS = [
  { id: 'day-1', date: '2026-07-10', dayIndex: 0, resolvedCity: 'Testville', resolvedCountry: 'TV', stops: [] },
];

// Builds a fake `discovery` prop (the shape TripPage's useDiscovery hook
// normally supplies) whose getDestination() always returns the given fixed
// state, regardless of which destination/country it's called with — this
// lets each test drive DiscoveryPanel's rendering directly without needing
// to fake the SSE stream underneath useDiscovery.
function makeDiscovery({ partialResults = {}, completedCategories = new Set(), loading = false, error = null } = {}) {
  return {
    discover: vi.fn(),
    showMore: vi.fn(),
    getDestination: vi.fn(() => ({ partialResults, completedCategories, loading, error, cached: false })),
    isAnyLoading: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DiscoveryPanel co-pilot entry-point forwarding', () => {
  it('forwards real suggestion context from category, search, More, and surprise card paths', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    const onOpenCopilot = vi.fn();
    const partialResults = {
      essentials: [{ id: 1, name: 'Essential A', description: 'Core place' }],
      culture: [{ id: 2, name: 'Culture A', description: 'Museum place' }],
    };
    const discovery = makeDiscovery({
      partialResults,
      completedCategories: new Set(['essentials', 'culture']),
    });
    render(
      <DiscoveryPanel
        trip={TRIP}
        days={DAYS}
        activeDay={DAYS[0]}
        onAddStop={vi.fn()}
        onClose={vi.fn()}
        discovery={discovery}
        onOpenCopilot={onOpenCopilot}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^ask co-pilot$/i }));
    expect(onOpenCopilot).toHaveBeenLastCalledWith({ tab: 'discovery', discoveryName: 'Essential A' });

    fireEvent.change(screen.getByPlaceholderText(/find a place/i), { target: { value: 'Culture A' } });
    fireEvent.click(screen.getByRole('button', { name: /^ask co-pilot$/i }));
    expect(onOpenCopilot).toHaveBeenLastCalledWith({ tab: 'discovery', discoveryName: 'Culture A' });

    fireEvent.change(screen.getByPlaceholderText(/find a place/i), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /^more/i }));
    fireEvent.click(screen.getByRole('button', { name: /^ask co-pilot$/i }));
    expect(onOpenCopilot).toHaveBeenLastCalledWith({ tab: 'discovery', discoveryName: 'Culture A' });

    fireEvent.click(screen.getByRole('button', { name: /^surprise me$/i }));
    const askButtons = screen.getAllByRole('button', { name: /^ask co-pilot$/i });
    fireEvent.click(askButtons.at(-1));
    expect(onOpenCopilot).toHaveBeenLastCalledWith({ tab: 'discovery', discoveryName: 'Essential A' });
    expect(onOpenCopilot).toHaveBeenCalledTimes(4);

    random.mockRestore();
  });
});

describe('DiscoveryPanel — honest tabs and hero count (Wave 4 §4.2)', () => {
  it('surfaces a category with no matching interest tag under "More", and the hero count includes it', () => {
    // interestTags maps 'food & drink' -> 'food', so only essentials/food get
    // named tabs. 'culture' has no matching interest tag and must land under
    // the terminal "More" tab, counted toward the hero total all the same.
    const partialResults = {
      essentials: [{ id: 1, name: 'Essential A' }],
      food: [{ id: 2, name: 'Food A' }, { id: 3, name: 'Food B' }],
      culture: [{ id: 4, name: 'Culture A' }],
    };
    const completedCategories = new Set(['essentials', 'food', 'culture']);
    const discovery = makeDiscovery({ partialResults, completedCategories });

    render(
      <DiscoveryPanel
        trip={TRIP}
        days={DAYS}
        activeDay={DAYS[0]}
        onAddStop={vi.fn()}
        onClose={vi.fn()}
        discovery={discovery}
      />,
    );

    // "More" tab is present (culture isn't a named tab for this trip's tags).
    expect(screen.getByRole('button', { name: /^more/i })).toBeInTheDocument();
    // Hero count sums every reachable tab: 1 (essentials) + 2 (food) + 1 (culture, via More) = 4.
    expect(screen.getByText(/4 curated places/i)).toBeInTheDocument();
  });

  it('reaching "More" shows the unmapped category\'s items', () => {
    const partialResults = {
      essentials: [{ id: 1, name: 'Essential A' }],
      food: [{ id: 2, name: 'Food A' }],
      culture: [{ id: 4, name: 'Culture A' }],
    };
    const completedCategories = new Set(['essentials', 'food', 'culture']);
    const discovery = makeDiscovery({ partialResults, completedCategories });

    render(
      <DiscoveryPanel
        trip={TRIP}
        days={DAYS}
        activeDay={DAYS[0]}
        onAddStop={vi.fn()}
        onClose={vi.fn()}
        discovery={discovery}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^more/i }));
    expect(screen.getByText('Culture A')).toBeInTheDocument();
  });
});

describe('DiscoveryPanel — show more affordance (Wave 4 §4.3)', () => {
  it('swaps the Show more label while a show-more is in flight, and reverts once loading clears', () => {
    const partialResults = { essentials: [{ id: 1, name: 'Essential A' }] };
    const completedCategories = new Set(['essentials']);

    const { rerender } = render(
      <DiscoveryPanel
        trip={TRIP}
        days={DAYS}
        activeDay={DAYS[0]}
        onAddStop={vi.fn()}
        onClose={vi.fn()}
        discovery={makeDiscovery({ partialResults, completedCategories, loading: true })}
      />,
    );

    expect(screen.getByText(/finding more places/i)).toBeInTheDocument();

    rerender(
      <DiscoveryPanel
        trip={TRIP}
        days={DAYS}
        activeDay={DAYS[0]}
        onAddStop={vi.fn()}
        onClose={vi.fn()}
        discovery={makeDiscovery({ partialResults, completedCategories, loading: false })}
      />,
    );

    expect(screen.queryByText(/finding more places/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^show more$/i })).toBeInTheDocument();
  });
});

describe('DiscoveryPanel — trusted add-to-trip (Wave 4 §4.4)', () => {
  it('sends the trusted-coordinate payload for a verified item with coordinates', async () => {
    const partialResults = {
      essentials: [{
        id: 1,
        name: 'Verified Temple',
        description: 'A real place.',
        provenance: 'verified',
        lat: 12.34,
        lng: 56.78,
        placeRef: 'osm:way:123',
        estimatedDuration: '1h',
      }],
    };
    const completedCategories = new Set(['essentials']);
    const onAddStop = vi.fn().mockResolvedValue(undefined);

    render(
      <DiscoveryPanel
        trip={TRIP}
        days={DAYS}
        activeDay={DAYS[0]}
        onAddStop={onAddStop}
        onClose={vi.fn()}
        discovery={makeDiscovery({ partialResults, completedCategories })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /add to day/i }));
    fireEvent.click(screen.getByText('Day 1'));

    await waitFor(() => expect(onAddStop).toHaveBeenCalled());
    const [dayId, payload] = onAddStop.mock.calls[0];
    expect(dayId).toBe('day-1');
    expect(payload).toMatchObject({
      title: 'Verified Temple',
      lat: 12.34,
      lng: 56.78,
      coordinateSystem: 'wgs84',
      coordinateSource: 'places',
      locationStatus: 'resolved',
      providerId: 'osm:way:123',
      source: 'discovery',
      provenance: 'verified',
    });
  });

  it('does not send trusted-coordinate fields for an unverified item', async () => {
    const partialResults = {
      essentials: [{
        id: 2,
        name: 'Unverified Cafe',
        description: 'Maybe real.',
        provenance: 'unverified',
        lat: null,
        lng: null,
        estimatedDuration: '30m',
      }],
    };
    const completedCategories = new Set(['essentials']);
    const onAddStop = vi.fn().mockResolvedValue(undefined);

    render(
      <DiscoveryPanel
        trip={TRIP}
        days={DAYS}
        activeDay={DAYS[0]}
        onAddStop={onAddStop}
        onClose={vi.fn()}
        discovery={makeDiscovery({ partialResults, completedCategories })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /add to day/i }));
    fireEvent.click(screen.getByText('Day 1'));

    await waitFor(() => expect(onAddStop).toHaveBeenCalled());
    const [, payload] = onAddStop.mock.calls[0];
    expect(payload.title).toBe('Unverified Cafe');
    expect(payload.source).toBe('discovery');
    expect(payload.provenance).toBe('unverified');
    expect(payload.lat).toBeUndefined();
    expect(payload.lng).toBeUndefined();
    expect(payload.coordinateSource).toBeUndefined();
    expect(payload.coordinateSystem).toBeUndefined();
  });
});

describe('DiscoveryPanel — cross-city country selection (Wave 5 §5.2)', () => {
  it('uses the active day\'s resolved country when the committed search matches the day\'s own city', async () => {
    const partialResults = {
      essentials: [{ id: 10, name: 'Local Spot', description: 'Right here.', estimatedDuration: '1h' }],
    };
    const completedCategories = new Set(['essentials']);
    const onAddStop = vi.fn().mockResolvedValue(undefined);

    render(
      <DiscoveryPanel
        trip={TRIP}
        days={DAYS}
        activeDay={DAYS[0]}
        onAddStop={onAddStop}
        onClose={vi.fn()}
        discovery={makeDiscovery({ partialResults, completedCategories })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /add to day/i }));
    fireEvent.click(screen.getByText('Day 1'));

    await waitFor(() => expect(onAddStop).toHaveBeenCalled());
    const [, payload] = onAddStop.mock.calls[0];
    expect(payload.locationCountry).toBe('TV');
  });

  it('uses the searched destination\'s country (not the active day\'s) when the user has searched a different city', async () => {
    const partialResults = {
      essentials: [{ id: 11, name: 'Faraway Spot', description: 'Somewhere else.', estimatedDuration: '1h' }],
    };
    const completedCategories = new Set(['essentials']);
    const onAddStop = vi.fn().mockResolvedValue(undefined);

    render(
      <DiscoveryPanel
        trip={TRIP}
        days={DAYS}
        activeDay={DAYS[0]}
        onAddStop={onAddStop}
        onClose={vi.fn()}
        discovery={makeDiscovery({ partialResults, completedCategories })}
      />,
    );

    // Manually search a different destination than the active day's own
    // resolved city ("Testville") — the free-text "Go" search has no country
    // field, so committedCountry is cleared to null rather than reusing the
    // active day's country (Wave 4 §4.1). That null must win over
    // activeDay.resolvedCountry when adding a suggestion.
    fireEvent.change(screen.getByPlaceholderText('Destination'), { target: { value: 'Othertown' } });
    fireEvent.click(screen.getByRole('button', { name: /^go$/i }));

    fireEvent.click(screen.getByRole('button', { name: /add to day/i }));
    fireEvent.click(screen.getByText('Day 1'));

    await waitFor(() => expect(onAddStop).toHaveBeenCalled());
    const [, payload] = onAddStop.mock.calls[0];
    expect(payload.locationCountry).toBeNull();
    expect(payload.locationCity).toBe('Othertown');
  });
});

describe('DiscoveryPanel — report flow (Wave 4 §4.3)', () => {
  it('is a two-step flow: the flag icon alone does not report', async () => {
    discoveryApi.reportPlace.mockResolvedValue({ suppressed: true });

    const partialResults = {
      essentials: [{ id: 5, name: 'Fake Landmark', description: 'Suspicious.' }],
    };
    const completedCategories = new Set(['essentials']);

    render(
      <DiscoveryPanel
        trip={TRIP}
        days={DAYS}
        activeDay={DAYS[0]}
        onAddStop={vi.fn()}
        onClose={vi.fn()}
        discovery={makeDiscovery({ partialResults, completedCategories })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /report this place/i }));

    expect(discoveryApi.reportPlace).not.toHaveBeenCalled();
    expect(screen.getByText('Fake Landmark')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /not real/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /closed/i })).toBeInTheDocument();
  });

  it('removes a reported card from view once a reason is confirmed', async () => {
    discoveryApi.reportPlace.mockResolvedValue({ suppressed: true });

    const partialResults = {
      essentials: [{ id: 5, name: 'Fake Landmark', description: 'Suspicious.' }],
    };
    const completedCategories = new Set(['essentials']);

    render(
      <DiscoveryPanel
        trip={TRIP}
        days={DAYS}
        activeDay={DAYS[0]}
        onAddStop={vi.fn()}
        onClose={vi.fn()}
        discovery={makeDiscovery({ partialResults, completedCategories })}
      />,
    );

    expect(screen.getByText('Fake Landmark')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /report this place/i }));
    fireEvent.click(screen.getByRole('button', { name: /not real/i }));

    await waitFor(() => expect(screen.queryByText('Fake Landmark')).not.toBeInTheDocument());
    expect(discoveryApi.reportPlace).toHaveBeenCalledWith(5, 'trip-1');
  });
});
