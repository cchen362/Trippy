// @vitest-environment jsdom
import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import ExpenseSummary from './ExpenseSummary.jsx';

afterEach(cleanup);

describe('ExpenseSummary', () => {
  it('renders the spent headline, secondary lines, and the exact FX footer sentence', () => {
    render(
      <ExpenseSummary
        totals={{
          summaryCurrency: 'SGD',
          spent: 50000,
          awaitingRepayment: 8000,
          netShare: 42000,
          unestimatedByCurrency: {},
        }}
      />
    );
    expect(screen.getByText('S$500.00')).toBeInTheDocument();
    expect(screen.getByText('Awaiting repayment: S$80.00')).toBeInTheDocument();
    expect(screen.getByText('Your share (est.): S$420.00')).toBeInTheDocument();
    expect(screen.getByText("Estimates use daily mid-market reference rates, not your card's exchange rate.")).toBeInTheDocument();
  });

  it('surfaces unestimated amounts per currency instead of silently dropping them', () => {
    render(
      <ExpenseSummary
        totals={{
          summaryCurrency: 'SGD',
          spent: 50000,
          awaitingRepayment: 0,
          netShare: 50000,
          unestimatedByCurrency: { JPY: 1240000 },
        }}
      />
    );
    expect(screen.getByText('Not included in total yet: + ¥1,240,000 unestimated')).toBeInTheDocument();
  });
});
