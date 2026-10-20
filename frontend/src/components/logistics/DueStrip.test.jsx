// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import DueStrip from './DueStrip.jsx';

const NOW = new Date(2026, 9, 21, 12, 0);
const TODAY = '2026-10-21';
const fact = (id, at, label) => ({ id, kind: 'deadline', at, label, value: 'v' });
const b1 = { id: 'b1', title: 'Seoul flight', startDatetime: '2026-11-01T08:00' };
const b2 = { id: 'b2', title: 'Tokyo flight', startDatetime: '2026-11-05T08:00' };
const show = (bookings, factsByBooking) => render(
  <DueStrip bookings={bookings} factsByBooking={factsByBooking} today={TODAY} now={NOW} />,
);

afterEach(cleanup);

describe('DueStrip', () => {
  it('renders nothing without upcoming deadlines', () => {
    const { container } = show([b1], { b1: [fact('p', '2026-10-01', 'Old')] });
    expect(container.firstChild).toBeNull();
  });

  it('lists lines in order with Today and countdowns, one gold dot on the first', () => {
    const { container } = show([b1], {
      b1: [fact('b', '2026-10-26T09:00', 'Pay balance'), fact('a', '2026-10-21T18:00', 'Check in')],
    });
    const items = container.querySelectorAll('li');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain('Check in');
    expect(items[0].textContent).toContain('Today');
    expect(items[0].textContent).toContain('21 Oct 18:00');
    expect(items[1].textContent).toContain('In 5 days');
    expect(container.querySelectorAll('.trip-live-dot')).toHaveLength(1);
    expect(items[0].querySelector('.trip-live-dot')).not.toBeNull();
  });

  it('names both bookings for a shared fact', () => {
    show([b1, b2], { b1: [fact('s', '2026-11-01', 'Check in')], b2: [fact('s', '2026-11-01', 'Check in')] });
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('Seoul flight · Tokyo flight')).toBeTruthy();
  });

  it('caps at three and expands in place', () => {
    show([b1], {
      b1: [1, 2, 3, 4, 5].map((n) => fact(`f${n}`, `2026-11-0${n}`, `Item ${n}`)),
    });
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: '2 more' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
    expect(screen.getByRole('button', { name: 'Fewer' })).toBeTruthy();
  });
});
