// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import CopilotMessage from './CopilotMessage.jsx';

afterEach(cleanup);

describe('CopilotMessage context chip', () => {
  it('renders the approved chip above a context-carrying user turn', () => {
    render(
      <CopilotMessage
        role="user"
        content="How is this day looking?"
        authorLabel="Test User"
        context={{ tab: 'plan', dayId: 'day-3' }}
        days={[{ id: 'day-3', resolvedCity: 'Hangzhou' }]}
      />,
    );

    const chip = screen.getByTestId('copilot-context-chip');
    expect(chip).toHaveTextContent('plan · Day 1 · Hangzhou');
    expect(chip).toHaveStyle({
      fontFamily: "'DM Mono', monospace",
      fontSize: '9px',
      letterSpacing: '0.16em',
      textTransform: 'uppercase',
      color: 'rgba(201,168,76,0.9)',
      border: '1px solid rgba(201,168,76,0.35)',
      background: 'transparent',
      borderRadius: '4px',
    });
    expect(screen.getByText('Test User').parentElement).toBe(chip.parentElement);
  });

  it('renders no chip or placeholder when context is absent', () => {
    render(<CopilotMessage role="user" content="Plain turn" />);

    expect(screen.queryByTestId('copilot-context-chip')).not.toBeInTheDocument();
    expect(screen.getByText('Plain turn')).toBeInTheDocument();
  });

  it('keeps mobile type compact and enlarges desktop conversation type', () => {
    const { rerender } = render(<CopilotMessage role="assistant" content="Responsive response" />);
    expect(screen.getByText('Responsive response')).toHaveStyle({ fontSize: '15px' });

    rerender(<CopilotMessage role="assistant" content="Responsive response" isDesktop />);
    expect(screen.getByText('Responsive response')).toHaveStyle({ fontSize: '18px' });
  });
});
