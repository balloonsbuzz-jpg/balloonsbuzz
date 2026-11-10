import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import { Lightning, ChatCircle, X } from '@phosphor-icons/react';
import { PageHeader } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/hooks/useAuth';
import { cn } from '@/lib/utils';
import { useTemplates, PURPOSE_LABEL } from './TemplatesPage';

/** Plain-language description of each automation, and which template it needs. */
const ABOUT = {
  quote_no_reply: { what: 'Sends a friendly nudge if the customer goes quiet after getting a price.', delay: 'delay_minutes', unit: 'hours after the price', text: true },
  advance_pending: { what: 'Reminds the customer to pay the advance for a booking.', delay: 'delay_minutes', unit: 'hours after booking', purpose: 'advance_reminder' },
  booking_confirmed: { what: 'Confirms the booking when the full advance is recorded (always on, from Bookings).', purpose: 'booking_confirmation', fixed: true },
  event_reminder: { what: 'Reminds the customer before the event: venue, time and balance.', delay: 'offset_hours', unit: 'hours before the event', purpose: 'event_reminder' },
  post_event_review: { what: 'Asks for a photo or review after the event.', delay: 'offset_hours', unit: 'hours after the event', purpose: 'review_request' },
  handover_requested: { what: 'Messages the team phones (Settings → Business) when a chat needs a person.', purpose: 'handover_alert' },
  lead_stale: { what: 'Marks enquiries as “gone quiet” after no activity.', delay: 'delay_minutes', unit: 'hours of silence' },
};

export default function FollowupsPage() {
  const { can } = useAuth();
  const canWrite = can('automations:write');
  const { data: autos = [] } = useQuery({ queryKey: ['automations'], queryFn: async () => (await api.get('/automations')).data.automations });
  const { data: tpls } = useTemplates();
  const approved = new Set((tpls?.templates || []).filter((t) => t.status === 'approved' && t.purpose).map((t) => t.purpose));
  return (
    <>
      <PageHeader title="Follow-ups" description="Automatic messages: reminders, nudges and alerts. Each one goes out once per quote or booking, and nudges are cancelled when the customer replies first." />
      <div className="grid gap-3 lg:grid-cols-2">
        {autos.map((a) => <AutomationCard key={a.id} a={a} canWrite={canWrite} hasTemplate={ABOUT[a.trigger_type]?.purpose ? approved.has(ABOUT[a.trigger_type].purpose) : null} />)}
      </div>
      <Queue canWrite={canWrite} />
    </>
  );
}

function AutomationCard({ a, canWrite, hasTemplate }) {
  const about = ABOUT[a.trigger_type] || { what: a.name };
  const qc = useQueryClient();
  const raw = about.delay ? Math.abs(Number(a.trigger_config[about.delay] || 0)) : null;
  const [hours, setHours] = useState('');
  const [text, setText] = useState('');
  useEffect(() => {
    setHours(raw == null ? '' : String(about.delay === 'delay_minutes' ? raw / 60 : raw));
    setText(a.action_config.text || '');
  }, [a]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useMutation({
    mutationFn: async (body) => (await api.patch(`/automations/${a.id}`, body)).data.automation,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['automations'] }); toast.success('Saved'); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const saveSettings = () => {
    const body = {};
    if (about.delay) {
      const h = Number(hours);
      body.trigger_config = { [about.delay]: about.delay === 'delay_minutes' ? Math.round(h * 60) : (a.trigger_config.offset_hours < 0 ? -h : h) };
    }
    if (about.text) body.action_config = { text };
    save.mutate(body);
  };
  return (
    <article className="rounded-xl border bg-card p-4">
      <div className="flex items-start gap-3">
        <Lightning size={20} className={cn('mt-0.5 shrink-0', a.is_active ? 'text-primary' : 'text-muted-foreground')} weight={a.is_active ? 'fill' : 'regular'} />
        <div className="min-w-0 flex-1">
          <p className="font-bold">{a.name}</p>
          <p className="text-sm text-muted-foreground">{about.what}</p>
        </div>
        {!about.fixed && <Switch checked={a.is_active} disabled={!canWrite || save.isPending} onCheckedChange={(v) => save.mutate({ is_active: v })} aria-label={`${a.name} on/off`} />}
      </div>
      {about.purpose && (
        <p className={cn('mt-2 text-xs', hasTemplate ? 'text-success' : 'text-muted-foreground')}>
          {hasTemplate ? `✓ Uses the approved “${PURPOSE_LABEL[about.purpose]}” template` : <>Needs an approved “{PURPOSE_LABEL[about.purpose]}” template (<Link to="/templates" className="font-bold text-primary">Templates</Link>); until then it only sends inside the 24-hour window{about.purpose === 'handover_alert' ? ' (team alerts need the template)' : ''}.</>}
        </p>
      )}
      {(about.delay || about.text) && canWrite && (
        <div className="mt-3 space-y-2">
          {about.delay && (
            <label className="flex items-center gap-2 text-sm">
              <Input type="number" min={about.delay === 'delay_minutes' ? 0.25 : 1} step={0.25} value={hours} onChange={(e) => setHours(e.target.value)} className="w-24" aria-label={`${a.name} timing`} />
              <span className="text-muted-foreground">{about.unit}</span>
            </label>
          )}
          {about.text && <Textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} aria-label={`${a.name} message`} />}
          {about.text && <p className="text-xs text-muted-foreground">Use {'{{contact.first_name}}'} for the customer’s name. No prices: the bot handles those.</p>}
          <Button size="sm" variant="outline" onClick={saveSettings} disabled={save.isPending}>Save</Button>
        </div>
      )}
      <p className="mt-2 text-[11px] text-muted-foreground">{a.sent_count} sent · {a.pending_count} waiting{a.last_run_at ? ` · last ${formatDistanceToNow(new Date(a.last_run_at), { addSuffix: true })}` : ''}</p>
    </article>
  );
}

const TABS = [['pending', 'Waiting'], ['sent', 'Sent'], ['cancelled', 'Cancelled'], ['skipped', 'Skipped']];

function Queue({ canWrite }) {
  const [status, setStatus] = useState('pending');
  const qc = useQueryClient();
  const { data = [] } = useQuery({ queryKey: ['followups', status], queryFn: async () => (await api.get('/followups', { params: { status } })).data.followups });
  const cancel = useMutation({
    mutationFn: async (id) => (await api.post(`/followups/${id}/cancel`)).data,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['followups'] }); toast.success('Follow-up cancelled'); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <section className="mt-8">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="mr-2 text-sm font-extrabold">Follow-up queue</h2>
        {TABS.map(([k, l]) => <button key={k} type="button" onClick={() => setStatus(k)} className={cn('rounded-full px-2.5 py-0.5 text-xs font-bold', status === k ? 'bg-primary text-primary-foreground' : 'bg-muted')}>{l}</button>)}
      </div>
      <ul className="divide-y rounded-xl border bg-card text-sm">
        {!data.length && <li className="px-4 py-4 text-muted-foreground">Nothing here.</li>}
        {data.map((f) => (
          <li key={f.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
            <span className="min-w-0 flex-1">
              <b>{f.contact_name || `+${f.contact_phone}`}</b> <span className="text-muted-foreground">· {f.automation_name || (f.kind === 'bot_scheduled' ? 'Bot follow-up' : f.kind)}{f.booking_code ? ` · ${f.booking_code}` : ''}</span>
              {f.content?.text && <span className="block truncate text-xs text-muted-foreground">“{f.content.text}”</span>}
              {f.cancel_reason && <span className="block text-xs text-muted-foreground">{f.cancel_reason}</span>}
            </span>
            <span className="text-xs text-muted-foreground">{new Date(f.sent_at || f.scheduled_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</span>
            {f.conversation_id && <Button size="icon-sm" variant="ghost" aria-label="Open chat" nativeButton={false} render={<Link to={`/inbox/${f.conversation_id}`} />}><ChatCircle size={15} /></Button>}
            {canWrite && f.status === 'pending' && <Button size="sm" variant="ghost" onClick={() => cancel.mutate(f.id)}><X size={14} /> Cancel</Button>}
          </li>
        ))}
      </ul>
    </section>
  );
}
