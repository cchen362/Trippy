// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import IntegrationsPanel from './IntegrationsPanel.jsx';
import { integrationsApi } from '../../services/integrationsApi.js';

vi.mock('../../services/integrationsApi.js', () => ({
  integrationsApi: {
    list: vi.fn(),
    create: vi.fn(),
    revoke: vi.fn(),
  },
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const noop = () => {};

const baseToken = {
  id: 'tok-1',
  userId: 'user-1',
  name: 'claude-code-laptop',
  tokenPrefix: 'trp_ab12cd34',
  scopes: ['trips:read'],
  createdAt: '2026-09-01T10:00:00.000Z',
  expiresAt: null,
  lastUsedAt: null,
  revokedAt: null,
};

describe('IntegrationsPanel', () => {
  it('renders the list with tokenPrefix and never the full token', async () => {
    integrationsApi.list.mockResolvedValue({ tokens: [baseToken] });

    render(<IntegrationsPanel open onRequestClose={noop} />);

    expect(await screen.findByText('claude-code-laptop')).toBeInTheDocument();
    expect(screen.getByText('trp_ab12cd34…')).toBeInTheDocument();
    expect(screen.queryByText(/trp_ab12cd34[a-zA-Z0-9]{10,}/)).not.toBeInTheDocument();
  });

  it('creates a token, shows the plaintext once in reveal, then clears it and refetches on Done', async () => {
    integrationsApi.list
      .mockResolvedValueOnce({ tokens: [] })
      .mockResolvedValueOnce({ tokens: [baseToken] });
    integrationsApi.create.mockResolvedValue({
      token: 'trp_ab12cd34fullsecretvalue',
      record: baseToken,
    });

    render(<IntegrationsPanel open onRequestClose={noop} />);

    await screen.findByText(/Nothing connected yet/);
    fireEvent.click(screen.getByRole('button', { name: 'New token' }));

    fireEvent.change(screen.getByPlaceholderText('claude-code-laptop'), {
      target: { value: 'claude-code-laptop' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(integrationsApi.create).toHaveBeenCalledWith({
        name: 'claude-code-laptop',
        scopes: ['trips:read'],
        expiresInDays: 90,
      });
    });

    expect(await screen.findByText('trp_ab12cd34fullsecretvalue')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    await waitFor(() => {
      expect(screen.queryByText('trp_ab12cd34fullsecretvalue')).not.toBeInTheDocument();
    });
    await waitFor(() => expect(integrationsApi.list).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('claude-code-laptop')).toBeInTheDocument();
  });

  it('revokes a token via two-step confirm and shows it revoked', async () => {
    const revoked = { ...baseToken, revokedAt: '2026-09-16T12:00:00.000Z' };
    integrationsApi.list
      .mockResolvedValueOnce({ tokens: [baseToken] })
      .mockResolvedValueOnce({ tokens: [revoked] });
    integrationsApi.revoke.mockResolvedValue({ token: revoked });

    render(<IntegrationsPanel open onRequestClose={noop} />);

    await screen.findByText('claude-code-laptop');
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm?' }));

    await waitFor(() => expect(integrationsApi.revoke).toHaveBeenCalledWith('tok-1'));
    await waitFor(() => expect(screen.getByText(/revoked/)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
  });

  it('renders a friendly error message on API failure', async () => {
    integrationsApi.list.mockRejectedValue(Object.assign(new Error('nope'), { status: 500 }));

    render(<IntegrationsPanel open onRequestClose={noop} />);

    expect(await screen.findByText('nope')).toBeInTheDocument();
  });
});
