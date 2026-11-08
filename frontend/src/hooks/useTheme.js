import { useCallback, useState } from 'react';

export function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  const toggle = useCallback(() => {
    setDark((d) => {
      const next = !d;
      document.documentElement.classList.toggle('dark', next);
      try { localStorage.setItem('bb-theme', next ? 'dark' : 'light'); } catch { /* storage blocked */ }
      return next;
    });
  }, []);
  return { dark, toggle };
}
