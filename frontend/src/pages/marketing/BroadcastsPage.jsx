import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import { Plus, Pause, Play, X, ArrowCounterClockwise, Users, Trash } from '@phosphor-icons/react';
import { PageHeader } from '@/components/layout/AppLayout';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Field } from '@/pages/ai/fields';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/hooks/useAuth';
import { useCatalog } from '@/hooks/useCatalog';
import { cn } from '@/lib/utils';
import { useTemplates } from './TemplatesPage';

const STATUS = {
  draft: ['Draft', 'bg-muted text-muted-foreground'], scheduled: ['Scheduled', 'bg-secondary text-secondary-foreground'],
  running: ['Sending', 'bg-accent text-accent-foreground'], paused: ['Paused', 'bg-accent text-accent-foreground'],
  completed: ['Done', 'bg-success/15 text-success'], cancelled: ['Cancelled', 'bg-muted text-muted-foreground'], failed: ['Failed', 'bg-destructive/10 text-destructive'],
};
const LEAD_STATUSES = [['new', 'New'], ['qualifying', 'Qualifying'], ['quoted', 'Quoted'], ['negotiating', 'Negotiating'], ['won', 'Booked'], ['lost', 'Lost'], ['stale', 'Gone quiet']];

const useBroadcastAction = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ method = 'post', url, body }) => (await api[method](url, body)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['broadcasts'] }),
    onError: (e) => toast.error(errorMessage(e)),
  });
};

export default function BroadcastsPage() {
  const { can } = useAuth();
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState(null);
  const { data, isLoading } = useQuery({ queryKey: ['broadcasts'], queryFn: async () => (await api.get('/broadcasts')).data.broadcasts, refetchInterval: (q) => (q.state.data?.some((b) => b.status === 'running') ? 3000 : false) });
  const list = data || [];
  return (
    <>
      <PageHeader title="Broadcasts" description="Send an approved template to a group of customers, e.g. a festive offer to everyone tagged “Diwali”. Customers who replied STOP are never messaged."
        actions={can('broadcasts:write') && <Button onClick={() => setCreating(true)}><Plus size={16} /> New broadcast</Button>} />
      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {!isLoading && !list.length && <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">No broadcasts yet. You’ll need an approved template first (see <Link to="/templates" className="font-bold text-primary">Templates</Link>).</p>}
      <ul className="space-y-2">
        {list.map((b) => {
          const [label, tone] = STATUS[b.status];
          const pct = b.total_count ? Math.round(((b.sent_count + b.failed_count + b.skipped_count) / b.total_count) * 100) : 0;
          return (
            <li key={b.id}>
              <button type="button" onClick={() => setOpenId(b.id)} className="grid w-full gap-2 rounded-xl border bg-card p-4 text-left hover:shadow-md sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_auto]">
                <span className="min-w-0">
                  <span className="block truncate font-bold">{b.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{b.template_name} · {b.status === 'scheduled' ? `starts ${formatDistanceToNow(new Date(b.scheduled_at), { addSuffix: true })}` : formatDistanceToNow(new Date(b.created_at), { addSuffix: true })}</span>
                </span>
                <span className="min-w-0 self-center">
                  {b.total_count > 0 ? (
                    <>
                      <span className="block h-2 overflow-hidden rounded-full bg-muted"><span className="block h-full bg-primary transition-all" style={{ width: `${pct}%` }} /></span>
                      <span className="mt-1 block text-xs text-muted-foreground">{b.sent_count}/{b.total_count} sent · {b.delivered_count} delivered · {b.read_count} read · {b.replied_count} replied{b.failed_count ? ` · ${b.failed_count} failed` : ''}</span>
                    </>
                  ) : <span className="text-xs text-muted-foreground">Not started</span>}
                </span>
                <span className={cn('self-center justify-self-start rounded-full px-2 py-0.5 text-xs font-bold sm:justify-self-end', tone)}>{label}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {creating && <CreateSheet onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setOpenId(id); }} />}
      <DetailSheet id={openId} onClose={() => setOpenId(null)} canWrite={can('broadcasts:write')} />
    </>
  );
}

function Chips({ options, value, onChange }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map(([v, l]) => {
        const on = value.includes(v);
        return (
          <button key={v} type="button" aria-pressed={on} onClick={() => onChange(on ? value.filter((x) => x !== v) : [...value, v])}
            className={cn('rounded-full border px-2.5 py-0.5 text-xs font-bold', on ? 'border-primary bg-primary text-primary-foreground' : 'bg-card hover:bg-muted')}>{l}</button>
        );
      })}
      {!options.length && <span className="text-xs text-muted-foreground">None yet</span>}
    </div>
  );
}

function CreateSheet({ onClose, onCreated }) {
  const { data: tpls } = useTemplates();
  const { data: tags = [] } = useQuery({ queryKey: ['tags'], queryFn: async () => (await api.get('/tags')).data.tags });
  const { data: catalog } = useCatalog();
  const approved = (tpls?.templates || []).filter((t) => t.status === 'approved');
  const [f, setF] = useState({ name: '', template_id: null, statics: {}, tags_any: [], lead_status: [], occasion_ids: [], booked: 'any', active: '', when: 'now', at: '' });
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v?.target ? v.target.value : v }));
  const tpl = approved.find((t) => t.id === f.template_id);
  const filter = useMemo(() => ({
    ...(f.tags_any.length ? { tags_any: f.tags_any } : {}), ...(f.lead_status.length ? { lead_status: f.lead_status } : {}),
    ...(f.occasion_ids.length ? { occasion_ids: f.occasion_ids } : {}), ...(f.booked !== 'any' ? { booked: f.booked } : {}),
    ...(f.active ? { active_within_days: Number(f.active) } : {}),
  }), [f.tags_any, f.lead_status, f.occasion_ids, f.booked, f.active]);
  const [aud, setAud] = useState(null);
  useEffect(() => {
    const t = setTimeout(() => api.post('/broadcasts/audience', filter).then((r) => setAud(r.data)).catch(() => setAud(null)), 300);
    return () => clearTimeout(t);
  }, [filter]);
  const statics = tpl ? tpl.placeholders.filter((n) => tpl.variable_map?.[n] === 'static') : [];
  const body = (tpl?.components || []).find((c) => c.type === 'BODY')?.text || '';
  const sample = body.replace(/\{\{\s*(\d+)\s*\}\}/g, (all, n) => {
    const key = tpl?.variable_map?.[n];
    if (key === 'static') return f.statics[n] || `[${n}]`;
    return tpls?.variables.find((v) => v.key === key)?.example || all;
  });
  const act = useBroadcastAction();
  const go = async (mode) => {
    try {
      const { broadcast } = await act.mutateAsync({ url: '/broadcasts', body: { name: f.name.trim(), template_id: f.template_id, variables: f.statics, audience_filter: filter } });
      if (mode !== 'draft') await act.mutateAsync({ url: `/broadcasts/${broadcast.id}/schedule`, body: { at: mode === 'later' ? new Date(f.at).toISOString() : null } });
      toast.success(mode === 'draft' ? 'Draft saved' : mode === 'later' ? 'Broadcast scheduled' : 'Broadcast started');
      onCreated(broadcast.id);
    } catch { /* toast already shown */ }
  };
  const ready = f.name.trim().length >= 2 && tpl && statics.every((n) => (f.statics[n] || '').trim()) && aud?.count > 0;

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto data-[side=right]:sm:max-w-xl">
        <SheetHeader className="pr-12"><SheetTitle className="text-lg font-extrabold">New broadcast</SheetTitle><SheetDescription>One approved template, to the customers you choose.</SheetDescription></SheetHeader>
        <div className="space-y-5 px-4 pb-6">
          <Field id="bc-name" label="Name (only your team sees it)"><Input id="bc-name" value={f.name} onChange={set('name')} placeholder="Diwali offer 2026" /></Field>
          <Field id="bc-tpl" label="Template" hint={approved.length ? undefined : 'No approved templates yet: submit or sync one on the Templates page.'}>
            <NativeSelect id="bc-tpl" value={f.template_id} onChange={set('template_id')} options={approved.map((t) => [t.id, `${t.name} (${t.category.toLowerCase()})`])} placeholder="Choose…" />
          </Field>
          {tpl && (
            <>
              {statics.map((n) => (
                <Field key={n} id={`bc-s${n}`} label={`Text for {{${n}}}`}><Input id={`bc-s${n}`} value={f.statics[n] || ''} maxLength={500} onChange={(e) => setF((x) => ({ ...x, statics: { ...x.statics, [n]: e.target.value } }))} placeholder="e.g. 20% off" /></Field>
              ))}
              {tpl.placeholders.some((n) => !tpl.variable_map?.[n]) && <p className="text-sm text-destructive">This template has unmapped {'{{n}}'}. Set them on the Templates page first.</p>}
              <div><p className="mb-1 text-xs font-bold text-muted-foreground">Preview</p><p className="ml-auto max-w-sm rounded-lg bg-[#d9fdd3] px-3 py-2 text-[13px] whitespace-pre-line text-[#111b21] shadow-sm dark:bg-[#005c4b] dark:text-[#e9edef]">{sample}</p></div>
            </>
          )}

          <section className="space-y-3 rounded-xl border p-4">
            <h3 className="flex items-center gap-2 text-sm font-extrabold"><Users size={16} /> Who gets it</h3>
            <div><p className="mb-1 text-xs font-bold text-muted-foreground">Tagged with any of</p><Chips options={tags.map((t) => [t.id, `${t.name} (${t.contacts})`])} value={f.tags_any} onChange={set('tags_any')} /></div>
            <div><p className="mb-1 text-xs font-bold text-muted-foreground">Enquiry status</p><Chips options={LEAD_STATUSES} value={f.lead_status} onChange={set('lead_status')} /></div>
            <div><p className="mb-1 text-xs font-bold text-muted-foreground">Occasion</p><Chips options={(catalog?.occasions || []).map((o) => [o.id, o.name])} value={f.occasion_ids} onChange={set('occasion_ids')} /></div>
            <div className="grid grid-cols-2 gap-3">
              <Field id="bc-booked" label="Has booked with us"><NativeSelect id="bc-booked" value={f.booked} onChange={set('booked')} options={[['any', 'Doesn’t matter'], ['yes', 'Yes (past customers)'], ['no', 'Not yet']]} /></Field>
              <Field id="bc-active" label="Messaged us in the last (days)"><Input id="bc-active" type="number" min={1} value={f.active} onChange={set('active')} placeholder="any time" /></Field>
            </div>
            <p className="rounded-lg bg-muted px-3 py-2 text-sm" aria-live="polite">
              {aud ? <><b>{aud.count}</b> customer{aud.count === 1 ? '' : 's'}{aud.sample.length ? `: ${aud.sample.map((s) => s.name || `+${s.phone}`).join(', ')}${aud.count > aud.sample.length ? '…' : ''}` : ''}{aud.opted_out_excluded ? ` · ${aud.opted_out_excluded} left out (replied STOP)` : ''}</> : 'Counting…'}
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-extrabold">When</h3>
            <div className="flex flex-wrap gap-2">
              <label className="flex items-center gap-2 text-sm"><input type="radio" name="when" checked={f.when === 'now'} onChange={() => set('when')('now')} /> Send now</label>
              <label className="flex items-center gap-2 text-sm"><input type="radio" name="when" checked={f.when === 'later'} onChange={() => set('when')('later')} /> Schedule</label>
              {f.when === 'later' && <Input type="datetime-local" aria-label="Send at" value={f.at} onChange={set('at')} className="w-56" />}
            </div>
          </section>
          <div className="flex flex-wrap gap-2">
            <Button disabled={!ready || act.isPending || (f.when === 'later' && !f.at)} onClick={() => go(f.when)}>{f.when === 'later' ? 'Schedule' : `Send to ${aud?.count ?? 0} now`}</Button>
            <Button variant="outline" disabled={!f.name.trim() || !tpl || act.isPending} onClick={() => go('draft')}>Save draft</Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

const R_STATUS = [['', 'All'], ['sent', 'Sent'], ['delivered', 'Delivered'], ['read', 'Read'], ['replied', 'Replied'], ['failed', 'Failed'], ['skipped', 'Skipped'], ['pending', 'Waiting']];

function DetailSheet({ id, onClose, canWrite }) {
  const [rs, setRs] = useState('');
  const { data } = useQuery({
    queryKey: ['broadcasts', id, rs], enabled: !!id,
    queryFn: async () => (await api.get(`/broadcasts/${id}`, { params: { status: rs || undefined } })).data,
    refetchInterval: (q) => (q.state.data?.broadcast?.status === 'running' ? 3000 : false),
  });
  const act = useBroadcastAction();
  const b = data?.broadcast;
  const run = (path, msg, method = 'post') => act.mutate({ method, url: `/broadcasts/${id}${path}` }, { onSuccess: () => { toast.success(msg); if (method === 'delete') onClose(); } });
  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto data-[side=right]:sm:max-w-xl">
        {!b ? <p className="p-6 text-sm text-muted-foreground">Loading…</p> : (
          <>
            <SheetHeader className="pr-12">
              <SheetTitle className="flex items-center gap-2 text-lg font-extrabold">{b.name} <span className={cn('rounded-full px-2 py-0.5 text-xs font-bold', STATUS[b.status][1])}>{STATUS[b.status][0]}</span></SheetTitle>
              <SheetDescription>{b.template_name} · by {b.created_by_name || '—'}{b.scheduled_at ? ` · ${new Date(b.scheduled_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}` : ''}</SheetDescription>
            </SheetHeader>
            <div className="space-y-5 px-4 pb-6">
              <dl className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                {[['Total', b.total_count], ['Sent', b.sent_count], ['Delivered', b.delivered_count], ['Read', b.read_count], ['Replied', b.replied_count], ['Failed', b.failed_count]].map(([k, v]) => (
                  <div key={k} className="rounded-lg bg-muted px-2 py-1.5 text-center"><dt className="text-[11px] text-muted-foreground">{k}</dt><dd className="text-lg font-extrabold">{v}</dd></div>
                ))}
              </dl>
              {b.skipped_count > 0 && <p className="text-xs text-muted-foreground">{b.skipped_count} skipped (opted out or cancelled).</p>}
              {canWrite && (
                <div className="flex flex-wrap gap-2">
                  {b.status === 'running' && <Button size="sm" variant="secondary" onClick={() => run('/pause', 'Paused')}><Pause size={14} /> Pause</Button>}
                  {b.status === 'paused' && <Button size="sm" onClick={() => run('/resume', 'Resumed')}><Play size={14} /> Resume</Button>}
                  {b.failed_count > 0 && ['completed', 'running', 'paused'].includes(b.status) && <Button size="sm" variant="outline" onClick={() => run('/retry-failed', 'Retrying failed messages')}><ArrowCounterClockwise size={14} /> Retry {b.failed_count} failed</Button>}
                  {b.status === 'draft' && <Button size="sm" onClick={() => run('/schedule', 'Broadcast started')}>Send now</Button>}
                  {['scheduled', 'running', 'paused'].includes(b.status) && <Button size="sm" variant="ghost" onClick={() => window.confirm('Cancel this broadcast? Messages not sent yet won’t go out.') && run('/cancel', 'Cancelled')}><X size={14} /> Cancel</Button>}
                  {['draft', 'cancelled', 'completed'].includes(b.status) && <Button size="sm" variant="ghost" onClick={() => window.confirm('Delete this broadcast?') && run('', 'Deleted', 'delete')}><Trash size={14} /> Delete</Button>}
                </div>
              )}
              <section>
                <div className="mb-2 flex flex-wrap gap-1">
                  {R_STATUS.map(([k, l]) => <button key={k} type="button" onClick={() => setRs(k)} className={cn('rounded-full px-2 py-0.5 text-xs font-bold', rs === k ? 'bg-primary text-primary-foreground' : 'bg-muted hover:bg-muted/70')}>{l}</button>)}
                </div>
                <ul className="divide-y rounded-lg border text-sm">
                  {!data.recipients.length && <li className="px-3 py-3 text-muted-foreground">Nobody here.</li>}
                  {data.recipients.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-baseline gap-x-2 px-3 py-2">
                      <b className="min-w-0 truncate">{r.contact_name || `+${r.phone}`}</b>
                      <span className="text-xs text-muted-foreground">+{r.phone}</span>
                      <span className="ml-auto text-xs font-bold">{r.replied_at ? 'replied' : r.status}</span>
                      {r.error_message && <span className="w-full text-xs text-destructive">{r.error_message}</span>}
                    </li>
                  ))}
                </ul>
              </section>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
