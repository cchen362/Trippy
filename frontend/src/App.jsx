import { AuthProvider, useAuth } from './context/AuthContext.jsx';
import SetupPage from './pages/SetupPage.jsx';
import LoginPage from './pages/LoginPage.jsx';

function AuthGate() {
  const { user, needsSetup, loading } = useAuth();

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--ink-deep)' }}>
      <div className="font-mono text-xs tracking-widest uppercase" style={{ color: 'var(--cream-mute)' }}>Loading…</div>
    </div>
  );

  if (needsSetup) return <SetupPage />;
  if (!user) return <LoginPage />;

  // Main app — placeholder until Plan 2
  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--ink-deep)' }}>
      <div>
        <div className="w-5 h-px mb-3" style={{ background: 'var(--gold)' }} />
        <p className="font-mono text-xs tracking-widest uppercase mb-1" style={{ color: 'var(--gold)' }}>Signed in as {user.username}</p>
        <h1 className="font-display italic text-3xl" style={{ color: 'var(--cream)' }}>Trippy</h1>
        <p className="font-body text-sm mt-2" style={{ color: 'var(--cream-mute)' }}>Main app coming in Plan 2.</p>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AuthGate />
    </AuthProvider>
  );
}
