import { NavLink } from 'react-router-dom';
import { CaretDoubleLeft, CaretDoubleRight, SignOut, Moon, Sun, X } from '@phosphor-icons/react';
import { NAV_SECTIONS } from '@/nav';
import { useAuth } from '@/hooks/useAuth';
import { useTheme } from '@/hooks/useTheme';
import { cn } from '@/lib/utils';

export default function Sidebar({ collapsed, onToggleCollapse, drawerOpen, onCloseDrawer }) {
  const { user, can, logout } = useAuth();
  const { dark, toggle } = useTheme();

  const sections = NAV_SECTIONS
    .map((s) => ({ ...s, items: s.items.filter((i) => can(i.permission)) }))
    .filter((s) => s.items.length);

  return (
    <>
      {drawerOpen && <div className="fixed inset-0 z-30 bg-black/30 lg:hidden" onClick={onCloseDrawer} aria-hidden />}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex flex-col border-r border-sidebar-border bg-sidebar transition-[width,transform] duration-200',
          collapsed ? 'lg:w-[72px]' : 'lg:w-64',
          'w-72 lg:translate-x-0',
          drawerOpen ? 'translate-x-0' : '-translate-x-full',
        )}
        aria-label="Main navigation"
      >
        <div className="flex h-16 items-center justify-between gap-2 px-4">
          <NavLink to="/" className="flex min-w-0 items-center gap-2" onClick={onCloseDrawer}>
            {collapsed
              ? <img src="/brand/icon.png" alt="BalloonsBuzz" className="hidden size-9 lg:block" />
              : null}
            <img src="/brand/logo.png" alt="BalloonsBuzz" className={cn('h-10 w-auto', collapsed && 'lg:hidden')} />
          </NavLink>
          <button className="rounded-md p-1.5 text-muted-foreground hover:bg-muted lg:hidden" onClick={onCloseDrawer} aria-label="Close menu">
            <X size={18} />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 pb-4">
          {sections.map((section) => (
            <div key={section.label} className="mt-4 first:mt-1">
              <p className={cn('mb-1 px-3 text-[11px] font-bold tracking-wider text-muted-foreground/80', collapsed && 'lg:sr-only')}>
                {section.label}
              </p>
              <ul className="space-y-0.5">
                {section.items.map(({ to, label, icon: Icon, milestone }) => (
                  <li key={to}>
                    <NavLink
                      to={to}
                      onClick={onCloseDrawer}
                      title={collapsed ? label : undefined}
                      className={({ isActive }) => cn(
                        'group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-semibold transition-colors',
                        isActive
                          ? 'bg-primary/10 text-primary'
                          : 'text-foreground/75 hover:bg-muted hover:text-foreground',
                        collapsed && 'lg:justify-center lg:px-0',
                      )}
                    >
                      {({ isActive }) => (
                        <>
                          <Icon size={19} weight={isActive ? 'fill' : 'regular'} className="shrink-0" />
                          <span className={cn('flex-1 truncate', collapsed && 'lg:hidden')}>{label}</span>
                          {milestone && (
                            <span className={cn('rounded-full bg-accent px-1.5 py-px text-[10px] font-bold text-accent-foreground', collapsed && 'lg:hidden')}>
                              soon
                            </span>
                          )}
                        </>
                      )}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        <div className="border-t border-sidebar-border p-3">
          <div className={cn('mb-2 flex items-center gap-3 px-2', collapsed && 'lg:hidden')}>
            <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-gold-200 text-sm font-bold text-[#8f6a22]">
              {user?.fullName?.[0]?.toUpperCase() || '?'}
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-bold">{user?.fullName}</p>
              <p className="truncate text-xs capitalize text-muted-foreground">{user?.role}</p>
            </div>
          </div>
          <div className={cn('flex items-center gap-1', collapsed && 'lg:flex-col')}>
            <IconBtn label={dark ? 'Light mode' : 'Dark mode'} onClick={toggle}>{dark ? <Sun size={18} /> : <Moon size={18} />}</IconBtn>
            <IconBtn label="Sign out" onClick={logout}><SignOut size={18} /></IconBtn>
            <IconBtn label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} onClick={onToggleCollapse} className="ml-auto hidden lg:flex">
              {collapsed ? <CaretDoubleRight size={18} /> : <CaretDoubleLeft size={18} />}
            </IconBtn>
          </div>
        </div>
      </aside>
    </>
  );
}

function IconBtn({ label, className, children, ...props }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className={cn('flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground', className)}
      {...props}
    >
      {children}
    </button>
  );
}
