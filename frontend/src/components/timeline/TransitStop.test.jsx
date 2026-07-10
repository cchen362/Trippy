// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import TransitStop from './TransitStop.jsx';

afterEach(cleanup);

const STOP = { id: 'stop-1', dayId: 'day-1', type: 'transit', title: 'Bullet Train', note: '' };

function renderTransitStop(props = {}) {
  return render(
    <TransitStop
      stop={STOP}
      index={0}
      expanded
      onExpand={() => {}}
      onDelete={() => {}}
      onUpdate={() => {}}
      days={[]}
      onMove={() => {}}
      {...props}
    />,
  );
}

describe('TransitStop — move chip city label (bug b: resolved city)', () => {
  it('shows the resolved city, not the raw seed city, on a move chip', () => {
    const days = [
      { id: 'day-1' },
      { id: 'day-2', city: 'Shanghai', resolvedCity: 'Hangzhou' },
    ];
    renderTransitStop({ days });

    fireEvent.click(screen.getByRole('button', { name: /move to →/i }));
    expect(screen.getByRole('button', { name: /day 2 · hangzhou/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /day 2 · shanghai/i })).not.toBeInTheDocument();
  });

  it('calls onMove directly with the stop id and target day id when a chip is clicked', () => {
    const days = [
      { id: 'day-1' },
      { id: 'day-2', city: 'Shanghai', resolvedCity: 'Hangzhou' },
    ];
    const onMove = vi.fn();
    renderTransitStop({ days, onMove });

    fireEvent.click(screen.getByRole('button', { name: /move to →/i }));
    fireEvent.click(screen.getByRole('button', { name: /day 2 · hangzhou/i }));

    expect(onMove).toHaveBeenCalledWith('stop-1', 'day-2');
  });
});
