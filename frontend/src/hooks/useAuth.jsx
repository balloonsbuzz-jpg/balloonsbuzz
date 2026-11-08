import { createContext, useCallback, useContext, useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const qc = useQueryClient();
  const me = useQuery({
    queryKey: ['me'],
    queryFn: async () => (await api.get('/auth/me')).data.user,
    retry: false,
    staleTime: 5 * 60_000,
  });

  useEffect(() => {
    const onSignedOut = () => qc.setQueryData(['me'], null);
    window.addEventListener('bb:signed-out', onSignedOut);
    return () => window.removeEventListener('bb:signed-out', onSignedOut);
  }, [qc]);

  const login = useCallback(async (email, password) => {
    await api.post('/auth/login', { email, password });
    await qc.invalidateQueries({ queryKey: ['me'] });
  }, [qc]);

  const logout = useCallback(async () => {
    try { await api.post('/auth/logout'); } finally {
      qc.clear();
      qc.setQueryData(['me'], null);
    }
  }, [qc]);

  const value = useMemo(() => {
    const user = me.data || null;
    const can = (perm) => !!user && (user.permissions.includes('*') || user.permissions.includes(perm));
    return { user, loading: me.isLoading, login, logout, can };
  }, [me.data, me.isLoading, login, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
