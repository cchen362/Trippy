// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import LogisticsTab from './LogisticsTab.jsx';
import { factsApi } from '../services/factsApi.js';
import { bookingsApi } from '../services/bookingsApi.js';

const hotel = {
  id: 'b-hotel',
  type: 'hotel',
  title: 'Marina Hotel',
  documents: [
    { url: '/api/docs/hotel-1', mediaType: 'application/pdf', filename: 'Hotel.pdf', key: 'artifactFile:1', source: 'import' },
    { url: '/api/docs/att-2', mediaType: 'image/png', filename: '', key: 'attachment:2', source: 'attachment' },
  ],
};
const flight = { id: 'b-flight', type: 'flight', title: 'SQ 12', documents: [] };

const mockContext = {
  trip: { id: 'trip-1', startDate: '2026-06-08', endDate: '2026-06-12' },
  bookings: [hotel, flight],
  activeDay: { id: 'day-1' },
  refresh: vi.fn(),
  bookingActions: {
    createBooking: vi.fn(),
    updateBooking: vi.fn(),
    deleteBooking: vi.fn(),
    saving: false,
    lookupHotels: vi.fn(),
    lookupHotelDetails: vi.fn(),
    lookupFlight: vi.fn(),
    lookupCities: vi.fn(),
  },
};

vi.mock('./TripPage.jsx', () => ({ useTripContext: () => mockContext }));
vi.mock('../context/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 'user-1' } }) }));
vi.mock('../hooks/useExpenses.js', () => ({
  useExpenses: () => ({ expenses: [], summaryCurrency: 'SGD', saving: false, refresh: vi.fn() }),
}));
vi.mock('../hooks/useCollaboration.js', () => ({
  useCollaboration: () => ({ owner: null, collaborators: [] }),
}));
vi.mock('../services/factsApi.js', () => ({ factsApi: { list: vi.fn() } }));
vi.mock('../services/bookingsApi.js', () => ({
  bookingsApi: { addAttachment: vi.fn(), removeAttachment: vi.fn() },
}));
vi.mock('../services/importApi.js', () => ({
  fileToInput: vi.fn().mockResolvedValue({ mediaType: 'application/pdf', filename: 'x.pdf', content: 'AA' }),
}));

// The cards, modals and expense sheet have their own suites; here they are reduced to the
// one thing LogisticsTab wires: a card opens its booking's detail sheet.
function stubCard(name) {
  return {
    default: ({ booking, onOpen }) => (
      <button type="button" onClick={() => onOpen(booking)}>{`${name}:${booking.title}`}</button>
    ),
  };
}
vi.mock('../components/logistics/HotelBookingCard.jsx', () => stubCard('hotel'));
vi.mock('../components/logistics/FlightBookingCard.jsx', () => stubCard('flight'));
vi.mock('../components/logistics/TrainBookingCard.jsx', () => stubCard('train'));
vi.mock('../components/logistics/OtherBookingCard.jsx', () => stubCard('other'));
vi.mock('../components/logistics/AddBookingModal.jsx', () => ({ default: () => null }));
vi.mock('../components/import/CaptureFlow.jsx', () => ({ default: () => null }));
vi.mock('../components/expenses/ExpenseSheet.jsx', () => ({ default: () => null }));

const FACTS = {
  bookings: [{
    bookingId: 'b-hotel',
    facts: [
      {
        id: 'f-instruction', kind: 'instruction', label: 'Early check-in', value: 'Ask at the desk',
        quote: 'Early check-in on request', page: '2', quoteVerified: true, at: '', tz: '', tzSource: 'none',
        document: { key: 'artifactFile:1', kind: 'pdf', mediaType: 'application/pdf', filename: 'Hotel.pdf', url: '/api/docs/hotel-1' },
      },
      {
        id: 'f-deadline', kind: 'deadline', label: 'Free cancellation until', value: 'Before 3 pm',
        quote: 'Free cancellation until 15:00', page: '2', quoteVerified: true, at: '2026-06-09T15:00',
        tz: 'Asia/Singapore', tzSource: 'document',
        document: { key: 'artifactFile:1', kind: 'pdf', mediaType: 'application/pdf', filename: 'Hotel.pdf', url: '/api/docs/hotel-1' },
      },
      {
        id: 'f-window', kind: 'window', label: 'Check-in window', value: 'From 2 pm',
        quote: 'Check-in from 14:00', page: '', quoteVerified: false, at: '2026-06-10T14:00', tz: '', tzSource: 'none',
        document: { key: 'attachment:2', kind: 'image', mediaType: 'image/png', filename: '', url: '/api/docs/att-2' },
      },
      {
        id: 'f-text', kind: 'requirement', label: 'Deposit', value: 'Card held at arrival',
        quote: 'A card is held at arrival', page: '', quoteVerified: true, at: '', tz: '', tzSource: 'none',
        document: { key: 'artifactText:9', kind: 'text', mediaType: 'text/plain', filename: '', url: null },
      },
    ],
  }],
  readsPending: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  factsApi.list.mockResolvedValue(FACTS);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderTab() {
  return render(<MemoryRouter><LogisticsTab /></MemoryRouter>);
}

async function openHotelSheet() {
  renderTab();
  await waitFor(() => expect(factsApi.list).toHaveBeenCalled());
  fireEvent.click(screen.getByText('hotel:Marina Hotel'));
}

describe('LogisticsTab — Conditions in the detail sheet (Plan 37 W2)', () => {
  it('shows Conditions with the primary group first, then "Also in the document"', async () => {
    await openHotelSheet();
    await screen.findByText('Conditions');
    const text = document.body.textContent;
    const deadline = text.indexOf('Free cancellation until');
    const window_ = text.indexOf('Check-in window');
    const requirement = text.indexOf('Deposit');
    const secondaryLabel = text.indexOf('Also in the document');
    const instruction = text.indexOf('Early check-in');
    expect(deadline).toBeGreaterThan(-1);
    expect(deadline).toBeLessThan(window_);
    expect(window_).toBeLessThan(requirement);
    expect(requirement).toBeLessThan(secondaryLabel);
    expect(secondaryLabel).toBeLessThan(instruction);
  });

  it('opens a PDF source at its page without changing the document url', async () => {
    await openHotelSheet();
    // The deadline and the instruction both cite page 2 of the hotel PDF; either opens it there.
    const sources = await screen.findAllByRole('button', { name: /p\.2 · read from PDF · Hotel\.pdf/ });
    expect(sources).toHaveLength(2);
    fireEvent.click(sources[0]);
    const frame = document.querySelector('iframe');
    expect(frame.getAttribute('src')).toBe('/api/docs/hotel-1#page=2');
    expect(hotel.documents[0].url).toBe('/api/docs/hotel-1');

    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));
    expect(document.querySelector('iframe')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Hotel.pdf' }));
    expect(document.querySelector('iframe').getAttribute('src')).toBe('/api/docs/hotel-1');
  });

  it('shows a pasted-text source as plain text, not a button', async () => {
    await openHotelSheet();
    const line = await screen.findByText('from the pasted confirmation');
    expect(line.closest('button')).toBeNull();
  });

  it('keeps a time as written and says when the zone is not stated', async () => {
    await openHotelSheet();
    await screen.findByText('Conditions');
    expect(screen.getByText('10 Jun 14:00 zone not stated')).toBeInTheDocument();
    expect(screen.getByText(/^9 Jun 15:00 \S+/)).toBeInTheDocument();
  });

  it('shows no Conditions for a booking without facts', async () => {
    renderTab();
    await waitFor(() => expect(factsApi.list).toHaveBeenCalled());
    fireEvent.click(screen.getByText('flight:SQ 12'));
    await screen.findByText('Costs');
    expect(screen.queryByText('Conditions')).toBeNull();
    expect(screen.queryByText('Also in the document')).toBeNull();
  });
});

describe('LogisticsTab — facts failing to load', () => {
  it('renders the bookings with no error text and logs to the console', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    factsApi.list.mockRejectedValue(new Error('Network down'));
    renderTab();
    await waitFor(() => expect(consoleError).toHaveBeenCalledWith('[facts] load failed:', 'Network down'));
    expect(screen.getByText('hotel:Marina Hotel')).toBeInTheDocument();
    expect(screen.getByText('flight:SQ 12')).toBeInTheDocument();
    expect(screen.queryByText(/network down/i)).toBeNull();
    consoleError.mockRestore();
  });
});

describe('LogisticsTab — follow-up fetch after an attach', () => {
  it('fetches at once, then exactly once more after 10 seconds', async () => {
    vi.useFakeTimers();
    bookingsApi.addAttachment.mockResolvedValue({});
    mockContext.refresh.mockResolvedValue(undefined);
    renderTab();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(factsApi.list).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText('hotel:Marina Hotel'));
    const input = document.querySelector('input[type="file"]');
    const file = new File(['x'], 'x.pdf', { type: 'application/pdf' });
    await act(async () => { fireEvent.change(input, { target: { files: [file] } }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(bookingsApi.addAttachment).toHaveBeenCalledTimes(1);
    expect(factsApi.list).toHaveBeenCalledTimes(2);

    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(factsApi.list).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(factsApi.list).toHaveBeenCalledTimes(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(factsApi.list).toHaveBeenCalledTimes(3);
  });
});
