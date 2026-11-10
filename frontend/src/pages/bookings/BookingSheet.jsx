import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatDistanceToNow } from 'date-fns';
import { ChatCircle, Robot, Warning, CurrencyInr } from '@phosphor-icons/react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { NativeSelect } from '@/components/ui/native-select';
import { Field } from '@/pages/ai/fields';
import { useAuth } from '@/hooks/useAuth';
import { inr } from '@/lib/money';
import { cn } from '@/lib/utils';
import { useBooking, useBookingMutation, onBookingError, STATUS_META, ADVANCE_META, MOVES, fmtDate, fmtTime } from './useBookings';

export default function BookingSheet({ id, onClose, onCancel }) {
  const { can } = useAuth();
  const { data: b } = useBooking(id);
  const move = useBookingMutation({ success: (d) => `Moved to ${STATUS_META[d.booking.status].label}` });

  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto data-[side=right]:sm:max-w-lg">
        {!b ? <p className="p-6 text-sm text-muted-foreground">Loading…</p> : (
          <>
            <SheetHeader className="pr-12">
              <SheetTitle className="flex flex-wrap items-center gap-2 text-lg font-extrabold">
                {b.booking_code}
                <span className={cn('rounded-full px-2 py-0.5 text-xs font-bold', STATUS_META[b.status].tone)}>{STATUS_META[b.status].label}</span>
                {b.created_by_type === 'bot' && <span className="inline-flex items-center gap-1 text-xs font-semibold text-muted-foreground"><Robot size={13} /> booked by the bot</span>}
              </SheetTitle>
              <SheetDescription>{b.contact_name || 'Customer'} · +{b.contact_phone}</SheetDescription>
            </SheetHeader>
            <div className="space-y-5 px-4 pb-6">
              <div className="flex flex-wrap gap-2">
                {b.conversation_id && <Button size="sm" variant="outline" nativeButton={false} render={<Link to={`/inbox/${b.conversation_id}`} />}><ChatCircle size={15} /> Open chat</Button>}
                {can('bookings:write') && (MOVES[b.status] || []).map((to) => (
                  <Button key={to} size="sm" variant={to === 'cancelled' ? 'ghost' : 'secondary'} disabled={move.isPending}
                    onClick={() => (to === 'cancelled' ? onCancel(b) : move.mutate({ url: `/bookings/${b.id}/status`, body: { status: to } }, { onError: (e) => onBookingError(e) }))}>
                    {to === 'cancelled' ? 'Cancel booking' : `Mark ${STATUS_META[to].label.toLowerCase()}`}
                  </Button>
                ))}
              </div>
              {b.status === 'cancelled' && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">Cancelled: {b.cancelled_reason}</p>}
              {b.capacity_max != null && b.status !== 'cancelled' && b.bookings_that_day > b.capacity_max && (
                <p className="flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm font-bold text-destructive"><Warning size={16} /> {b.bookings_that_day} bookings on this day; the limit is {b.capacity_max}.</p>
              )}

              {b.photo_url && <img src={b.photo_url} alt={b.photo_title || 'Chosen design'} className="aspect-video w-full rounded-xl object-cover" />}
              <Money b={b} />
              <EventForm b={b} canWrite={can('bookings:write')} />
              <Payments b={b} canPay={can('payments:write')} />

              <section>
                <h3 className="mb-2 text-sm font-extrabold">History</h3>
                <ol className="space-y-1.5 border-l pl-3 text-sm">
                  {b.history.map((h) => (
                    <li key={h.id}>
                      <b>{STATUS_META[h.to_status]?.label || h.to_status}</b>
                      <span className="text-muted-foreground"> · {h.actor_type === 'bot' ? 'bot' : h.actor_name || h.actor_type} · {formatDistanceToNow(new Date(h.created_at), { addSuffix: true })}</span>
                    </li>
                  ))}
                </ol>
              </section>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Money({ b }) {
  const paid = Number(b.advance_paid_amount);
  const [adv, tone] = ADVANCE_META[b.advance_status] || ['', ''];
  return (
    <section className="rounded-xl border p-4">
      <h3 className="mb-2 flex items-center gap-2 text-sm font-extrabold"><CurrencyInr size={16} /> Price</h3>
      <table className="w-full text-sm">
        <tbody className="divide-y">
          {b.line_items.map((l, i) => <tr key={i}><td className="py-1">{l.label}</td><td className="py-1 text-right tabular-nums">{inr(l.amount)}</td></tr>)}
          {Number(b.quoted_price) !== Number(b.agreed_price) && <tr><td className="py-1 text-muted-foreground">Discount</td><td className="py-1 text-right tabular-nums text-muted-foreground">−{inr(Number(b.quoted_price) - Number(b.agreed_price))}</td></tr>}
          <tr className="border-t-2"><td className="py-1.5 font-extrabold">Agreed price</td><td className="py-1.5 text-right text-lg font-extrabold tabular-nums">{inr(b.agreed_price)}</td></tr>
          <tr><td className="py-1">Advance required</td><td className="py-1 text-right tabular-nums">{inr(b.advance_amount)}</td></tr>
          <tr><td className="py-1">Paid so far</td><td className="py-1 text-right tabular-nums">{inr(paid)} <span className={cn('ml-1 rounded-full px-1.5 text-[10px] font-bold', tone)}>{adv}</span></td></tr>
          <tr><td className="py-1 font-bold">Balance on the day</td><td className="py-1 text-right font-bold tabular-nums">{inr(b.balance_amount)}</td></tr>
        </tbody>
      </table>
      <p className="mt-2 text-xs text-muted-foreground">Lowest allowed price for this design: {inr(b.floor_price)}</p>
    </section>
  );
}

function EventForm({ b, canWrite }) {
  const [f, setF] = useState(null);
  useEffect(() => setF({
    event_date: b.event_date, event_time: b.event_time ? String(b.event_time).slice(0, 5) : '', venue_address: b.venue_address,
    guest_count: b.guest_count ?? '', special_requests: b.special_requests || '', internal_notes: b.internal_notes || '',
  }), [b]);
  const [over, setOver] = useState(null);
  const save = useBookingMutation({ success: 'Saved' });
  if (!f) return null;
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const submit = (e, allow = false) => {
    e?.preventDefault();
    save.mutate({ method: 'patch', url: `/bookings/${b.id}`, body: {
      event_date: f.event_date, event_time: f.event_time || null, venue_address: f.venue_address, guest_count: f.guest_count === '' ? null : Number(f.guest_count),
      special_requests: f.special_requests || null, internal_notes: f.internal_notes || null, ...(allow ? { allow_over_capacity: true } : {}),
    } }, { onSuccess: () => setOver(null), onError: (err) => onBookingError(err, { onCapacity: (d, msg) => setOver(msg) }) });
  };
  return (
    <form onSubmit={submit} className="space-y-3 rounded-xl border p-4">
      <h3 className="text-sm font-extrabold">Event</h3>
      <p className="text-sm text-muted-foreground">{b.occasion_name || 'Event'} · {[b.package_name, b.theme_name, b.photo_title].filter(Boolean).join(' · ')} · {fmtDate(b.event_date)}{b.event_time ? `, ${fmtTime(b.event_time)}` : ''}</p>
      <fieldset disabled={!canWrite} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field id="bk-date" label="Date"><Input id="bk-date" type="date" value={f.event_date} onChange={set('event_date')} required /></Field>
          <Field id="bk-time" label="Time"><Input id="bk-time" type="time" value={f.event_time} onChange={set('event_time')} /></Field>
        </div>
        <Field id="bk-venue" label="Venue"><Input id="bk-venue" value={f.venue_address} onChange={set('venue_address')} required minLength={3} /></Field>
        <Field id="bk-guests" label="Guests"><Input id="bk-guests" type="number" min={1} value={f.guest_count} onChange={set('guest_count')} className="max-w-32" /></Field>
        <Field id="bk-req" label="Customer’s requests"><Textarea id="bk-req" rows={2} value={f.special_requests} onChange={set('special_requests')} /></Field>
        <Field id="bk-notes" label="Team notes" hint="Only your team sees these"><Textarea id="bk-notes" rows={2} value={f.internal_notes} onChange={set('internal_notes')} /></Field>
      </fieldset>
      {over && (
        <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {over} <button type="button" className="font-bold underline" onClick={() => submit(null, true)}>Move it anyway</button>
        </p>
      )}
      {canWrite && <Button type="submit" size="sm" disabled={save.isPending}>Save</Button>}
    </form>
  );
}

const METHODS = [['upi', 'UPI'], ['cash', 'Cash'], ['bank_transfer', 'Bank transfer'], ['gateway', 'Online payment']];

function Payments({ b, canPay }) {
  const due = Math.max(0, Number(b.advance_amount) - Number(b.advance_paid_amount));
  const [f, setF] = useState({ amount: '', method: 'upi', reference: '' });
  useEffect(() => setF((x) => ({ ...x, amount: due || '' })), [b.id, due]);
  const pay = useBookingMutation({ success: (d) => (d.booking.status === 'confirmed' && d.confirmation?.sent ? 'Payment recorded. Booking confirmed; the confirmation message is on its way.' : 'Payment recorded') });
  return (
    <section className="rounded-xl border p-4">
      <h3 className="mb-2 text-sm font-extrabold">Payments</h3>
      {!b.payments.length && <p className="text-sm text-muted-foreground">Nothing received yet.</p>}
      <ul className="mb-3 divide-y text-sm">
        {b.payments.map((p) => (
          <li key={p.id} className="flex flex-wrap items-baseline gap-x-2 py-1.5">
            <b className={p.kind === 'refund' ? 'text-destructive' : ''}>{p.kind === 'refund' ? '−' : ''}{inr(p.amount)}</b>
            <span>{METHODS.find(([k]) => k === p.method)?.[1]}</span>
            {p.reference && <span className="font-mono text-xs text-muted-foreground">{p.reference}</span>}
            <span className="ml-auto text-xs text-muted-foreground">{new Date(p.received_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} · {p.recorded_by_name || '—'}</span>
          </li>
        ))}
      </ul>
      {canPay && b.status !== 'cancelled' && (
        <form className="grid gap-2 sm:grid-cols-[110px_130px_minmax(0,1fr)_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            pay.mutate({ url: `/bookings/${b.id}/payments`, body: { amount: Number(f.amount), method: f.method, ...(f.reference.trim() ? { reference: f.reference.trim() } : {}) } },
              { onSuccess: () => setF((x) => ({ ...x, reference: '' })), onError: (e2) => onBookingError(e2) });
          }}>
          <Input aria-label="Amount received" type="number" min={1} step={1} value={f.amount} onChange={(e) => setF((x) => ({ ...x, amount: e.target.value }))} placeholder="₹" required />
          <NativeSelect aria-label="Payment method" value={f.method} onChange={(v) => setF((x) => ({ ...x, method: v }))} options={METHODS} />
          <Input aria-label="UPI / bank reference" value={f.reference} onChange={(e) => setF((x) => ({ ...x, reference: e.target.value }))} placeholder="UTR / reference (optional)" />
          <Button type="submit" disabled={pay.isPending || !f.amount}>Record</Button>
        </form>
      )}
      {due > 0 && b.status === 'advance_pending' && <p className="mt-2 text-xs text-muted-foreground">When the full advance ({inr(b.advance_amount)}) is recorded, the booking is confirmed and the customer gets the confirmation message.</p>}
    </section>
  );
}
