// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import DestinationChipPicker from './DestinationChipPicker.jsx';

afterEach(cleanup);

describe('DestinationChipPicker — chip shape and dedup', () => {
  it('addChip stores {label, countryCode, kind} from a picker suggestion', async () => {
    const onChange = vi.fn();
    const lookupCities = async () => ({
      suggestions: [{ label: 'Bali', countryCode: 'ID', kind: 'region' }],
    });
    render(<DestinationChipPicker chips={[]} onChange={onChange} lookupCities={lookupCities} />);

    const input = screen.getByLabelText('Destinations');
    fireEvent.change(input, { target: { value: 'Bal' } });

    const suggestionButton = await waitFor(() => screen.getByText('Bali').closest('button'));
    fireEvent.click(suggestionButton);

    expect(onChange).toHaveBeenCalledWith([{ label: 'Bali', countryCode: 'ID', kind: 'region' }]);
  });

  it('dedupes case-insensitively by label', async () => {
    const onChange = vi.fn();
    const lookupCities = async () => ({
      suggestions: [{ label: 'bali', countryCode: 'ID', kind: 'region' }],
    });
    const chips = [{ label: 'Bali', countryCode: 'ID', kind: 'region' }];
    render(<DestinationChipPicker chips={chips} onChange={onChange} lookupCities={lookupCities} />);

    const input = screen.getByLabelText('Destinations');
    fireEvent.change(input, { target: { value: 'bal' } });

    const suggestionButton = await waitFor(() => screen.getByText('bali').closest('button'));
    fireEvent.click(suggestionButton);

    // Duplicate (case-insensitive) — onChange should not be called with an appended chip
    expect(onChange).not.toHaveBeenCalled();
  });

  it('removes a chip by label', () => {
    const chips = [{ label: 'Bali', countryCode: 'ID', kind: 'region' }];
    const onChange = vi.fn();
    render(<DestinationChipPicker chips={chips} onChange={onChange} lookupCities={async () => ({ suggestions: [] })} />);

    expect(screen.getByText('Bali')).toBeInTheDocument();

    const removeButton = screen.getByText('Bali').closest('button');
    fireEvent.click(removeButton);
    expect(onChange).toHaveBeenCalledWith([]);
  });
});
