import { useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useRealtime } from '@/hooks/useRealtime';
import { List } from '@phosphor-icons/react';
import Sidebar from './Sidebar';
import { cn } from '@/lib/utils';

const COLLAPSE_KEY = 'bb-sidebar-collapsed';

export default function AppLayout() {
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; }
  });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { pathname } = useLocation();
  const fullBleed = pathname.startsWith('/inbox');
  useRealtime(true);

  const toggleCollapse = () => setCollapsed((c) => {
    try { localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1'); } catch { /* ignore */ }
    return !c;
  });

  return (
    <div className="min-h-full">
      <Sidebar collapsed={collapsed} onToggleCollapse={toggleCollapse} drawerOpen={drawerOpen} onCloseDrawer={() => setDrawerOpen(false)} />

      {/* mobile top bar */}
      <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b bg-background/90 px-4 backdrop-blur lg:hidden">
        <button onClick={() => setDrawerOpen(true)} className="rounded-md p-1.5 hover:bg-muted" aria-label="Open menu">
          <List size={22} />
        </button>
        <img src="/brand/logo.png" alt="BalloonsBuzz" className="h-8 w-auto" />
      </header>

      <main className={cn('transition-[padding] duration-200', collapsed ? 'lg:pl-[72px]' : 'lg:pl-64')}>
        {fullBleed ? <Outlet /> : (
          <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:py-8">
            <Outlet />
          </div>
        )}
      </main>
    </div>
  );
}

export function PageHeader({ title, description, actions }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
