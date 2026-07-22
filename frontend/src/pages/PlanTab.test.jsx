// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import PlanTab from './PlanTab.jsx';

afterEach(cleanup);

const mockContext = {
  trip: { id: 'trip-1' },
  days: [{ id: 'day-1' }, { id: 'day-2' }],
  activeDay: { id: 'day-1' },
  activeDayId: 'day-1',
  setActiveDayId: vi.fn(),
  stopActions: {
    reorderStops: vi.fn(),
    createStop: vi.fn(),
    saving: false,
    deleteStop: vi.fn(),
    updateStop: vi.fn(),
  },
  discovery: {},
  refresh: vi.fn(),
  reportError: vi.fn(),
};

vi.mock('./TripPage.jsx', () => ({
  useTripContext: () => mockContext,
}));

// Timeline/DayHeader/DayTabs are presentational leaves that just wire props
// through to StopCard — stubbed here so the test exercises only PlanTab's
// own handleMove wiring, not Timeline's dnd-kit reorder machinery.
vi.mock('../components/timeline/Timeline.jsx', () => ({
  default: ({ onMove }) => (
    <button type="button" onClick={() => onMove('stop-1', 'day-2')}>trigger-move</button>
  ),
}));
vi.mock('../components/timeline/DayHeader.jsx', () => ({ default: () => null }));
vi.mock('../components/timeline/DayTabs.jsx', () => ({ default: () => null }));

describe('PlanTab — move failure surfaces feedback (Wave 4 §4.2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports a failed move via reportError instead of silently swallowing it', async () => {
    const err = new Error('Network drop');
    mockContext.stopActions.updateStop.mockRejectedValueOnce(err);

    render(<PlanTab />);
    fireEvent.click(screen.getByText('trigger-move'));

    await waitFor(() => {
      expect(mockContext.reportError).toHaveBeenCalledWith(err, 'Could not move that stop.');
    });
    expect(mockContext.stopActions.updateStop).toHaveBeenCalledWith('stop-1', { dayId: 'day-2' });
  });

  it('does not call reportError on a successful move', async () => {
    mockContext.stopActions.updateStop.mockResolvedValueOnce({});

    render(<PlanTab />);
    fireEvent.click(screen.getByText('trigger-move'));

    await waitFor(() => {
      expect(mockContext.stopActions.updateStop).toHaveBeenCalledWith('stop-1', { dayId: 'day-2' });
    });
    expect(mockContext.reportError).not.toHaveBeenCalled();
  });
});
