import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ChatCircle, Robot, Warning, DotsThreeVertical, CalendarPlus } from '@phosphor-icons/react';
import { PageHeader } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useAuth } from '@/hooks/useAuth';
import { inr } from '@/lib/money';
import { cn } from '@/lib/utils';
import { useBoard, useBookingMutation, onBookingError, STATUS_META, ADVANCE_META, MOVES, fmtDate, fmtTime } from './useBookings';
import BookingSheet from './BookingSheet';
import BookDialog from './BookDialog';
import CancelDialog from './CancelDialog';

const COLUMNS = ['enquiry', 'quoted', 'advance_pending', 'confirmed', 'completed', 'cancelled'];
const HINT = {
  enquiry: 'Chats still being qualified',
  quoted: 'A price was given',
  advance_pending: 'Booked, waiting for the advance',
  confirmed: 'Advance received',
  completed: 'Last 30 days',
  cancelled: 'Last 30 days',
};

export default function BookingsPage() {
  const { can } = useAuth();
  const canWrite = can('bookings:write');
  const { data, isLoading } = useBoard();
  const [params, setParams] = useSearchParams();
  const openId = params.get('open');
  const setOpen = (id) => setParams(id ? { open: id } : {}, { replace: true });
  const [booking, setBooking] = useState(null);     // lead to book
  const [cancelling, setCancelling] = useState(null);
  const [dragId, setDragId] = useState(null);
  const move = useBookingMutation({ success: (d) => `${d.booking.booking_code}: ${STATUS_META[d.booking.status].label}` });

  const doMove = (b, to) => {
    if (b.status === to) return;
    if (!MOVES[b.status]?.includes(to)) return;
    if (to === 'cancelled') { setCancelling(b); return; }
    move.mutate({ url: `/bookings/${b.id}/status`, body: { status: to } }, { onError: (e) => onBookingError(e) });
  };

  const cols = data?.columns || {};
  const all = COLUMNS.flatMap((c) => cols[c] || []);
  const upcoming = [...(cols.advance_pending || []), ...(cols.confirmed || [])];
  const advanceDue = (cols.advance_pending || []).reduce((s, b) => s + Number(b.advance_amount) - Number(b.advance_paid_amount), 0);
  const confirmedValue = (cols.confirmed || []).reduce((s, b) => s + Number(b.agreed_price), 0);

  return (
    <>
      <PageHeader title="Bookings" description="From first message to finished event. Drag a booking to change its status, or use its ⋮ menu." />
      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[['Upcoming events', upcoming.length], ['Waiting for advance', (cols.advance_pending || []).length], ['Advance still due', inr(advanceDue)], ['Confirmed value', inr(confirmedValue)]].map(([k, v]) => (
          <div key={k} className="rounded-xl border bg-card px-3 py-2">
            <p className="text-xs text-muted-foreground">{k}</p>
            <p className="text-xl font-extrabold">{v}</p>
          </div>
        ))}
      </div>

      {isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : (
        <div className="-mx-4 overflow-x-auto px-4 pb-4 sm:-mx-6 sm:px-6">
          <div className="flex min-w-max gap-3">
            {COLUMNS.map((c) => {
              const items = cols[c] || [];
              const droppable = dragId && c !== 'enquiry' && c !== 'quoted';
              const dragged = dragId && all.find((x) => x.id === dragId);
              const allowed = dragged && MOVES[dragged.status]?.includes(c);
              return (
                <section key={c} aria-label={STATUS_META[c].label}
                  onDragOver={(e) => { if (droppable && allowed) e.preventDefault(); }}
                  onDrop={(e) => { e.preventDefault(); if (dragged && allowed) doMove(dragged, c); setDragId(null); }}
                  className={cn('flex w-72 shrink-0 flex-col rounded-xl bg-muted/50 p-2', droppable && allowed && 'ring-2 ring-primary/40', droppable && !allowed && dragged?.status !== c && 'opacity-50')}>
                  <header className="mb-2 px-1">
                    <h2 className="text-sm font-extrabold">{STATUS_META[c].label} <span className="font-semibold text-muted-foreground">{items.length}</span></h2>
                    <p className="text-[11px] text-muted-foreground">{HINT[c]}</p>
                  </header>
                  <ul className="flex max-h-[calc(100dvh-330px)] min-h-24 flex-col gap-2 overflow-y-auto">
                    {items.map((it) => (c === 'enquiry' || c === 'quoted'
                      ? <LeadCard key={it.id} l={it} canWrite={canWrite} onBook={() => setBooking(it)} />
                      : <BookingCard key={it.id} b={it} cap={data.capacity_max} canWrite={canWrite} onOpen={() => setOpen(it.id)} onMove={(to) => doMove(it, to)}
                          onDragStart={() => setDragId(it.id)} onDragEnd={() => setDragId(null)} />))}
                    {!items.length && <li className="rounded-lg border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">Nothing here</li>}
                  </ul>
                </section>
              );
            })}
          </div>
        </div>
      )}

      <BookingSheet id={openId} onClose={() => setOpen(null)} onCancel={(b) => setCancelling(b)} />
      {booking && <BookDialog lead={booking} onClose={() => setBooking(null)} onBooked={(b) => { setBooking(null); setOpen(b.id); }} />}
      {cancelling && <CancelDialog booking={cancelling} onClose={() => setCancelling(null)} />}
    </>
  );
}

function LeadCard({ l, canWrite, onBook }) {
  return (
    <li className="rounded-lg border bg-card p-2.5 text-sm shadow-xs">
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 truncate font-bold">{l.contact_name || `+${l.contact_phone}`}</p>
        {l.handling_mode && l.handling_mode !== 'bot' && <span className="shrink-0 rounded-full bg-accent px-1.5 text-[10px] font-bold text-accent-foreground">team</span>}
      </div>
      <p className="truncate text-xs text-muted-foreground">{[l.occasion_name, l.theme_name || l.package_name].filter(Boolean).join(' · ') || 'Details not known yet'}</p>
      <p className="mt-1 text-xs">{l.event_date ? fmtDate(l.event_date) : 'No date yet'}{l.latest_price ? <> · <b>{inr(l.latest_price)}</b></> : ''}</p>
      <div className="mt-2 flex gap-1.5">
        {l.conversation_id && <Button size="xs" variant="outline" nativeButton={false} render={<Link to={`/inbox/${l.conversation_id}`} />}><ChatCircle size={13} /> Chat</Button>}
        {canWrite && l.latest_quote_id && <Button size="xs" onClick={onBook}><CalendarPlus size={13} /> Book</Button>}
      </div>
    </li>
  );
}

function BookingCard({ b, cap, canWrite, onOpen, onMove, onDragStart, onDragEnd }) {
  const [adv, advTone] = ADVANCE_META[b.advance_status] || ['', ''];
  const over = cap != null && b.status !== 'cancelled' && b.bookings_that_day > cap;
  return (
    <li draggable={canWrite} onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; onDragStart(); }} onDragEnd={onDragEnd}
      className={cn('group rounded-lg border bg-card text-sm shadow-xs transition hover:shadow-md', canWrite && 'cursor-grab active:cursor-grabbing')}>
      <div className="flex items-start gap-1 p-2.5 pb-1">
        <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left focus-visible:outline-none">
          <p className="flex items-center gap-1.5 text-xs font-bold text-muted-foreground">
            {b.booking_code}{b.created_by_type === 'bot' && <Robot size={12} aria-label="Booked by the bot" />}
          </p>
          <p className="truncate font-bold">{b.contact_name || `+${b.contact_phone}`}</p>
          <p className="truncate text-xs text-muted-foreground">{[b.package_name, b.theme_name].filter(Boolean).join(' · ')}</p>
        </button>
        {canWrite && MOVES[b.status] && (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button size="icon-xs" variant="ghost" aria-label={`Move ${b.booking_code}`} />}><DotsThreeVertical size={16} /></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {MOVES[b.status].map((to) => <DropdownMenuItem key={to} onClick={() => onMove(to)}>Move to {STATUS_META[to].label}</DropdownMenuItem>)}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <button type="button" onClick={onOpen} className="block w-full px-2.5 pb-2.5 text-left">
        <p className="text-xs"><b>{fmtDate(b.event_date)}</b>{b.event_time ? ` · ${fmtTime(b.event_time)}` : ''}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span className="font-extrabold">{inr(b.agreed_price)}</span>
          {b.status !== 'cancelled' && <span className={cn('rounded-full px-1.5 py-px text-[10px] font-bold', advTone)}>{adv}</span>}
          {over && <span className="inline-flex items-center gap-0.5 rounded-full bg-destructive/10 px-1.5 py-px text-[10px] font-bold text-destructive" title={`${b.bookings_that_day} bookings that day, limit ${cap}`}><Warning size={11} /> {b.bookings_that_day}/{cap} that day</span>}
        </div>
      </button>
    </li>
  );
}

