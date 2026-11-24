import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, apiUrl } from '@/lib/api';

/**
 * One Server-Sent-Events connection per signed-in tab. Events carry ids only;
 * we invalidate the affected queries and React Query refetches what is on screen.
 */
export function useRealtime(enabled) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return undefined;
    let es;
    let timer;
    let stopped = false;

    const onMessage = (e) => {
      const d = safeParse(e.data);
      qc.invalidateQueries({ queryKey: ['conversations'] });
      qc.invalidateQueries({ queryKey: ['conv-counts'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      if (d.conversation_id) {
        qc.invalidateQueries({ queryKey: ['messages', d.conversation_id] });
        qc.invalidateQueries({ queryKey: ['conversation', d.conversation_id] });
      }
    };
    const listen = () => {
      es = new EventSource(apiUrl('/stream'), { withCredentials: true });
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
        qc.invalidateQueries({ queryKey: ['dashboard'] });
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
      // The browser reconnects by itself after a dropped line, but gives up when the answer is an
      // error, e.g. 401 once the 15-minute sign-in cookie has run out. Renew it, then listen again.
      es.addEventListener('error', () => {
        if (es.readyState !== EventSource.CLOSED || stopped) return;
        timer = setTimeout(() => api.get('/auth/me').then(() => !stopped && listen(), (e) => {
          if (!stopped && e?.response?.status !== 401) timer = setTimeout(listen, 15_000);
        }), 3000);
      });
    };
    listen();
    return () => { stopped = true; clearTimeout(timer); es.close(); };
  }, [enabled, qc]);
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
}
