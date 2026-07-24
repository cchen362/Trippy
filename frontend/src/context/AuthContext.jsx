import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { authApi } from '../services/api.js';
import { friendlyError } from '../utils/apiError.js';

const AuthContext = createContext(null);
const CACHED_USER_KEY = 'trippy:cachedUser';

function readCachedUser() {
  try {
    const raw = window.localStorage.getItem(CACHED_USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function clearCachedUser() {
  window.localStorage.removeItem(CACHED_USER_KEY);
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const clearError = useCallback(() => setError(null), []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const { needsSetup } = await authApi.status();
        if (cancelled) return;
        if (needsSetup) { setNeedsSetup(true); return; }

        try {
          const { user } = await authApi.me();
          if (cancelled) return;
          setUser(user);
          window.localStorage.setItem(CACHED_USER_KEY, JSON.stringify(user));
        } catch (err) {
          if (cancelled) return;
          if (err.status === 401) {
            clearCachedUser();
          } else {
            // Network failure (offline) — fall back to the last known session
            // instead of dropping the user at the login page.
            const cached = readCachedUser();
            if (cached) setUser(cached);
          }
        }
      } catch {
        // status() itself failed to reach the network — same offline fallback.
        if (cancelled) return;
        const cached = readCachedUser();
        if (cached) setUser(cached);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const handler = () => { setUser(null); clearCachedUser(); };
    window.addEventListener('auth:unauthorized', handler);
    return () => window.removeEventListener('auth:unauthorized', handler);
  }, []);

  const setup = useCallback(async (username, password, displayName) => {
    setError(null);
    try {
      const { user } = await authApi.setup({ username, password, displayName });
      setNeedsSetup(false);
      setUser(user);
      window.localStorage.setItem(CACHED_USER_KEY, JSON.stringify(user));
    } catch (err) { setError(friendlyError(err, 'auth')); throw err; }
  }, []);

  const login = useCallback(async (username, password) => {
    setError(null);
    try {
      const { user } = await authApi.login({ username, password });
      setUser(user);
      window.localStorage.setItem(CACHED_USER_KEY, JSON.stringify(user));
    } catch (err) { setError(friendlyError(err, 'auth')); throw err; }
  }, []);

  const register = useCallback(async (username, password, displayName, inviteCode) => {
    setError(null);
    try {
      const { user } = await authApi.register({ username, password, displayName, inviteCode });
      setUser(user);
      window.localStorage.setItem(CACHED_USER_KEY, JSON.stringify(user));
    } catch (err) { setError(friendlyError(err, 'auth')); throw err; }
  }, []);

  const logout = useCallback(async () => {
    await authApi.logout().catch(() => {});
    setUser(null);
    clearCachedUser();
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
