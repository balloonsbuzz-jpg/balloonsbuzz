import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useBookingMutation, onBookingError } from './useBookings';

export default function CancelDialog({ booking, onClose }) {
  const [reason, setReason] = useState('');
  const cancel = useBookingMutation({ success: `${booking.booking_code} cancelled` });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Cancel {booking.booking_code}?</DialogTitle>
          <DialogDescription>The date is freed up. Record any refund under Payments. The customer is not messaged automatically.</DialogDescription>
        </DialogHeader>
        <Textarea aria-label="Reason for cancelling" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why? e.g. Customer postponed the event" autoFocus />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Keep booking</Button>
          <Button variant="destructive" disabled={reason.trim().length < 3 || cancel.isPending}
            onClick={() => cancel.mutate({ url: `/bookings/${booking.id}/status`, body: { status: 'cancelled', reason: reason.trim() } }, { onSuccess: onClose, onError: (e) => onBookingError(e) })}>
            Cancel booking
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
