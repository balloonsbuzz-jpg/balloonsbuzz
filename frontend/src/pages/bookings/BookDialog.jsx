import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Warning } from '@phosphor-icons/react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Field } from '@/pages/ai/fields';
import { api } from '@/lib/api';
import { inr } from '@/lib/money';
import { useBookingMutation, onBookingError } from './useBookings';

/** Book an enquiry from its latest quote (the price the customer was given). */
export default function BookDialog({ lead, onClose, onBooked }) {
  const [f, setF] = useState({ event_date: lead.event_date || '', event_time: '', venue_address: lead.venue_address || '', guest_count: lead.guest_count || '', special_requests: '' });
  const [force, setForce] = useState(false);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const { data: cap } = useQuery({
    queryKey: ['bookings', 'capacity', f.event_date], enabled: /^\d{4}-\d{2}-\d{2}$/.test(f.event_date),
    queryFn: async () => (await api.get('/bookings/capacity', { params: { date: f.event_date } })).data,
  });
  useEffect(() => setForce(false), [f.event_date]);
  const book = useBookingMutation({ success: (d) => `Booked ${d.booking.booking_code}` });
  const submit = (e) => {
    e.preventDefault();
    book.mutate({ url: '/bookings', body: {
      quote_id: lead.latest_quote_id, event_date: f.event_date, event_time: f.event_time || null, venue_address: f.venue_address,
      guest_count: f.guest_count === '' ? null : Number(f.guest_count), special_requests: f.special_requests || null, allow_over_capacity: force,
    } }, { onSuccess: (d) => onBooked(d.booking), onError: (err) => onBookingError(err, { onCapacity: () => setForce(false) }) });
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Book for {lead.contact_name || `+${lead.contact_phone}`}</DialogTitle>
          <DialogDescription>{[lead.occasion_name, lead.theme_name || lead.package_name].filter(Boolean).join(' · ')} at the quoted price {inr(lead.latest_price)}.</DialogDescription>
        </DialogHeader>
        <form id="book-form" onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field id="bd-date" label="Date"><Input id="bd-date" type="date" value={f.event_date} onChange={set('event_date')} required /></Field>
            <Field id="bd-time" label="Time"><Input id="bd-time" type="time" value={f.event_time} onChange={set('event_time')} /></Field>
          </div>
          {cap?.full && (
            <label className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <Warning size={16} className="mt-0.5 shrink-0" />
              <span className="flex-1"><b>{cap.count} booking{cap.count === 1 ? '' : 's'} already on this day</b> (limit {cap.max}).
                <span className="mt-1 flex items-center gap-2"><input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> Book anyway</span></span>
            </label>
          )}
          {cap && !cap.full && cap.count > 0 && <p className="text-xs text-muted-foreground">{cap.count} other booking{cap.count === 1 ? '' : 's'} that day{cap.max ? ` (limit ${cap.max})` : ''}.</p>}
          <Field id="bd-venue" label="Venue address"><Input id="bd-venue" value={f.venue_address} onChange={set('venue_address')} required minLength={3} /></Field>
          <Field id="bd-guests" label="Guests"><Input id="bd-guests" type="number" min={1} value={f.guest_count} onChange={set('guest_count')} className="max-w-32" /></Field>
          <Field id="bd-req" label="Requests"><Textarea id="bd-req" rows={2} value={f.special_requests} onChange={set('special_requests')} /></Field>
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button type="submit" form="book-form" disabled={book.isPending || (cap?.full && !force)}>{book.isPending ? 'Booking…' : 'Create booking'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
