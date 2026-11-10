import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';

/**
 * One Server-Sent-Events connection per signed-in tab. Events carry ids only;
 * we invalidate the affected queries and React Query refetches what is on screen.
 */
export function useRealtime(enabled) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return undefined;
    const es = new EventSource('/api/stream', { withCredentials: true });

    const onMessage = (e) => {
      const d = safeParse(e.data);
      qc.invalidateQueries({ queryKey: ['conversations'] });
      qc.invalidateQueries({ queryKey: ['conv-counts'] });
      if (d.conversation_id) {
        qc.invalidateQueries({ queryKey: ['messages', d.conversation_id] });
        qc.invalidateQueries({ queryKey: ['conversation', d.conversation_id] });
      }
    };
    es.addEventListener('message.new', onMessage);
    es.addEventListener('message.status', (e) => {
      const d = safeParse(e.data);
      if (d.conversation_id) qc.invalidateQueries({ queryKey: ['messages', d.conversation_id] });
    });
    es.addEventListener('conversation.updated', onMessage);
    // Bookings changed (bot booked, payment recorded, status moved)
    es.addEventListener('booking.updated', () => {
      qc.invalidateQueries({ queryKey: ['bookings'] });
      qc.invalidateQueries({ queryKey: ['leads'] });
    });
    es.addEventListener('broadcast.updated', () => qc.invalidateQueries({ queryKey: ['broadcasts'] }));
    // Gallery import / Drive sync progress
    es.addEventListener('gallery.sync', () => {
      qc.invalidateQueries({ queryKey: ['gallery'] });
    });
    // After a reconnect we may have missed events: refresh everything inbox-related.
    es.addEventListener('hello', () => {
      qc.invalidateQueries({ queryKey: ['conversations'] });
      qc.invalidateQueries({ queryKey: ['conv-counts'] });
    });
    return () => es.close();
  }, [enabled, qc]);
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
}
