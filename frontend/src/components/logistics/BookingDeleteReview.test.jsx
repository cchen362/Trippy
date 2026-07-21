// @vitest-environment jsdom
import { describe, expect, it, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import BookingDeleteReview from './BookingDeleteReview.jsx';

afterEach(cleanup);

const booking = { id: 'b1', title: 'Hangzhou Airport Transfer Lodge' };

const expenses = [
  // Two owed rows spelled differently — one person, not two (decision e).
  {
    id: 'e1',
    title: 'Airport transfer',
    category: 'transport',
    amount: 24000,
    currency: 'CNY',
    owed: [
      { id: 'o1', name: 'Sarah', amount: 8000, settled: false },
      { id: 'o2', name: 'sarah ', amount: 4000, settled: false },
    ],
  },
  {
    id: 'e2',
    title: 'Lounge passes',
    category: 'other',
    amount: 8400,
    currency: 'SGD',
    owed: [
      { id: 'o3', name: 'Sarah', amount: 2200, settled: false },
      { id: 'o4', name: 'Ben', amount: 2000, settled: false },
    ],
  },
  // Settled owed rows must never count as an open repayment consequence.
  {
    id: 'e3',
    title: 'Late checkout',
    category: 'lodging',
    amount: 5000,
    currency: 'CNY',
    owed: [{ id: 'o5', name: 'Ben', amount: 2500, settled: true }],
  },
];

function renderReview(props = {}) {
  const onConfirm = vi.fn();
  render(
    <BookingDeleteReview
      booking={booking}
      expenses={expenses}
      saving={false}
      error={null}
      onCancel={() => {}}
      onConfirm={onConfirm}
      {...props}
    />
  );
  return { onConfirm };
}

const confirmButton = () => screen.getByRole('button', { name: /^Delete booking/ });
const checkboxFor = (label) => screen.getByRole('checkbox', { name: new RegExp(label) });

describe('BookingDeleteReview', () => {
  it('starts with every cost unchecked and offers to delete the booking only', () => {
    renderReview();
    screen.getAllByRole('checkbox').forEach((box) => expect(box).not.toBeChecked());
    expect(confirmButton()).toHaveTextContent('Delete booking only');
    expect(screen.getByText('Unchecked costs stay in Expenses without a booking link.')).toBeInTheDocument();
  });

  it('shows a repayment consequence only for checked rows, and only for open owed rows', () => {
    renderReview();
    expect(screen.queryByText(/open repayment/)).not.toBeInTheDocument();

    fireEvent.click(checkboxFor('Late checkout'));
    // e3's only owed row is settled — checking it must not claim an open repayment.
    expect(screen.queryByText(/open repayment/)).not.toBeInTheDocument();
    expect(confirmButton()).toHaveTextContent('Delete booking and 1 cost');
  });

  it('counts spelling variants of one name as one person', () => {
    renderReview();
    fireEvent.click(checkboxFor('Airport transfer'));
    expect(screen.getByText("includes Sarah's ¥120.00 open repayment")).toBeInTheDocument();
  });

  it('reports several distinct people with a summed original-currency amount', () => {
    renderReview();
    fireEvent.click(checkboxFor('Lounge passes'));
    expect(screen.getByText('includes S$42.00 in open repayments across 2 people')).toBeInTheDocument();
  });

  it('lists mixed currencies side by side instead of summing across them', () => {
    renderReview();
    fireEvent.click(checkboxFor('Airport transfer'));
    fireEvent.click(checkboxFor('Lounge passes'));
    expect(confirmButton()).toHaveTextContent(
      'Delete booking and 2 costs · ¥120.00 + S$42.00 in open repayments'
    );
  });

  it('confirms with the selected ids and never with a cost that has left the list', () => {
    const { onConfirm } = renderReview();
    fireEvent.click(checkboxFor('Airport transfer'));
    fireEvent.click(confirmButton());
    expect(onConfirm).toHaveBeenCalledWith(['e1']);
  });

  it('drops a selected cost from the payload once it disappears from the live list', () => {
    const onConfirm = vi.fn();
    const { rerender } = render(
      <BookingDeleteReview
        booking={booking} expenses={expenses} saving={false} error={null}
        onCancel={() => {}} onConfirm={onConfirm}
      />
    );
    fireEvent.click(checkboxFor('Airport transfer'));
    fireEvent.click(checkboxFor('Lounge passes'));

    // A concurrent delete elsewhere removes e1; a retry must not resend its dead id.
    rerender(
      <BookingDeleteReview
        booking={booking} expenses={expenses.filter((e) => e.id !== 'e1')} saving={false} error={null}
        onCancel={() => {}} onConfirm={onConfirm}
      />
    );
    fireEvent.click(confirmButton());
    expect(onConfirm).toHaveBeenCalledWith(['e2']);
  });

  it('select all checks every cost and toggles back to clear all', () => {
    renderReview();
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    screen.getAllByRole('checkbox').forEach((box) => expect(box).toBeChecked());
    expect(confirmButton()).toHaveTextContent('Delete booking and 3 costs');

    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    screen.getAllByRole('checkbox').forEach((box) => expect(box).not.toBeChecked());
  });

  it('surfaces a failure message without closing the review', () => {
    renderReview({ error: 'Expense not found Nothing was deleted.' });
    expect(screen.getByText('Expense not found Nothing was deleted.')).toBeInTheDocument();
    expect(screen.getAllByRole('checkbox')).toHaveLength(3);
  });
});
