import { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { CaretRight, Robot, Gear, User, X } from '@phosphor-icons/react';
import { PageHeader } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';

/** Plain-English names for what happened. Unknown actions fall back to "entity · verb". */
const ACTION = {
  'auth.login': 'Signed in', 'auth.logout': 'Signed out',
  'user.invite': 'Invited a team member', 'user.invite_resend': 'Made a new invite link', 'user.invite_accept': 'Accepted the invite',
  'user.update': 'Changed a team member', 'user.deactivate': 'Deactivated a team member', 'user.reactivate': 'Reactivated a team member',
  'user.remove': 'Removed a team member', 'user.sign_out_all': 'Signed someone out of all devices',
  'user.password_reset_link': 'Made a password reset link', 'user.password_reset': 'Reset their password', 'user.password_change': 'Changed their password',
  'role.create': 'Created a role', 'role.update': 'Changed a role', 'role.delete': 'Deleted a role',
  'analytics.export': 'Downloaded a CSV',
  'booking.create': 'Created a booking',
};
const label = (a) => ACTION[a] || a.replace('.', ' · ').replace(/_/g, ' ');

const SECRET = /pass(word)?|token|secret|api_?key/i;

export default function AuditPage() {
  const [f, setF] = useState({ from: '', to: '', actor: '', entity_type: '', action: '' });
  const params = Object.fromEntries(Object.entries(f).filter(([, v]) => v));
  const { data: facets } = useQuery({ queryKey: ['audit-facets'], queryFn: async () => (await api.get('/audit/facets')).data });
  const q = useInfiniteQuery({
    queryKey: ['audit', params],
    queryFn: async ({ pageParam }) => (await api.get('/audit', { params: { ...params, ...(pageParam ? { before: pageParam } : {}) } })).data,
    initialPageParam: null,
    getNextPageParam: (last) => last.next,
  });
  const rows = q.data?.pages.flatMap((p) => p.entries) || [];
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v?.target ? v.target.value : (v || '') }));
  const filtered = Object.keys(params).length > 0;

  return (
    <>
      <PageHeader title="Audit Log" description="Every sign-in and every change to settings, prices, rules, bookings and the team: who did it, when, and what changed. Entries can’t be edited or deleted." />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <NativeSelect className="w-44" value={f.actor} onChange={set('actor')} placeholder="Anyone" aria-label="Who"
          options={[['bot', 'The AI bot'], ['system', 'System'], ...(facets?.actors || []).map((a) => [a.id, a.removed ? `${a.full_name} (removed)` : a.full_name])]} />
        <NativeSelect className="w-56" value={f.action} onChange={set('action')} placeholder="Any action" aria-label="What"
          options={(facets?.actions || []).map((a) => [a.action, `${label(a.action)} (${a.n})`])} />
        <NativeSelect className="w-40" value={f.entity_type} onChange={set('entity_type')} placeholder="Anything" aria-label="On what"
          options={(facets?.entity_types || []).map((e) => [e.entity_type, e.entity_type.replace(/_/g, ' ')])} />
        <span className="flex items-center gap-1.5 text-sm">
          <Input type="date" className="h-8 w-[9.5rem]" value={f.from} onChange={set('from')} aria-label="From date" />
          <span className="text-muted-foreground">to</span>
          <Input type="date" className="h-8 w-[9.5rem]" value={f.to} onChange={set('to')} aria-label="To date" />
        </span>
        {filtered && <Button size="sm" variant="ghost" onClick={() => setF({ from: '', to: '', actor: '', entity_type: '', action: '' })}><X size={14} /> Clear</Button>}
      </div>

      {q.error && <p className="mb-3 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{errorMessage(q.error)}</p>}
      <ul className="divide-y rounded-xl border bg-card">
        {q.isLoading && <li className="px-4 py-4 text-sm text-muted-foreground">Loading…</li>}
        {!q.isLoading && !rows.length && <li className="px-4 py-4 text-sm text-muted-foreground">Nothing matches.</li>}
        {rows.map((e) => <Entry key={e.id} e={e} />)}
      </ul>
      {q.hasNextPage && (
        <div className="mt-3 flex justify-center">
          <Button variant="outline" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>{q.isFetchingNextPage ? 'Loading…' : 'Show older'}</Button>
        </div>
      )}
    </>
  );
}

function Entry({ e }) {
  const [open, setOpen] = useState(false);
  const changes = diff(e.before, e.after);
  const hasDetail = changes.length > 0 || e.ip;
  const Who = e.actor_type === 'bot' ? Robot : e.actor_type === 'system' ? Gear : User;
  const who = e.actor_type === 'bot' ? 'AI bot' : e.actor_type === 'system' ? 'System' : (e.actor_name || 'Someone');
  return (
    <li>
      <button type="button" disabled={!hasDetail} onClick={() => setOpen((o) => !o)} aria-expanded={hasDetail ? open : undefined}
        className={cn('flex w-full flex-wrap items-center gap-x-3 gap-y-0.5 px-4 py-2.5 text-left text-sm', hasDetail && 'hover:bg-muted/50')}>
        <CaretRight size={13} className={cn('shrink-0 text-muted-foreground transition-transform', open && 'rotate-90', !hasDetail && 'invisible')} />
        <span className="inline-flex w-36 shrink-0 items-center gap-1.5 truncate font-bold"><Who size={14} className="text-muted-foreground" aria-hidden />{who}</span>
        <span className="min-w-0 flex-1">{label(e.action)}{changes.length > 0 && <span className="ml-1.5 text-xs text-muted-foreground">{changes.length} field{changes.length > 1 ? 's' : ''}</span>}</span>
        <time className="text-xs text-muted-foreground tabular-nums" dateTime={e.created_at}>
          {new Date(e.created_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
        </time>
      </button>
      {open && (
        <div className="space-y-2 px-4 pb-3 pl-10">
          {changes.length > 0 && (
            <table className="w-full max-w-2xl text-xs">
              <thead className="text-left text-muted-foreground"><tr><th className="py-1 pr-3 font-bold">Field</th><th className="py-1 pr-3 font-bold">Before</th><th className="py-1 font-bold">After</th></tr></thead>
              <tbody>
                {changes.map(([k, a, b]) => (
                  <tr key={k} className="border-t align-top">
                    <td className="py-1 pr-3 font-mono">{k}</td>
                    <td className="py-1 pr-3 break-all text-muted-foreground line-through decoration-muted-foreground/40">{show(k, a)}</td>
                    <td className="py-1 break-all">{show(k, b)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="text-[11px] text-muted-foreground">{e.entity_type}{e.entity_id ? ` ${e.entity_id.slice(0, 8)}` : ''}{e.ip ? ` · from ${e.ip}` : ''}</p>
        </div>
      )}
    </li>
  );
}

/** [[field, before, after]] for fields that differ (or appear on one side only). */
export function diff(before, after) {
  const b = before && typeof before === 'object' ? before : {};
  const a = after && typeof after === 'object' ? after : {};
  return [...new Set([...Object.keys(b), ...Object.keys(a)])]
    .filter((k) => JSON.stringify(b[k]) !== JSON.stringify(a[k]))
    .map((k) => [k, b[k], a[k]]);
}

function show(k, v) {
  if (SECRET.test(k)) return '••••';
  if (v === undefined) return '—';
  if (v === null) return 'empty';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
