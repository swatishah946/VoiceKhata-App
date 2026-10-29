import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { storage } from './storage';
import { api, ApiError, setAuthToken, setUnauthorizedHandler } from './api';
import type { Session } from './types';

/**
 * Login state. The token is kept in the phone's secure storage (Android
 * Keystore), so he logs in once per phone. If the server says the token is no
 * longer valid (PIN changed, member removed), the app logs out.
 */

const KEY = 'vk.session';

interface Auth {
  ready: boolean;
  session: Session | null;
  login(phone: string, pin: string): Promise<void>;
  logout(): Promise<void>;
}

const Ctx = createContext<Auth>({ ready: false, session: null, login: async () => undefined, logout: async () => undefined });

export function AuthProvider({ children, onLogout }: { children: ReactNode; onLogout?: () => Promise<void> | void }) {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<Session | null>(null);

  const logout = useCallback(async () => {
    try {
      await api('/app/push-token', { method: 'POST', body: { token: null }, timeoutMs: 5000 });
    } catch {
      /* offline: fine */
    }
    setAuthToken(null);
    setSession(null);
    await storage.remove(KEY);
    await onLogout?.();
  }, [onLogout]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setAuthToken(null);
      setSession(null);
      void storage.remove(KEY);
    });
    (async () => {
      const raw = await storage.get(KEY);
      if (raw) {
        try {
          const s = JSON.parse(raw) as Session;
          setAuthToken(s.token);
          setSession(s);
          // Refresh name/role in the background; offline is fine, 401 logs out (handler above)
          api<Omit<Session, 'token'>>('/app/me')
            .then((me) => {
              const next = { ...s, ...me };
              setSession(next);
              void storage.set(KEY, JSON.stringify(next));
            })
            .catch(() => undefined);
        } catch {
          await storage.remove(KEY);
        }
      }
      setReady(true);
    })();
  }, []);

  const login = useCallback(async (phone: string, pin: string) => {
    const s = await api<Session>('/app/auth/login', { method: 'POST', body: { phone, pin } });
    setAuthToken(s.token);
    await storage.set(KEY, JSON.stringify(s));
    setSession(s);
  }, []);

  const value = useMemo(() => ({ ready, session, login, logout }), [ready, session, login, logout]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);

export function loginErrorKey(err: unknown): 'wrongLogin' | 'tooManyTries' | 'offline' | 'serverSlow' {
  if (err instanceof ApiError) {
    if (err.status === 429) return 'tooManyTries';
    if (err.status === 0) return 'offline';
    if (err.status >= 500) return 'serverSlow';
  }
  return 'wrongLogin';
}
