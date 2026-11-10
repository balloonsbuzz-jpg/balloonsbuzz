import { Link } from 'react-router-dom';
import { formatDistanceToNow, format } from 'date-fns';
import { X, CalendarCheck } from '@phosphor-icons/react';
import { inr } from '@/lib/money';
import { STATUS_META, fmtDate } from '@/pages/bookings/useBookings';
import { useAuth } from '@/hooks/useAuth';
import { useConversation, useConvAction, useTeam } from './useInbox';
import { displayName, formatPhone, windowLeft } from './format';

const TRIGGER_LABEL = {
  customer_request: 'Customer asked for a person', keyword: 'Customer asked for a person', discount_limit: 'Discount above the limit',
  bot_stuck: 'Bot got stuck', out_of_area: 'Venue outside service area', date_unavailable: 'Date unavailable',
  agent_takeover: 'Taken over', agent_pause: 'Bot paused', agent_resume: 'Bot resumed', auto_resume: 'Bot resumed automatically',
  agent_reply: 'Agent replied', system: 'System',
};

export default function DetailsPanel({ id, onClose }) {
  const { can } = useAuth();
  const { data: conv } = useConversation(id);
  const { data: team = [] } = useTeam();
  const act = useConvAction(id);
  if (!conv) return null;
  const left = windowLeft(conv.window_expires_at);

  return (
    <aside className="h-full overflow-y-auto border-l bg-card p-4" aria-label="Customer details">
      <div className="mb-4 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-lg font-extrabold">{displayName(conv)}</p>
          <p className="text-sm text-muted-foreground">{formatPhone(conv.contact_phone)}</p>
        </div>
        {onClose && <button onClick={onClose} className="rounded-md p-1 hover:bg-muted xl:hidden" aria-label="Close details"><X size={18} /></button>}
      </div>

      <dl className="space-y-3 text-sm">
        <div>
          <dt className="text-xs font-bold text-muted-foreground">24h reply window</dt>
          <dd>{left ? <span className="font-bold text-success">Open · {left}</span> : <span className="font-bold text-muted-foreground">Closed (templates only)</span>}</dd>
        </div>
        <div>
          <dt className="text-xs font-bold text-muted-foreground">Assigned to</dt>
          <dd>
            {can('inbox:write') ? (
              <select aria-label="Assign conversation" value={conv.assigned_user_id || ''} onChange={(e) => act.mutate({ path: 'assign', body: { user_id: e.target.value || null } })}
                className="mt-1 h-8 w-full rounded-lg border border-input bg-background px-2 text-sm">
                <option value="">Unassigned</option>
                {team.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
              </select>
            ) : conv.assigned_user_name || 'Unassigned'}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-bold text-muted-foreground">Customer since</dt>
          <dd>{format(new Date(conv.contact_since), 'd MMM yyyy')} · via {conv.contact_source}</dd>
        </div>
      </dl>

      <EventDetails lead={conv.lead} bookings={conv.bookings || []} />

      <h3 className="mb-2 mt-6 text-xs font-bold uppercase tracking-wide text-muted-foreground">Handover history</h3>
      {conv.handover_history.length === 0 ? <p className="text-sm text-muted-foreground">The bot has handled this chat so far.</p> : (
        <ol className="space-y-2 border-l pl-3">
          {conv.handover_history.map((h, i) => (
            <li key={i} className="text-sm">
              <p className="font-bold">{TRIGGER_LABEL[h.trigger] || h.trigger} <span className="font-normal text-muted-foreground">→ {h.to_mode}</span></p>
              <p className="text-xs text-muted-foreground">{h.actor_name || (h.trigger === 'auto_resume' ? 'Timer' : 'Bot')} · {formatDistanceToNow(new Date(h.created_at), { addSuffix: true })}</p>
              {h.reason && !['Agent took over', 'Agent replied', 'Agent resumed the bot', 'Bot paused'].includes(h.reason) && <p className="text-xs italic text-muted-foreground">{h.reason}</p>}
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}

const LEAD_LABEL = { new: 'New', qualifying: 'Qualifying', quoted: 'Quoted', negotiating: 'Negotiating', won: 'Booked', lost: 'Lost', stale: 'Gone quiet' };

function EventDetails({ lead, bookings }) {
  const rows = lead ? [
    ['Occasion', lead.occasion_name],
    ['Theme / design', lead.theme_name || lead.theme_text || lead.package_name],
    ['Date', lead.event_date ? `${fmtDate(lead.event_date)}${lead.event_time ? `, ${String(lead.event_time).slice(0, 5)}` : ''}` : null],
    ['Venue', lead.venue_address || (lead.distance_km != null ? `Pin, ${lead.distance_km} km` : null)],
    ['Guests', lead.guest_count],
    ['Budget', lead.budget_max != null ? `${inr(lead.budget_min ?? lead.budget_max)}–${inr(lead.budget_max)}` : null],
    ['Price given', lead.latest_price != null ? inr(lead.latest_price) : null],
  ] : [];
  return (
    <section className="mt-6">
      <h3 className="mb-2 flex items-center justify-between text-xs font-bold uppercase tracking-wide text-muted-foreground">
        Event {lead && <span className="rounded-full bg-muted px-2 py-0.5 normal-case tracking-normal">{LEAD_LABEL[lead.status]}</span>}
      </h3>
      {!lead ? <p className="text-sm text-muted-foreground">The bot fills this in as the customer shares details.</p> : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          {rows.map(([k, v]) => (
            <div key={k} className="contents"><dt className="text-muted-foreground">{k}</dt><dd className={v ? 'font-bold' : 'text-muted-foreground'}>{v || '—'}</dd></div>
          ))}
        </dl>
      )}
      {bookings.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {bookings.map((b) => (
            <li key={b.id}>
              <Link to={`/bookings?open=${b.id}`} className="flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-sm hover:bg-muted">
                <CalendarCheck size={15} /> <b>{b.booking_code}</b> <span className="text-muted-foreground">{fmtDate(b.event_date, false)}</span>
                <span className={`ml-auto rounded-full px-1.5 text-[10px] font-bold ${STATUS_META[b.status]?.tone}`}>{STATUS_META[b.status]?.label}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
