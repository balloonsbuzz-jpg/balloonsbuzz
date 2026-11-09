import { format, isToday, isYesterday, differenceInMinutes } from 'date-fns';

export function displayName(c) {
  return c?.contact_name || (c?.contact_phone ? `+${c.contact_phone}` : 'Unknown');
}

export function shortTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isToday(d)) return format(d, 'h:mm a');
  if (isYesterday(d)) return 'Yesterday';
  return format(d, 'd MMM');
}

export function dayLabel(iso) {
  const d = new Date(iso);
  if (isToday(d)) return 'Today';
  if (isYesterday(d)) return 'Yesterday';
  return format(d, 'EEEE, d MMMM');
}

/** "18h 20m left" until the 24h customer-service window closes. */
export function windowLeft(expiresAt) {
  if (!expiresAt) return null;
  const mins = differenceInMinutes(new Date(expiresAt), new Date());
  if (mins <= 0) return null;
  const h = Math.floor(mins / 60);
  return h ? `${h}h ${mins % 60}m left` : `${mins}m left`;
}

export const formatPhone = (p) => (p ? `+${p.replace(/^(\d{2})(\d{5})(\d{5})$/, '$1 $2 $3')}` : '');
