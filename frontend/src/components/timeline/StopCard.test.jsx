// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '@testing-library/jest-dom/vitest';
import StopCard from './StopCard.jsx';

afterEach(cleanup);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const STOP = { id: 'stop-1', dayId: 'day-1', type: 'experience', title: 'Fushimi Inari', note: '' };
const DAYS = [
  { id: 'day-1' },
  { id: 'day-2', city: 'Osaka' },
];

function renderCard(props = {}) {
  return render(
    <MemoryRouter>
      <StopCard
        stop={STOP}
        expanded
        onToggle={() => {}}
        onDelete={() => {}}
        onUpdate={() => {}}
        days={DAYS}
        onMove={() => Promise.resolve()}
        {...props}
      />
    </MemoryRouter>,
  );
}

describe('StopCard — per-stop move pending state (Wave 4 §4.2)', () => {
  it('disables move controls while its own move request is in flight, then re-enables on settle', async () => {
    const pending = deferred();
    const onMove = vi.fn(() => pending.promise);
    renderCard({ onMove });

    fireEvent.click(screen.getByRole('button', { name: /move to →/i }));
    const targetButton = screen.getByRole('button', { name: /day 2 · osaka/i });
    fireEvent.click(targetButton);

    expect(onMove).toHaveBeenCalledWith('stop-1', 'day-2');
    await waitFor(() => expect(targetButton).toBeDisabled());
    expect(screen.getByRole('button', { name: /cancel/i })).toBeDisabled();
    expect(screen.getByText(/moving…/i)).toBeInTheDocument();

    pending.resolve();
    await waitFor(() => expect(targetButton).not.toBeDisabled());
    expect(screen.getByText(/move to/i)).toBeInTheDocument();
  });

  it('re-enables controls after a failed move (rejection does not leave the card stuck pending)', async () => {
    const pending = deferred();
    const onMove = vi.fn(() => pending.promise);
    renderCard({ onMove });

    fireEvent.click(screen.getByRole('button', { name: /move to →/i }));
    const targetButton = screen.getByRole('button', { name: /day 2 · osaka/i });
    fireEvent.click(targetButton);
    await waitFor(() => expect(targetButton).toBeDisabled());

    pending.reject(new Error('network drop'));
    await waitFor(() => expect(targetButton).not.toBeDisabled());
  });

  it('ignores a second click on the same target while a move is already in flight', async () => {
    const pending = deferred();
    const onMove = vi.fn(() => pending.promise);
    renderCard({ onMove });

    fireEvent.click(screen.getByRole('button', { name: /move to →/i }));
    const targetButton = screen.getByRole('button', { name: /day 2 · osaka/i });
    fireEvent.click(targetButton);
    await waitFor(() => expect(targetButton).toBeDisabled());

    fireEvent.click(targetButton);
    expect(onMove).toHaveBeenCalledTimes(1);

    pending.resolve();
  });
});

describe('StopCard — move chip city label (bug b: resolved city)', () => {
  it('shows the resolved city, not the raw seed city, on a move chip', () => {
    const days = [
      { id: 'day-1' },
      { id: 'day-2', city: 'Shanghai', resolvedCity: 'Hangzhou' },
    ];
    renderCard({ days });

    fireEvent.click(screen.getByRole('button', { name: /move to →/i }));
    expect(screen.getByRole('button', { name: /day 2 · hangzhou/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /day 2 · shanghai/i })).not.toBeInTheDocument();
  });
});
