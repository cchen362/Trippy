// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import DiscoveryPanel from './DiscoveryPanel.jsx';
import { discoveryApi } from '../../services/discoveryApi.js';
import { bookingsApi } from '../../services/bookingsApi.js';

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
    lookupCountries: vi.fn(),
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
function makeDiscovery({ partialResults = {}, completedCategories = new Set(), loading = false, error = null, notice = null } = {}) {
  return {
    discover: vi.fn(),
    showMore: vi.fn(),
    getDestination: vi.fn(() => ({ partialResults, completedCategories, loading, error, notice, cached: false })),
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

    fireEvent.click(screen.getByRole('button', { name: /^search$/i }));
    fireEvent.change(screen.getByRole('textbox', { name: /find a place/i }), { target: { value: 'Culture A' } });
    fireEvent.click(screen.getByRole('button', { name: /^ask co-pilot$/i }));
    expect(onOpenCopilot).toHaveBeenLastCalledWith({ tab: 'discovery', discoveryName: 'Culture A' });

    fireEvent.change(screen.getByRole('textbox', { name: /find a place/i }), { target: { value: '' } });
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

describe('DiscoveryPanel — show more decline notice (W1.5)', () => {
  it('shows the decline message near Show more without hiding results, and not as the red error line', () => {
    const partialResults = { essentials: [{ id: 1, name: 'Essential A' }] };
    const completedCategories = new Set(['essentials']);

    render(
      <DiscoveryPanel
        trip={TRIP}
        days={DAYS}
        activeDay={DAYS[0]}
        onAddStop={vi.fn()}
        onClose={vi.fn()}
        discovery={makeDiscovery({
          partialResults,
          completedCategories,
          notice: { code: 'catalogue_full', message: "Every category here is already full." },
        })}
      />,
    );

    // Results stay on screen — a decline is not a failure.
    expect(screen.getByText('Essential A')).toBeInTheDocument();
    expect(screen.getByText('Every category here is already full.')).toBeInTheDocument();
    // Never the generic red retry line.
    expect(screen.queryByText('Couldn’t load places right now. Please try again.')).not.toBeInTheDocument();
    // The Show more button itself is unaffected — the user can still see and use it.
    expect(screen.getByRole('button', { name: /^show more$/i })).toBeInTheDocument();
  });

  it('does not render a notice when there is none', () => {
    const partialResults = { essentials: [{ id: 1, name: 'Essential A' }] };
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

    expect(screen.getByText('Essential A')).toBeInTheDocument();
    expect(screen.queryByText(/already full/i)).not.toBeInTheDocument();
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
    fireEvent.click(screen.getByRole('button', { name: /^change$/i }));
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

describe('DiscoveryPanel — city and country resolve from the SAME day (Plan 26 W4.2 defect fix)', () => {
  // The regression this guards: defaultDestination and defaultCountry used to
  // be two INDEPENDENT `??` chains (activeDay -> days[0] -> trip-level, each
  // evaluated separately). That let a country discoveryCountryForDay just
  // rejected for activeDay fall through to days[0]'s country, or further to
  // trip.destinationCountries[0] — both of which are typically the exact
  // country that was just rejected. Here activeDay is the 冲绳-style rejected
  // day, days[0] is a DIFFERENT day with a good country, and
  // destinationCountries also holds that same good country — every fallback
  // hop is primed to silently resurrect 'CN'. The fix must still land on null.
  it('never falls through to days[0] or trip.destinationCountries when the active day\'s own country is rejected', () => {
    const rejectedDay = {
      id: 'day-2',
      resolvedCity: 'Okinawa',
      city: 'Okinawa',
      resolvedCountry: 'CN',
      resolvedCountryEvidenceCity: 'Shanghai', // different city -> rejected
    };
    const goodDay = {
      id: 'day-1',
      resolvedCity: 'Shanghai',
      city: 'Shanghai',
      resolvedCountry: 'CN',
      resolvedCountryEvidenceCity: 'Shanghai', // same city -> would be kept
    };
    const trip = { ...TRIP, destinationCountries: ['CN'] };
    const discovery = makeDiscovery();

    render(
      <DiscoveryPanel
        trip={trip}
        days={[goodDay, rejectedDay]}
        activeDay={rejectedDay}
        onAddStop={vi.fn()}
        onClose={vi.fn()}
        discovery={discovery}
      />,
    );

    expect(discovery.discover).toHaveBeenCalledWith('Okinawa', null);
    expect(discovery.discover).not.toHaveBeenCalledWith('Okinawa', 'CN');
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

describe('DiscoveryPanel — Option 1b destination and control contract (Plan 14 Wave 1)', () => {
  it('keeps committed results visible while editing and returns to a trimmed committed header after Go', async () => {
    const partialResults = {
      essentials: [{ id: 1, name: 'Essential A', description: 'Core place' }],
    };
    const discovery = makeDiscovery({
      partialResults,
      completedCategories: new Set(['essentials']),
    });

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

    expect(screen.getByText('Essential A')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^change$/i })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Destination')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^change$/i }));
    const destinationInput = screen.getByPlaceholderText('Destination');
    expect(destinationInput).toHaveValue('Testville');
    expect(destinationInput).toHaveFocus();

    fireEvent.change(destinationInput, { target: { value: '  Othertown  ' } });
    expect(screen.getByText('Essential A')).toBeInTheDocument();
    expect(discovery.getDestination).toHaveBeenLastCalledWith('Testville', 'TV');

    fireEvent.click(screen.getByRole('button', { name: /^go$/i }));

    await waitFor(() => expect(discovery.discover).toHaveBeenLastCalledWith('Othertown', null));
    expect(screen.queryByPlaceholderText('Destination')).not.toBeInTheDocument();
    expect(screen.getByText('Othertown')).toBeInTheDocument();
    expect(screen.getByText('Essential A')).toBeInTheDocument();
  });

  it('returns the results scroller to the top on category switch without fetching', () => {
    const discovery = makeDiscovery({
      partialResults: {
        essentials: [{ id: 1, name: 'Essential A' }],
        food: [{ id: 2, name: 'Food A' }],
      },
      completedCategories: new Set(['essentials', 'food']),
    });

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

    const results = screen.getByRole('region', { name: /discovery results/i });
    Object.defineProperty(results, 'scrollTop', { configurable: true, writable: true, value: 480 });
    results.scrollTo = vi.fn(({ top }) => { results.scrollTop = top; });
    discovery.discover.mockClear();
    discovery.showMore.mockClear();

    fireEvent.click(screen.getByRole('button', { name: /^food/i }));

    expect(results.scrollTop).toBe(0);
    expect(discovery.discover).not.toHaveBeenCalled();
    expect(discovery.showMore).not.toHaveBeenCalled();
    expect(screen.getByText('Food A')).toBeInTheDocument();
  });

  it('expands and clears the mobile search control without mutating the destination', () => {
    const discovery = makeDiscovery({
      partialResults: {
        essentials: [{ id: 1, name: 'Essential A' }],
        culture: [{ id: 2, name: 'Culture A' }],
      },
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
      />,
    );

    expect(screen.queryByRole('textbox', { name: /find a place/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^search$/i }));

    const searchInput = screen.getByRole('textbox', { name: /find a place/i });
    fireEvent.change(searchInput, { target: { value: 'Culture' } });
    expect(screen.getByText('Culture A')).toBeInTheDocument();
    expect(screen.queryByText('Essential A')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /clear search/i }));
    expect(screen.queryByRole('textbox', { name: /find a place/i })).not.toBeInTheDocument();
    expect(screen.getByText('Essential A')).toBeInTheDocument();
    expect(screen.getByText('Testville')).toBeInTheDocument();
    expect(discovery.discover).toHaveBeenCalledTimes(1);
    expect(discovery.getDestination).toHaveBeenLastCalledWith('Testville', 'TV');
  });

  it('filters the loaded catalogue at two characters and adds the Google fallback at three', async () => {
    bookingsApi.lookupPlaces.mockResolvedValue({
      suggestions: [{ placeId: 'google-1', mainText: 'Museum Annex', secondaryText: 'Testville' }],
    });
    bookingsApi.lookupHotelDetails.mockResolvedValue({
      place: {
        placeId: 'google-1', name: 'Museum Annex', address: '1 Gallery Road', lat: 12.3, lng: 45.6,
      },
    });
    const onAddStop = vi.fn().mockResolvedValue(undefined);
    const discovery = makeDiscovery({
      partialResults: {
        essentials: [
          { id: 1, name: 'Museum Quarter', description: 'A district of galleries.' },
          { id: 2, name: 'River Walk', description: 'A waterside path.' },
        ],
      },
      completedCategories: new Set(['essentials']),
    });

    render(
      <DiscoveryPanel
        trip={TRIP}
        days={DAYS}
        activeDay={DAYS[0]}
        onAddStop={onAddStop}
        onClose={vi.fn()}
        discovery={discovery}
      />,
    );

    const searchButton = screen.queryByRole('button', { name: /^search$/i });
    if (searchButton) fireEvent.click(searchButton);
    const searchInput = screen.getByRole('textbox', { name: /find a place/i });

    fireEvent.change(searchInput, { target: { value: 'Mu' } });
    expect(screen.getByText('Museum Quarter')).toBeInTheDocument();
    expect(screen.queryByText('River Walk')).not.toBeInTheDocument();
    expect(bookingsApi.lookupPlaces).not.toHaveBeenCalled();

    fireEvent.change(searchInput, { target: { value: 'Mus' } });

    await waitFor(() => {
      expect(bookingsApi.lookupPlaces).toHaveBeenCalledWith('Mus', expect.any(String), 'Testville');
    });
    expect(screen.getByText(/on the map/i)).toBeInTheDocument();
    expect(screen.getByText('Museum Annex')).toBeInTheDocument();
    expect(discovery.discover).toHaveBeenCalledTimes(1);

    const sessionToken = bookingsApi.lookupPlaces.mock.calls[0][1];
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));
    fireEvent.click(screen.getByText('Day 1'));
    await waitFor(() => expect(bookingsApi.lookupHotelDetails).toHaveBeenCalledWith('google-1', sessionToken));
    expect(onAddStop).toHaveBeenCalledWith('day-1', expect.objectContaining({
      title: 'Museum Annex',
      lat: 12.3,
      lng: 45.6,
      providerId: 'google:google-1',
    }));
  });
});

describe('DiscoveryPanel — Option 1b result-flow and detail cleanup (Plan 14 Wave 1)', () => {
  it('shows a clean retry message instead of exposing provider error details', () => {
    render(
      <DiscoveryPanel
        trip={TRIP}
        days={DAYS}
        activeDay={DAYS[0]}
        onAddStop={vi.fn()}
        onClose={vi.fn()}
        discovery={makeDiscovery({ error: new Error('401 invalid x-api-key request_id=secret') })}
      />,
    );

    expect(screen.getByText('Couldn’t load places right now. Please try again.')).toBeInTheDocument();
    expect(screen.queryByText(/invalid x-api-key|request_id/i)).not.toBeInTheDocument();
  });

  it('renders exactly one Show more action in the scrolling result flow and preserves its working state', () => {
    const partialResults = { essentials: [{ id: 1, name: 'Essential A' }] };
    const completedCategories = new Set(['essentials']);
    const discovery = makeDiscovery({ partialResults, completedCategories, loading: false });
    const { rerender } = render(
      <DiscoveryPanel
        trip={TRIP}
        days={DAYS}
        activeDay={DAYS[0]}
        onAddStop={vi.fn()}
        onClose={vi.fn()}
        discovery={discovery}
      />,
    );

    const results = screen.getByRole('region', { name: /discovery results/i });
    expect(within(results).getAllByRole('button', { name: /^show more$/i })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /^show more$/i })).toHaveLength(1);

    rerender(
      <DiscoveryPanel
        trip={TRIP}
        days={DAYS}
        activeDay={DAYS[0]}
        onAddStop={vi.fn()}
        onClose={vi.fn()}
        discovery={makeDiscovery({ partialResults, completedCategories, loading: true })}
      />,
    );

    const workingButton = within(screen.getByRole('region', { name: /discovery results/i }))
      .getByRole('button', { name: /finding more places/i });
    expect(workingButton).toBeDisabled();
  });

  it('clears selected Details when its place is reported', async () => {
    discoveryApi.reportPlace.mockResolvedValue({ suppressed: true });
    const discovery = makeDiscovery({
      partialResults: { essentials: [{ id: 5, name: 'Fake Landmark', description: 'Suspicious.' }] },
      completedCategories: new Set(['essentials']),
    });

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

    fireEvent.click(screen.getByRole('button', { name: /details/i }));
    expect(screen.getByRole('region', { name: /details for fake landmark/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /report this place/i }));
    fireEvent.click(screen.getByRole('button', { name: /not real/i }));

    await waitFor(() => {
      expect(screen.queryByRole('region', { name: /details for fake landmark/i })).not.toBeInTheDocument();
      expect(screen.queryByText('Fake Landmark')).not.toBeInTheDocument();
    });
  });

  it('clears selected Details when a category or search state makes the place unavailable', () => {
    const discovery = makeDiscovery({
      partialResults: {
        essentials: [{ id: 1, name: 'Essential A', description: 'Core place' }],
        food: [{ id: 2, name: 'Food A', description: 'Dining place' }],
      },
      completedCategories: new Set(['essentials', 'food']),
    });

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

    fireEvent.click(screen.getByRole('button', { name: /details/i }));
    expect(screen.getByRole('region', { name: /details for essential a/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^food/i }));
    expect(screen.queryByRole('region', { name: /details for essential a/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^essentials/i }));
    fireEvent.click(screen.getByRole('button', { name: /details/i }));
    fireEvent.click(screen.getByRole('button', { name: /^search$/i }));
    fireEvent.change(screen.getByRole('textbox', { name: /find a place/i }), { target: { value: 'Food' } });
    expect(screen.queryByRole('region', { name: /details for essential a/i })).not.toBeInTheDocument();
    expect(screen.getByText('Food A')).toBeInTheDocument();
  });
});

describe('DiscoveryPanel — presentation follow-up', () => {
  it('shows the same "Find a place…" placeholder on desktop as mobile while preserving its aria-label', () => {
    const discovery = makeDiscovery({
      partialResults: { essentials: [{ id: 1, name: 'Essential A' }] },
      completedCategories: new Set(['essentials']),
    });

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

    // The desktop input keeps its descriptive accessible name ("Search
    // places") while showing the same visible hint as the mobile field so the
    // two read consistently. Because aria-label wins the accessible-name
    // computation over placeholder, this is also what lets tests target the
    // desktop vs mobile input unambiguously once both share a placeholder.
    const desktopInput = screen.getByRole('textbox', { name: 'Search places' });
    expect(desktopInput).toHaveAttribute('placeholder', 'Find a place…');
    expect(desktopInput).toHaveAttribute('aria-label', 'Search places');
  });

  it('cancel restores the committed header and results without refetching, and returns focus to Change', async () => {
    const discovery = makeDiscovery({
      partialResults: { essentials: [{ id: 1, name: 'Essential A' }] },
      completedCategories: new Set(['essentials']),
    });

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

    fireEvent.click(screen.getByRole('button', { name: /^change$/i }));
    const destinationInput = screen.getByPlaceholderText('Destination');
    fireEvent.change(destinationInput, { target: { value: 'Zzz Draft' } });
    expect(screen.getByText('Essential A')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(screen.queryByPlaceholderText('Destination')).not.toBeInTheDocument();
    expect(screen.getByText('Testville')).toBeInTheDocument();
    expect(screen.getByText('Essential A')).toBeInTheDocument();
    expect(discovery.discover).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /^change$/i })).toHaveFocus();
  });

  it('Escape in the destination input cancels edit the same way as clicking Cancel', () => {
    const discovery = makeDiscovery({
      partialResults: { essentials: [{ id: 1, name: 'Essential A' }] },
      completedCategories: new Set(['essentials']),
    });

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

    fireEvent.click(screen.getByRole('button', { name: /^change$/i }));
    const destinationInput = screen.getByPlaceholderText('Destination');
    fireEvent.change(destinationInput, { target: { value: 'Zzz Draft' } });

    fireEvent.keyDown(destinationInput, { key: 'Escape' });

    expect(screen.queryByPlaceholderText('Destination')).not.toBeInTheDocument();
    expect(screen.getByText('Testville')).toBeInTheDocument();
    expect(screen.getByText('Essential A')).toBeInTheDocument();
    expect(discovery.discover).toHaveBeenCalledTimes(1);
  });

  it('keeps every named category tab reachable, including Architecture and Wellness', () => {
    // buildTabs only fills in every named category when the trip's mapped
    // categories collapse to just 'essentials' (categories.length === 1) —
    // an empty interestTags list guarantees that here.
    const partialResults = {
      essentials: [{ id: 1, name: 'Essentials Item' }],
      culture: [{ id: 2, name: 'Culture Item' }],
      food: [{ id: 3, name: 'Food Item' }],
      nature: [{ id: 4, name: 'Nature Item' }],
      nightlife: [{ id: 5, name: 'Nightlife Item' }],
      hidden_gems: [{ id: 6, name: 'Hidden Item' }],
      architecture: [{ id: 7, name: 'Architecture Item' }],
      wellness: [{ id: 8, name: 'Wellness Item' }],
    };
    const completedCategories = new Set(Object.keys(partialResults));
    const discovery = makeDiscovery({ partialResults, completedCategories });
    const trip = { ...TRIP, interestTags: [] };

    render(
      <DiscoveryPanel
        trip={trip}
        days={DAYS}
        activeDay={DAYS[0]}
        onAddStop={vi.fn()}
        onClose={vi.fn()}
        discovery={discovery}
      />,
    );

    expect(screen.getByRole('button', { name: /^essentials/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^culture/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^food/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^nature/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^nightlife/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^hidden gems/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^architecture/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^wellness/i })).toBeInTheDocument();
  });
});

describe('DiscoveryPanel — inline country confirmation (Plan 26 W4.5, F-26-26)', () => {
  it('renders the confirmation on a country_required notice, pre-selects the suggested country, and confirming calls discover with the chosen code', async () => {
    bookingsApi.lookupCountries.mockResolvedValue({
      countries: [{ code: 'CN', name: 'China' }, { code: 'MY', name: 'Malaysia' }],
    });

    const discovery = makeDiscovery({
      notice: {
        code: 'country_required',
        message: "We don't know which country Suzhou is in — confirm it and we'll start its catalogue.",
        destination: 'Suzhou',
        suggestedCountryCode: 'MY',
      },
    });

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

    // The question line renders in the product's voice, and the empty-state
    // "Enter a destination" line must not render underneath it.
    expect(screen.getByText(/we don't know which country suzhou is in/i)).toBeInTheDocument();
    expect(screen.queryByText(/enter a destination and tap go/i)).not.toBeInTheDocument();

    const select = await screen.findByLabelText('Country');
    await waitFor(() => expect(select).toHaveValue('MY'));

    fireEvent.change(select, { target: { value: 'CN' } });
    fireEvent.click(screen.getByRole('button', { name: /^confirm$/i }));

    expect(discovery.discover).toHaveBeenCalledWith('Suzhou', 'CN');
    // Defect fix: confirming must also move committedDestination to
    // notice.destination ('Suzhou', which differs from the panel's original
    // 'Testville' default here) — otherwise getDestination() keeps reading
    // results under the OLD key while discover() streams them in under the
    // new one, and the confirmed catalogue never appears.
    await waitFor(() => expect(discovery.getDestination).toHaveBeenLastCalledWith('Suzhou', 'CN'));
  });

  it('leaves the panel usable and reports the error when the country list fails to load', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    bookingsApi.lookupCountries.mockRejectedValue(new Error('network down'));

    const discovery = makeDiscovery({
      notice: {
        code: 'country_required',
        message: "We don't know which country Suzhou is in — confirm it and we'll start its catalogue.",
        destination: 'Suzhou',
        suggestedCountryCode: null,
      },
    });

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

    await waitFor(() => expect(consoleError).toHaveBeenCalled());
    expect(screen.getByText(/couldn.t load the country list/i)).toBeInTheDocument();
    // The panel around the failed control stays intact and usable.
    expect(screen.getByText(/we don't know which country suzhou is in/i)).toBeInTheDocument();

    consoleError.mockRestore();
  });
});
