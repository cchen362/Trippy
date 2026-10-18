// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import CopilotPanel from './CopilotPanel.jsx';

const { mockUseMediaQuery, mockAuth } = vi.hoisted(() => ({
  mockUseMediaQuery: vi.fn(() => false),
  mockAuth: { user: { id: 'owner-1' } },
}));

vi.mock('../../context/AuthContext.jsx', () => ({
  useAuth: () => ({ user: mockAuth.user }),
}));

vi.mock('../../hooks/useMediaQuery.js', () => ({
  default: mockUseMediaQuery,
}));

afterEach(cleanup);

beforeEach(() => {
  HTMLElement.prototype.scrollTo = vi.fn();
  mockUseMediaQuery.mockReturnValue(false);
  mockAuth.user = { id: 'owner-1' };
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
    removeExchange: vi.fn().mockResolvedValue({ removed: 2 }),
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

describe('CopilotPanel desktop readability', () => {
  it('uses the wider desktop sheet and larger conversation type', () => {
    mockUseMediaQuery.mockReturnValue(true);
    renderPanel({
      copilot: makeCopilot({
        messages: [{ id: 'm1', role: 'assistant', content: 'Readable desktop response', context: null }],
      }),
    });

    expect(screen.getByTestId('copilot-sheet')).toHaveStyle({
      width: 'calc(100% - 48px)',
      maxWidth: '800px',
    });
    expect(screen.getByText('Readable desktop response')).toHaveStyle({
      fontSize: '18px',
    });
    expect(screen.getByPlaceholderText('Message your co-pilot...')).toHaveStyle({
      fontSize: '18px',
    });
  });
});

// Plan 32 D-32-5: Remove on a stopped reply's notice line, for the question's author or the owner.
describe('CopilotPanel remove a stopped exchange (Plan 32)', () => {
  function exchange({ userId = 'collab-1', serverId = 'q1', notice = 'stopped' } = {}) {
    return [
      { id: 'u1', serverId, userId, role: 'user', content: 'Move Day 3 to Osaka', createdAt: '2026-01-01', context: null },
      { id: 'a1', serverId: 'a1', userId: null, role: 'assistant', content: 'Partial', createdAt: '2026-01-01', notice },
    ];
  }

  const removeLink = () => screen.queryByRole('button', { name: 'Remove' });

  it('shows Remove to the author of the question (a collaborator on their own question)', () => {
    mockAuth.user = { id: 'collab-1' };
    renderPanel({ copilot: makeCopilot({ messages: exchange({ userId: 'collab-1' }) }) });

    expect(removeLink()).toBeInTheDocument();
    expect(screen.getByText('This reply was stopped.')).toBeInTheDocument();
  });

  it('shows Remove to the trip owner on a collaborator question', () => {
    renderPanel({ copilot: makeCopilot({ messages: exchange({ userId: 'collab-1' }) }) });
    expect(removeLink()).toBeInTheDocument();
  });

  it("hides Remove on another collaborator's question when the viewer is not the owner", () => {
    mockAuth.user = { id: 'collab-2' };
    renderPanel({ copilot: makeCopilot({ messages: exchange({ userId: 'collab-1' }) }) });
    expect(removeLink()).not.toBeInTheDocument();
  });

  it('hides Remove while a reply is streaming', () => {
    renderPanel({ copilot: makeCopilot({ messages: exchange(), streaming: true }) });
    expect(removeLink()).not.toBeInTheDocument();
  });

  it.each([[null], ['interrupted']])('hides Remove on a reply whose notice is %s', (notice) => {
    renderPanel({ copilot: makeCopilot({ messages: exchange({ notice }) }) });
    expect(removeLink()).not.toBeInTheDocument();
  });

  it('hides Remove when the question has no server id yet', () => {
    renderPanel({ copilot: makeCopilot({ messages: exchange({ serverId: null }) }) });
    expect(removeLink()).not.toBeInTheDocument();
  });

  it('does not crash when the copilot object has no removeExchange', () => {
    renderPanel({ copilot: makeCopilot({ messages: exchange(), removeExchange: undefined }) });
    expect(removeLink()).not.toBeInTheDocument();
    expect(screen.getByText('This reply was stopped.')).toBeInTheDocument();
  });

  it('swaps the line for a confirm, focuses Keep, and Keep restores the line without removing', () => {
    const copilot = makeCopilot({ messages: exchange() });
    renderPanel({ copilot });

    fireEvent.click(removeLink());
    expect(screen.getByText('Remove question and reply?')).toBeInTheDocument();
    expect(screen.queryByText('This reply was stopped.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep' })).toHaveFocus();

    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(screen.getByText('This reply was stopped.')).toBeInTheDocument();
    expect(screen.queryByText('Remove question and reply?')).not.toBeInTheDocument();
    expect(copilot.removeExchange).not.toHaveBeenCalled();
  });

  it('calls removeExchange with the question server id when the confirm is accepted', () => {
    const copilot = makeCopilot({ messages: exchange({ serverId: 'srv-q9' }) });
    renderPanel({ copilot });

    fireEvent.click(removeLink());
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(copilot.removeExchange).toHaveBeenCalledWith('srv-q9');
  });

  it('shows the server sentence inline under the notice when the remove is rejected', async () => {
    const failure = Object.assign(new Error('This conversation changed — reload and try again.'), { status: 409 });
    const copilot = makeCopilot({
      messages: exchange(),
      removeExchange: vi.fn().mockRejectedValue(failure),
    });
    renderPanel({ copilot });

    fireEvent.click(removeLink());
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    expect(await screen.findByText('This conversation changed — reload and try again.')).toBeInTheDocument();
    expect(screen.getByText('This reply was stopped.')).toBeInTheDocument();

    // Tapping Remove again clears the error.
    fireEvent.click(removeLink());
    expect(screen.queryByText('This conversation changed — reload and try again.')).not.toBeInTheDocument();
  });

  it('gives each link a 36px minimum height on a coarse pointer', () => {
    mockUseMediaQuery.mockReturnValue(true);
    renderPanel({ copilot: makeCopilot({ messages: exchange() }) });

    expect(removeLink()).toHaveStyle({ minHeight: '36px' });
    fireEvent.click(removeLink());
    expect(screen.getByRole('button', { name: 'Keep' })).toHaveStyle({ minHeight: '36px' });
  });

  it('does not scroll the thread when an exchange above the last row leaves, but does when a row is appended', () => {
    const later = [
      { id: 'u2', serverId: 'q2', userId: 'owner-1', role: 'user', content: 'Right question', createdAt: '2026-01-02', context: null },
      { id: 'a2', serverId: 'a2', userId: null, role: 'assistant', content: 'Answer', createdAt: '2026-01-02', notice: null },
    ];
    const panel = (messages) => (
      <CopilotPanel
        copilot={makeCopilot({ messages })}
        context={{ tab: 'plan', dayId: null }}
        trip={{ id: 'trip-1', title: 'Test Trip' }}
        days={[]}
        bookings={[]}
        activeDayId={null}
        onClose={vi.fn()}
        onMutationApplied={vi.fn()}
        ownerId="owner-1"
      />
    );
    const { rerender } = render(panel([...exchange(), ...later]));
    HTMLElement.prototype.scrollTo.mockClear();

    rerender(panel(later));
    expect(HTMLElement.prototype.scrollTo).not.toHaveBeenCalled();

    rerender(panel([...later, { id: 'u3', role: 'user', content: 'Next', createdAt: '2026-01-03', context: null }]));
    expect(HTMLElement.prototype.scrollTo).toHaveBeenCalled();
  });
});

describe('CopilotPanel truncation notice (Plan 15 Wave 1)', () => {
  it('renders the cut-short notice under a message flagged as truncated', () => {
    renderPanel({
      copilot: makeCopilot({
        messages: [{
          id: 'm1',
          role: 'assistant',
          content: 'Some cut-off reply',
          createdAt: new Date().toISOString(),
          notice: 'truncated',
        }],
      }),
    });

    expect(screen.getByText('Reply cut short — ask me to continue.')).toBeInTheDocument();
  });

  it.each([
    ['refused', "I can't help with that one — try asking another way."],
    ['empty', 'Nothing came through that time — try asking again.'],
    ['stopped', 'This reply was stopped.'],
    ['interrupted', 'This reply was interrupted — ask again.'],
  ])('renders the %s notice copy', (notice, copy) => {
    renderPanel({
      copilot: makeCopilot({
        messages: [{
          id: 'm1',
          role: 'assistant',
          content: 'Partial text',
          createdAt: new Date().toISOString(),
          notice,
        }],
      }),
    });

    expect(screen.getByText(copy)).toBeInTheDocument();
    expect(screen.getByText('Partial text')).toBeInTheDocument();
  });

  it('renders the notice without an empty bubble when the row has no content', () => {
    renderPanel({
      copilot: makeCopilot({
        messages: [{ id: 'm1', role: 'assistant', content: '', createdAt: new Date().toISOString(), notice: 'empty' }],
      }),
    });

    const notice = screen.getByText('Nothing came through that time — try asking again.');
    expect(notice).toBeInTheDocument();
    // The notice's wrapper holds only the notice: no sibling bubble precedes it.
    expect(notice.parentElement.children).toHaveLength(1);
  });

  it('renders a stopped row that has no text as the notice alone, with no empty bubble', () => {
    renderPanel({
      copilot: makeCopilot({
        messages: [{ id: 'm1', role: 'assistant', content: '', createdAt: new Date().toISOString(), notice: 'stopped' }],
      }),
    });

    const notice = screen.getByText('This reply was stopped.');
    expect(notice).toBeInTheDocument();
    expect(notice.parentElement.children).toHaveLength(1);
    expect(document.body.querySelector('div[style*="border-radius: 2px 12px 12px 12px"]')).toBeNull();
  });

  it('still renders the bubble for an empty-content row with no notice (proposal-only turn)', () => {
    renderPanel({
      copilot: makeCopilot({
        messages: [{ id: 'm1', role: 'assistant', content: '', createdAt: new Date().toISOString() }],
      }),
    });

    expect(screen.queryByText('Start from your trip')).not.toBeInTheDocument();
    expect(document.body.querySelector('div[style*="border-radius: 2px 12px 12px 12px"]')).not.toBeNull();
  });

  it('does not render the notice for a message without a notice field', () => {
    renderPanel({
      copilot: makeCopilot({
        messages: [{
          id: 'm1',
          role: 'assistant',
          content: 'A normal complete reply',
          createdAt: new Date().toISOString(),
        }],
      }),
    });

    expect(screen.queryByText('Reply cut short — ask me to continue.')).not.toBeInTheDocument();
  });
});

describe('CopilotPanel tool activity line', () => {
  it.each([
    ['search_discovery_catalogue', 'Searching your Discovery picks…'],
    ['check_trip_health', 'Checking your trip…'],
    ['propose_itinerary_changes', 'Drafting the change…'],
  ])('labels %s in the co-pilot voice', (tool, label) => {
    renderPanel({ copilot: makeCopilot({ streaming: true, activeTool: tool }) });
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('renders no activity line when no tool is active', () => {
    renderPanel({ copilot: makeCopilot({ streaming: true }) });
    expect(screen.queryByText('Drafting the change…')).not.toBeInTheDocument();
  });
});
