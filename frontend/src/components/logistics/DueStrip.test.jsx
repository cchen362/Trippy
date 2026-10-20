// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import DueStrip from './DueStrip.jsx';

const NOW = new Date(2026, 9, 21, 12, 0);
const fact = (id, at, label) => ({ id, kind: 'deadline', at, label, value: 'v' });
const b1 = { id: 'b1', title: 'Seoul flight', startDatetime: '2026-11-01T08:00' };
const b2 = { id: 'b2', title: 'Tokyo flight', startDatetime: '2026-11-05T08:00' };
const show = (bookings, factsByBooking, deviceTz) => render(
  <DueStrip bookings={bookings} factsByBooking={factsByBooking} now={NOW} deviceTz={deviceTz} />,
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
    fireEvent.click(screen.getByRole('button', { name: '1 more' }));
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

  it('shows one line and expands the rest in place', () => {
    show([b1], {
      b1: [1, 2, 3].map((n) => fact(`f${n}`, `2026-11-0${n}`, `Item ${n}`)),
    });
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '2 more' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Fewer' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });

  it('adds the your-time note only when the zones differ', () => {
    const f = { ...fact('z', '2026-11-12T18:00', 'Check in'), tz: 'Europe/London' };
    const { container, unmount } = show([b1], { b1: [f] }, 'Asia/Singapore');
    expect(container.textContent).toContain('12 Nov 18:00');
    expect(container.textContent).toContain('· 13 Nov 02:00 your time');
    expect(container.querySelectorAll('.trip-live-dot')).toHaveLength(1);
    unmount();
    const same = show([b1], { b1: [f] }, 'Europe/London');
    expect(same.container.textContent).not.toContain('your time');
  });

  it('never notes an unknown zone', () => {
    const { container } = show([b1], { b1: [fact('u', '2026-11-12T18:00', 'Check in')] }, 'Asia/Singapore');
    expect(container.textContent).not.toContain('your time');
  });
});
