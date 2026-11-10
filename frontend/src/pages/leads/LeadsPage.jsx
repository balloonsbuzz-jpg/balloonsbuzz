import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { MagnifyingGlass, ChatCircle, CalendarCheck } from '@phosphor-icons/react';
import { PageHeader } from '@/components/layout/AppLayout';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { NativeSelect } from '@/components/ui/native-select';
import { Field } from '@/pages/ai/fields';
import { api } from '@/lib/api';
import { useAuth } from '@/hooks/useAuth';
import { useCatalog } from '@/hooks/useCatalog';
import { inr } from '@/lib/money';
import { cn } from '@/lib/utils';
import { useBookingMutation, onBookingError, STATUS_META as BOOKING_STATUS, fmtDate } from '@/pages/bookings/useBookings';
import TagsEditor from '@/components/TagsEditor';

const TABS = [['open', 'Open'], ['won', 'Booked'], ['lost', 'Lost'], ['all', 'All']];
const LEAD_STATUS = {
  new: ['New', 'bg-muted text-muted-foreground'], qualifying: ['Qualifying', 'bg-muted text-muted-foreground'],
  quoted: ['Quoted', 'bg-secondary text-secondary-foreground'], negotiating: ['Negotiating', 'bg-accent text-accent-foreground'],
  won: ['Booked', 'bg-success/15 text-success'], lost: ['Lost', 'bg-destructive/10 text-destructive'], stale: ['Gone quiet', 'bg-muted text-muted-foreground'],
};

export default function LeadsPage() {
  const [status, setStatus] = useState('open');
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState(null);
  const { data, isLoading } = useQuery({
    queryKey: ['leads', status, q],
    queryFn: async () => (await api.get('/leads', { params: { status, q: q || undefined, limit: 100 } })).data,
  });
  const leads = data?.leads || [];
  return (
    <>
      <PageHeader title="Contacts & Leads" description="Everyone who enquired on WhatsApp, what we know about their event, and where they are." />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex gap-1.5" role="tablist" aria-label="Lead status">
          {TABS.map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={status === k} onClick={() => setStatus(k)}
              className={cn('rounded-full border px-3 py-1 text-sm font-bold', status === k ? 'border-primary bg-primary text-primary-foreground' : 'bg-card hover:bg-muted')}>
              {label}{data?.counts && <span className="ml-1.5 opacity-75">{data.counts[k] || 0}</span>}
            </button>
          ))}
        </div>
        <div className="relative ml-auto w-full sm:w-72">
          <MagnifyingGlass size={16} className="absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, phone, venue…" className="pl-8" aria-label="Search leads" />
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border bg-card">
        {isLoading && <p className="p-4 text-sm text-muted-foreground">Loading…</p>}
        {!isLoading && !leads.length && <p className="p-6 text-center text-sm text-muted-foreground">No leads here yet. They appear as soon as a customer messages on WhatsApp.</p>}
        <ul className="divide-y">
          {leads.map((l) => {
            const [label, tone] = LEAD_STATUS[l.status] || [l.status, ''];
            return (
              <li key={l.id}>
                <button type="button" onClick={() => setOpenId(l.id)} className="grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 px-4 py-3 text-left hover:bg-muted/50 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1.3fr)_110px_100px_110px]">
                  <span className="min-w-0">
                    <span className="block truncate font-bold">{l.contact_name || `+${l.contact_phone}`}</span>
                    <span className="block truncate text-xs text-muted-foreground">+{l.contact_phone}</span>
                  </span>
                  <span className={cn('justify-self-end rounded-full px-2 py-0.5 text-[11px] font-bold md:hidden', tone)}>{label}</span>
                  <span className="col-span-2 truncate text-sm text-muted-foreground md:col-span-1">{[l.occasion_name, l.theme_name || l.theme_text || l.package_name].filter(Boolean).join(' · ') || '—'}</span>
                  <span className="hidden text-sm md:block">{l.event_date ? fmtDate(l.event_date, false) : '—'}</span>
                  <span className="hidden text-sm font-bold md:block">{l.booking_code || (l.latest_price ? inr(l.latest_price) : '—')}</span>
                  <span className="hidden flex-col items-end md:flex">
                    <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-bold', tone)}>{label}</span>
                    <span className="text-[11px] text-muted-foreground">{formatDistanceToNow(new Date(l.last_activity_at), { addSuffix: true })}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      <LeadSheet id={openId} onClose={() => setOpenId(null)} />
    </>
  );
}

function LeadSheet({ id, onClose }) {
  const { can } = useAuth();
  const canWrite = can('leads:write');
  const { data: catalog } = useCatalog();
  const { data } = useQuery({ queryKey: ['leads', 'one', id], enabled: !!id, queryFn: async () => (await api.get(`/leads/${id}`)).data });
  const [f, setF] = useState(null);
  const l = data?.lead;
  useEffect(() => {
    if (!l) return;
    setF({
      status: l.status, lost_reason: l.lost_reason || '', occasion: l.occasion_name || '', theme: l.theme_name || l.theme_text || '',
      event_date: l.event_date || '', venue_address: l.venue_address || '', guest_count: l.guest_count ?? '',
      budget_min: l.budget_min == null ? '' : Number(l.budget_min), budget_max: l.budget_max == null ? '' : Number(l.budget_max), notes: l.notes || '',
    });
  }, [l]);
  const save = useBookingMutation({ success: 'Saved' });
  const won = l?.status === 'won';
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e?.target ? e.target.value : e }));
  const num = (v) => (v === '' ? null : Number(v));

  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto data-[side=right]:sm:max-w-lg">
        {!l || !f ? <p className="p-6 text-sm text-muted-foreground">Loading…</p> : (
          <>
            <SheetHeader className="pr-12">
              <SheetTitle className="text-lg font-extrabold">{l.contact_name || `+${l.contact_phone}`}</SheetTitle>
              <SheetDescription>+{l.contact_phone} · enquired {formatDistanceToNow(new Date(l.created_at), { addSuffix: true })}</SheetDescription>
            </SheetHeader>
            <div className="space-y-5 px-4 pb-6">
              <div className="flex flex-wrap items-center gap-2">
                {l.conversation_id && <Button size="sm" variant="outline" nativeButton={false} render={<Link to={`/inbox/${l.conversation_id}`} />}><ChatCircle size={15} /> Open chat</Button>}
                {l.contact_opted_in === false && <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-bold text-muted-foreground">Opted out of offers</span>}
              </div>
              <section>
                <h3 className="mb-1.5 text-sm font-extrabold">Tags</h3>
                <TagsEditor contactId={l.contact_id} canWrite={can('contacts:write')} />
              </section>
              {data.bookings.length > 0 && (
                <section>
                  <h3 className="mb-2 text-sm font-extrabold">Bookings</h3>
                  <ul className="space-y-1.5">
                    {data.bookings.map((b) => (
                      <li key={b.id}>
                        <Link to={`/bookings?open=${b.id}`} className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm hover:bg-muted">
                          <CalendarCheck size={16} /> <b>{b.booking_code}</b> {fmtDate(b.event_date)} · {inr(b.agreed_price)}
                          <span className={cn('ml-auto rounded-full px-2 py-0.5 text-[11px] font-bold', BOOKING_STATUS[b.status]?.tone)}>{BOOKING_STATUS[b.status]?.label}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <form className="space-y-3 rounded-xl border p-4" onSubmit={(e) => {
                e.preventDefault();
                save.mutate({ method: 'patch', url: `/leads/${l.id}`, body: {
                  status: f.status, ...(f.status === 'lost' ? { lost_reason: f.lost_reason } : {}),
                  occasion: f.occasion || null, theme: f.theme || null, event_date: f.event_date || null, venue_address: f.venue_address || null,
                  guest_count: num(f.guest_count), budget_min: num(f.budget_min), budget_max: num(f.budget_max), notes: f.notes || null,
                } }, { onError: (err) => onBookingError(err) });
              }}>
                <h3 className="text-sm font-extrabold">Event details</h3>
                {won && <p className="text-xs text-muted-foreground">Booked: change details on the booking.</p>}
                <fieldset disabled={!canWrite || won} className="space-y-3">
                  {!won && (
                    <div className="grid grid-cols-2 gap-3">
                      <Field id="ld-status" label="Status">
                        <NativeSelect id="ld-status" value={f.status} onChange={set('status')} options={['new', 'qualifying', 'quoted', 'negotiating', 'lost', 'stale'].map((s) => [s, LEAD_STATUS[s][0]])} />
                      </Field>
                      {f.status === 'lost' && <Field id="ld-lost" label="Why lost?"><Input id="ld-lost" value={f.lost_reason} onChange={set('lost_reason')} required minLength={3} placeholder="e.g. booked elsewhere" /></Field>}
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-3">
                    <Field id="ld-occ" label="Occasion">
                      <NativeSelect id="ld-occ" value={f.occasion} onChange={(v) => setF((x) => ({ ...x, occasion: v || '' }))} options={(catalog?.occasions || []).map((o) => [o.name, o.name])} placeholder="—" />
                    </Field>
                    <Field id="ld-theme" label="Theme / design"><Input id="ld-theme" value={f.theme} onChange={set('theme')} /></Field>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <Field id="ld-date" label="Date"><Input id="ld-date" type="date" value={f.event_date} onChange={set('event_date')} /></Field>
                    <Field id="ld-guests" label="Guests"><Input id="ld-guests" type="number" min={1} value={f.guest_count} onChange={set('guest_count')} /></Field>
                  </div>
                  <Field id="ld-venue" label="Venue"><Input id="ld-venue" value={f.venue_address} onChange={set('venue_address')} /></Field>
                  <div className="grid grid-cols-2 gap-3">
                    <Field id="ld-bmin" label="Budget from (₹)"><Input id="ld-bmin" type="number" min={0} step={500} value={f.budget_min} onChange={set('budget_min')} /></Field>
                    <Field id="ld-bmax" label="Budget to (₹)"><Input id="ld-bmax" type="number" min={0} step={500} value={f.budget_max} onChange={set('budget_max')} /></Field>
                  </div>
                  <Field id="ld-notes" label="Notes"><Textarea id="ld-notes" rows={3} value={f.notes} onChange={set('notes')} /></Field>
                </fieldset>
                {canWrite && !won && <Button type="submit" size="sm" disabled={save.isPending}>Save</Button>}
              </form>

              <section>
                <h3 className="mb-2 text-sm font-extrabold">Prices given</h3>
                {!data.quotes.length && <p className="text-sm text-muted-foreground">No price given yet.</p>}
                <ul className="space-y-1.5 text-sm">
                  {data.quotes.map((q) => (
                    <li key={q.id} className={cn('rounded-lg border px-3 py-2', q.status === 'superseded' && 'opacity-50')}>
                      <p className="font-bold">{q.package_name}{q.photo_title ? ` · ${q.photo_title}` : ''}</p>
                      <p className="text-muted-foreground">{inr(q.final_price)} · lowest {inr(q.floor_price)} · {q.status}{q.rounds_used ? ` · ${q.rounds_used} discount rounds` : ''} · {formatDistanceToNow(new Date(q.created_at), { addSuffix: true })}</p>
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
