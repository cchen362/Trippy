// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import ChunkErrorBoundary from './components/common/ChunkErrorBoundary.jsx';

afterEach(cleanup);

// Mutable auth state the mocked useAuth() reads on every render — tests set this
// before rendering so each MemoryRouter case exercises a different auth branch.
let mockAuthState = { user: null, needsSetup: false, loading: false };

vi.mock('./context/AuthContext.jsx', () => ({
  useAuth: () => mockAuthState,
  AuthProvider: ({ children }) => children,
}));

// Trivial stand-ins for every lazily-loaded page so the route-graph test exercises
// routing/lazy-resolution only, never the pages' own heavy dependencies (leaflet,
// framer-motion chains, API calls on mount, etc).
vi.mock('./pages/ExpensesTab.jsx', () => ({ default: () => <div data-testid="page-expenses" /> }));
vi.mock('./pages/LoginPage.jsx', () => ({ default: () => <div data-testid="page-login">Login</div> }));
vi.mock('./pages/LogisticsTab.jsx', () => ({ default: () => <div data-testid="page-logistics" /> }));
vi.mock('./pages/MapTab.jsx', () => ({ default: () => <div data-testid="page-map" /> }));
vi.mock('./pages/PlanTab.jsx', () => ({ default: () => <div data-testid="page-plan" /> }));
vi.mock('./pages/ShareViewPage.jsx', () => ({ default: () => <div data-testid="page-share">Share</div> }));
vi.mock('./pages/SetupPage.jsx', () => ({ default: () => <div data-testid="page-setup">Setup</div> }));
vi.mock('./pages/TodayTab.jsx', () => ({ default: () => <div data-testid="page-today" /> }));
vi.mock('./pages/TripIndexRedirect.jsx', () => ({ default: () => <div data-testid="page-trip-index" /> }));
vi.mock('./pages/TripPage.jsx', () => ({ default: () => <div data-testid="page-trip-shell" /> }));
vi.mock('./pages/TripsHomePage.jsx', () => ({ default: () => <div data-testid="page-trips-home">TripsHome</div> }));

// Imported AFTER the mocks above so App.jsx's lazy() factories resolve to the stubs.
const { AppRoutes } = await import('./App.jsx');

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>,
  );
}

describe('AppRoutes — route graph resolves the right lazy page per path', () => {
  beforeEach(() => {
    mockAuthState = { user: null, needsSetup: false, loading: false };
  });

  it('renders ShareViewPage for /share/:token regardless of auth state', async () => {
    renderAt('/share/tok-123');
    expect(await screen.findByTestId('page-share')).toBeInTheDocument();
  });

  it('shows the full LoadingScreen while auth is loading', () => {
    mockAuthState = { user: null, needsSetup: false, loading: true };
    renderAt('/trips');
    expect(screen.getByText('Opening Trippy...')).toBeInTheDocument();
  });

  it('renders SetupPage when needsSetup is true', async () => {
    mockAuthState = { user: null, needsSetup: true, loading: false };
    renderAt('/trips');
    expect(await screen.findByTestId('page-setup')).toBeInTheDocument();
  });

  it('renders LoginPage when there is no user', async () => {
    mockAuthState = { user: null, needsSetup: false, loading: false };
    renderAt('/trips');
    expect(await screen.findByTestId('page-login')).toBeInTheDocument();
  });

  it('renders TripsHomePage for /trips when authenticated, and gates the login page', async () => {
    mockAuthState = { user: { id: 'u1' }, needsSetup: false, loading: false };
    renderAt('/trips');
    expect(await screen.findByTestId('page-trips-home')).toBeInTheDocument();
    expect(screen.queryByTestId('page-login')).not.toBeInTheDocument();
  });

  it('renders the TripPage shell for /trips/:tripId when authenticated', async () => {
    mockAuthState = { user: { id: 'u1' }, needsSetup: false, loading: false };
    renderAt('/trips/trip-1/plan');
    expect(await screen.findByTestId('page-trip-shell')).toBeInTheDocument();
  });
});

describe('ChunkErrorBoundary — chunk-load failures reach the boundary and reload UI shows', () => {
  let consoleErrorSpy;

  beforeEach(() => {
    // React logs a second, expected error to the console for boundary-caught throws — silence it.
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  function ThrowingChild() {
    throw new Error('boom');
  }

  it('shows the reload UI when a child throws during render', () => {
    render(
      <ChunkErrorBoundary variant="full">
        <ThrowingChild />
      </ChunkErrorBoundary>,
    );
    expect(screen.getByText(/Couldn't load/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reload/i })).toBeInTheDocument();
  });

  it('shows the reload UI when a lazy chunk import rejects (simulated 404)', async () => {
    const React = await import('react');
    const BrokenLazy = React.lazy(() => Promise.reject(new Error('chunk 404')));

    render(
      <ChunkErrorBoundary variant="inline">
        <React.Suspense fallback={<div data-testid="loading">Loading</div>}>
          <BrokenLazy />
        </React.Suspense>
      </ChunkErrorBoundary>,
    );

    expect(await screen.findByRole('button', { name: /reload/i })).toBeInTheDocument();
  });

  it('clears the error state when resetKey changes', () => {
    const { rerender } = render(
      <ChunkErrorBoundary variant="full" resetKey="a">
        <ThrowingChild />
      </ChunkErrorBoundary>,
    );
    expect(screen.getByText(/Couldn't load/i)).toBeInTheDocument();

    rerender(
      <ChunkErrorBoundary variant="full" resetKey="b">
        <div data-testid="recovered">Recovered</div>
      </ChunkErrorBoundary>,
    );
    expect(screen.getByTestId('recovered')).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't load/i)).not.toBeInTheDocument();
  });
});
