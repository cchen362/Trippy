import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext.jsx';
import LoadingScreen from './components/common/LoadingScreen.jsx';
import ChunkErrorBoundary from './components/common/ChunkErrorBoundary.jsx';

const ExpensesTab = lazy(() => import('./pages/ExpensesTab.jsx'));
const LoginPage = lazy(() => import('./pages/LoginPage.jsx'));
const LogisticsTab = lazy(() => import('./pages/LogisticsTab.jsx'));
const MapTab = lazy(() => import('./pages/MapTab.jsx'));
const PlanTab = lazy(() => import('./pages/PlanTab.jsx'));
const ShareViewPage = lazy(() => import('./pages/ShareViewPage.jsx'));
const SetupPage = lazy(() => import('./pages/SetupPage.jsx'));
const TodayTab = lazy(() => import('./pages/TodayTab.jsx'));
const TripIndexRedirect = lazy(() => import('./pages/TripIndexRedirect.jsx'));
const TripPage = lazy(() => import('./pages/TripPage.jsx'));
const TripsHomePage = lazy(() => import('./pages/TripsHomePage.jsx'));

export function AppRoutes() {
  const { user, needsSetup, loading } = useAuth();
  const location = useLocation();

  let content;

  if (location.pathname.startsWith('/share/')) {
    content = (
      <Routes>
        <Route path="/share/:token" element={<ShareViewPage />} />
        <Route path="*" element={<Navigate to="/trips" replace />} />
      </Routes>
    );
  } else if (loading) {
    return <LoadingScreen label="Opening Trippy..." />;
  } else if (needsSetup) {
    content = <SetupPage />;
  } else if (!user) {
    content = <LoginPage />;
  } else {
    content = (
      <Routes>
        <Route path="/" element={<Navigate to="/trips" replace />} />
        <Route path="/trips" element={<TripsHomePage />} />
        <Route path="/trips/:tripId" element={<TripPage />}>
          <Route index element={<TripIndexRedirect />} />
          <Route path="today" element={<TodayTab />} />
          <Route path="plan" element={<PlanTab />} />
          <Route path="logistics" element={<LogisticsTab />} />
          <Route path="map" element={<MapTab />} />
          <Route path="expenses" element={<ExpensesTab />} />
        </Route>
        <Route path="*" element={<Navigate to="/trips" replace />} />
      </Routes>
    );
  }

  return (
    <ChunkErrorBoundary variant="full" resetKey={location.pathname}>
      <Suspense fallback={<LoadingScreen label="Opening Trippy..." />}>
        {content}
      </Suspense>
    </ChunkErrorBoundary>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AuthProvider>
  );
}
