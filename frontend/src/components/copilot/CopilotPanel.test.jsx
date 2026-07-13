// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import CopilotPanel from './CopilotPanel.jsx';

vi.mock('../../context/AuthContext.jsx', () => ({
  useAuth: () => ({ user: { id: 'owner-1' } }),
}));

vi.mock('../../hooks/useMediaQuery.js', () => ({
  default: () => false,
}));

afterEach(cleanup);

beforeEach(() => {
  HTMLElement.prototype.scrollTo = vi.fn();
});

function makeCopilot(overrides = {}) {
  return {
    messages: [],
    streaming: false,
    streamingText: '',
    activeTool: null,
    proposals: [],
    error: null,
    send: vi.fn(),
    applyProposal: vi.fn(),
    rejectProposal: vi.fn(),
    cancel: vi.fn(),
    clear: vi.fn(),
    ...overrides,
  };
}

function renderPanel({ copilot = makeCopilot(), days = [], bookings = [], activeDayId = null } = {}) {
  const context = { tab: 'plan', dayId: activeDayId };
  render(
    <CopilotPanel
      copilot={copilot}
      context={context}
      trip={{ id: 'trip-1', title: 'Test Trip' }}
      days={days}
      bookings={bookings}
      activeDayId={activeDayId}
      onClose={vi.fn()}
      onMutationApplied={vi.fn()}
      ownerId="owner-1"
    />,
  );
  return { copilot, context };
}

describe('CopilotPanel grounded empty state', () => {
  it('renders grounded prompts and sends the selected text with captured context', () => {
    const days = [{
      id: 'day-1',
      date: '2026-06-11',
      resolvedCity: 'Hangzhou',
      stops: [{ id: 'stop-1', type: 'experience', time: null }],
    }];
    const { copilot, context } = renderPanel({ days, activeDayId: 'day-1' });
    const prompt = 'How should I order the 1 untimed stop on Day 1 in Hangzhou?';

    expect(screen.getByText('Start from your trip')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: new RegExp(prompt.replace(/[?]/g, '\\?')) }));
    expect(copilot.send).toHaveBeenCalledWith(prompt, context);
  });

  it('renders the degenerate fallback', () => {
    renderPanel();
    expect(screen.getByRole('button', { name: /what's worth knowing about this trip/i })).toBeInTheDocument();
  });

  it('does not render seeds for a non-empty conversation', () => {
    renderPanel({
      copilot: makeCopilot({
        messages: [{ id: 'm1', role: 'user', content: 'Existing turn', context: null }],
      }),
    });
    expect(screen.queryByText('Start from your trip')).not.toBeInTheDocument();
    expect(screen.getByText('Existing turn')).toBeInTheDocument();
  });
});
