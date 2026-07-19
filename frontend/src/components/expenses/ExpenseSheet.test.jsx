// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import ExpenseSheet from './ExpenseSheet.jsx';

afterEach(cleanup);

const noop = () => {};

describe('ExpenseSheet — currency default', () => {
  it('pre-fills the currency chip from the day-derived default currency', () => {
    render(
      <ExpenseSheet
        open
        onClose={noop}
        defaultCurrency="JPY"
        currentUserId={1}
        collaborators={[{ id: 1, username: 'me', displayName: 'Me' }]}
        bookings={[]}
        saving={false}
        onSave={noop}
      />
    );
    expect(screen.getByLabelText('Currency: JPY. Tap to change.')).toBeInTheDocument();
  });
});

describe('ExpenseSheet — owed-sum client validation', () => {
  it('disables Save and shows a warning when owed amounts exceed the expense amount', async () => {
    render(
      <ExpenseSheet
        open
        onClose={noop}
        defaultCurrency="SGD"
        currentUserId={1}
        collaborators={[{ id: 1, username: 'me', displayName: 'Me' }]}
        bookings={[]}
        saving={false}
        onSave={vi.fn()}
      />
    );

    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '50' } });

    fireEvent.click(screen.getByText('More'));
    fireEvent.click(screen.getByText('Add person'));

    const nameInput = screen.getByPlaceholderText('Name');
    fireEvent.change(nameInput, { target: { value: 'Sarah' } });

    const amountInputs = screen.getAllByPlaceholderText('0.00');
    const owedAmountInput = amountInputs[amountInputs.length - 1];
    fireEvent.change(owedAmountInput, { target: { value: '80' } });

    expect(screen.getByText('Owed amounts exceed the expense amount.')).toBeInTheDocument();
    expect(screen.getByText('Save')).toBeDisabled();
  });

  it('enables Save once amount is valid and owed rows sum within the amount', () => {
    render(
      <ExpenseSheet
        open
        onClose={noop}
        defaultCurrency="SGD"
        currentUserId={1}
        collaborators={[{ id: 1, username: 'me', displayName: 'Me' }]}
        bookings={[]}
        saving={false}
        onSave={vi.fn()}
      />
    );

    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '50' } });
    expect(screen.getByText('Save')).not.toBeDisabled();
  });
});
