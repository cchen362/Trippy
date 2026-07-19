// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import AddPlaceModal from './AddPlaceModal.jsx';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const noop = () => {};
const day = { date: '2026-08-01', resolvedCity: 'Shanghai', resolvedCountry: 'CN' };

describe('AddPlaceModal — ModalShell migration', () => {
  it('renders as a dialog with the day headline when open', () => {
    render(
      <AddPlaceModal
        open
        day={day}
        saving={false}
        onClose={noop}
        onSubmit={noop}
        lookupPlaces={undefined}
        lookupPlaceDetails={undefined}
      />
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    expect(screen.getAllByText('Add Place').length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: 'Shanghai' })).toBeInTheDocument();
  });

  it('renders nothing when closed', () => {
    render(
      <AddPlaceModal
        open={false}
        day={day}
        saving={false}
        onClose={noop}
        onSubmit={noop}
      />
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('focuses the search input on open', async () => {
    render(
      <AddPlaceModal
        open
        day={day}
        saving={false}
        onClose={noop}
        onSubmit={noop}
      />
    );
    await waitFor(() => {
      expect(screen.getByPlaceholderText('Raffles City Chongqing')).toHaveFocus();
    });
  });

  it('shows the DETAILS — OPTIONAL section label above the de-emphasized details fields', () => {
    render(
      <AddPlaceModal
        open
        day={day}
        saving={false}
        onClose={noop}
        onSubmit={noop}
      />
    );
    expect(screen.getByText('DETAILS — OPTIONAL')).toBeInTheDocument();
  });

  it('fills the title from a selected suggestion via place details lookup', async () => {
    const lookupPlaces = vi.fn(async () => ({
      suggestions: [
        { placeId: 'place-1', mainText: 'Raffles City', secondaryText: 'Chongqing, China', text: 'Raffles City' },
      ],
    }));
    const lookupPlaceDetails = vi.fn(async () => ({
      place: {
        placeId: 'place-1',
        name: 'Raffles City Chongqing',
        address: 'Chaotianmen, Chongqing',
        city: 'Chongqing',
        lat: 29.563,
        lng: 106.583,
      },
    }));

    render(
      <AddPlaceModal
        open
        day={day}
        saving={false}
        onClose={noop}
        onSubmit={noop}
        lookupPlaces={lookupPlaces}
        lookupPlaceDetails={lookupPlaceDetails}
      />
    );

    const input = screen.getByPlaceholderText('Raffles City Chongqing');
    fireEvent.change(input, { target: { value: 'Raffles City' } });

    const suggestion = await waitFor(() => screen.getByText('Raffles City').closest('button'));
    fireEvent.click(suggestion);

    await waitFor(() => {
      expect(lookupPlaceDetails).toHaveBeenCalledWith('place-1', expect.any(String));
    });
    await waitFor(() => {
      expect(input.value).toBe('Raffles City Chongqing');
    });
  });

  it('submits the payload from the footer submit button', async () => {
    const onSubmit = vi.fn(async () => {});
    const onClose = vi.fn();

    render(
      <AddPlaceModal
        open
        day={day}
        saving={false}
        onClose={onClose}
        onSubmit={onSubmit}
      />
    );

    const input = screen.getByPlaceholderText('Raffles City Chongqing');
    fireEvent.change(input, { target: { value: 'People Square' } });

    const submitButton = screen.getByRole('button', { name: 'Add Place' });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'People Square',
          locationQuery: 'People Square',
          type: 'experience',
        })
      );
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('calls onClose when Cancel is clicked', () => {
    const onClose = vi.fn();
    render(
      <AddPlaceModal
        open
        day={day}
        saving={false}
        onClose={onClose}
        onSubmit={noop}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
  });
});
