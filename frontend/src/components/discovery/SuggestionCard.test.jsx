// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
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
