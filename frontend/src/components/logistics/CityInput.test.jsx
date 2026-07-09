// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import CityInput from './CityInput.jsx';

afterEach(cleanup);

describe('CityInput — region tag and suggestion rendering', () => {
  it('renders a REGION tag for a region-kind suggestion', () => {
    render(
      <CityInput
        value="Bal"
        onChange={() => {}}
        onCitySelect={() => {}}
        lookupCities={async () => ({
          suggestions: [{ label: 'Bali', countryCode: 'ID', kind: 'region' }],
        })}
        placeholder="e.g. Chengdu"
        label="City"
      />
    );
    return waitFor(() => {
      expect(screen.getByText('Bali')).toBeInTheDocument();
      expect(screen.getByText('REGION')).toBeInTheDocument();
      expect(screen.getByText('ID')).toBeInTheDocument();
    });
  });

  it('does not render a REGION tag for a city-kind suggestion', () => {
    render(
      <CityInput
        value="Chen"
        onChange={() => {}}
        onCitySelect={() => {}}
        lookupCities={async () => ({
          suggestions: [{ label: 'Chengdu', countryCode: 'CN', kind: 'city' }],
        })}
        placeholder="e.g. Chengdu"
        label="City"
      />
    );
    return waitFor(() => {
      expect(screen.getByText('Chengdu')).toBeInTheDocument();
      expect(screen.queryByText('REGION')).not.toBeInTheDocument();
    });
  });

  it('calls onCitySelect with the full suggestion object on click', async () => {
    const onCitySelect = vi.fn();
    const suggestion = { label: 'Bali', countryCode: 'ID', kind: 'region' };
    render(
      <CityInput
        value="Bal"
        onChange={() => {}}
        onCitySelect={onCitySelect}
        lookupCities={async () => ({ suggestions: [suggestion] })}
        placeholder="e.g. Chengdu"
        label="City"
      />
    );
    const button = await waitFor(() => screen.getByText('Bali').closest('button'));
    fireEvent.click(button);
    expect(onCitySelect).toHaveBeenCalledWith(suggestion);
  });

  it('commits free text on Enter via onFreeTextCommit when provided', () => {
    const onFreeTextCommit = vi.fn();
    const onCitySelect = vi.fn();
    render(
      <CityInput
        value="Somewhere Remote"
        onChange={() => {}}
        onCitySelect={onCitySelect}
        onFreeTextCommit={onFreeTextCommit}
        lookupCities={async () => ({ suggestions: [] })}
        placeholder="e.g. Chengdu"
        label="City"
      />
    );
    const input = screen.getByLabelText('City');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onFreeTextCommit).toHaveBeenCalledWith('Somewhere Remote');
    expect(onCitySelect).not.toHaveBeenCalled();
  });

  it('falls back to onCitySelect with a freetext-kind suggestion on Enter when onFreeTextCommit is absent', () => {
    const onCitySelect = vi.fn();
    render(
      <CityInput
        value="Somewhere Remote"
        onChange={() => {}}
        onCitySelect={onCitySelect}
        lookupCities={async () => ({ suggestions: [] })}
        placeholder="e.g. Chengdu"
        label="City"
      />
    );
    const input = screen.getByLabelText('City');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCitySelect).toHaveBeenCalledWith({
      label: 'Somewhere Remote',
      countryCode: null,
      kind: 'freetext',
      placeId: null,
    });
  });
});
