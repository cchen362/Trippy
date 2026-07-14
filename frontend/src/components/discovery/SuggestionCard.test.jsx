// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import SuggestionCard from './SuggestionCard.jsx';

// Vitest doesn't register a global `afterEach` unless `test.globals` is set
// (this project's vitest.config.js doesn't), so @testing-library/react's
// automatic post-test cleanup never fires without this (see DiscoveryPanel.test.jsx).
afterEach(cleanup);

const SUGGESTION = {
  id: 1,
  name: 'Old Town',
  description: 'A place already added to the trip.',
  estimatedDuration: '1h',
};

const DETAILED_SUGGESTION = {
  id: 7,
  name: 'Panda Base',
  localName: '成都大熊猫繁育研究基地',
  description: 'Morning feedings are the whole show, before the pandas fall asleep.',
  whyItFits: 'Walk past the shuttle stop to reach the quieter nursery path.',
  fitLine: 'Best on an unhurried morning.',
  estimatedDuration: '3–4 hrs',
  openingHours: '07:30–18:00',
  provenance: 'verified',
};

describe('SuggestionCard co-pilot entry point', () => {
  it('preserves Add and report controls and forwards the real suggestion name without side effects', () => {
    const onOpenCopilot = vi.fn();
    const onAddToDay = vi.fn();
    const onReport = vi.fn();
    render(
      <SuggestionCard
        suggestion={SUGGESTION}
        days={[{ id: 'day-1', resolvedCity: 'Kyoto', stops: [] }]}
        onAddToDay={onAddToDay}
        destination="Kyoto"
        onReport={onReport}
        onOpenCopilot={onOpenCopilot}
      />,
    );

    expect(screen.getByRole('button', { name: /^add to day$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /report this place/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^ask co-pilot$/i }));

    expect(onOpenCopilot).toHaveBeenCalledWith({ tab: 'discovery', discoveryName: 'Old Town' });
    expect(onAddToDay).not.toHaveBeenCalled();
    expect(onReport).not.toHaveBeenCalled();
  });
});

describe('SuggestionCard — "in trip" city scoping (Wave 5 §5.4)', () => {
  it('matches a day resolved to a diacritic variant of the searched destination via canonicalGeoKey', () => {
    // The old `normalizeName` only lowercases and strips punctuation — it does
    // NOT strip combining diacritics, so "São Paulo" vs "Sao Paulo" would not
    // have matched under it. canonicalGeoKey NFD-normalizes and strips
    // diacritics, so this pair must now match.
    const days = [
      {
        id: 'day-1',
        dayIndex: 0,
        date: '2026-07-10',
        resolvedCity: 'São Paulo',
        stops: [{ title: 'Old Town' }],
      },
    ];

    render(
      <SuggestionCard
        suggestion={SUGGESTION}
        days={days}
        onAddToDay={() => {}}
        destination="Sao Paulo"
        onReport={() => {}}
      />,
    );

    expect(screen.getByText('In trip')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /added/i })).toBeInTheDocument();
  });

  it('does not match a day resolved to an unrelated city', () => {
    const days = [
      {
        id: 'day-1',
        dayIndex: 0,
        date: '2026-07-10',
        resolvedCity: 'Rio de Janeiro',
        stops: [{ title: 'Old Town' }],
      },
    ];

    render(
      <SuggestionCard
        suggestion={SUGGESTION}
        days={days}
        onAddToDay={() => {}}
        destination="Sao Paulo"
        onReport={() => {}}
      />,
    );

    expect(screen.queryByText('In trip')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^add to day$/i })).toBeInTheDocument();
  });
});

describe('SuggestionCard — per-suggestion pending state (Wave 4 §4.2)', () => {
  function deferred() {
    let resolve;
    const promise = new Promise((res) => { resolve = res; });
    return { promise, resolve };
  }

  it('disables Add while its own add is in flight, then re-enables on settle', async () => {
    const day = { id: 'day-1', dayIndex: 0, date: '2026-07-10', resolvedCity: 'Kyoto', stops: [] };
    const pending = deferred();
    const onAddToDay = vi.fn(() => pending.promise);

    render(
      <SuggestionCard
        suggestion={SUGGESTION}
        days={[day]}
        onAddToDay={onAddToDay}
        destination="Kyoto"
        onReport={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^add to day$/i }));
    fireEvent.click(screen.getByText(/Day 1/));

    expect(onAddToDay).toHaveBeenCalledWith('day-1', SUGGESTION);
    const button = await screen.findByRole('button', { name: /adding/i });
    expect(button).toBeDisabled();

    pending.resolve();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^add to day$/i })).not.toBeDisabled();
    });
  });

  it('does not block a second Add click on the same suggestion while pending', async () => {
    const day = { id: 'day-1', dayIndex: 0, date: '2026-07-10', resolvedCity: 'Kyoto', stops: [] };
    const pending = deferred();
    const onAddToDay = vi.fn(() => pending.promise);

    render(
      <SuggestionCard
        suggestion={SUGGESTION}
        days={[day]}
        onAddToDay={onAddToDay}
        destination="Kyoto"
        onReport={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^add to day$/i }));
    fireEvent.click(screen.getByText(/Day 1/));
    const addingButton = await screen.findByRole('button', { name: /adding/i });

    // The button is disabled and re-clicking it (or re-opening the picker)
    // must not fire a second onAddToDay call for this same suggestion.
    fireEvent.click(addingButton);
    expect(onAddToDay).toHaveBeenCalledTimes(1);

    pending.resolve();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^add to day$/i })).not.toBeDisabled();
    });
  });
});

describe('SuggestionCard — Option 1b Details contract (Plan 14 Wave 1)', () => {
  const days = [
    { id: 'day-1', dayIndex: 0, date: '2026-07-10', resolvedCity: 'Chengdu', stops: [] },
  ];

  it('exposes bounded summary content, then reveals full metadata without side effects', () => {
    const onAddToDay = vi.fn();
    const onReport = vi.fn();
    const onOpenCopilot = vi.fn();
    render(
      <SuggestionCard
        suggestion={DETAILED_SUGGESTION}
        days={days}
        onAddToDay={onAddToDay}
        destination="Chengdu"
        onReport={onReport}
        onOpenCopilot={onOpenCopilot}
      />,
    );

    expect(screen.getByText(DETAILED_SUGGESTION.description)).toBeVisible();
    expect(screen.getByText(DETAILED_SUGGESTION.whyItFits)).toBeVisible();
    expect(screen.getByText(DETAILED_SUGGESTION.estimatedDuration)).toBeInTheDocument();
    expect(screen.queryByText(/07:30–18:00/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^verified$/i)).not.toBeInTheDocument();

    const detailsButton = screen.getByRole('button', { name: /^details/i });
    expect(detailsButton).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(detailsButton);

    expect(detailsButton).toHaveAttribute('aria-expanded', 'true');
    const details = screen.getByRole('region', { name: /details for panda base/i });
    expect(within(details).getByText(/07:30–18:00/)).toBeInTheDocument();
    expect(within(details).getByText(/^verified$/i)).toBeInTheDocument();
    expect(within(details).getByText(DETAILED_SUGGESTION.fitLine)).toBeInTheDocument();
    expect(onAddToDay).not.toHaveBeenCalled();
    expect(onReport).not.toHaveBeenCalled();
    expect(onOpenCopilot).not.toHaveBeenCalled();
  });

  it('preserves exact co-pilot context and the two-step report flow from Details', async () => {
    const onAddToDay = vi.fn();
    const onReport = vi.fn().mockResolvedValue(undefined);
    const onOpenCopilot = vi.fn();
    render(
      <SuggestionCard
        suggestion={DETAILED_SUGGESTION}
        days={days}
        onAddToDay={onAddToDay}
        destination="Chengdu"
        onReport={onReport}
        onOpenCopilot={onOpenCopilot}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^details/i }));
    fireEvent.click(screen.getByRole('button', { name: /^ask co-pilot$/i }));
    expect(onOpenCopilot).toHaveBeenCalledWith({ tab: 'discovery', discoveryName: 'Panda Base' });
    expect(onAddToDay).not.toHaveBeenCalled();
    expect(onReport).not.toHaveBeenCalled();

    const reportButton = screen.getByRole('button', { name: /report this place/i });
    fireEvent.click(reportButton);
    expect(onReport).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /not real/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /closed/i })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('button', { name: /not real/i })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: /details for panda base/i })).toBeInTheDocument();
    expect(reportButton).toHaveFocus();

    fireEvent.click(reportButton);
    fireEvent.click(screen.getByRole('button', { name: /closed/i }));
    await waitFor(() => expect(onReport).toHaveBeenCalledWith(7));
  });

  it('opens DayPicker from Details and keeps the per-card pending guard', async () => {
    let resolveAdd;
    const pendingAdd = new Promise((resolve) => { resolveAdd = resolve; });
    const onAddToDay = vi.fn(() => pendingAdd);
    render(
      <SuggestionCard
        suggestion={DETAILED_SUGGESTION}
        days={days}
        onAddToDay={onAddToDay}
        destination="Chengdu"
        onReport={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^details/i }));
    const addButton = screen.getByRole('button', { name: /^add to day$/i });
    fireEvent.click(addButton);
    expect(screen.getByText(/Day 1/)).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText(/Day 1/)).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: /details for panda base/i })).toBeInTheDocument();
    expect(addButton).toHaveFocus();

    fireEvent.click(addButton);
    fireEvent.click(screen.getByText(/Day 1/));

    expect(onAddToDay).toHaveBeenCalledWith('day-1', DETAILED_SUGGESTION);
    const addingButton = await screen.findByRole('button', { name: /adding/i });
    expect(addingButton).toBeDisabled();
    fireEvent.click(addingButton);
    expect(onAddToDay).toHaveBeenCalledTimes(1);

    resolveAdd();
    await waitFor(() => expect(screen.getByRole('button', { name: /^add to day$/i })).not.toBeDisabled());
  });

  it('retains every matching day in the compact multi-day In trip display', () => {
    const inTripDays = [
      {
        id: 'day-1', dayIndex: 0, date: '2026-07-10', resolvedCity: 'Chengdu',
        stops: [{ title: 'Panda Base' }],
      },
      {
        id: 'day-3', dayIndex: 2, date: '2026-07-12', resolvedCity: 'Chengdu',
        stops: [{ title: 'Panda Base' }],
      },
    ];
    render(
      <SuggestionCard
        suggestion={DETAILED_SUGGESTION}
        days={inTripDays}
        onAddToDay={vi.fn()}
        destination="Chengdu"
        onReport={vi.fn()}
      />,
    );

    expect(screen.getByText(/in trip/i)).toBeInTheDocument();
    expect(screen.getByText(/Day 1/)).toBeInTheDocument();
    expect(screen.getByText(/Day 3/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /added/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^details/i })).toBeInTheDocument();
  });
});
