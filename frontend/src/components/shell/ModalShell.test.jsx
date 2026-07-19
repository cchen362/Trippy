// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { useRef } from 'react';
import ModalShell from './ModalShell.jsx';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.style.overflow = '';
});

function Harness({ open = true, onRequestClose = () => {}, initialFocus = false, footer = null, children = null }) {
  const inputRef = useRef(null);
  return (
    <ModalShell
      open={open}
      onRequestClose={onRequestClose}
      eyebrow="Eyebrow"
      headline="Test Headline"
      initialFocusRef={initialFocus ? inputRef : undefined}
      footer={footer}
    >
      <button type="button">First</button>
      <input ref={inputRef} type="text" aria-label="Named field" />
      <button type="button">Second</button>
      {children}
    </ModalShell>
  );
}

describe('ModalShell — geometry and semantics', () => {
  it('renders nothing when open is false', () => {
    const { container } = render(<Harness open={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a labelled dialog when open', () => {
    render(<Harness open />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    const labelId = dialog.getAttribute('aria-labelledby');
    expect(document.getElementById(labelId)).toHaveTextContent('Test Headline');
  });
});

describe('ModalShell — escape', () => {
  it('calls onRequestClose once on Escape without removing the panel itself', () => {
    const onRequestClose = vi.fn();
    render(<Harness open onRequestClose={onRequestClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onRequestClose).toHaveBeenCalledTimes(1);
    // The parent controls `open`; the shell itself doesn't hard-remove on Escape.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('ModalShell — focus management', () => {
  it('focuses initialFocusRef target when provided', () => {
    render(<Harness open initialFocus />);
    expect(screen.getByLabelText('Named field')).toHaveFocus();
  });

  it('focuses the default close button when no initialFocusRef is given', () => {
    render(<Harness open />);
    expect(screen.getByLabelText('Close')).toHaveFocus();
  });

  it('returns focus to the previously-focused element on unmount', () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'Open modal';
    document.body.appendChild(trigger);
    trigger.focus();
    expect(trigger).toHaveFocus();

    const { unmount } = render(<Harness open />);
    expect(trigger).not.toHaveFocus();

    unmount();
    expect(trigger).toHaveFocus();
    trigger.remove();
  });
});

describe('ModalShell — focus trap', () => {
  it('wraps Tab from the last focusable element to the first', () => {
    render(
      <Harness
        open
        footer={<button type="button">Footer action</button>}
      />
    );
    const footerButton = screen.getByText('Footer action');
    footerButton.focus();
    expect(footerButton).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Tab' });
    expect(screen.getByLabelText('Close')).toHaveFocus();
  });

  it('wraps Shift+Tab from the first focusable element to the last', () => {
    render(
      <Harness
        open
        footer={<button type="button">Footer action</button>}
      />
    );
    screen.getByLabelText('Close').focus();
    expect(screen.getByLabelText('Close')).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(screen.getByText('Footer action')).toHaveFocus();
  });
});

describe('ModalShell — scroll lock', () => {
  it('locks body overflow while open and restores it after unmount', () => {
    expect(document.body.style.overflow).toBe('');
    const { unmount } = render(<Harness open />);
    expect(document.body.style.overflow).toBe('hidden');
    unmount();
    expect(document.body.style.overflow).toBe('');
  });

  it('keeps the lock while a second shell is still open, releasing only when both close', () => {
    const first = render(<Harness open />);
    const second = render(<Harness open />);
    expect(document.body.style.overflow).toBe('hidden');

    second.unmount();
    expect(document.body.style.overflow).toBe('hidden');

    first.unmount();
    expect(document.body.style.overflow).toBe('');
  });
});

describe('ModalShell — stacking', () => {
  it('uses zBase for the first shell while keeping the default at 40', () => {
    const { rerender } = render(
      <ModalShell open onRequestClose={() => {}} eyebrow="Default" headline="Default shell">
        <button type="button">Default content</button>
      </ModalShell>,
    );

    expect(screen.getByRole('dialog').parentElement).toHaveStyle({ zIndex: '40' });

    rerender(
      <ModalShell open onRequestClose={() => {}} eyebrow="Custom" headline="Custom shell" zBase={220}>
        <button type="button">Custom content</button>
      </ModalShell>,
    );

    expect(screen.getByRole('dialog').parentElement).toHaveStyle({ zIndex: '220' });
  });

  it('routes Escape only to the topmost shell and raises its z-index', () => {
    const onRequestCloseA = vi.fn();
    const onRequestCloseB = vi.fn();

    render(
      <ModalShell open onRequestClose={onRequestCloseA} eyebrow="A" headline="Shell A">
        <button type="button">A content</button>
      </ModalShell>
    );
    render(
      <ModalShell open onRequestClose={onRequestCloseB} eyebrow="B" headline="Shell B">
        <button type="button">B content</button>
      </ModalShell>
    );

    const dialogs = screen.getAllByRole('dialog');
    expect(dialogs).toHaveLength(2);
    const overlayA = dialogs[0].parentElement;
    const overlayB = dialogs[1].parentElement;
    expect(Number(overlayB.style.zIndex)).toBeGreaterThan(Number(overlayA.style.zIndex));

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onRequestCloseB).toHaveBeenCalledTimes(1);
    expect(onRequestCloseA).not.toHaveBeenCalled();
  });
});
