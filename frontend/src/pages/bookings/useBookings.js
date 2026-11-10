import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';

export const useBoard = () => useQuery({ queryKey: ['bookings', 'board'], queryFn: async () => (await api.get('/bookings/board')).data });
export const useBooking = (id) => useQuery({ queryKey: ['bookings', 'one', id], enabled: !!id, queryFn: async () => (await api.get(`/bookings/${id}`)).data.booking });

/** Any booking change: refresh board, details, leads and inbox panels. */
export function useBookingMutation({ success } = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ method = 'post', url, body }) => (await api[method](url, body)).data,
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['bookings'] });
      qc.invalidateQueries({ queryKey: ['leads'] });
      qc.invalidateQueries({ queryKey: ['conversation'] });
      const msg = typeof success === 'function' ? success(data) : success;
      if (msg) toast.success(msg);
      if (data?.confirmation && !data.confirmation.sent) toast.warning(`Customer not messaged: ${data.confirmation.reason}`);
    },
  });
}

export function onBookingError(e, { onCapacity } = {}) {
  const d = e?.response?.data;
  if (d?.details?.code === 'capacity' && onCapacity) return onCapacity(d.details, d.error);
  return toast.error(errorMessage(e));
}

export const STATUS_META = {
  enquiry: { label: 'Enquiry', tone: 'bg-muted text-muted-foreground' },
  quoted: { label: 'Quoted', tone: 'bg-secondary text-secondary-foreground' },
  advance_pending: { label: 'Advance pending', tone: 'bg-accent text-accent-foreground' },
  confirmed: { label: 'Confirmed', tone: 'bg-success/15 text-success' },
  completed: { label: 'Completed', tone: 'bg-primary/10 text-primary' },
  cancelled: { label: 'Cancelled', tone: 'bg-destructive/10 text-destructive' },
};

export const ADVANCE_META = {
  pending: ['Advance pending', 'text-accent-foreground bg-accent'],
  partial: ['Part paid', 'text-accent-foreground bg-accent'],
  paid: ['Advance paid', 'text-success bg-success/15'],
  refunded: ['Refunded', 'text-muted-foreground bg-muted'],
};

/** Allowed moves on the board (same rules as the API). */
export const MOVES = {
  advance_pending: ['confirmed', 'cancelled'],
  confirmed: ['advance_pending', 'completed', 'cancelled'],
  completed: ['confirmed'],
  cancelled: ['advance_pending'],
};

export function fmtDate(d, withDay = true) {
  if (!d) return '—';
  const dt = new Date(`${String(d).slice(0, 10)}T00:00:00`);
  return dt.toLocaleDateString('en-IN', { ...(withDay ? { weekday: 'short' } : {}), day: 'numeric', month: 'short', year: dt.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined });
}
export const fmtTime = (t) => (t ? new Date(`2000-01-01T${String(t).slice(0, 5)}:00`).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }) : null);
