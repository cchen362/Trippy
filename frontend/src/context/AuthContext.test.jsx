// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

afterEach(cleanup);

vi.mock('../services/api.js', () => ({
  authApi: {
    status: vi.fn(() => Promise.resolve({ needsSetup: false })),
    me: vi.fn(() => Promise.reject(Object.assign(new Error('Unauthorized'), { status: 401 }))),
    setup: vi.fn(),
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(() => Promise.resolve()),
  },
}));

const { authApi } = await import('../services/api.js');
const { AuthProvider, useAuth } = await import('./AuthContext.jsx');

function Consumer({ action }) {
  const auth = useAuth();
  return (
    <div>
      <p data-testid="error">{auth.error || ''}</p>
      <button
        type="button"
        onClick={() => {
          const call =
            action === 'login'
              ? auth.login('u', 'p')
              : action === 'register'
                ? auth.register('u', 'p', 'D', 'invite')
                : auth.setup('u', 'p', 'D');
          call.catch((err) => {
            window.__lastRejection = err;
          });
        }}
      >
        go
      </button>
    </div>
  );
}

async function renderAndTrigger(action) {
  render(
    <AuthProvider>
      <Consumer action={action} />
    </AuthProvider>
  );
  // Let the initial status/me bootstrap effect settle.
  await waitFor(() => expect(authApi.status).toHaveBeenCalled());
  fireEvent.click(screen.getByText('go'));
}

describe('AuthContext friendly error mapping', () => {
  for (const action of ['login', 'register', 'setup']) {
    it(`${action}: network failure sets friendly copy and rethrows the original error`, async () => {
      const networkErr = Object.assign(new Error('Failed to fetch'), { code: 'NETWORK_ERROR' });
      authApi[action].mockRejectedValueOnce(networkErr);

      window.__lastRejection = undefined;
      await renderAndTrigger(action);

      await waitFor(() =>
        expect(screen.getByTestId('error').textContent).toBe(
          "Can't reach Trippy right now. Check your connection and try again."
        )
      );
      await waitFor(() => expect(window.__lastRejection).toBeDefined());
      expect(window.__lastRejection.code).toBe('NETWORK_ERROR');
    });

    it(`${action}: 429 sets the cooldown copy and rethrows the original error with status`, async () => {
      const rateLimitErr = Object.assign(new Error('Too many requests'), { status: 429 });
      authApi[action].mockRejectedValueOnce(rateLimitErr);

      window.__lastRejection = undefined;
      await renderAndTrigger(action);

      await waitFor(() =>
        expect(screen.getByTestId('error').textContent).toBe('Too many attempts. Please wait before trying again.')
      );
      await waitFor(() => expect(window.__lastRejection).toBeDefined());
      expect(window.__lastRejection.status).toBe(429);
    });
  }
});
