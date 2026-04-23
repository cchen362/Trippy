import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { authApi } from '../services/api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const clearError = useCallback(() => setError(null), []);

  useEffect(() => {
    authApi.status()
      .then(({ needsSetup }) => {
        if (needsSetup) { setNeedsSetup(true); setLoading(false); return; }
        return authApi.me().then(({ user }) => setUser(user)).catch(() => {});
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const handler = () => { setUser(null); };
    window.addEventListener('auth:unauthorized', handler);
    return () => window.removeEventListener('auth:unauthorized', handler);
  }, []);

  const setup = useCallback(async (username, password, displayName) => {
    setError(null);
    try {
      const { user } = await authApi.setup({ username, password, displayName });
      setNeedsSetup(false);
      setUser(user);
    } catch (err) { setError(err.message); throw err; }
  }, []);

  const login = useCallback(async (username, password) => {
    setError(null);
    try {
      const { user } = await authApi.login({ username, password });
      setUser(user);
    } catch (err) { setError(err.message); throw err; }
  }, []);

  const register = useCallback(async (username, password, displayName, inviteCode) => {
    setError(null);
    try {
      const { user } = await authApi.register({ username, password, displayName, inviteCode });
      setUser(user);
    } catch (err) { setError(err.message); throw err; }
  }, []);

  const logout = useCallback(async () => {
    await authApi.logout().catch(() => {});
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, needsSetup, loading, error, clearError, setup, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
