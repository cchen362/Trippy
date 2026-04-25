import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext.jsx';
import LoadingScreen from './components/common/LoadingScreen.jsx';
import LoginPage from './pages/LoginPage.jsx';
import LogisticsTab from './pages/LogisticsTab.jsx';
import MapTab from './pages/MapTab.jsx';
import PlanTab from './pages/PlanTab.jsx';
import ShareViewPage from './pages/ShareViewPage.jsx';
import SetupPage from './pages/SetupPage.jsx';
import TripPage from './pages/TripPage.jsx';
import TripsHomePage from './pages/TripsHomePage.jsx';

function AppRoutes() {
  const { user, needsSetup, loading } = useAuth();
  const location = useLocation();

  if (location.pathname.startsWith('/share/')) {
    return (
      <Routes>
        <Route path="/share/:token" element={<ShareViewPage />} />
        <Route path="*" element={<Navigate to="/trips" replace />} />
      </Routes>
    );
  }

  if (loading) return <LoadingScreen label="Opening Trippy..." />;
  if (needsSetup) return <SetupPage />;
  if (!user) return <LoginPage />;

  return (
    <Routes>
      <Route path="/" element={<Navigate to="/trips" replace />} />
      <Route path="/trips" element={<TripsHomePage />} />
      <Route path="/trips/:tripId" element={<TripPage />}>
        <Route index element={<Navigate to="plan" replace />} />
        <Route path="plan" element={<PlanTab />} />
        <Route path="logistics" element={<LogisticsTab />} />
        <Route path="map" element={<MapTab />} />
      </Route>
      <Route path="*" element={<Navigate to="/trips" replace />} />
    </Routes>
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
