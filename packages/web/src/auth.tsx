import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, getToken, setToken, setUnauthorizedHandler } from './api.ts';
import type { Operator } from './types.ts';

interface AuthState {
  operator: Operator | null;
  checking: boolean;
  signIn: (token: string) => Promise<void>;
  signOut: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [operator, setOperator] = useState<Operator | null>(null);
  const [checking, setChecking] = useState(Boolean(getToken()));

  const signOut = useCallback(() => {
    setToken(null);
    setOperator(null);
  }, []);

  // Any 401 from the API (token rotated, operator deactivated) signs the user out.
  useEffect(() => setUnauthorizedHandler(signOut), [signOut]);

  // Restore the session on reload.
  useEffect(() => {
    const token = getToken();
    if (!token) return;
    api<Operator>('/me')
      .then(setOperator)
      .catch(signOut)
      .finally(() => setChecking(false));
  }, [signOut]);

  const signIn = useCallback(async (token: string) => {
    const me = await api<Operator>('/me', { token }); // throws ApiError(401) for a bad token
    setToken(token);
    setOperator(me);
  }, []);

  return <AuthContext.Provider value={{ operator, checking, signIn, signOut }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
