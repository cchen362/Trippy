import { Navigate } from 'react-router-dom';
import { useTripContext } from './TripPage.jsx';

export default function TripIndexRedirect() {
  const { live } = useTripContext();
  return <Navigate to={live ? 'today' : 'plan'} replace />;
}
