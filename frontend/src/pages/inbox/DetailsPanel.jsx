import { formatDistanceToNow, format } from 'date-fns';
import { X } from '@phosphor-icons/react';
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
        <div>
          <dt className="text-xs font-bold text-muted-foreground">Event details</dt>
          <dd className="text-muted-foreground">Occasion, theme, date, venue, guests and budget appear here once the bot collects them (M6–M7).</dd>
        </div>
      </dl>

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
