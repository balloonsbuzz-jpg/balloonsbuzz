import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Hand, ChatCircleDots, AddressBook, Wallet, ClockCountdown, Robot, CalendarCheck, ArrowRight } from '@phosphor-icons/react';
import { PageHeader } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/hooks/useAuth';
import { cn } from '@/lib/utils';
import { rupees, percent, count, duration } from './charts';

export function useDashboard() {
  return useQuery({ queryKey: ['dashboard'], queryFn: async () => (await api.get('/dashboard')).data, refetchInterval: 60_000 });
}

function Tile({ to, icon: Icon, label, value, sub, urgent }) {
  return (
    <Link to={to} className={cn('group rounded-xl border bg-card p-4 transition-colors hover:border-primary/40', urgent && 'border-destructive/40 bg-destructive/5')}>
      <p className="flex items-center gap-1.5 text-xs font-bold text-muted-foreground"><Icon size={15} weight={urgent ? 'fill' : 'regular'} className={urgent ? 'text-destructive' : ''} aria-hidden /> {label}</p>
      <p className="mt-1 text-2xl font-extrabold tabular-nums">{value}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </Link>
  );
}

const dayName = (d, today) => {
  if (d === today) return 'Today';
  const t = new Date(`${today}T00:00:00`); t.setDate(t.getDate() + 1);
  const tomorrow = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
  if (d === tomorrow) return 'Tomorrow';
  return new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
};
const time12 = (t) => (t ? new Date(`2000-01-01T${t}`).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }) : 'time not set');

export default function DashboardPage() {
  const { user, can } = useAuth();
  const { data, isLoading, error } = useDashboard();
  const first = (user?.fullName || '').split(' ')[0];
  const hour = Number(new Date().toLocaleString('en-IN', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' }));
  const hello = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  return (
    <>
      <PageHeader title={`${hello}${first ? `, ${first}` : ''}`} description="What needs attention today, and how the month is going." />
      {error && <p className="mb-4 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{errorMessage(error)}</p>}
      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {data && (
        <>
          {data.counts.bot_enabled === false && (
            <p className="mb-4 flex items-center gap-2 rounded-xl border bg-accent px-4 py-2.5 text-sm text-accent-foreground">
              <Robot size={17} aria-hidden /> The AI bot is switched off, so new chats wait for the team.
              {can('agent:write') && <Link to="/ai/agent" className="ml-auto font-bold underline">Turn it on</Link>}
            </p>
          )}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Tile to="/inbox?filter=needs_human" icon={Hand} label="Need a person" value={count(data.counts.needs_human)} urgent={data.counts.needs_human > 0} sub="chats waiting for the team" />
            <Tile to="/inbox?filter=unread" icon={ChatCircleDots} label="Unread chats" value={count(data.counts.unread_chats)} />
            <Tile to="/contacts" icon={AddressBook} label="Open enquiries" value={count(data.counts.open_leads)} sub={`${data.counts.leads_today} new today`} />
            <Tile to="/bookings" icon={CalendarCheck} label="Booked today" value={count(data.counts.bookings_today)} />
            <Tile to="/bookings" icon={Wallet} label="Advance pending" value={count(data.counts.advance_pending)} sub={data.counts.advance_pending ? `${rupees(data.counts.advance_pending_amount)} to collect` : 'all paid'} />
            <Tile to="/followups" icon={ClockCountdown} label="Follow-ups waiting" value={count(data.counts.followups_waiting)} />
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-5">
            <section className="rounded-xl border bg-card p-4 lg:col-span-3">
              <h2 className="mb-3 text-sm font-extrabold">Events in the next 7 days</h2>
              {!data.upcoming.length && <p className="text-sm text-muted-foreground">No events booked for the coming week.</p>}
              <ul className="divide-y">
                {data.upcoming.map((b) => (
                  <li key={b.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-2.5 text-sm">
                    <span className="w-24 shrink-0 font-bold">{dayName(b.event_date, data.today)}<span className="block text-xs font-normal text-muted-foreground">{time12(b.event_time)}</span></span>
                    <span className="min-w-0 flex-1">
                      <b>{b.contact_name || 'Customer'}</b> <span className="text-muted-foreground">· {[b.occasion_name, b.package_name].filter(Boolean).join(' · ')}</span>
                      <span className="block truncate text-xs text-muted-foreground">{b.venue_address}</span>
                    </span>
                    <span className="text-right text-xs">
                      <span className={cn('rounded-full px-2 py-0.5 font-bold', b.status === 'confirmed' ? 'bg-success/15 text-success' : 'bg-accent text-accent-foreground')}>
                        {b.status === 'confirmed' ? 'Confirmed' : 'Advance pending'}
                      </span>
                      {b.balance_amount > 0 && <span className="mt-0.5 block text-muted-foreground">{rupees(b.balance_amount)} balance</span>}
                    </span>
                  </li>
                ))}
              </ul>
              <Button variant="ghost" size="sm" className="mt-2" nativeButton={false} render={<Link to="/bookings" />}>All bookings <ArrowRight size={14} /></Button>
            </section>

            <section className="rounded-xl border bg-card p-4 lg:col-span-2">
              <h2 className="mb-3 text-sm font-extrabold">This month so far</h2>
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <Fact k="Enquiries" v={count(data.month.funnel.leads)} />
                <Fact k="Bookings" v={count(data.month.bookings.count)} sub={data.month.funnel.conversion_pct != null ? `${percent(data.month.funnel.conversion_pct)} of enquiries` : null} />
                <Fact k="Booked value" v={rupees(data.month.bookings.booked_value)} />
                <Fact k="Collected" v={rupees(data.month.bookings.collected)} />
                <Fact k="Typical reply" v={duration(data.month.response.median_secs)} />
                <Fact k="Handed to team" v={percent(data.month.handover.rate_pct)} />
              </dl>
              {can('analytics:read') && <Button variant="ghost" size="sm" className="mt-3" nativeButton={false} render={<Link to="/analytics" />}>Full analytics <ArrowRight size={14} /></Button>}
            </section>
          </div>
        </>
      )}
    </>
  );
}

function Fact({ k, v, sub }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{k}</dt>
      <dd className="text-lg font-extrabold tabular-nums">{v}</dd>
      {sub && <dd className="text-xs text-muted-foreground">{sub}</dd>}
    </div>
  );
}
