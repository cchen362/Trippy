// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import DestinationChipPicker from './DestinationChipPicker.jsx';
import { bookingsApi } from '../../services/bookingsApi.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// The picker mutates chips via functional onChange updaters (so an async bounds fetch
// can't clobber a just-added chip — see the "async bounds fetch never clobbers" test and
// the EditTripModal regression). resolveUpdate mirrors what React's real setState does:
// apply the updater to the current value. Tests assert on the resulting array.
function resolveUpdate(update, current) {
  return typeof update === 'function' ? update(current) : update;
}

describe('DestinationChipPicker — chip shape and dedup', () => {
  it('addChip stores {label, countryCode, kind, placeId, bounds} from a picker suggestion', async () => {
    const onChange = vi.fn();
    const lookupCities = async () => ({
      suggestions: [{ label: 'Bali', countryCode: 'ID', kind: 'region', placeId: null }],
    });
    render(<DestinationChipPicker chips={[]} onChange={onChange} lookupCities={lookupCities} />);

    const input = screen.getByLabelText('Destinations');
    fireEvent.change(input, { target: { value: 'Bal' } });

    const suggestionButton = await waitFor(() => screen.getByText('Bali').closest('button'));
    fireEvent.click(suggestionButton);

    expect(resolveUpdate(onChange.mock.calls[0][0], [])).toEqual([
      { label: 'Bali', countryCode: 'ID', kind: 'region', placeId: null, bounds: null },
    ]);
  });

  it('dedupes case-insensitively by label', async () => {
    const onChange = vi.fn();
    const lookupCities = async () => ({
      suggestions: [{ label: 'bali', countryCode: 'ID', kind: 'region' }],
    });
    const chips = [{ label: 'Bali', countryCode: 'ID', kind: 'region', placeId: null, bounds: null }];
    render(<DestinationChipPicker chips={chips} onChange={onChange} lookupCities={lookupCities} />);

    const input = screen.getByLabelText('Destinations');
    fireEvent.change(input, { target: { value: 'bal' } });

    const suggestionButton = await waitFor(() => screen.getByText('bali').closest('button'));
    fireEvent.click(suggestionButton);

    // Duplicate (case-insensitive): the functional updater returns the list unchanged
    // (identity), appending nothing.
    expect(resolveUpdate(onChange.mock.calls[0][0], chips)).toEqual(chips);
  });

  it('removes a chip by label', () => {
    const chips = [{ label: 'Bali', countryCode: 'ID', kind: 'region', placeId: null, bounds: null }];
    const onChange = vi.fn();
    render(<DestinationChipPicker chips={chips} onChange={onChange} lookupCities={async () => ({ suggestions: [] })} />);

    expect(screen.getByText('Bali')).toBeInTheDocument();

    const removeButton = screen.getByText('Bali').closest('button');
    fireEvent.click(removeButton);
    expect(resolveUpdate(onChange.mock.calls[0][0], chips)).toEqual([]);
  });

  it('adds a free-text chip on Enter with a FREETEXT tag, no gold styling on the tag', async () => {
    const onChange = vi.fn();
    render(
      <DestinationChipPicker
        chips={[]}
        onChange={onChange}
        lookupCities={async () => ({ suggestions: [] })}
      />
    );

    const input = screen.getByLabelText('Destinations');
    fireEvent.change(input, { target: { value: 'Somewhere Remote' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(resolveUpdate(onChange.mock.calls[0][0], [])).toEqual([
      { label: 'Somewhere Remote', countryCode: null, kind: 'freetext', placeId: null, bounds: null },
    ]);

    // Re-render with the committed chip to assert the tag renders without gold.
    cleanup();
    render(
      <DestinationChipPicker
        chips={[{ label: 'Somewhere Remote', countryCode: null, kind: 'freetext', placeId: null, bounds: null }]}
        onChange={onChange}
        lookupCities={async () => ({ suggestions: [] })}
      />
    );
    const tag = screen.getByText('FREETEXT');
    expect(tag).toBeInTheDocument();
    expect(tag.style.color).not.toBe('var(--gold)');
  });

  it('adds a chip immediately on suggestion select with a placeId, then attaches bounds once the async lookup resolves', async () => {
    let chips = [];
    const onChange = vi.fn((update) => {
      chips = typeof update === 'function' ? update(chips) : update;
    });
    vi.spyOn(bookingsApi, 'lookupDestinationBounds').mockResolvedValue({
      placeId: 'place-123',
      bounds: { low: { lat: 1, lng: 2 }, high: { lat: 3, lng: 4 } },
    });
    const lookupCities = async () => ({
      suggestions: [{ label: 'Chengdu', countryCode: 'CN', kind: 'city', placeId: 'place-123' }],
    });

    const { rerender } = render(<DestinationChipPicker chips={chips} onChange={onChange} lookupCities={lookupCities} />);
    const input = screen.getByLabelText('Destinations');
    fireEvent.change(input, { target: { value: 'Cheng' } });
    const suggestionButton = await waitFor(() => screen.getByText('Chengdu').closest('button'));
    fireEvent.click(suggestionButton);

    // Chip is added immediately with bounds:null — not blocked on the async fetch.
    expect(chips).toEqual([
      { label: 'Chengdu', countryCode: 'CN', kind: 'city', placeId: 'place-123', bounds: null },
    ]);
    rerender(<DestinationChipPicker chips={chips} onChange={onChange} lookupCities={lookupCities} />);

    await waitFor(() => {
      expect(bookingsApi.lookupDestinationBounds).toHaveBeenCalledWith('place-123', expect.any(String));
    });
    await waitFor(() => {
      expect(chips[0].bounds).toEqual({ low: { lat: 1, lng: 2 }, high: { lat: 3, lng: 4 } });
    });
  });

  it('leaves bounds null without throwing when the bounds fetch rejects', async () => {
    let chips = [];
    const onChange = vi.fn((update) => {
      chips = typeof update === 'function' ? update(chips) : update;
    });
    vi.spyOn(bookingsApi, 'lookupDestinationBounds').mockRejectedValue(new Error('network down'));
    const lookupCities = async () => ({
      suggestions: [{ label: 'Chengdu', countryCode: 'CN', kind: 'city', placeId: 'place-123' }],
    });

    render(<DestinationChipPicker chips={chips} onChange={onChange} lookupCities={lookupCities} />);
    const input = screen.getByLabelText('Destinations');
    fireEvent.change(input, { target: { value: 'Cheng' } });
    const suggestionButton = await waitFor(() => screen.getByText('Chengdu').closest('button'));
    fireEvent.click(suggestionButton);

    expect(chips).toEqual([
      { label: 'Chengdu', countryCode: 'CN', kind: 'city', placeId: 'place-123', bounds: null },
    ]);

    await waitFor(() => {
      expect(bookingsApi.lookupDestinationBounds).toHaveBeenCalled();
    });
    // Give the rejected promise a tick to settle; chip should remain intact, bounds null.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(chips).toEqual([
      { label: 'Chengdu', countryCode: 'CN', kind: 'city', placeId: 'place-123', bounds: null },
    ]);
  });
});
